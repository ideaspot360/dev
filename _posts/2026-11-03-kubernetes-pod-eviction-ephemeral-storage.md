---
title: "Fixing Kubernetes Pod Evictions and CrashLoopBackOff: Ephemeral Storage Limits & EmptyDir Sizing"
category: "Cloud & DevOps"
tags: [kubernetes, devops, docker, containers, troubleshooting]
author: "Justin (IdeaSpot360 Lead Engineer)"
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

Or subsequently:

```text
Events:
  Type     Reason     Age                From               Message
  ----     ------     ----               ----               -------
  Warning  Evicted    2m (x3 over 15m)   kubelet            The node was low on resource: ephemeral-storage.
  Normal   Killing    2m                 kubelet            Stopping container billing-worker
```

Unlike CPU throttling (which merely delays response times) or RAM exhaustion (which triggers `OOMKilled exit code 137`), **ephemeral storage eviction immediately terminates the pod and schedules a reschedule**. If multiple pods on the same worker node breach storage thresholds simultaneously, cascading node evictions can disrupt cluster stability.

Here is the exact diagnostic workflow to pinpoint runaway disk consumption and configure bulletproof ephemeral storage boundaries.

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
Kubelet calculates a container’s local ephemeral storage consumption ($S_{ephemeral}$) as the aggregate of three distinct layers:

$$S_{ephemeral} = S_{\text{container writable layer (rootfs)}} + S_{\text{stdout/stderr logs}} + S_{\text{emptyDir volumes}}$$

Even if your container runtime truncates `stdout` logs at `10MB`, applications that:
1. Generate uncompressed PDF exports or temporary CSV reports in `/tmp`
2. Download dynamic model weights or ML artifacts at runtime
3. Retain unpruned Lucene/Elasticsearch index segments in local directories

will rapidly bloat the container's **writable layer (`upperdir`)**. Once this layer breaches the kubelet eviction threshold, the node drops the hammer regardless of CPU or memory margins.

---

## 3. Diagnosing Disk Consumption Inside the Pod

Before the pod is killed, identify which directory is ballooning in storage. Execute an interactive exec into a running replica:

```bash
kubectl exec -it <pod-name> -n production -- df -h
```

Then identify disk hogs by depth:

```bash
kubectl exec -it <pod-name> -n production -- du -ah / 2>/dev/null | sort -rh | head -n 20
```

Typical output revealing the leak:
```text
4.8G    /tmp/report_cache
1.2G    /var/log/application.log
320M    /app/node_modules
```

Notice `/tmp/report_cache` consumed nearly 5GB of the container's root file system.

---

## 4. The Architectural Fix: Decoupling Temp Storage with Memory-Backed `emptyDir`

To protect the container filesystem from unconstrained writes, explicitly route high-throughput temporary directories (`/tmp`, `/app/cache`) to an isolated `emptyDir` volume.

### Implementation: RAM-Backed Temp Mount

For workloads generating ephemeral artifacts, mounting `emptyDir` backed by `medium: Memory` guarantees supercharged I/O speeds while preventing disk exhaustion on the host EBS root volume:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: billing-worker
  namespace: production
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: billing-worker
          image: ideaspot360/billing-worker:v2.1.0
          resources:
            requests:
              cpu: "1000m"
              memory: "2Gi"
              ephemeral-storage: "2Gi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
              ephemeral-storage: "4Gi"
          volumeMounts:
            - name: scratch-storage
              mountPath: /tmp
      volumes:
        - name: scratch-storage
          emptyDir:
            # Memory medium uses tmpfs (consumes container RAM limit instead of host disk)
            medium: Memory
            sizeLimit: "512Mi"
```

### Key Differences & Benefits:
1. **Explicit `ephemeral-storage` Limits**: Guarantees that if disk writes exceed `4Gi`, kubelet evicts *only* this rogue pod before it exhausts the host node's root filesystem and destabilizes neighboring services.
2. **`medium: Memory` for `/tmp`**: Directs all temporary files into a fast `tmpfs` RAM slice. If the app forgets to clean up temporary exports, it will trip the `512Mi` limit cleanly without touching physical disk sectors.
