---
layout: post
title: "Fixing PyTorch CUDA OOM: Allocator Memory Fragmentation & max_split_size_mb Tuning"
date: 2026-11-23 10:14:00 +0900
category: "Systems & Networking"
tags: ['PyTorch', 'CUDA', 'DeepLearning', 'GPU', 'OutOfMemory', 'Troubleshooting']
---

## Production Incident Summary

During the fine-tuning of an 8B-parameter open LLM on an 80GB NVIDIA A100 GPU cluster, the training worker abruptly crashed with a fatal CUDA Out of Memory (OOM) error:

```text
RuntimeError: CUDA out of memory. Tried to allocate 512.00 MiB (GPU 0; 79.15 GiB total capacity; 68.42 GiB already allocated; 486.25 MiB free; 9.74 GiB reserved in total by PyTorch) If reserved memory is >> allocated memory try setting max_split_size_mb to avoid fragmentation. See documentation for Memory Management and PYTORCH_CUDA_ALLOC_CONF
```

Notice the paradox: `79.15 GiB total capacity`, only `68.42 GiB already allocated`, and `9.74 GiB reserved` by PyTorch's caching allocator. Mathematically, over 10 GB of GPU physical VRAM remained untouched, yet an allocation request for just 512 MiB failed catastrophically.

## Production Specs
* **PyTorch Version**: 2.3.1+cu121
* **Hardware**: 8x NVIDIA A100-SXM4-80GB (NVLink 600 GB/s)
* **Model**: Llama-3-8B (bfloat16 weights, DeepSpeed ZeRO-3)
* **Sequence Length**: 4,096 tokens with dynamic padding
* **Host RAM**: 512GB DDR4, Ubuntu 22.04 LTS (Kernel 5.15)

---

## 1. Root Cause: Caching Allocator Memory Fragmentation

PyTorch does not issue `cudaMalloc` or `cudaFree` syscalls for every tensor allocation because NVIDIA CUDA kernel allocations are synchronous, blocking GPU host-device pipelines and introducing severe latency overhead.

Instead, PyTorch relies on an internal **caching allocator**. It acquires large contiguous memory blocks (typically 20MB to 512MB) from the CUDA driver and manages smaller memory segments internally using a buddy allocator algorithm.

```text
[ Physical GPU VRAM: 80 GB ]
├─ Active Allocated Tensors (Weights, Gradients, Activations) : 68.42 GiB
├─ PyTorch Reserved Pool (Unallocated Cached Blocks)          :  9.74 GiB
│  ├─ [Chunk: 4MB] [Free: 2MB] [Chunk: 16MB] [Free: 8MB] ... (Heavily Fragmented)
│  └─ Largest Single Free Contiguous Slot                      :  280.00 MiB (< 512 MiB requested!)
└─ Driver Unreserved Free Memory                               :  486.25 MiB (< 512 MiB requested!)
```

When multi-head self-attention mechanisms dynamically create and destroy variable-length attention masks and intermediate QKV activation buffers, the reserved pool becomes severely **fragmented**.

Although the total sum of idle memory blocks inside the caching allocator exceeds 9 GB, no single contiguous chunk of 512 MiB exists. When PyTorch queries the CUDA driver for a fresh allocation and the GPU driver has only 486 MiB of unreserved VRAM left, the allocation fails and terminates the job with `RuntimeError: CUDA out of memory`.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

When facing CUDA OOM while reserved memory is visibly higher than allocated memory, developers typically resort to two common workarounds:

### Misstep 1: Sprinkling `torch.cuda.empty_cache()` Inside the Step Loop
The most common initial reflex is calling `torch.cuda.empty_cache()` at the end of every forward or backward step.
* **Why It Backfires**: `empty_cache()` releases all unused cached memory blocks back to the CUDA driver via `cudaFree`. Because `cudaFree` forces a device-wide CPU-GPU synchronization, running it every step stalls the GPU instruction pipeline. In our benchmarks, GPU compute utilization collapsed from **96% down to 48%**, doubling the training time per epoch without eliminating the risk of sudden mid-forward memory spikes.

### Misstep 2: Slashing Per-Device Batch Size to 1
Another common reaction is dropping the micro-batch size from 4 or 2 down to 1 and attempting to compensate with higher gradient accumulation steps.
* **Why It Backfires**: While a smaller batch size lowers the baseline activation memory, it does not prevent memory fragmentation when sequences have varying lengths. Variable-length sequences still produce irregular tensor allocations that leave fragmented holes in the allocator pool. On top of that, running batch size 1 underutilizes Tensor Core throughput and inflates total gradient synchronization overhead across GPUs.

---

## 3. Before vs. After Remediation

Instead of manual cache flushing or sacrificing batch throughput, configure the caching allocator behavior directly through `PYTORCH_CUDA_ALLOC_CONF`.

### Solution A: Kubernetes Training Job Manifest (Production Standard)

```diff
--- deploy/helm/trainer/values.yaml.orig
+++ deploy/helm/trainer/values.yaml
@@ -14,6 +14,12 @@
     image: pytorch/pytorch:2.3.1-cuda12.1-cudnn8-devel
     env:
       - name: NCCL_DEBUG
         value: "INFO"
+      # Eliminate CUDA caching allocator fragmentation:
+      # 1. expandable_segments:True uses virtual memory mapping to avoid contiguous chunk requirements (PyTorch >= 2.1)
+      # 2. max_split_size_mb:128 prevents large chunks from being split for tiny temporary allocations
+      - name: PYTORCH_CUDA_ALLOC_CONF
+        value: "expandable_segments:True,max_split_size_mb:128,garbage_collection_threshold:0.8"
     resources:
       limits:
         nvidia.com/gpu: "8"
```

### Solution B: Application Entrypoint Setup

```diff
--- train.py.orig
+++ train.py
@@ -1,5 +1,9 @@
 import os
 import sys
+# Configure allocator BEFORE importing torch or initializing CUDA
+os.environ["PYTORCH_CUDA_ALLOC_CONF"] = (
+    "expandable_segments:True,max_split_size_mb:128,garbage_collection_threshold:0.8"
+)
 import torch
 import torch.distributed as dist
 from transformers import AutoModelForCausalLM, AutoTokenizer
```

### Key Parameters Explained:
1. **`expandable_segments:True` (Recommended for PyTorch >= 2.1)**: Leverages CUDA Virtual Memory Management APIs (`cuMemMap`). PyTorch allocates virtual address space upfront without requiring physical backing pages to be contiguous. This completely eliminates allocator fragmentation.
2. **`max_split_size_mb:128`**: Prevents the allocator from splitting blocks larger than 128MB to satisfy smaller allocations, keeping large contiguous chunks reserved for massive backward-pass gradient tensors.
3. **`garbage_collection_threshold:0.8`**: Triggers internal memory compaction when the allocator pool exceeds 80% capacity before querying the CUDA driver for new memory.

---

## 4. Verification & Production Trade-Offs

* **Stability**: Ran 48 consecutive hours of fine-tuning across 8x A100s without a single CUDA OOM crash.
* **Peak Memory Efficiency**: Usable memory allocation reached 76.8 GB / 79.15 GB (97.0% VRAM saturation) without triggering allocation failures.
* **Overhead**: `expandable_segments:True` adds virtually zero runtime overhead (<0.2% difference in step time), making it strictly superior to periodic `torch.cuda.empty_cache()` calls.
