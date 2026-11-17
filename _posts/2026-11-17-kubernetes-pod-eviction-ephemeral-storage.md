---
title: "Fixing Kubernetes Pod Evictions and CrashLoopBackOff: Ephemeral Storage Limits & EmptyDir Sizing"
category: "Cloud & DevOps"
tags: [kubernetes, devops, docker, containers, troubleshooting]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When your Kubernetes pods suddenly enter an Evicted or CrashLoopBackOff state due to 'ephemeral-storage exceeded', increasing CPU or RAM limits will not prevent node drain. Here is how k8s local storage accounting actually works."
---

One of the most elusive production failures in Kubernetes clusters occurs when a pod transitions from `Running` to `Evicted` without throwing memory OOM warnings or application-level stack traces:

```text
Status:       Failed
Reason:       Evicted
Message:      The node was low on resource: ephemeral-storage. 
              Threshold quantity: 5368709120, available: 4194304000. 
              Container app was using 6291456000, requesting 1073741824.
```

Or subsequently in cluster event streams:

```text
Events:
  Type     Reason     Age                From               Message
  ----     ------     ----               ----               -------
  Warning  Evicted    2m (x3 over 15m)   kubelet            The node was low on resource: ephemeral-storage.
  Normal   Killing    2m                 kubelet            Stopping container billing-worker
```

Unlike CPU throttling (which merely delays response times) or RAM exhaustion (which triggers `OOMKilled exit code 137`), ephemeral storage eviction immediately terminates the pod and schedules a reschedule. If multiple pods on the same worker node breach storage thresholds simultaneously, cascading node evictions can disrupt cluster stability.

---

## 1. Verified Production Specs

The diagnostic rules and remediation configs documented here were verified on:

* **Kubernetes Control Plane & Kubelet:** v1.29.x & v1.30.x
* **Container Runtime:** `containerd` v1.7.15 (with overlayfs snapshotter)
* **Underlying Host OS:** Amazon Linux 2023 / Ubuntu 22.04 LTS
* **Storage Driver:** AWS EBS `gp3` (mounted on `/var/lib/kubelet` and `/var/lib/containerd`)

---

## 2. Common False Fix: Why Application Logging Limits Alone Fail

A common reaction to storage eviction is tuning logging frameworks (e.g., Logback or Winston) to rotate logs faster:

```yaml
# WRONG FIX: Assuming standard container logs are the sole culprit
resources:
  requests:
    cpu: "500m"
    memory: "1Gi"
  # Omitting ephemeral-storage limits under the assumption that stdout log rotation handles it
```

### Why this fails:
Kubelet calculates a container’s local ephemeral storage consumption as the aggregate of three distinct layers:

1. **The Container Writable Layer (`upperdir`):** Dynamic files written directly to the container root filesystem outside mounted volumes.
2. **Container stdout/stderr Logs:** Managed by containerd under `/var/log/pods/`.
3. **Mounted `emptyDir` Volumes:** Local directories provisioned by kubelet under `/var/lib/kubelet/pods/<pod-uid>/volumes/kubernetes.io~empty-dir/`.

Even if your container runtime truncates `stdout` logs at `10MB`, applications that:
1. Generate uncompressed PDF exports or temporary CSV reports in `/tmp`
2. Download intermediate ML model weights directly into working directories
3. Fail to purge ephemeral SQLite or RocksDB caches

will rapidly bloat the container's **writable layer (`upperdir`)**. Once this layer breaches the kubelet eviction threshold, the node drops the hammer regardless of CPU or memory margins.

---

## 3. Root Cause Analysis: How Kubelet Measures Storage Exceeded

To locate which specific directory breached local limits before the container gets killed, execute a direct scan inside the running pod or directly on the node's overlayfs path:

```bash
# Step 1: Trace root directory storage consumption within the pod
kubectl exec -it billing-worker-7f9b8c64-x8k2p -n production -- du -h -d 1 / 2>/dev/null | sort -hr | head -n 10
```

Sample output pinpointing runaway write directories:

```text
4.8G    /tmp
1.2G    /var/log/application.log
320M    /app/node_modules
```

Notice `/tmp` consumed nearly 5GB of the container's root file system. By default, `/tmp` writes directly to `overlayfs` on the host root EBS volume. Kubelet's periodic housekeeping loop (default every 10 seconds) executes `statfs` across node partitions. When free storage drops below the node eviction threshold (`nodefs.available<15%`), kubelet sorts candidate pods by storage consumption relative to requests and evicts the highest consumer immediately.

---

## 4. The Architectural Fix: Decoupling Temp Storage with Memory-Backed `emptyDir`

To protect the container filesystem from unconstrained writes, explicitly route high-throughput temporary directories (`/tmp`, `/app/cache`) to an isolated `emptyDir` volume backed by RAM tmpfs:

```diff
--- deploy/kubernetes/billing-worker.yaml.orig
+++ deploy/kubernetes/billing-worker.yaml
@@ -14,6 +14,14 @@
           resources:
             requests:
               cpu: "1000m"
               memory: "2Gi"
+              ephemeral-storage: "2Gi"
             limits:
               cpu: "2000m"
               memory: "2Gi"
+              # Evict this specific rogue pod before node disk exhaustion
+              ephemeral-storage: "4Gi"
+          volumeMounts:
+            - name: scratch-storage
+              mountPath: /tmp
+      volumes:
+        - name: scratch-storage
+          # Route temporary disk writes to RAM tmpfs
+          emptyDir:
+            medium: Memory
+            sizeLimit: "512Mi"
```

### Key Differences & Benefits:
1. **Explicit `ephemeral-storage` Limits**: Guarantees that if disk writes exceed `4Gi`, kubelet evicts *only* this rogue pod before it exhausts the host node's root filesystem and destabilizes neighboring services.
2. **`medium: Memory` for `/tmp`**: Directs all temporary files into a fast `tmpfs` RAM slice. If the app forgets to clean up temporary exports, it will trip the `512Mi` limit cleanly without touching physical disk sectors.

---

## 5. Verification: Confirming Pod Ephemeral Storage Compliance

After deploying the modified manifest, verify that storage accounting is actively monitored by the kubelet and that the `emptyDir` memory limit is honored:

```bash
# 1. Inspect pod resource specifications and live events
kubectl describe pod -l app=billing-worker -n production | grep -A 8 "Limits:"

# 2. Verify tmpfs mount inside the active container
kubectl exec -it deploy/billing-worker -n production -- df -h /tmp
```

Expected terminal output:

```text
Filesystem      Size  Used Avail Use% Mounted on
tmpfs           512M  4.0K  512M   1% /tmp
```

The billing worker now operates with deterministic disk boundaries, eliminating cluster-wide cascade evictions and ensuring neighboring workloads remain unaffected during batch processing spikes.
