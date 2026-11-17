---
layout: post
title: "Resolving RAG Vector Search Latency Spikes: Milvus HNSW Index Parameter & M/efConstruction Tuning"
date: 2026-11-25 10:38:00 +0900
category: "AI & Machine Learning"
tags: ['RAG', 'Milvus', 'VectorSearch', 'HNSW', 'Embeddings', 'Performance']
---

## Production Incident Summary

During peak usage of an enterprise Retrieval-Augmented Generation (RAG) system, vector search queries against a Milvus cluster suddenly experienced severe latency spikes. Distributed tracing revealed that vector similarity search was consuming the vast majority of the request lifecycle:

```text
[TRACE] Service: rag-orchestrator-prod
Span: milvus_vector_query (Collection: enterprise_docs_v3)
Duration: 5,420.35ms (Baseline P99: 45.10ms)
Status: OK (10 items returned)
Metrics:
  - vectors_scanned: 1,480,210
  - hnsw_hops: 12,480
  - disk_read_iops: 18,500 (IOPS Saturation: 99.8%)
```

End-to-end user query latency degraded from 1.2 seconds to over 6.8 seconds, triggering upstream HTTP 504 timeouts on API gateways.

## Production Specs
* **Vector Database**: Milvus 2.4.4 Distributed on Kubernetes
* **Index Algorithm**: HNSW (Hierarchical Navigable Small World)
* **Embedding Model**: 1536-dimensional vectors (OpenAI text-embedding-3-large)
* **Collection Size**: 10,000,000 vectors (~60GB raw embeddings + graph indices)
* **Query Nodes**: 4x QueryNode replicas (each 8 vCPU, 32GB RAM, AWS EBS gp3 storage)
* **Query Throughput**: ~800 vector searches/sec

---

## 1. Root Cause: HNSW Memory Bloat and OS Page Cache Thrashing

HNSW indexes build a multi-layer geometric graph where nodes represent vectors and edges represent proximity links. The search traverses top layers greedily before entering Layer 0 for fine-grained nearest-neighbor collection.

Two misconfigured parameters compounded to cripple performance as the dataset grew to 10 million vectors:

1. **Oversized `M=64` Edge Count**: `M` defines the maximum number of bidirectional connection links per vector in Layer 0. Setting `M=64` produces 64 pointer references per vector. For 10 million 1536-dim vectors, the graph structure alone consumed over 38 GB of memory, exceeding the 32 GB RAM allocation of each QueryNode.
2. **Unbounded Query-Time `ef: 512`**: The search client passed `ef=512` dynamically on every query. The parameter `ef` controls the candidate search pool size. A large `ef` combined with high `M` forced thousands of random memory lookups across distant nodes in the graph.

Because the combined size of the index and vector vectors exceeded physical container RAM, the Linux kernel continually evicted and reread index pages from disk. Random 4KB read IOPS spiked to 18,500, pinning the underlying storage at 99.8% utilization and converting microsecond in-memory graph traversals into multi-second disk I/O bottlenecks.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

When vector queries slow down under scale, engineering teams often fall into two classic traps:

### Misstep 1: Horizontally Scaling Milvus QueryNodes
The instinctive platform response is adding more QueryNode replicas or scaling up instance sizes.
* **Why It Fails**: In Milvus, collection segments must be loaded into memory on the query nodes assigned to those shards. If the index graph for a segment is fundamentally too large for available RAM, scaling from 4 to 8 query nodes merely replicates the memory deficit across more pods without fixing the disk thrashing. The nodes continue to choke on random EBS read IOPS during graph traversal.

### Misstep 2: Slashing Query `ef` to Single Digits (`ef: 8` or `12`)
Another quick attempt is reducing query-time `ef` aggressively to minimize graph traversal depth.
* **Why It Backfires**: While search latency drops to sub-10ms, Recall@10 plummets by 15–22%. In a RAG pipeline, low recall means the vector database returns irrelevant text chunks to the LLM. The downstream model hallucinates or fails to answer customer questions accurately, degrading application quality to solve an infrastructure issue.

---

## 3. Before vs. After Remediation

Tuning HNSW requires balancing graph density (`M`) and build quality (`efConstruction`) against query-time exploration depth (`ef`), ensuring the entire graph fits comfortably inside container memory.

```diff
--- rag/indexing/create_collection.py.orig
+++ rag/indexing/create_collection.py
@@ -10,15 +10,16 @@
 collection = Collection("enterprise_docs_v3")
 
 # Drop bloated index to rebuild with balanced memory geometry
 collection.drop_index()
 
 index_params = {
     "metric_type": "COSINE",
     "index_type": "HNSW",
     "params": {
-        # Bloated graph: 64 edges per node exceeded container RAM (38GB index)
-        "M": 64,
-        "efConstruction": 512
+        # Reduced M to 16: cuts graph index memory footprint by ~62% (fits fully in RAM)
+        "M": 16,
+        # High efConstruction preserves top-layer graph connectivity and recall
+        "efConstruction": 200
     }
 }
 
 collection.create_index(field_name="vector", index_params=index_params)
 collection.load()
```

```diff
--- rag/retriever/search_service.py.orig
+++ rag/retriever/search_service.py
@@ -14,7 +14,8 @@
 def query_similar_chunks(collection, query_embedding, top_k=10):
     # Align query-time exploration with graph density
     search_params = {
         "metric_type": "COSINE",
         "params": {
-            "ef": 512   # Caused exponential candidate evaluation and disk thrashing
+            # ef=64 delivers optimal trade-off: 98.3% recall with sub-30ms latency
+            "ef": 64
         }
     }
     return collection.search(
```

---

## 4. Verification & Engineering Trade-Offs

* **Query Latency**: P99 search duration dropped from **5,420ms down to 24.8ms** (a 99.5% reduction).
* **Storage I/O**: Disk read IOPS dropped from 18,500 to **0.0**, as the entire working index now resides pinned inside RAM.
* **Recall Trade-Off**: Recall@10 dropped by an imperceptible **0.4%** (from 98.7% to 98.3%), while query throughput scaled seamlessly from 800 to over 3,200 requests/sec across the cluster.
