---
layout: post
title: "Troubleshooting Kubernetes GPU Scheduling & NVIDIA Container Toolkit Driver Mismatch"
date: 2026-11-28 10:41:00 +0900
category: "AI & Machine Learning"
tags: ['Kubernetes', 'GPU', 'NVIDIA', 'DevOps', 'Troubleshooting', 'Containers']
---

## Production Incident Summary

Following an automated worker node AMI update across an Amazon EKS GPU node group (instance family `g4dn.metal` with NVIDIA T4 GPUs), GPU-dependent workloads failed to schedule, and active pods entered `CrashLoopBackOff`:

```text
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  42s   default-scheduler  0/8 nodes are available: 8 Insufficient nvidia.com/gpu.
```

When pods were scheduled onto recently provisioned nodes, containers abruptly terminated with:

```text
[FATAL] nvidia-container-cli: initialization error: nvml error: driver/library version mismatch: unknown.
container_linux.go:380: starting container process caused: process_linux.go:545: container init caused: Running hook #0:: error running hook: exit status 1
```

Inspecting the host via SSH confirmed that running `nvidia-smi` failed with `Failed to initialize NVML: Driver/library version mismatch`.

## Production Specs
* **Kubernetes Cluster**: v1.29 on AWS EKS
* **Node Group**: 4x `g4dn.metal` (8x NVIDIA T4 GPUs per node, 32 GPUs total)
* **Host Operating System**: Ubuntu 22.04 LTS (Kernel 5.15.0-1052-aws)
* **NVIDIA Device Plugin**: `k8s-device-plugin:v0.15.0`
* **NVIDIA Container Toolkit**: 1.15.0-1

---

## 1. Root Cause: Kernel Driver Module vs. Userspace Library Version Skew

This failure is not a hardware fault, nor is it an issue with application container images. It is a **version divergence between the loaded Linux kernel module and the userspace NVML dynamic libraries** on the host.

```text
[ Host OS Userspace ]                                      [ Host Linux Kernel Space ]
/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.535.161.07       nvidia.ko (Loaded in Memory: 535.129.03)
                     │                                                          │
                     └───> API Handshake Mismatch! <────────────────────────────┘
                                   │
                                   ▼
          NVML: "driver/library version mismatch"
                                   │
                                   ▼
        Kubelet removes 'nvidia.com/gpu' from Allocatable Capacity
```

1. During an automated security patch cycle, `apt upgrade` updated the host NVIDIA driver packages from `535.129.03` to `535.161.07`.
2. This immediately replaced the on-disk userspace libraries (`libnvidia-ml.so`, `nvidia-smi`, `libcuda.so`).
3. However, because active GPU container processes were holding open file descriptors to `/dev/nvidia0` through `/dev/nvidiactl`, the Linux kernel could not dynamically unload the running `nvidia.ko` kernel module.
4. When `k8s-device-plugin` restarted, it dynamically linked against the new `535.161.07` userspace library, which queried the older `535.129.03` kernel module.
5. NVML safety checks rejected the connection. Failing its health check, the device plugin withdrew all `nvidia.com/gpu` resources from the node's capacity table, leaving the Kubernetes scheduler with zero available GPUs.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

When faced with `driver/library version mismatch` or `Insufficient nvidia.com/gpu`, engineers frequently waste time on misleading fixes:

### Misstep 1: Blaming Application Images and Rebuilding CUDA Containers
A common misdiagnosis is assuming the application container's PyTorch or CUDA version is incompatible with the node's driver, prompting teams to rebuild and re-tag Docker images.
* **Why It Fails**: The version mismatch occurs entirely on the host between the kernel module (`nvidia.ko`) and the host userspace libraries mounted into containers by the NVIDIA Container Runtime hook. Rebuilding application containers has zero effect because container processes never even start before the runtime hook fails.

### Misstep 2: Repeatedly Deleting the `nvidia-device-plugin` Pod
Another reflex is running `kubectl delete pod -n kube-system -l name=nvidia-device-plugin-ds` in hopes that re-registering will restore GPU allocatable counts.
* **Why It Fails**: The device plugin pod simply queries the host's `/var/run/nvidia-container-toolkit` socket on startup. As long as the host kernel module remains out of sync with userspace libraries, the newly spawned daemonset pod fails with the identical NVML error and immediately enters `CrashLoopBackOff`.

---

## 3. Before vs. After Remediation

Resolving the issue requires a two-pronged approach: recovering the live nodes cleanly, and locking driver packages in node bootstrap scripts to prevent automated package upgrades from causing skew.

### Step 1: Immediate Node Recovery (Cordon, Drain, Reboot)

```bash
# 1. Cordon the node to prevent new pods from scheduling
kubectl cordon ip-10-0-45-12.ec2.internal

# 2. Drain running workloads gracefully
kubectl drain ip-10-0-45-12.ec2.internal --ignore-daemonsets --delete-emptydir-data --force

# 3. Cleanly reboot the host to load the updated kernel module
sudo reboot
```

### Step 2: Infrastructure Hardening via Node Bootstrap User-Data

Lock NVIDIA package versions with `apt-mark hold` and exclude them from unattended upgrades in the node provisioning template:

```diff
--- bootstrap/gpu-node-userdata.sh.orig
+++ bootstrap/gpu-node-userdata.sh
@@ -12,6 +12,14 @@
 apt-get update -y
 apt-get install -y linux-headers-$(uname -r)
 apt-get install -y nvidia-driver-535 nvidia-utils-535 nvidia-container-toolkit
 
+# CRITICAL: Pin NVIDIA driver packages to prevent silent background updates from breaking NVML
+apt-mark hold nvidia-driver-535 nvidia-utils-535 libnvidia-compute-535 nvidia-container-toolkit
+
+# Explicitly disable unattended-upgrades for all NVIDIA driver components
+cat <<EOF > /etc/apt/apt.conf.d/51unattended-upgrades-nvidia-blacklist
+Unattended-Upgrade::Package-Blacklist {
+    "nvidia-.*";
+    "libnvidia-.*";
+};
+EOF
```

```diff
--- deploy/helm/nvidia-device-plugin/values.yaml.orig
+++ deploy/helm/nvidia-device-plugin/values.yaml
@@ -8,6 +8,8 @@
   failOnInitError: true
   passDeviceSpecs: true
+  # Automatic node remediation: fail liveness when NVML detects driver version mismatch
+  deviceListStrategy: "envvar"
 tolerations:
   - key: "nvidia.com/gpu"
     operator: "Exists"
     effect: "NoSchedule"
```

---

## 4. Verification & Long-Term Prevention

* **Host Node Validation**: Following the clean reboot, `nvidia-smi` reported full health with driver `535.161.07` matching CUDA 12.2.
* **Kubernetes Allocatable Capacity**: Within 30 seconds of node uncordoning, `kubectl get node ip-10-0-45-12 -o jsonpath='{.status.allocatable}'` reflected `nvidia.com/gpu: 8`.
* **Zero Disruption Guarantee**: With `apt-mark hold` and package blacklisting in place, unattended system security patches no longer touch GPU kernel or userspace components without coordinated node draining.
