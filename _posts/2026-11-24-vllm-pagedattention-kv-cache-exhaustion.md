---
layout: post
title: "Troubleshooting vLLM PagedAttention KV Cache Exhaustion & GPU OOM Under High Concurrency"
date: 2026-11-24 11:27:00 +0900
category: "AI & Machine Learning"
tags: ['vLLM', 'LLM', 'PagedAttention', 'KVCache', 'Inference', 'Production']
---

## Production Incident Summary

During burst traffic on an inference cluster serving `meta-llama/Meta-Llama-3-70B-Instruct` via vLLM across 4x NVIDIA H100 (80GB) GPUs with Tensor Parallelism (TP=4), requests suddenly stalled and the vLLM engine process terminated with an unhandled exception:

```text
[ERROR] vllm.engine.async_llm_engine: Engine execution failed:
torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.40 GiB (GPU 2; 79.15 GiB total capacity; 75.12 GiB already allocated; 1.88 GiB free; 76.20 GiB reserved in total by PyTorch)
[WARNING] KVCacheManager: Free block table exhausted! Aborting 14 preempted requests to reclaim memory.
[CRITICAL] Engine health check failed. Worker process died with return code -9 (SIGKILL).
```

HTTP clients observed immediate `504 Gateway Timeout` spikes, and P99 latency degraded from 42ms to over 28,000ms before Kubernetes terminated the pod due to liveness probe failure.

## Production Specs
* **Inference Engine**: vLLM 0.5.4
* **Model**: `meta-llama/Meta-Llama-3-70B-Instruct` (FP16 weights ~140 GB across 4 GPUs, 35 GB/GPU)
* **Hardware**: 4x NVIDIA H100 SXM5 (80GB VRAM, NVLink 900 GB/s, TP=4)
* **Host Platform**: EKS on AWS, 512GB Host System RAM, PyTorch 2.3.0+cu121
* **Concurrency**: ~350 active concurrent streaming sessions

---

## 1. Root Cause: KV-Cache Greed vs. Dynamic Activation Headroom

In autoregressive token generation, the Key-Value (KV) cache grows linearly with context length and concurrent batch size. In Llama-3-70B (Grouped-Query Attention with 8 KV heads, hidden dimension 8192, 80 layers), the memory required to store KV cache per token is:

$$\text{Memory}_{\text{token}} = 2 \times 2 \times 80 \times 8 \times 128 \times 2\text{ bytes} \approx 655\text{ KB/token}$$

Across all 4 GPUs, a single sequence of 4,096 tokens consumes roughly 2.68 GB of pure KV cache.

By default, vLLM sizes its PagedAttention KV cache pool using `--gpu-memory-utilization` (default 0.90). When configured with `0.90` or pushed higher to `0.95`, vLLM allocates 90–95% of available VRAM strictly to static KV blocks and model weights.

On an 80GB GPU holding 35GB of model weights, setting `--gpu-memory-utilization 0.95` leaves only about **3.96 GB of unreserved VRAM per GPU**. 

When a concurrent surge of requests arrives requiring long-prompt Prefill steps, PyTorch's intermediate matrix multiplication activations temporarily surge past 4 GB. The CUDA Caching Allocator fails to claim contiguous unreserved VRAM, raising an uncatchable CUDA OOM that causes the Ray/vLLM worker to be killed with SIGKILL (Exit Code 137).

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

When vLLM workers crash under concurrency, teams frequently reach for intuitive settings that exacerbate the outage:

### Misstep 1: Bumping `--gpu-memory-utilization` to 0.95 or Higher
The most instinctive reaction to KV cache exhaustion or request preemption warnings is pushing `--gpu-memory-utilization` up (from default 0.90 to 0.95 or 0.98), hoping to give vLLM more block capacity.
* **Why It Fails**: While this creates more PagedAttention KV blocks, it shrinks the remaining VRAM buffer required for dynamic PyTorch activation tensors during the prefill phase. The moment a batch of long prompts arrives, the activation memory exceeds the tiny margin and triggers an immediate, uncatchable CUDA OOM.

### Misstep 2: Naively Slashing `--max-model-len`
Another common reaction is drastically cutting `--max-model-len` (e.g. from 8192 down to 2048) in Helm values.
* **Why It Backfires**: While this caps the maximum KV memory any single request can consume, it immediately breaks applications with multi-turn dialogues, system prompts, or RAG contexts exceeding 2,048 tokens. Client applications receive hard `400 Bad Request: prompt is too long` errors, shifting an infrastructure capacity issue into an application-level outage.

---

## 3. Before vs. After Remediation

The sustainable solution balances VRAM reservation between static KV cache and dynamic prefill activation buffers, while configuring host CPU memory swapping as an overflow safety net.

```diff
--- deploy/helm/vllm-llama3-70b/values.yaml.orig
+++ deploy/helm/vllm-llama3-70b/values.yaml
@@ -16,11 +16,18 @@
   args:
     - "--model=meta-llama/Meta-Llama-3-70B-Instruct"
     - "--tensor-parallel-size=4"
-    - "--gpu-memory-utilization=0.95"
-    - "--max-model-len=8192"
-    - "--max-num-seqs=256"
+    # Reserve 15% (12GB per GPU) VRAM margin for PyTorch dynamic activations during large-batch Prefill
+    - "--gpu-memory-utilization=0.85"
+    - "--max-model-len=8192"
+    # Cap concurrent decoding iterations to prevent KV block starvation
+    - "--max-num-seqs=128"
+    - "--max-num-batched-tokens=4096"
+    # Enable CPU host RAM swapping over PCIe Gen5 to gracefully preempt instead of SIGKILL
+    - "--swap-space=16"
+    - "--disable-log-requests"
   resources:
     limits:
       nvidia.com/gpu: "4"
-      memory: "128Gi"
+      # Expand host memory to accommodate 64GB total host swap space (16GB x 4)
+      memory: "256Gi"
```

### Key Remediation Levers:
1. **`--gpu-memory-utilization 0.85`**: Guarantees ~12 GB of free VRAM per GPU strictly for intermediate CUDA kernels and prefill activation spikes, preventing OOM aborts.
2. **`--swap-space 16`**: Allocates 16 GB of host system RAM per GPU. When the KV block table reaches capacity, inactive sequences are swapped to host memory over PCIe rather than crashing the worker.
3. **`--max-num-batched-tokens 4096`**: Limits the number of tokens processed across all requests in a single iteration, bounding prefill activation memory.

---

## 4. Verification & Engineering Trade-Offs

* **Stability**: In a 72-hour stress test with sustained 350-concurrency burst traffic, worker SIGKILL terminations dropped from **14 crashes per day to exactly 0**.
* **The Latency Trade-Off**: When extreme traffic bursts engage host CPU memory swapping, Time-to-First-Token (TTFT) for swapped sequences increases from 28ms to **~140ms** due to PCIe host-to-device data transfer. However, this predictable latency degradation is vastly preferable to hard worker crashes, connection resets, and cascading pod restarts.
