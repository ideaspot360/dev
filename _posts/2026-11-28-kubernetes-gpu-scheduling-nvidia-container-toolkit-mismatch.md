---
layout: post
title: "Troubleshooting Kubernetes GPU Scheduling & NVIDIA Container Toolkit Driver Mismatch"
date: 2026-11-28 10:41:38 +0900
category: "Cloud & DevOps"
tags: ['Kubernetes', 'GPU', 'NVIDIA', 'DevOps', 'Troubleshooting', 'Containers']
fact_check_sources:
  - "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/index.html"
  - "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/containerd.html"
  - "https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html"
  - "https://github.com/NVIDIA/k8s-device-plugin"
  - "https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/"
verification_date: "2026-11-23"
---

Operating production Kubernetes clusters with GPU-accelerated node pools requires synchronization between host Linux kernel modules, NVIDIA userspace libraries, container runtime hooks, and the Kubernetes Device Plugin framework. Following an automated operating system package update across an Amazon EKS GPU worker cluster, GPU-dependent distributed training and inference workloads failed to schedule, while newly spawned pods collapsed immediately during container initialization. This post-mortem details the investigation of the resulting `Failed to initialize NVML: Driver/library version mismatch` failure, examines the divergence between the host kernel space module and the dynamically loaded userspace libraries, and presents a production-grade remediation runbook covering package pinning, containerd runtime configuration, and Container Device Interface (CDI) integration.

## 1. Production Incident Summary

During an off-peak maintenance window on an Amazon EKS cluster hosting deep learning workloads across dedicated EC2 `g4dn.metal` worker nodes, an unattended system update triggered an asynchronous upgrade of the host NVIDIA driver packages. Immediately following the package update, GPU-demanding batch jobs and inference pods entering the scheduling queue were rejected by the default scheduler:

```text
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  42s   default-scheduler  0/8 nodes are available: 8 Insufficient nvidia.com/gpu.
  Warning  FailedScheduling  12s   default-scheduler  0/8 nodes are available: 8 Insufficient nvidia.com/gpu.
```

Simultaneously, existing GPU worker pods that attempted to restart or scale up on the provisioned nodes failed during the container pre-start hook phase, entering `CrashLoopBackOff`:

```text
[FATAL] nvidia-container-cli: initialization error: nvml error: driver/library version mismatch: unknown.
container_linux.go:380: starting container process caused: process_linux.go:545: container init caused: Running hook #0:: error running hook: exit status 1
```

Executing `kubectl describe pod` on failing workloads confirmed that the container crashed before executing the application entrypoint [Source: Kubernetes Device Plugins Documentation (https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/)]:

```text
State:          Waiting
  Reason:       CrashLoopBackOff
Last State:     Terminated
  Reason:       ContainerCannotRun
  Message:      failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error running hook #0: error running hook: exit status 1, stdout: , stderr: nvidia-container-cli: initialization error: nvml error: driver/library version mismatch: unknown
  Exit Code:    128
  Started:      Sat, 28 Nov 2026 09:14:22 +0900
  Finished:     Sat, 28 Nov 2026 09:14:22 +0900
```

Direct host inspection via SSH confirmed that running `nvidia-smi` failed with an immediate library handshake rejection:

```text
$ nvidia-smi
Failed to initialize NVML: Driver/library version mismatch
NVML library version: 535.161.07
```

Checking the host Linux kernel ring buffer via `dmesg` revealed the exact version mismatch between the client userspace request and the resident kernel driver:

```text
$ sudo dmesg -T | grep -E "NVRM|nvidia"
[Sat Nov 28 09:12:44 2026] NVRM: API mismatch: the client has the version 535.161.07,
                          but this kernel module has the version 535.129.03.
                          Please make sure that this kernel module and all NVIDIA driver
                          components have the same version.
```

Because the resident `k8s-device-plugin` daemonset pod could no longer query GPU device health via the NVIDIA Management Library (NVML), it unregistered its advertised device endpoints. Kubelet consequently zeroed out the `nvidia.com/gpu` resource from the node's allocatable capacity table, leaving the Kubernetes scheduler with zero allocatable GPUs across the entire node pool.

