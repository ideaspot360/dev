---
layout: post
title: "Resolving RAG Vector Search Latency Spikes: Milvus HNSW Index Parameter & M/efConstruction Tuning"
date: 2026-11-25 10:38:00 +0900
category: "AI & Machine Learning"
tags: ['RAG', 'Milvus', 'VectorSearch', 'HNSW', 'Embeddings', 'Performance']
---

## Production Incident Summary

During peak usage of an enterprise Retrieval-Augmented Generation (RAG) agent, end-to-end response times degraded from 1.2 seconds to over 6.8 seconds. Distributed tracing pinpointed the exact bottleneck:

```text
[TRACE] Service: rag-orchestrator-prod
Span: milvus_vector_query (Collection: enterprise_docs_v3)
Duration: 5,420.35ms (P99 Baseline: 45.10ms)
Status: OK (10 items returned)
Metrics:
  - vectors_scanned: 1,480,210
  - hnsw_hops: 12,480
  - disk_read_iops: 18,500 (IOPS Saturation 99.8%)
```

---

## 1. Root Cause: Suboptimal HNSW Parameters & Memory-Disk Swapping

The RAG pipeline utilized a Hierarchical Navigable Small World (HNSW) index with 1536-dimensional embeddings. The collection had scaled to 10 million vectors without re-evaluating index configurations.

1. **Unbounded efSearch**: The query client was passing `ef: 512` dynamically on every query. While recall improved by 0.3%, search graph traversals expanded exponentially, forcing candidate distance calculations in Layer 0.
2. **HNSW Index Evicted to Disk**: With `M=64`, each vector node stored 64 bidirectional graph pointers, ballooning graph structure overhead beyond physical container RAM (64GB). OS buffer cache thrashing triggered random 4K read IOPS bottlenecks on NVMe EBS storage.

---

## 2. Production Fix: Balanced Indexing & Query Parameters

```python
from pymilvus import Collection

collection = Collection("enterprise_docs_v3")
collection.drop_index()

index_params = {
    "metric_type": "COSINE",
    "index_type": "HNSW",
    "params": {
        "M": 16,               # Reduced from 64 -> lowers graph memory footprint by 60%
        "efConstruction": 200  # High construction quality for recall preservation
    }
}

collection.create_index(field_name="vector", index_params=index_params)
collection.load()
```

At query time, constrain `ef` to 64:

```python
search_params = {"metric_type": "COSINE", "params": {"ef": 64}}
results = collection.search(data=[query_embedding], anns_field="vector", param=search_params, limit=10)
```

With `M=16` and `ef=64`, the entire graph fitted into RAM cache, disk I/O dropped to 0, and query throughput surged by **14x**.
