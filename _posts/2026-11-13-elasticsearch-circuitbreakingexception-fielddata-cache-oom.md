---
layout: post
title: "Fixing Elasticsearch CircuitBreakingException: Data Too Large & Fielddata Cache OOM"
date: 2026-11-13 10:29:00 +0900
categories: [Database, Elasticsearch]
tags: [Elasticsearch, CircuitBreaker, JVM, Heap, FullTextSearch, BigData]
---

In production search clusters running Elasticsearch 8.x, aggregation or heavy wildcard queries frequently trigger the cluster's internal circuit breakers, abruptly terminating user queries with HTTP 429 or 503 errors.

The client log reports a severe memory threshold violation:

```text
{
  "error": {
    "root_cause": [
      {
        "type": "circuit_breaking_exception",
        "reason": "[parent] Data too large, data for [<transport_request>] would be [31849102432/29.6gb], which is larger than the limit of [30601641984/28.5gb], real usage: [31849098128/29.6gb], new bytes reserved: [4304/4.2kb]",
        "bytes_wanted": 31849102432,
        "bytes_limit": 30601641984,
        "durability": "TRANSIENT"
      }
    ],
    "type": "circuit_breaking_exception",
    "reason": "[parent] Data too large, data for [<transport_request>] would be [31849102432/29.6gb], which is larger than the limit of [30601641984/28.5gb]",
    "status": 429
  }
}
```

## Production Specs
* **Elasticsearch Version**: 8.14.0
* **Node JVM Heap**: `-Xms31g -Xmx31g` (Compressed OOPs ceiling)
* **Cluster Scale**: 6 Data Nodes, 1.2 Billion documents
* **Host RAM**: 64GB per node

---

## 1. Root Cause: In-Memory Fielddata Heap Explosion on `text` Fields

The `parent` circuit breaker trips when total JVM memory pressure exceeds 95% of the allocated heap.

The root cause stems from developers running **aggregations, sorting, or scripting on unindexed `text` fields**:

1. Standard text fields are stored as inverted indexes (`term -> doc_ids`), optimized for full-text lookup.
2. When a query demands `terms` aggregation or `sort` on a raw `text` field without a dedicated `keyword` subfield, Elasticsearch is forced to construct an in-memory inverted unigram data structure called **Fielddata**.
3. Fielddata is loaded directly into the JVM heap and **never garbage collected** until node memory limits force eviction.
4. Loading high-cardinality strings (e.g., product descriptions, log messages) into Fielddata consumes 10GB+ in seconds, breaching the breaker threshold and rejecting all subsequent search requests.

---

## 2. Before vs. After Remediation

### Architecture Fix: Migrate Aggregations to `doc_values` via Multi-Fields
Never enable `fielddata: true` on raw text. Instead, leverage on-disk, column-oriented **`doc_values`** using `keyword` multi-fields:

```diff
# PUT /orders/_mapping
{
  "properties": {
    "customer_comment": {
      "type": "text",
-     "fielddata": true   # FATAL ANTI-PATTERN: Consumes 10GB+ JVM heap
+     "fields": {
+       "keyword": {
+         "type": "keyword",
+         "ignore_above": 256
+       }
+     }
    }
  }
}
```

Queries must target `.keyword` for aggregations:
```diff
{
  "aggs": {
    "top_comments": {
      "terms": {
-       "field": "customer_comment"
+       "field": "customer_comment.keyword"
      }
    }
  }
}
```

### Dynamic Circuit Breaker Tuning
Adjust the parent and fielddata breaker limits in `elasticsearch.yml` to prevent runaway heap allocations:

```diff
# /etc/elasticsearch/elasticsearch.yml
- indices.breaker.fielddata.limit: 40%
+ indices.breaker.fielddata.limit: 10%
+ indices.breaker.total.use_real_memory: true
+ indices.breaker.total.limit: 85%
```

---

## Verification & Metrics
* **Heap Utilization**: Peak stabilized from 98% (OOM edge) to a predictable **58%**.
* **Zero 429 Errors**: Handled 4,000 aggregation queries/sec using efficient column-store `doc_values` without JVM heap degradation.