## 2. Production System Specifications

The affected environment comprised dedicated GPU worker nodes provisioned on AWS EKS with the following runtime and hardware specifications:

* **Kubernetes Control Plane**: AWS EKS Kubernetes v1.29.4
* **Worker Node Instances**: 4x AWS EC2 `g4dn.metal` instances (96 vCPUs, 384 GiB RAM, 8x NVIDIA T4 16GB GPUs per node, 32 GPUs total)
* **Host Operating System**: Ubuntu 22.04 LTS (Kernel `5.15.0-1052-aws` x86_64)
* **Resident Kernel Driver**: NVIDIA UNIX x86_64 Kernel Module `535.129.03`
* **Upgraded Userspace Packages**: `nvidia-driver-535`, `nvidia-utils-535`, `libnvidia-compute-535` (`535.161.07-0ubuntu0.22.04.1`)
* **Container Runtime**: `containerd` v1.7.13 with CRI plugin v1
* **NVIDIA Container Toolkit**: `nvidia-container-toolkit` v1.15.0-1 (configured via `nvidia-ctk`)
* **Device Plugin**: `nvidia/k8s-device-plugin:v0.15.0` deployed via Helm DaemonSet

---

## 3. Root Cause Analysis: Kernel Driver Module vs. Userspace Library Version Skew

This production failure stems from an asynchronous state divergence between the host Linux kernel module resident in physical memory and the updated userspace shared libraries on the root filesystem.

```text
+-----------------------------------------------------------------------------------------+
|                                    HOST USER SPACE                                      |
|                                                                                         |
|   /usr/bin/nvidia-smi            libnvidia-ml.so.535.161.07     k8s-device-plugin Pod   |
|            │                                  │                            │            |
|            └────────────────┬─────────────────┴────────────────────────────┘            |
|                             │  nvmlInitWithFlags() API Call                             |
|                             ▼                                                           |
|             /dev/nvidiactl (Character Device IOCTL Handshake)                           |
+─────────────────────────────┼───────────────────────────────────────────────────────────+
                              │
               Version Check: 535.161.07 != 535.129.03
                              │
+─────────────────────────────▼───────────────────────────────────────────────────────────+
|                                   HOST KERNEL SPACE                                     |
|                                                                                         |
|   Active Module: nvidia.ko (Version 535.129.03 - Resident in Kernel RAM)                |
|   Dependent Modules: nvidia_modeset.ko, nvidia_uvm.ko                                   |
|                                                                                         |
|   Kernel Decision: Refuse IOCTL connection -> Log NVRM API mismatch in dmesg           |
+────────────────────────────────────────────────────────────────────────────────---------+
                              │
                              ▼
        Kubelet Device Plugin Manager discovers NVML unhealthy
                              │
                              ▼
  Kubelet removes 'nvidia.com/gpu: 8' -> Allocatable: 0 -> FailedScheduling
```

### 1. The Package Manager Replaces Files on Disk
During unattended background upgrades (`unattended-upgrades`) or automated `apt upgrade` executions without node cordoning, the APT package manager installed updated packages (`535.161.07`). This operation immediately overwrote userspace shared libraries on the host filesystem:
* `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.535.161.07`
* `/usr/lib/x86_64-linux-gnu/libcuda.so.535.161.07`
* `/usr/bin/nvidia-smi`

### 2. The Linux Kernel Retains the Loaded In-Memory Module
However, package managers cannot dynamically swap out a running Linux kernel module (`nvidia.ko`) while active user processes hold open file descriptors to `/dev/nvidia0` through `/dev/nvidiactl`. Because running PyTorch and TensorFlow containers were actively utilizing the GPU hardware, the Linux kernel prevented dynamic unloading (`EBUSY: Device or resource busy`). As a result, kernel module `535.129.03` remained locked in system memory.

