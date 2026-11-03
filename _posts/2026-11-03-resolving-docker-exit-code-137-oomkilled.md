---
layout: post
title: "Resolving Docker & Kubernetes Exit Code 137 (OOMKilled): Root Cause & JVM Memory Tuning"
date: 2026-11-03 10:00:00 +0900
category: "Cloud & DevOps"
tags: [docker, kubernetes, java, devops, troubleshooting]
author: "Justin (IdeaSpot360 Lead Engineer)"
excerpt: "When your production container abruptly terminates with exit code 137, increasing -Xmx usually makes it crash faster. Here is how Linux cgroups v2, off-heap buffers, and container memory limits actually interact."
---

If your containerized application terminates abruptly without leaving an application-level stack trace in standard log outputs, inspecting the container state usually reveals:

```text
State:          Terminated
  Reason:       OOMKilled
  Exit Code:    137
  Started:      Mon, 03 Nov 2026 01:14:22 UTC
  Finished:     Mon, 03 Nov 2026 01:38:05 UTC
```

Exit code `137` is not arbitrary: in POSIX systems, fatal signals result in an exit code of `128 + n`. Signal 9 is `SIGKILL` ($128 + 9 = 137$). Because `SIGKILL` cannot be caught, blocked, or handled by the JVM process, shutdown hooks never execute, thread dumps are never generated, and your APM agent ceases transmitting telemetry mid-flight.

Here is the exact diagnostic workflow and configuration fix for production workloads.

---

## 1. Verified Environment & Reproduction Specs

The behavior documented below was verified against modern container runtimes and JVM environments:

* **Host OS Kernel:** Linux 6.6.x (Ubuntu 24.04 LTS / Amazon Linux 2023)
* **Control Group:** `cgroup v2` enabled (`/sys/fs/cgroup/cgroup.controllers`)
* **Container Runtime:** containerd v1.7.x / Docker Engine 27.x
* **Orchestrator:** Kubernetes v1.30.x
* **Runtime Stack:** Eclipse Temurin OpenJDK 21 (LTS) running Spring Boot 3.3.x

---

## 2. Common False Fix: Why Bumping `-Xmx` Accelerates the Crash

When engineers first observe an OOM event, the immediate reflex is often:

```bash
# WRONG FIX: Allocating 90% of container memory to Java Heap
java -Xms1800m -Xmx1800m -jar app.jar
```

In a container constrained to `2048Mi` memory limit in Kubernetes:

```yaml
# Pod Spec (Vulnerable)
resources:
  limits:
    memory: "2Gi"
  requests:
    memory: "1Gi"
```

### Why this fails:
The Linux kernel OOM killer (`mm/oom_kill.c`) tracks the **total resident memory consumption (RSS + swap + page cache)** of all processes in the container's cgroup, **not just the Java Heap**.

A JVM's total memory footprint ($M_{total}$) is calculated as:

$$M_{total} = \text{Heap} + \text{Metaspace} + \text{Thread Stacks} + \text{Direct ByteBuffers (Netty/NIO)} + \text{CodeCache} + \text{GC Overhead} + \text{Native C/C++ Libraries}$$

When you set `-Xmx` to `1800MB` inside a `2048MB` cgroup, you leave only **248MB** for:
1. **Thread Stacks:** 200 concurrent HTTP threads $\times$ 1MB default stack = **200MB**.
2. **Netty Direct Memory:** Off-heap networking buffers for WebFlux or gRPC.
3. **Metaspace:** Spring Boot class metadata usually requires **120MB–180MB**.

The moment network traffic spikes, off-heap allocations push total process RSS to `2050MB`. The kernel immediately invokes `oom_killer` and sends `SIGKILL (9)`.

---

## 3. Kernel Diagnostic: Confirming the OOM Event

To verify that the host kernel dispatched the kill signal, inspect `dmesg` or `/var/log/messages` on the worker node:

```bash
dmesg -T | grep -E -i "oom_reaper|killed process"
```

Expected kernel output:
```text
[Mon Nov  3 01:38:05 2026] Memory cgroup out of memory: Killed process 38421 (java) total-vm:4918204kB, anon-rss:2097152kB, file-rss:1248kB, shmem-rss:0kB, UID:1000 pgtables:8204kB oom_score_adj:988
[Mon Nov  3 01:38:05 2026] oom_reaper: reaped process 38421 (java), now anon-rss:0kB, file-rss:0kB, shmem-rss:0kB
```

Notice `anon-rss:2097152kB` ($= 2048\text{ MB}$). The kernel killed the process precisely when anonymous pages hit the cgroup ceiling.

---

## 4. The Production Fix: Dynamic Percentage Tuning

Modern OpenJDK releases (Java 11+) are fully container-aware via `-XX:+UseContainerSupport` (enabled by default). Instead of hardcoding static `-Xmx` megabytes in your Dockerfile or startup scripts, leverage percentage-based sizing and restrict off-heap headroom.

### Before vs After Configuration

```diff
# In your Dockerfile or K8s Deployment args:

- ENV JAVA_OPTS="-Xms1800m -Xmx1800m"
+ ENV JAVA_OPTS="-XX:+UseContainerSupport \
+                -XX:MaxRAMPercentage=70.0 \
+                -XX:InitialRAMPercentage=50.0 \
+                -XX:MaxMetaspaceSize=256m \
+                -XX:ReservedCodeCacheSize=128m \
+                -XX:+ExitOnOutOfMemoryError"
```

### Explanation of Flags:
1. **`-XX:MaxRAMPercentage=70.0`**: Automatically allocates 70% of the container's cgroup limit to Heap ($2048\text{ MB} \times 0.70 = 1433\text{ MB}$). This guarantees 30% ($615\text{ MB}$) is reserved for Metaspace, thread stacks, and native buffers.
2. **`-XX:MaxMetaspaceSize=256m`**: Prevents runaway classloader memory leaks from consuming the remaining cgroup margin.
3. **`-XX:+ExitOnOutOfMemoryError`**: If an application-level heap exhaustion occurs, this forces the JVM to exit immediately with an informative exit code and log line before the Linux kernel kills it silently.

---

## 5. Kubernetes Resource Specification Best Practice

Align Kubernetes requests and limits to guarantee consistent Quality of Service (QoS):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: billing-service
spec:
  template:
    spec:
      containers:
        - name: app
          image: ideaspot360/billing-service:v1.4.2
          resources:
            requests:
              memory: "2Gi"
              cpu: "1000m"
            limits:
              memory: "2Gi"
              cpu: "2000m"
          env:
            - name: JAVA_TOOL_OPTIONS
              value: >-
                -XX:MaxRAMPercentage=70.0
                -XX:MaxMetaspaceSize=256m
                -XX:+HeapDumpOnOutOfMemoryError
                -XX:HeapDumpPath=/dumps/heapdump.hprof
```

By providing equal `requests.memory` and `limits.memory`, Kubernetes assigns the pod a **Guaranteed QoS class**, minimizing the probability of node-pressure eviction under tight cluster resources.

