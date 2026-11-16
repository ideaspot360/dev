---
layout: post
title: "Troubleshooting Kubernetes GPU Scheduling & NVIDIA Container Toolkit Driver Mismatch"
date: 2026-11-28 10:41:00 +0900
category: "AI & Machine Learning"
tags: ['Kubernetes', 'GPU', 'NVIDIA', 'DevOps', 'Troubleshooting', 'Containers']
---

## Production Incident Summary

Following an automated worker node AMI upgrade on an Amazon EKS GPU cluster (instance family `g4dn.metal` with NVIDIA T4 GPUs), all AI training and inference Pods entered indefinite `Pending` or `CrashLoopBackOff`:

```text
Events:
  Warning  FailedScheduling  default-scheduler  0/12 nodes are available: 12 Insufficient nvidia.com/gpu.
```

Scheduled containers failed with:

```text
[FATAL] nvidia-container-cli: initialization error: nvml error: driver/library version mismatch: unknown.
```

---

## 1. Root Cause: Kernel Driver Update vs DaemonSet NVML Incompatibility

When the node package manager updated NVIDIA driver packages in the background, userspace shared libraries (`libnvidia-ml.so`) were upgraded immediately, but the running kernel module (`nvidia.ko`) remained at the older version.

NVML requires identical versions across userspace and kernel space.

When `nvidia-device-plugin-daemonset` encountered NVML errors, it withdrew the `nvidia.com/gpu` resource from the node specification, causing K8s scheduler failure across all GPU workloads.

---

## 2. Production Fix: Node Drain, Kernel Reload & Driver Version Locking

```bash
# 1. Cordon and drain the affected GPU node
kubectl cordon ip-10-0-45-12.ec2.internal
kubectl drain ip-10-0-45-12.ec2.internal --ignore-daemonsets --delete-emptydir-data

# 2. Reload kernel modules (or cleanly reboot node)
sudo rmmod nvidia_uvm nvidia_drm nvidia_modeset nvidia
sudo modprobe nvidia
# If unloading fails due to active processes, reboot:
sudo reboot
```

Prevent future unattended upgrades in node user-data:

```bash
sudo apt-mark hold nvidia-driver-535 nvidia-utils-535 libnvidia-compute-535
kubectl -n kube-system rollout restart daemonset nvidia-device-plugin-daemonset
```
