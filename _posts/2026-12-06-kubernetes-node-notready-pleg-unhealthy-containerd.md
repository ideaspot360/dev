---
layout: post
title: "Kubernetes Node NotReady & PLEG (Pod Lifecycle Event Generator) Is Not Healthy"
date: 2026-12-06 10:14:48 +0900
category: "Cloud & DevOps"
tags: ['Kubernetes', 'Kubelet', 'PLEG', 'Containerd', 'Troubleshooting', 'DevOps']
---

## Production Incident Summary

During a scheduled morning scale-out burst processing asynchronous ETL pipelines and customer event streams, 18 worker nodes across three availability zones in our production Kubernetes cluster simultaneously flipped from `Ready` to `NotReady`. The Kubernetes controller manager initiated node-lifecycle evictions, triggering cascading pod terminations that rescheduled over 450 mission-critical microservice workloads onto remaining nodes, driving the cluster toward widespread cascading failure.

Log aggregation across affected worker nodes indicated that the local `kubelet` daemon had failed its internal liveness check due to Pod Lifecycle Event Generator (PLEG) unresponsiveness, while underlying containerd CRI gRPC calls timed out:

```text
2026-12-06T01:14:12.802Z [ERROR] kubelet: PLEG is not healthy: pleg was last seen active 3m24s ago; threshold is 3m0s
2026-12-06T01:14:12.803Z [ERROR] kubelet: Node status update failed: node "ip-10-0-42-181.ec2.internal" is NotReady
2026-12-06T01:14:13.119Z [ERROR] kubelet: rpc error: code = DeadlineExceeded desc = context deadline exceeded: failed to get sandbox status for "8f2a9c1d04b281f6e291"
2026-12-06T01:14:14.492Z [WARN]  containerd: failed to list pods from CRI: context deadline exceeded
2026-12-06T01:14:15.011Z [ERROR] kubelet: Error syncing pod "batch-worker-7c48f87b8d-9zp21_prod(d29a1482-12f8-4e89-a3b1-918239018471)", skipping: [failed to "GetPodStatus" for "batch-worker-7c48f87b8d-9zp21_prod" with PLEGInternalError: PLEG is not healthy]
```

Cluster monitoring dashboards confirmed that while worker node CPU and memory utilization remained well below 65%, the local CRI runtime socket `/run/containerd/containerd.sock` experienced gRPC response latency exceeding 180 seconds for routine container listing operations.

## Production Specs
* **Kubernetes Version**: v1.29.4 managed via Amazon EKS
* **Container Runtime**: containerd v1.7.13 (`runc` v1.1.12)
* **Operating System**: Ubuntu 22.04 LTS (Linux Kernel 5.15.0-1053-aws)
* **Worker Node Tier**: 36x AWS EC2 `m6i.4xlarge` (16 vCPU, 64 GiB RAM, EBS gp3)
* **Cgroup Hierarchy**: Legacy cgroup v1 (`/sys/fs/cgroup`)
* **Workload Scale**: 95-110 active pods per node experiencing frequent ephemeral CronJob churn (~4,000 container lifecycles/hour)

---

## 1. Architectural Cause & Root Cause Analysis: The PLEG Relist Loop & Cgroup Leaks

PLEG is an internal subsystem inside the `kubelet` daemon responsible for keeping the node's local pod cache in sync with the actual container runtime state.

```text
                  Kubelet PLEG Architecture & Bottleneck
                  
    [ Kubelet Main Loop ] 
             │
             ├── Every 1 Second: PLEG relist()
             │        │
             │        ▼
             │  gRPC: CRI ListPodSandbox() + PodSandboxStatus()
             │        │
             │        ▼
             │  [ Containerd Daemon (/run/containerd/containerd.sock) ]
             │        │
             │        ├── Reads /sys/fs/cgroup/memory/kubepods/...
             │        └── Scans Hundreds of Zombie Cgroups & Exited Containers!
             │
             ├── PLEG Relist takes > 3 Minutes! (Threshold: 3m)
             ▼
    [ Kubelet Reports Node NotReady ] ──► [ Controller Manager Evicts All Pods! ]
```

### 1. The PLEG Relist Mechanism
1. Every second, PLEG invokes `relist()`. It queries containerd over the local Unix domain socket using CRI methods (`ListPodSandbox`, `ListContainers`, and `PodSandboxStatus`) to inspect every container running or stopped on the host.
2. PLEG compares the previous runtime state against the newly retrieved state to generate discrete lifecycle events (`ContainerStarted`, `ContainerDied`).
3. If PLEG's `relist()` cycle does not complete within 3 minutes (`pleg-unhealthy-threshold = 3m`), kubelet flags itself unhealthy and marks the node condition `Ready = False` with reason `KubeletNotReady`.

### 2. Root Cause: High Container Churn and Cgroup v1 Memory Controller Lock Contention
1. **The Ephemeral Churn**: Batch ETL CronJobs created and destroyed thousands of short-lived pods hourly. Each pod creation created nested cgroup directories under `/sys/fs/cgroup/memory/kubepods/burstable/...`.
2. **Zombie Cgroups**: In Linux cgroup v1, when a container terminates, its cgroup memory directory cannot be released by the kernel if any memory pages remain in the page cache or socket buffers associated with that cgroup. Over several days, affected nodes accumulated over 35,000 dead cgroup directories.
3. **CRI Lockup**: When containerd attempted to satisfy kubelet's `ListPodSandbox()` request, it iterated through `/sys/fs/cgroup` to gather memory metrics for each container. The kernel spent excessive CPU cycles in `shrink_dcache_parent` and spinlock acquisition across thousands of lingering cgroups.
4. **Deadline Exceeded**: Querying 110 pods required containerd to inspect 35,000 dead paths. Single `relist()` calls that should take 80ms spiked to 210 seconds. The 3-minute threshold was breached, kubelet declared `PLEG is not healthy`, and the control plane initiated catastrophic pod evictions.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

