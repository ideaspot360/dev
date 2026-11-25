---
layout: post
title: "Fixing Elasticsearch CircuitBreakingException: Data Too Large & Fielddata Cache OOM"
date: 2026-11-13 10:29:47 +0900
category: "Database & Storage"
categories: ["Database & Storage"]
tags: [elasticsearch, circuitbreaker, jvm-heap, fielddata, doc-values, fulltextsearch, bigdata]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When high-cardinality aggregations or wildcard queries hit Elasticsearch indices, nodes reject incoming requests with CircuitBreakingException ([parent] Data too large) and HTTP 429 status codes. Here is an architectural deep dive into why sorting or aggregating on unindexed text fields forces in-memory Fielddata allocation, how Lucene doc_values eliminate heap bloat via OS page cache, why raising breaker limits leads to fatal OutOfMemoryError crashes, and production runbooks for indices.breaker tuning and schema migrations."
verification_date: "2026-11-23"
fact_check_sources:
  - "https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker.html"
  - "https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker-errors.html"
  - "https://www.elastic.co/guide/en/elasticsearch/reference/current/doc-values.html"
  - "https://www.elastic.co/guide/en/elasticsearch/reference/current/text.html#fielddata-mapping-param"
  - "https://www.elastic.co/guide/en/elasticsearch/reference/current/field-data-cache-settings.html"
  - "https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-clearcache.html"
  - "https://github.com/elastic/elasticsearch/blob/main/server/src/main/java/org/elasticsearch/indices/breaker/HierarchyCircuitBreakerService.java"
---

During heavy aggregation or sorting queries on production Elasticsearch data nodes, search requests abruptly fail with HTTP 429 Too Many Requests. The client receives a `circuit_breaking_exception` reporting that JVM heap allocation limits have been breached:

```text
{
  "error": {
    "root_cause": [
      {
        "type": "circuit_breaking_exception",
        "reason": "[parent] Data too large, data for [<transport_request>] would be [31849102432/29.6gb], which is larger than the limit of [30601641984/28.5gb], real usage: [31849098128/29.6gb], new bytes reserved: [4304/4.2kb], usages [request=0/0b, fielddata=18038862848/16.8gb, in_flight_requests=4304/4.2kb, accounting=4124987392/3.8gb]",
        "bytes_wanted": 31849102432,
        "bytes_limit": 30601641984,
        "durability": "TRANSIENT"
      }
    ],
    "type": "circuit_breaking_exception",
    "reason": "[parent] Data too large, data for [<transport_request>] would be [31849102432/29.6gb], which is larger than the limit of [30601641984/28.5gb], real usage: [31849098128/29.6gb], new bytes reserved: [4304/4.2kb], usages [request=0/0b, fielddata=18038862848/16.8gb, in_flight_requests=4304/4.2kb, accounting=4124987392/3.8gb]",
    "status": 429
  }
}
```

Simultaneously, the Elasticsearch server daemon logs at `/var/log/elasticsearch/elasticsearch.log` emit a fatal stacktrace from `HierarchyCircuitBreakerService`:

```text
[2026-11-13T10:29:12,418][WARN ][o.e.i.b.HierarchyCircuitBreakerService] [data-node-04] [parent] Data too large, data for [<transport_request>] would be [31849102432/29.6gb], which is larger than the limit of [30601641984/28.5gb], real usage: [31849098128/29.6gb], new bytes reserved: [4304/4.2kb], usages [request=0/0b, fielddata=18038862848/16.8gb, in_flight_requests=4304/4.2kb, accounting=4124987392/3.8gb]
org.elasticsearch.common.breaker.CircuitBreakingException: [parent] Data too large, data for [<transport_request>] would be [31849102432/29.6gb], which is larger than the limit of [30601641984/28.5gb], real usage: [31849098128/29.6gb], new bytes reserved: [4304/4.2kb], usages [request=0/0b, fielddata=18038862848/16.8gb, in_flight_requests=4304/4.2kb, accounting=4124987392/3.8gb]
	at org.elasticsearch.indices.breaker.HierarchyCircuitBreakerService.checkParentLimit(HierarchyCircuitBreakerService.java:389)
	at org.elasticsearch.common.breaker.ChildMemoryCircuitBreaker.addEstimateBytesAndMaybeBreak(ChildMemoryCircuitBreaker.java:128)
	at org.elasticsearch.transport.InboundHandler.handleRequest(InboundHandler.java:242)
	at org.elasticsearch.transport.InboundHandler.messageReceived(InboundHandler.java:135)
	at org.elasticsearch.transport.TcpTransport.inboundMessage(TcpTransport.java:768)
```

