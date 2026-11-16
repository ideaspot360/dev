---
layout: post
title: "Troubleshooting vLLM PagedAttention KV Cache Exhaustion & GPU OOM Under High Concurrency"
date: 2026-11-24 11:27:00 +0900
category: "AI & Machine Learning"
tags: ['vLLM', 'LLM', 'PagedAttention', 'KVCache', 'Inference', 'Production']
---

## Production Incident Summary

During a traffic spike on a production inference cluster serving Llama-3-70B-Instruct via vLLM across 4x NVIDIA H100 (80GB) GPUs with Tensor Parallelism (TP=4), requests suddenly stalled and the vLLM engine aborted with an unhandled exception:

```text
[ERROR] vllm.engine.async_llm_engine: Engine execution failed:
torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.40 GiB (GPU 2; 79.15 GiB total capacity; 75.12 GiB already allocated; 1.88 GiB free)
[WARNING] KVCacheManager: Free block table exhausted! Aborting 14 preempted requests to reclaim memory.
[CRITICAL] Engine health check failed. Worker process died with return code -9 (SIGKILL).
```

HTTP clients observed 504 Gateway Timeouts, and latency percentiles (P99) spiked from 42ms to over 28,000ms before Kubernetes terminated the Pod due to liveness probe failure.

---

## 1. Root Cause: PagedAttention KV Cache Over-Allocation

In autoregressive token generation, the Key-Value (KV) cache grows linearly with context length and batch size. For Llama-3-70B using Grouped Query Attention (GQA), the KV cache size per token across all layers is approximately 320 KB per token.

For 256 concurrent requests with an average context length of 4,096 tokens, the KV cache alone demands ~335.5 GB across the cluster.

vLLM allocates KV cache blocks based on `--gpu-memory-utilization` (default 0.90). When model weights, CUDA graphs, and activation memory exceed the remaining 10% safety margin during large-batch Prefill stages, physical VRAM is exhausted, triggering an uncatchable CUDA OOM.

---

## 2. Production Fix: Memory Fractioning & Preemption Tuning

```bash
# Production optimized vLLM command line
python3 -m vllm.entrypoints.openai.api_server \
    --model meta-llama/Meta-Llama-3-70B-Instruct \
    --tensor-parallel-size 4 \
    --gpu-memory-utilization 0.85 \
    --max-model-len 8192 \
    --max-num-seqs 128 \
    --max-num-batched-tokens 4096 \
    --swap-space 16 \
    --enforce-eager
```

1. `--gpu-memory-utilization 0.85`: Caps KV cache allocation to 85% of total VRAM, leaving 12GB per GPU for dynamic activation spikes during concurrent prefill steps.
2. `--swap-space 16`: Allocates 16GB of CPU RAM per GPU as a swap overflow partition. When KV blocks are exhausted, vLLM swaps inactive sequences to host memory rather than crashing the worker.
3. `--max-num-seqs 128`: Hard limit on concurrent active requests to prevent scheduler queue overcommitment.
