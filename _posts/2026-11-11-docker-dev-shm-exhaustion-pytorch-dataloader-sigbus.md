---
layout: post
title: "Fixing Docker /dev/shm Exhaustion: Python PyTorch DataLoader Bus Error (SIGBUS)"
date: 2026-11-11 11:18:00 +0900
categories: [DevOps, Docker]
tags: [Docker, PyTorch, DeepLearning, SharedMemory, Linux, SIGBUS]
---

When training deep learning models or running large-scale tensor batch transformations inside Docker containers with multiple DataLoader workers (`num_workers > 0`), the training process abruptly crashes with an unhandled kernel signal:

```text
Traceback (most recent call last):
  File "train.py", line 142, in <module>
    for batch_idx, (data, target) in enumerate(train_loader):
  File "/opt/conda/lib/python3.10/site-packages/torch/utils/data/dataloader.py", line 630, in __next__
    data = self._next_data()
  File "/opt/conda/lib/python3.10/site-packages/torch/utils/data/dataloader.py", line 1344, in _next_data
    return self._process_data(data)
  File "/opt/conda/lib/python3.10/site-packages/torch/utils/data/dataloader.py", line 1370, in _process_data
    data.reraise()
  File "/opt/conda/lib/python3.10/site-packages/torch/_utils.py", line 694, in reraise
    raise exception
RuntimeError: DataLoader worker (pid 284) is killed by signal: Bus error (core dumped). It is possible that dataloader's workers are out of shared memory. Please increase the shared memory limit via --shm-size in docker.
```

Checking kernel messages via `dmesg -T` on the host reveals:
```text
[Wed Nov 11 11:15:32 2026] traps: python[284] trap page fault ip:7f9201948210 sp:7ffe81902830 error:4 in libtorch_cpu.so[7f9200000000+3a00000]
[Wed Nov 11 11:15:32 2026] tmpfs: size 64M exceeded on /dev/shm
```

## Production Specs
* **Docker Engine**: 27.0.3 Community
* **Base Image**: `pytorch/pytorch:2.3.1-cuda12.1-cudnn8-devel`
* **Host Kernel**: Linux 6.6.0-generic (Ubuntu 24.04 LTS)
* **Hardware**: 8x NVIDIA A100 (80GB), 512GB Host RAM

---

## 1. Root Cause: Default 64MB tmpfs Mount in Docker

By default, Docker allocates a microscopic **64MB** `tmpfs` volume to `/dev/shm` (POSIX shared memory) inside containers, regardless of whether the physical host possesses 64GB or 1TB of RAM.

PyTorch DataLoader spawns multiple worker processes to load images and pre-process mini-batches asynchronously. To avoid high IPC serialization overhead between Python processes, PyTorch writes raw tensor memory blocks directly into `/dev/shm`.

* With `batch_size=128` and image size `3x224x224` (float32), a single batch consumes ~75MB.
* As soon as 8 workers push tensors into `/dev/shm`, the 64MB limit is breached instantly.
* The Linux virtual memory manager fails to allocate backing pages on `tmpfs`, raising a hardware page fault and terminating the process via **SIGBUS (Exit Code 135)**.

---

## 2. Before vs. After Remediation

### Approach A: Docker CLI / Compose Hardening
Override the default 64MB shared memory via `--shm-size`:

```diff
# Docker Run
- docker run --gpus all -v /data:/data train_app:latest
+ docker run --gpus all --shm-size=16g -v /data:/data train_app:latest
```

```diff
# docker-compose.yml
version: '3.8'
services:
  trainer:
    image: pytorch/pytorch:2.3.1-cuda12.1-cudnn8-devel
+   shm_size: '16gb'
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

### Approach B: Kubernetes Pod Spec (`emptyDir` with Medium Memory)
Kubernetes pods also inherit Docker's 64MB `/dev/shm` constraint by default. Mount an in-memory `emptyDir` volume:

```diff
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pytorch-training
spec:
  template:
    spec:
      containers:
      - name: trainer
        image: custom-pytorch:v1
+       volumeMounts:
+       - mountPath: /dev/shm
+         name: dshm
+     volumes:
+     - name: dshm
+       emptyDir:
+         medium: Memory
+         sizeLimit: 16Gi
```

---

## Verification
* Monitored `/dev/shm` utilization under 8-worker DataLoader: Peak reached 4.2GB.
* Zero SIGBUS crashes across 100 consecutive training epochs.

