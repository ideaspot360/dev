---
layout: post
title: "Fixing PyTorch CUDA OOM: Allocator Memory Fragmentation & max_split_size_mb Tuning"
date: 2026-11-23 10:14:00 +0900
category: "AI & Machine Learning"
tags: ['PyTorch', 'CUDA', 'DeepLearning', 'GPU', 'OutOfMemory', 'Troubleshooting']
---

## Production Incident Summary

During the fine-tuning of an 8B-parameter open LLM on an 80GB NVIDIA A100 GPU cluster, the training worker abruptly crashed with a fatal CUDA Out of Memory (OOM) error:

```text
RuntimeError: CUDA out of memory. Tried to allocate 512.00 MiB (GPU 0; 79.15 GiB total capacity; 68.42 GiB already allocated; 486.25 MiB free; 9.74 GiB reserved in total by PyTorch) If reserved memory is >> allocated memory try setting max_split_size_mb to avoid fragmentation. See documentation for Memory Management and PYTORCH_CUDA_ALLOC_CONF
```

Notice the paradox: `79.15 GiB total capacity`, only `68.42 GiB already allocated`, and `9.74 GiB reserved` by PyTorch's caching allocator. Mathematically, over 10 GB of GPU physical VRAM remained untouched, yet an allocation request for just 512 MiB failed catastrophically.

---

## 1. Root Cause: Caching Allocator Fragmentation

PyTorch does not issue `cudaMalloc` or `cudaFree` syscalls for every tensor allocation because NVIDIA CUDA kernel allocations are synchronous, blocking GPU host-device pipelines and causing massive latency overhead.

Instead, PyTorch relies on a **caching allocator**. It acquires large contiguous memory blocks (typically 20MB to 512MB) from the CUDA driver and manages smaller memory segments internally.

When multi-head self-attention mechanisms dynamically create and destroy variable-length attention masks and intermediate QKV activation buffers, the reserved pool becomes severely **fragmented**.

Although the total sum of idle memory blocks inside the caching allocator exceeds 9 GB, no single contiguous chunk of 512 MiB exists. When PyTorch queries the CUDA driver for a fresh allocation and the GPU driver has only 486 MiB of unreserved VRAM left, the allocation fails and terminates the job.

---

## 2. Production Fix: Environmental Allocator Tuning

### The Ineffective Fix: Calling `torch.cuda.empty_cache()`
Many engineers sprinkle `torch.cuda.empty_cache()` inside the training loop. This forces PyTorch to release all cached blocks back to the CUDA driver via `cudaFree`. Because `cudaFree` triggers device-wide synchronization, iterating this per step collapses GPU compute utilization from 98% down to 52%.

### The Production Fix: Environmental Allocator Tuning
Instead of manual cache flushing, configure PyTorch's internal buddy allocator behavior via `PYTORCH_CUDA_ALLOC_CONF`:

```bash
# Set in entrypoint script or container manifest
export PYTORCH_CUDA_ALLOC_CONF="max_split_size_mb:128,garbage_collection_threshold:0.8"
```

```python
import os
import torch

os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:128,garbage_collection_threshold:0.8"
```

1. **Prevents oversized splits**: Restricts the allocator from splitting large contiguous memory blocks (>128MB) to fulfill tiny intermediate tensor allocations.
2. **Preserves contiguous space**: Keeps large 512MB+ blocks intact for massive backward-pass gradient tensors.
3. **Expandable Segments**: On PyTorch 2.1+, setting `expandable_segments:True` allows virtual memory mapping without physical contiguous allocation constraints, completely resolving fragmentation.