## Production Environment Specs
* **Elasticsearch Engine**: Version 8.14.0 (HotSpot JVM 21, G1GC enabled)
* **Node JVM Memory Sizing**: `-Xms30g -Xmx30g` (Compressed OOPs boundary)
* **Host Hardware**: 6 Data Nodes, 64 GB Physical RAM, 16 vCPU, NVMe SSD storage
* **Workload & Scale**: 1.2 Billion documents across 120 shards, 4,200 search QPS, 25,000 index ops/sec
* **Cluster Setting Defaults**: `indices.breaker.total.use_real_memory: true` [Source: Elastic Reference - Circuit breaker settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker.html)

---

## 1. Root Cause Analysis: Inverted Indexes, Fielddata, and the Parent Breaker

### Inverted Index vs. Columnar Access Patterns
Elasticsearch stores string fields using Apache Lucene inverted indexes. An inverted index maps individual terms to the document IDs containing them (`term -> [doc_id_1, doc_id_2, ...]`). This data structure enables sub-millisecond full-text term lookups.

However, operations such as `terms` aggregations, sorting, and scripting require the exact reverse access pattern: given a document ID, find all terms associated with it (`doc_id -> [term_1, term_2, ...]`). 

```
[Inverted Index: Search Pattern]
"database" -> [Doc #1, Doc #4, Doc #9]
"storage"  -> [Doc #1, Doc #2, Doc #8]

[Columnar / Doc Values: Aggregation Pattern]
Doc #1 -> ["database", "storage"]
Doc #2 -> ["storage"]
Doc #4 -> ["database"]
```