During the incident, standard reactive operations failed to rectify the underlying bottleneck:

### Anti-Pattern 1: Blindly Restarting Kubelet or Rebooting Worker Nodes
* **The Attempted Fix**: When nodes turned `NotReady`, on-call engineers ran `systemctl restart kubelet` and `systemctl restart containerd`, or rebooted the EC2 instances.
* **Why this wrong fix failed**: While rebooting flushed dead cgroups from memory and returned the node to `Ready` temporarily, within 2 to 3 hours of morning batch workloads running, the accumulation of exited container cgroups reached the critical threshold again. The nodes flipped right back to `NotReady`, causing recurring eviction storms throughout the day.

### Anti-Pattern 2: Arbitrarily Lengthening PLEG Threshold to 15 Minutes
* **The Attempted Fix**: In an attempt to prevent nodes from flipping to `NotReady`, an engineer modified `/var/lib/kubelet/config.yaml` to set high tolerance limits.
* **Why this wrong fix failed**: Masking the threshold did not fix the containerd CRI responsiveness stall. Kubelet was still unable to detect container crashes or update pod health statuses. Readiness probes failed to register, routing dead pods into service endpoints and causing continuous HTTP 502/504 gateways errors to upstream clients.

---

## 3. Production Remediation: Before vs. After Unified Diff

Permanent remediation required transitioning from legacy cgroup v1 to unified **cgroup v2** (which cleanly decouples process death from memory charging and eliminates zombie cgroup stalls), tuning kubelet container garbage collection, and optimizing containerd CRI event processing.

Apply the following kernel and OS boot parameters via GRUB to enforce cgroup v2:

```diff
--- /etc/default/grub.orig
+++ /etc/default/grub
@@ -8,4 +8,6 @@
-GRUB_CMDLINE_LINUX="console=tty1 console=ttyS0 nvme_core.io_timeout=4294967295"
+GRUB_CMDLINE_LINUX="console=tty1 console=ttyS0 nvme_core.io_timeout=4294967295 systemd.unified_cgroup_hierarchy=1 cgroup_no_v1=all"
```

Apply the following kubelet garbage collection tuning in `/var/lib/kubelet/config.yaml`:

```diff
--- /var/lib/kubelet/config.yaml.orig
+++ /var/lib/kubelet/config.yaml
@@ -24,6 +24,14 @@
+imageGCHighThresholdPercent: 75
+imageGCLowThresholdPercent: 60
+maximumDeadContainers: 100
+maximumDeadContainersPerContainer: 1
+minimumGCAge: 2m
+containerLogMaxSize: 50Mi
+containerLogMaxFiles: 3
+cgroupDriver: systemd
-cgroupDriver: cgroupfs
```

Update containerd CRI configuration in `/etc/containerd/config.toml`:

```diff
--- /etc/containerd/config.toml.orig
+++ /etc/containerd/config.toml
@@ -18,6 +18,12 @@
     [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
       runtime_type = "io.containerd.runc.v2"
       [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
-        SystemdCgroup = false
+        SystemdCgroup = true
+    [plugins."io.containerd.grpc.v1.cri"]
+      stream_server_address = "127.0.0.1"
+      drain_exec_sync_io_timeout = "10s"
+      max_container_log_line_size = 262144
```

---

## 4. Verification CLI & Live Cluster Diagnostics

Execute the following diagnostic commands to verify cgroup v2 hierarchy, monitor PLEG relist duration, and test CRI socket latency:

```bash
# 1. Verify that the node has booted into unified cgroup v2
stat -fc %T /sys/fs/cgroup/
# Output must show: cgroup2fs

# 2. Check kubelet systemd service status and tail PLEG relist events
systemctl status kubelet
journalctl -u kubelet -n 100 --no-pager | grep -E "PLEG|relist"

# 3. Inspect containerd CRI socket connection latency and verify active containers
crictl info
crictl stats
ss -x -a | grep containerd.sock

# 4. Count remaining dead/exited containers across the node
crictl ps -a --state Exited | wc -l

# 5. Measure kernel slab and dentry memory cache to ensure no zombie cgroup leaks
cat /proc/cgroups
vmstat 1 5
```

Following the migration to cgroup v2 with `SystemdCgroup = true` and dead container limits capped at 100, the PLEG `relist()` execution duration plummeted from 180+ seconds down to **24 milliseconds**. Over 72 hours of intensive batch scheduling, zero nodes reported PLEG unhealthy events.

---

## 5. Long-Term Architectural Safeguards & Operating Runbook

To prevent recurring node degradation in high-density Kubernetes clusters:

1. **Mandatory Cgroup v2 Migration**: Upgrade all Kubernetes AMI baseline images to kernel versions supporting unified cgroup v2. Cgroup v2's unified resource model fundamentally prevents memory controller dentry leakage.
2. **Aggressive Dead Container Trimming**: Never leave `maximumDeadContainers` unconfigured on nodes running ephemeral batch workloads. Enforce `maximumDeadContainers: 100` and `maximumDeadContainersPerContainer: 1`.
3. **PLEG Latency Alerting**: Instate Prometheus alerts on `histogram_quantile(0.99, sum(rate(kubelet_pleg_relist_duration_seconds_bucket[5m])) by (le, instance)) > 5.0` to detect CRI degradation hours before the 3-minute hard failure threshold trips.
4. **Runtime Socket Isolation**: Configure dedicated disk partitions for `/var/lib/containerd` and `/var/log/pods` to prevent container disk saturation from freezing the runtime domain socket.
