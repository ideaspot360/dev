---
layout: post
title: "Optimizing Triton Inference Server Dynamic Batching & P99 Queue Delay Under Burst Traffic"
date: 2026-11-29 11:32:00 +0900
category: "AI & Machine Learning"
tags: ['Triton', 'Inference', 'ModelServing', 'Performance', 'HighThroughput', 'Latency']
---

## Production Incident Summary

An online payment fraud detection service utilizing NVIDIA Triton Inference Server experienced catastrophic P99 latency spikes during a flash sale:

```text
[METRIC] Triton Model Inference Metrics:
Model: fraud_detection_ensemble
Request Rate: 4,800 req/sec
Average Queue Time: 420.5ms (Baseline: 2.1ms)
Compute Infer Time: 8.4ms
Client End-to-End P99 Latency: 485.0ms (SLA Threshold: 50.0ms)
Drop Rate: 14.2% (HTTP 408 / DeadlineExceeded)
```

---

## 1. Root Cause: Over-Aggressive Dynamic Batching max_queue_delay

Triton's Dynamic Batcher combines individual requests across client connections into a single batch to maximize GPU tensor core utilization.

In the model's `config.pbtxt`, `max_queue_delay_microseconds` was set to `50000` (50ms) to pursue maximum batch consolidation (`max_batch_size: 128`).

When burst traffic arrived with uneven spacing, early requests waited the full 50ms timeout window. Because downstream callers had a strict 50ms SLA, requests timed out while sitting in Triton's queue, forcing the GPU to waste compute processing canceled transactions.

---

## 2. Production Fix: Queue Timeout Tuning & Delayed Request Cancellation

```protobuf
name: "fraud_detection_ensemble"
platform: "ensemble"
max_batch_size: 64

dynamic_batching {
  max_queue_delay_microseconds: 4000
  preferred_batch_size: [ 8, 16, 32, 64 ]
  default_priority_level: 2
  priority_levels: 3
  priority_queue_policy {
    key: 2
    value: {
      max_queue_delay_microseconds: 4000
      timeout_action: REJECT
    }
  }
}

instance_group [
  {
    count: 2
    kind: KIND_GPU
    gpus: [ 0 ]
  }
]
```

### Result:
* Queue Time dropped from `420.5ms` to **`3.8ms`**.
* P99 Latency stabilized at **`16.2ms`**.
* Throughput scaled seamlessly from 4,800 to over **11,500 req/sec**.