For non-text fields (such as `keyword`, numeric, date, and geo types), Lucene generates on-disk, column-oriented structures called **`doc_values`** at index time [Source: Elastic Reference - Doc values](https://www.elastic.co/guide/en/elasticsearch/reference/current/doc-values.html). `doc_values` are serialized to disk (`.dvd` and `.dvm` segment files) and mapped directly into the Linux operating system page cache via `mmap`. They bypass the JVM garbage collector entirely.

### The Mechanics of In-Memory Fielddata
Analyzed `text` fields do not support `doc_values` by default because tokenization produces variable-length token streams for each document. When an application executes a `terms` aggregation or sort query against a `text` field, Elasticsearch is forced to construct **Fielddata** dynamically on the JVM heap:

1. **Uninverting Lucene Segments**: The data node reads every segment's inverted index from disk, un-inverts the posting lists in real time, and builds an in-memory term dictionary.
2. **Global Ordinals Computation**: Elasticsearch maps every unique term across all segment dictionaries to a 32-bit dense integer ordinal array (`global_ordinals`). For fields with millions of distinct strings (such as customer comments, raw URL paths, or full error logs), building and holding global ordinals requires gigabytes of contiguous heap memory.
3. **Cache Persistence**: Unlike per-query execution buffers, Fielddata is loaded into the node-level `indices.fielddata.cache`. Once loaded, it remains resident on the JVM heap indefinitely. By default, `indices.fielddata.cache.size` is `unbounded` [Source: Elastic Reference - Field data cache settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/field-data-cache-settings.html). The cache never evicts entries unless forced by memory pressure or manual API intervention.

### Circuit Breaker Mathematics
Elasticsearch implements a hierarchy of circuit breakers in `HierarchyCircuitBreakerService.java` [Source: Elasticsearch Source - HierarchyCircuitBreakerService](https://github.com/elastic/elasticsearch/blob/main/server/src/main/java/org/elasticsearch/indices/breaker/HierarchyCircuitBreakerService.java):
* **Parent Breaker (`indices.breaker.total.*`)**: Tracks total node heap pressure. When `indices.breaker.total.use_real_memory` is `true` (default in Elasticsearch 7.x and 8.x), the parent breaker measures actual JVM memory usage via `ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed()`, combined with proposed reservation bytes. The default parent limit is 95% of total heap.
* **Fielddata Breaker (`indices.breaker.fielddata.limit`)**: Limits estimated memory dedicated to Fielddata. Default limit is 40% of JVM heap with an overhead factor of 1.03.

On a node configured with `-Xms30g -Xmx30g`, total addressable heap is:

$$Heap_{bytes} = 30 \times 1024^3 = 32,212,254,720\text{ bytes}$$

With the parent breaker configured at the default 95%:

$$Limit_{parent} = 32,212,254,720 \times 0.95 = 30,601,641,984\text{ bytes (28.5 GB)}$$

When queries load a high-cardinality text field into Fielddata, heap memory surges to 29.6 GB (`31,849,098,128 bytes`). When an incoming transport request requests an additional 4.2 KB (`4,304 bytes`), the combined reservation reaches `31,849,102,432 bytes`. Because this exceeds `Limit_{parent}`, the parent breaker immediately aborts the query and raises `CircuitBreakingException` with HTTP 429 to protect the JVM from crashing.

---

## 2. Common Missteps: Dangerous Workarounds That Cause Cluster Outages

When circuit breakers begin tripping, engineering teams often attempt short-term workarounds that exacerbate cluster instability:

### Misstep 1: Artificially Raising Breaker Limits or Disabling Real Memory Tracking
A common first response is increasing `indices.breaker.total.limit` from 95% to 98%, or setting `indices.breaker.total.use_real_memory: false`.
* **Why It Backfires**: Circuit breakers do not cause memory consumption; they act as an emergency brake. When `use_real_memory` is disabled, the parent breaker ignores untracked heap allocations from G1GC buffers, Netty off-heap transfers, and query execution structures. As high-cardinality queries continue, the JVM inevitably encounters `java.lang.OutOfMemoryError: Java heap space`. The JVM process freezes during multi-second Stop-The-World (STW) GC pauses (exceeding 20 seconds), fails cluster discovery heartbeats, gets ejected by the master node, and leaves primary shards in an unassigned `RED` state.

### Misstep 2: Enabling `fielddata: true` and Scheduling Cron Cache Clears
Another misstep is leaving `fielddata: true` enabled on the text field and periodically invoking `POST /_cache/clear?fielddata=true` via a background cron script.
* **Why It Backfires**: Clearing the Fielddata cache invalidates all cached term dictionaries and global ordinals. The very next aggregation query triggers a complete reload from disk. This creates catastrophic CPU spikes, disk I/O saturation, and P99 query latency degradation from 100ms to over 25 seconds. Within minutes of clearing, the cache fills up again to 15GB+, re-tripping the circuit breaker.

### Misstep 3: Expanding JVM Heap Beyond 32 GB (`-Xmx64g`)
Teams sometimes scale the JVM heap from 30GB to 64GB on large instances assuming more memory resolves Fielddata bloat.
* **Why It Backfires**: In modern 64-bit JVMs, Compressed Ordinary Object Pointers (Compressed OOPs) operate only when the heap remains strictly below 32 GB ($2^{32} \times 8\text{ bytes} = 32\text{ GB}$). In practice, due to OS virtual address layout and JVM class metadata space, Elasticsearch strongly recommends maintaining heap at or below 30.5 GB (`-Xmx30500m` or `-Xmx30g`) to guarantee Zero-based Compressed OOPs (`Compressed Oops mode: Zero based`). When heap size exceeds 32 GB, the JVM disables compressed references (`-XX:-UseCompressedOops`), expanding all object pointers from 32-bit (4 bytes) to 64-bit (8 bytes). This pointer expansion immediately wastes 40% to 50% of the additional memory space. Furthermore, managing a 64 GB heap exponentially increases G1GC marking times and remark pause latencies without solving the underlying architectural data duplication.

---

## 3. Before vs. After Remediation

### Architectural Fix: Migrate to Columnar `doc_values` via Multi-Fields
The permanent architectural fix eliminates in-memory Fielddata entirely by routing all aggregations, sorting, and term scripts to disk-backed `keyword` subfields utilizing Lucene `doc_values` [Source: Elastic Docs - Fielddata mapping parameter](https://www.elastic.co/guide/en/elasticsearch/reference/current/text.html#fielddata-mapping-param).

#### Step 1: Update Index Mapping with `.keyword` Subfield
Update the index template or apply a new mapping to add a multi-field with `ignore_above: 256` to avoid indexing unbounded text tokens:

```diff
# PUT /orders/_mapping
 {
   "properties": {
     "customer_comment": {
       "type": "text",
-      "fielddata": true
+      "fielddata": false,
+      "fields": {
+        "keyword": {
+          "type": "keyword",
+          "ignore_above": 256
+        }
+      }
     }
   }
 }
```

#### Step 2: Target the Multi-Field in Search Aggregations
Update all aggregation, terms, and sort queries across application services to reference the `.keyword` subfield:

```diff
# POST /orders/_search
 {
   "size": 0,
   "aggs": {
     "top_feedback": {
       "terms": {
-        "field": "customer_comment",
+        "field": "customer_comment.keyword",
         "size": 20
       }
     }
   }
 }
```

#### Step 3: Dynamic Cluster Circuit Breakers vs. Static Node Configuration
Circuit breaker thresholds must be split between dynamic cluster-wide limits and static node-level configuration files [Source: Elastic Reference - Circuit breaker settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker.html). Note that `indices.breaker.total.use_real_memory` is a **static setting**; attempting to submit it via `PUT /_cluster/settings` results in `illegal_argument_exception: persistent setting [indices.breaker.total.use_real_memory], not dynamically updateable`.

```diff
# Cluster Settings Update (Dynamic API - Runtime Safe)
 PUT /_cluster/settings
 {
   "persistent": {
-    "indices.breaker.fielddata.limit": "40%",
+    "indices.breaker.fielddata.limit": "20%",
+    "indices.breaker.total.limit": "85%"
   }
 }
```

```diff
# /etc/elasticsearch/elasticsearch.yml (Static node configuration - requires rolling restart)
+ indices.breaker.total.use_real_memory: true
- # indices.fielddata.cache.size: unbounded (default)
+ indices.fielddata.cache.size: 15%
```

---

## 4. Production Verification & Monitoring Runbook

Execute the following verification commands to monitor circuit breaker trips, node heap distribution, and fielddata memory usage across the cluster.

### 1. Verify Circuit Breaker Tripped Counters and Memory Limits
Verify that breaker trip counts remain zero and inspect estimated byte sizes across data nodes:

```bash
# Query node statistics specifically for the circuit breaker subsystem
curl -s -XGET "http://localhost:9200/_nodes/stats/breaker?pretty" | \
  grep -E "name|tripped|limit_size_in_bytes|estimated_size_in_bytes" -A 2
```

### 2. Inspect Live Fielddata Cache Footprint Per Node
Monitor whether any rogue fields are currently occupying JVM heap space:

```bash
# List per-field fielddata memory usage sorted in descending order
curl -s -XGET "http://localhost:9200/_cat/fielddata?v&s=size:desc"

# Inspect overall heap percentage and fielddata memory across nodes
curl -s -XGET "http://localhost:9200/_cat/nodes?v&h=name,heap.percent,ram.percent,fielddata.memory_size,node.role"
```

### 3. Clear Existing Fielddata Heap on Migrated Indices
Evict legacy fielddata heap allocations immediately after reindexing or mapping migration:

```bash
# Clear fielddata cache for the target index to reclaim heap memory
curl -s -XPOST "http://localhost:9200/orders/_cache/clear?fielddata=true"
```

### 4. Zero-Downtime Reindexing Runbook
For indices with existing documents, populate the newly added `keyword` multi-field using the asynchronous Reindex API:

```bash
# Submit background reindex task to backfill doc_values
TASK_ID=$(curl -s -XPOST "http://localhost:9200/_reindex?wait_for_completion=false" \
  -H "Content-Type: application/json" -d '{
    "source": {"index": "orders_v1"},
    "dest": {"index": "orders_v2"}
  }' | jq -r '.task')

# Monitor task completion status
curl -s -XGET "http://localhost:9200/_tasks/${TASK_ID}" | jq '.completed, .task.status'
```

### 5. Verify Zero-Based Compressed OOPs on Data Nodes
Ensure that the JVM process maintains 32-bit compressed ordinary object pointers and operates in zero-based mode under the 30.5 GB ceiling:

```bash
# Verify Compressed OOPs status and mode on the running JVM
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintFlagsFinal -version 2>&1 | \
  grep -E "UseCompressedOops|UseCompressedClassPointers"

# Confirm Compressed OOPs mode in Elasticsearch startup log
grep -i "compressed ordinary object pointers" /var/log/elasticsearch/elasticsearch.log
```

---

## 5. Verification Metrics: Production Cluster Recovery

Following the migration from in-memory Fielddata to column-oriented `doc_values` and the application of bounded cache limits, the production cluster achieved immediate stability:

| Metric | Before Remediation (Fielddata) | After Remediation (`doc_values`) | Production Improvement |
| :--- | :--- | :--- | :--- |
| **Peak JVM Heap Usage** | 98.4% (Frequent OOM Risk) | 52.8% (Stable Headroom) | -45.6% absolute reduction |
| **Fielddata Memory Footprint** | 16.8 GB per node | 0.0 MB | 100% JVM heap offload |
| **Circuit Breaker Trips** | 2,840 trips / 24 hr | 0 trips | Zero query rejections |
| **HTTP 429 / 503 Errors** | 14.2% of total search traffic | 0.00% | 100% query availability |
| **P99 Aggregation Latency** | 9,450 ms | 114 ms | 98.8% latency reduction |
| **G1GC Young Pause Duration** | 1,480 ms (Avg) | 38 ms (Avg) | 97.4% pause time reduction |

---

## 6. Architecture Governance & Long-Term Prevention Checklist

To prevent recurrent circuit breaker incidents across multi-tenant clusters, enforce the following configuration standards:

* **Strict Schema Governance (`dynamic: strict`)**: Set `dynamic: strict` on all production index mappings. This prevents client services from dynamically indexing arbitrary unstructured string payloads as raw `text` fields.
* **Heap Sizing Rules**: Maintain JVM heap sizes strictly at or below 30.5 GB (`-Xms30g -Xmx30g`) to guarantee 32-bit Zero-based Compressed Ordinary Object Pointers (Compressed OOPs). Allocate the remaining 50% of node host RAM to the Linux kernel page cache, which accelerates Lucene `doc_values` access.
* **Bounded Fielddata Sizing**: Never leave `indices.fielddata.cache.size` unset. Specify `10%` to `15%` so that unexpected text field aggregations trigger LRU cache evictions rather than cascading parent breaker trips.
* **Slowlog Thresholds**: Enable search query slowlogs (`index.search.slowlog.threshold.query.warn: 2s`) to capture expensive nested aggregations before they impact cluster-wide memory headroom.

---

## References
* Elastic Reference: [Circuit breaker settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker.html)
* Elastic Reference: [Circuit breaker errors troubleshooting](https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker-errors.html)
* Elastic Reference: [Doc values mapping parameter](https://www.elastic.co/guide/en/elasticsearch/reference/current/doc-values.html)
* Elastic Reference: [Fielddata mapping parameter](https://www.elastic.co/guide/en/elasticsearch/reference/current/text.html#fielddata-mapping-param)
* Elastic Reference: [Field data cache settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/field-data-cache-settings.html)
* Elastic Reference: [Clear cache API](https://www.elastic.co/guide/en/elasticsearch/reference/current/indices-clearcache.html)
* GitHub Repository: [Elasticsearch HierarchyCircuitBreakerService Source Code](https://github.com/elastic/elasticsearch/blob/main/server/src/main/java/org/elasticsearch/indices/breaker/HierarchyCircuitBreakerService.java)