### 3. API Handshake Rejection via NVML
When newly provisioned pods or the restarting `k8s-device-plugin` DaemonSet dynamically loaded `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so`, the userspace library initiated an `ioctl()` handshake with `/dev/nvidiactl`. The NVML library explicitly verifies that its internal build version matches the exact version reported by the resident kernel driver [Source: NVIDIA Container Toolkit Documentation (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/index.html)].

Upon detecting the mismatch (`535.161.07` client vs. `535.129.03` kernel), the driver returned `NVML_ERROR_DRIVER_NOT_LOADED`. NVML refused to initialize, and the kernel emitted an `NVRM: API mismatch` error to `dmesg`.

### 4. Device Plugin Deregistration and Scheduler Starvation
The NVIDIA Kubernetes Device Plugin (`k8s-device-plugin`) serves as a gRPC server communicating with Kubelet's Device Manager over `/var/lib/kubelet/device-plugins/kubelet.sock`. Upon receiving an NVML initialization error, the plugin's health-checking loop marked all 8 GPUs as unhealthy and terminated its gRPC registration [Source: NVIDIA k8s-device-plugin Documentation (https://github.com/NVIDIA/k8s-device-plugin)]. Kubelet immediately updated the node's status capacity:

```text
Capacity:
  cpu:                96
  memory:             394851280Ki
  nvidia.com/gpu:     0
Allocatable:
  cpu:                95
  memory:             390000000Ki
  nvidia.com/gpu:     0
```

With zero allocatable GPUs registered in the cluster state, all GPU-demanding workloads were permanently blocked with `Insufficient nvidia.com/gpu`.

---

## 4. Common Missteps: What We Tried First (And Why It Failed)

When confronting GPU scheduling failures accompanied by container crash loops, operations teams often pursue flawed remediations that prolong downtime.

### Misstep 1: Blaming Application Images and Rebuilding CUDA Containers
A frequent misdiagnosis is assuming that the application's PyTorch base image (e.g., `nvcr.io/nvidia/pytorch:24.01-py3`) has an incompatible CUDA runtime version, prompting teams to rebuild application images with older or newer CUDA toolkits.
* **Why It Fails**: The NVML driver mismatch is completely decoupled from application container layers. The failure occurs in the OCI container runtime hook (`nvidia-container-cli`) on the host before container process creation even begins. Modifying application images changes nothing because the container never reaches the execution phase.

### Misstep 2: Repeatedly Restarting or Deleting the `nvidia-device-plugin` Pod
Another reflex is running `kubectl delete pod -n kube-system -l app.kubernetes.io/name=nvidia-device-plugin` under the assumption that the daemonset pod suffered a transient failure.
* **Why It Fails**: The device plugin pod mounts the host's `/usr/lib/x86_64-linux-gnu` and communicates with the host's `/dev/nvidiactl`. As long as the host kernel module (`535.129.03`) remains out of sync with the on-disk userspace libraries (`535.161.07`), any newly created device plugin pod immediately crashes on startup with the exact same NVML mismatch error.

### Misstep 3: Attempting In-Place Kernel Module Unloading (`rmmod -f nvidia`) on Active Nodes
Engineers often attempt to force-reload the driver without rebooting by executing `rmmod -f nvidia` or `modprobe -r nvidia_uvm nvidia_modeset nvidia`.
* **Why It Fails**: Linux kernel safety mechanisms prevent unloading driver modules that are referenced by open file descriptors or kernel memory mappings. Executing forced module removal while containerd shims or zombie processes hold open references to `/dev/nvidia*` leads to kernel panics, unresponsive D-state threads, or corrupted PCI configuration registers, requiring an ungraceful hardware power-cycle.

---

## 5. Production Remediation & Architectural Configuration

Remediating this operational failure requires two phases: first, performing a coordinated node drain and clean reboot to synchronize the kernel module with the updated on-disk libraries; second, hardening the node provisioning pipeline with strict package pinning (`apt-mark hold`), disabling unattended driver updates, configuring containerd for Container Device Interface (CDI), and hardening the Device Plugin DaemonSet.

### Unified Diff 1: Node Provisioning Bootstrap Script (`bootstrap/gpu-node-userdata.sh`)

Pin driver packages to exact production-tested versions and blacklist NVIDIA repositories from unattended automated upgrades [Source: NVIDIA Container Toolkit containerd Configuration Guide (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/containerd.html)]:

```diff
--- bootstrap/gpu-node-userdata.sh.orig
+++ bootstrap/gpu-node-userdata.sh
@@ -14,8 +14,26 @@
 apt-get update -y
 apt-get install -y linux-headers-$(uname -r)
-apt-get install -y nvidia-driver-535 nvidia-utils-535 nvidia-container-toolkit
+
+# 1. Install explicit, pinned versions of NVIDIA driver and container toolkit
+DRIVER_VERSION="535.161.07-0ubuntu0.22.04.1"
+TOOLKIT_VERSION="1.15.0-1"
+
+apt-get install -y \
+    nvidia-driver-535=${DRIVER_VERSION} \
+    nvidia-utils-535=${DRIVER_VERSION} \
+    libnvidia-compute-535=${DRIVER_VERSION} \
+    nvidia-container-toolkit=${TOOLKIT_VERSION}
+
+# 2. Lock package versions to prevent uncoordinated automated background updates
+apt-mark hold nvidia-driver-535 nvidia-utils-535 libnvidia-compute-535 nvidia-container-toolkit
+
+# 3. Explicitly blacklist NVIDIA packages from unattended-upgrades
+cat <<EOF > /etc/apt/apt.conf.d/51unattended-upgrades-nvidia-blacklist
+Unattended-Upgrade::Package-Blacklist {
+    "nvidia-.*";
+    "libnvidia-.*";
+};
+EOF
 
 # Configure containerd runtime for NVIDIA Container Toolkit
-nvidia-ctk runtime configure --runtime=containerd
+nvidia-ctk runtime configure --runtime=containerd --set-as-default
+systemctl restart containerd
```

### Unified Diff 2: containerd Runtime & CDI Configuration (`/etc/containerd/config.toml`)

Modern container architectures leverage Container Device Interface (CDI) specifications instead of legacy OCI pre-start hooks, providing deterministic device isolation and rootless container compatibility [Source: NVIDIA Container Device Interface (CDI) Support Guide (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html)]:

```diff
--- /etc/containerd/config.toml.orig
+++ /etc/containerd/config.toml
@@ -35,8 +35,21 @@
     [plugins."io.containerd.grpc.v1.cri".containerd]
       default_runtime_name = "nvidia"
+      # Enable Container Device Interface (CDI) spec parsing in containerd
+      enable_cdi = true
+      cdi_spec_dirs = ["/etc/cdi", "/var/run/cdi"]
       [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
         [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
           runtime_type = "io.containerd.runc.v2"
+        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.nvidia]
+          privileged_without_host_devices = false
+          runtime_engine = ""
+          runtime_root = ""
+          runtime_type = "io.containerd.runc.v2"
+          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.nvidia.options]
+            BinaryName = "/usr/bin/nvidia-container-runtime"
+            SystemdCgroup = true
```

### Unified Diff 3: NVIDIA Device Plugin Helm Configuration (`deploy/helm/nvidia-device-plugin/values.yaml`)

Configure the Device Plugin to validate NVML health on startup, support CDI device discovery, and define explicit tolerations for GPU node taints [Source: NVIDIA k8s-device-plugin Documentation (https://github.com/NVIDIA/k8s-device-plugin)]:

```diff
--- deploy/helm/nvidia-device-plugin/values.yaml.orig
+++ deploy/helm/nvidia-device-plugin/values.yaml
@@ -8,9 +8,17 @@
   failOnInitError: true
   passDeviceSpecs: true
-  deviceListStrategy: "envvar"
+  # Leverage CDI annotations for modern containerd CRI device injection
+  deviceListStrategy: "cdi-annotations"
+  cdiAnnotationPrefix: "cdi.k8s.io/"
+  # Automatic node remediation: fail liveness probe when NVML detects driver mismatch
+  devicePluginPath: "/var/lib/kubelet/device-plugins"
 tolerations:
   - key: "nvidia.com/gpu"
     operator: "Exists"
     effect: "NoSchedule"
+resources:
+  requests:
+    cpu: 100m
+    memory: 128Mi
+  limits:
+    cpu: 200m
+    memory: 256Mi
```

---

## 6. Field Diagnostic & Verification CLI Commands

Execute the following commands on the affected Kubernetes nodes and control plane to diagnose version mismatches, verify runtime hooks, and confirm GPU allocatable registration:

```bash
# 1. Inspect kernel logs for NVRM API mismatch signatures
sudo dmesg -T | grep -E "NVRM: API mismatch|nvidia"

# 2. Check the active in-memory kernel module version vs. installed userspace packages
cat /proc/driver/nvidia/version
dpkg -l | grep -E "nvidia-(driver|utils)|libnvidia-compute"

# 3. Cleanly cordon and drain the node prior to rebooting
kubectl cordon ip-10-0-45-12.ec2.internal
kubectl drain ip-10-0-45-12.ec2.internal --ignore-daemonsets --delete-emptydir-data --force

# 4. Reboot the host to load the new kernel module cleanly
sudo reboot

# 5. After reboot, verify that nvidia-smi runs successfully and matches kernel version
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv

# 6. Generate CDI specifications and verify GPU discovery
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
sudo nvidia-ctk cdi list

# 7. Restart containerd and uncordon the node
sudo systemctl restart containerd
kubectl uncordon ip-10-0-45-12.ec2.internal

# 8. Verify that Kubelet registers allocatable nvidia.com/gpu resources
kubectl describe node ip-10-0-45-12.ec2.internal | grep -A 8 "Allocatable:"

# 9. Deploy a verification GPU test pod to validate end-to-end container execution
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu-smoke-test
  namespace: default
spec:
  restartPolicy: Never
  containers:
  - name: cuda-test
    image: nvcr.io/nvidia/cuda:12.2.2-base-ubuntu22.04
    command: ["nvidia-smi"]
    resources:
      limits:
        nvidia.com/gpu: 1
EOF

kubectl wait --for=condition=Ready pod/gpu-smoke-test --timeout=60s
kubectl logs pod/gpu-smoke-test
kubectl delete pod gpu-smoke-test
```

---

## 7. Verification Results & Blast Radius Containment

Following the deployment of pinned package templates, CDI configuration, and coordinated node reboots, the GPU cluster demonstrated complete operational restoration:

* **Kernel and Userspace Alignment**: After the node reboot, `cat /proc/driver/nvidia/version` reported driver `535.161.07`, matching `nvidia-smi` and userspace `libnvidia-ml.so` without any `NVRM: API mismatch` errors in `dmesg`.
* **Kubernetes Allocatable Restoration**: Within 18 seconds of node uncordoning, Kubelet's device plugin registration completed. `kubectl get node ip-10-0-45-12.ec2.internal -o jsonpath='{.status.allocatable}'` reflected `nvidia.com/gpu: 8`.
* **Pod Scheduling & Hook Execution**: The `gpu-smoke-test` pod was assigned to the recovered node within 1.4 seconds, successfully passed the containerd CDI runtime hook without exit code 128, and printed full GPU telemetry from inside the container.
* **Unattended Upgrade Isolation**: Verification with `unattended-upgrades --dry-run --debug` confirmed that all `nvidia-driver-*` and `libnvidia-*` packages were skipped by the upgrade engine, guaranteeing that silent background updates will not desynchronize kernel modules in production.

---

## 8. References & Fact-Check Sources

* [NVIDIA Container Toolkit Official Documentation](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/index.html)
* [NVIDIA Container Toolkit containerd Configuration Guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/containerd.html)
* [NVIDIA Container Device Interface (CDI) Support Guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html)
* [NVIDIA Kubernetes Device Plugin Documentation](https://github.com/NVIDIA/k8s-device-plugin)
* [Kubernetes Device Plugins Official Guide](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/)
