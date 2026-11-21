---
layout: post
title: "Resolving Linux TCP Listen Backlog Drops: net.core.somaxconn & tcp_max_syn_backlog Saturation Under High Connection Bursts"
date: 2026-12-11 10:15:24 +0900
category: Systems & Networking
tags: [Linux, Networking, TCP, DevOps, Kubernetes, Sysctl, Performance]
pair_id: pair_20261211
---

## 1. Production Incident Summary

During a high-concurrency flash promotion event on our distributed e-commerce platform, our ingress tier experienced an acute spike in connection latency and intermittent connection drops. The edge API Gateway (Envoy/Nginx) reported sudden waves of HTTP 502 Bad Gateway and 504 Gateway Timeout errors when routing traffic to backend microservice pods.

Upstream request p99 latency surged from a baseline of 18 milliseconds to over 3.2 seconds. While backend pod CPU utilization remained modest at approximately 42% and heap usage was stable, thousands of client connection handshakes either stalled or were dropped during burst intervals.

A preliminary check of the Linux kernel ring buffer on affected Kubernetes worker nodes revealed critical warnings from the TCP networking subsystem:

```text
[2026-12-11T01:14:22.841912+00:00] kernel: TCP: request_sock_TCP: Possible SYN flooding on port 8080. Dropping request.  Check SNMP counters.
[2026-12-11T01:14:23.109243+00:00] kernel: net_ratelimit: 412 callbacks suppressed
[2026-12-11T01:14:23.109248+00:00] kernel: TCP: request_sock_TCP: Possible SYN flooding on port 8080. Dropping request.  Check SNMP counters.
[2026-12-11T01:14:24.492011+00:00] kernel: TCP: possible SYN flooding on port 8080. Sending cookies.  Check SNMP counters.
```

Inspecting the network stack counters via `netstat -s` confirmed continuous packet drops and queue overflows at the socket layer:

```text
$ netstat -s | grep -i listen
    142982 times the listen queue of a socket overflowed
    142982 SYNs to LISTEN sockets dropped
```

At the application gateway layer, the upstream connection pool was repeatedly exhausted, throwing downstream timeouts:

```text
2026-12-11T01:14:24.901Z [error] 48#48: *849102 upstream timed out (110: Connection timed out) while connecting to upstream, client: 10.244.18.91, server: api.internal.store, request: "POST /v2/checkout/orders HTTP/1.1", upstream: "http://10.244.32.148:8080/v2/checkout/orders", host: "api.internal.store"
```

### Production Environment Specifications
* **Host Operating System**: Ubuntu 22.04.4 LTS (Linux Kernel 5.15.0-105-generic / 6.1 LTS)
* **Container Runtime**: containerd 1.7.15 on AWS EKS v1.28
* **Node Instance Type**: AWS EC2 c6i.4xlarge (16 vCPU, 32 GiB Memory, 12.5 Gbps network bandwidth)
* **Workload Stack**: Nginx Ingress Controller 1.9.4 fronting Java Spring Boot 3.2 (Embedded Tomcat 10.1) and Go microservices
* **Traffic Ingress Profile**: Baseline 12,000 req/sec ramping to 85,000 req/sec connection bursts within a 15-second window

---

## 2. Common Missteps & Failed Troubleshooting Attempts

When facing socket drops and "Possible SYN flooding" kernel messages, engineering teams frequently implement misguided configuration changes that worsen system reliability or cause immediate connection aborts.

### Misstep 1: Disabling SYN Cookies (`net.ipv4.tcp_syncookies = 0`)
* **Attempted Action**: Operating under the mistaken assumption that the "Sending cookies" log indicated an unnecessary defense mechanism causing latency, an engineer disabled TCP syncookies by setting `sysctl -w net.ipv4.tcp_syncookies=0`.
* **Failure Outcome**: Once the SYN backlog was exhausted during the subsequent burst, the kernel stopped generating cryptographically encoded initial sequence numbers (ISNs). Instead of buffering through syncookies, all incoming SYN packets were dropped immediately. This triggered complete connection starvation across the cluster.

### Misstep 2: Forcing TCP Abort on Overflow (`net.ipv4.tcp_abort_on_overflow = 1`)
* **Attempted Action**: To avoid client-side connection hangs, the team enabled `tcp_abort_on_overflow=1`, expecting that fast failure would enable cleaner client retries.
* **Failure Outcome**: By default, Linux silently ignores the final ACK packet when the Accept Queue is full, allowing the client to retransmit the ACK after exponential backoff while the backend application catches up. Setting `tcp_abort_on_overflow=1` caused the kernel to transmit an immediate `RST` (Reset) packet back to the client. This turned transient 1-second tail latency into permanent, instant 502 Bad Gateway errors across tens of thousands of consumer checkout requests.

### Misstep 3: Adjusting `net.core.somaxconn` While Ignoring the Application Socket Backlog
* **Attempted Action**: The team increased the OS-level parameter `net.core.somaxconn` from 128 to 65535, expecting an immediate resolution.
* **Failure Outcome**: The queue drops persisted. The Linux kernel determines the effective capacity of the completed connection queue by taking the minimum of two values:

$$\text{Effective Queue Size} = \min(\text{net.core.somaxconn}, \text{backlog})$$

Because Tomcat's embedded server had its default `acceptCount` hardcoded at 100 and Nginx's default socket listen directive omitted an explicit backlog (`listen 80;` defaults to 511), the kernel capped the listen queue at 100 entries regardless of the OS somaxconn setting.

---

## 3. Root Cause Analysis: Dual-Queue TCP Handshake Architecture in Linux Kernel

The root cause of this failure lies in the architectural division of labor between the kernel's **SYN Queue** (Incomplete Connection Queue) and **Accept Queue** (Completed Connection Queue), combined with undersized defaults designed decades ago for modest hardware.

![Linux TCP Listen Queue Architecture](diagram_tcp_listen_queue.png)

### The Dual-Queue Mechanics of the TCP 3-Way Handshake

Under the Linux networking stack (`net/ipv4/tcp_input.c` and `net/core/request_sock.c`), an incoming connection proceeds through two distinct kernel queues before an application process retrieves the established socket descriptor via `accept()`:

```text
Client                              Linux Kernel Network Stack                       User Application
  │                                           │                                              │
  │─────── [1] SYN (Seq=x) ──────────────────>│                                              │
  │                                           │ 1. Allocates request_sock                    │
  │                                           │ 2. Places into SYN Queue (Half-Open)         │
  │                                           │    Limit: net.ipv4.tcp_max_syn_backlog       │
  │                                           │                                              │
  │<────── [2] SYN+ACK (Seq=y, Ack=x+1) ──────│                                              │
  │                                           │                                              │
  │─────── [3] ACK (Ack=y+1) ─────────────────>│                                              │
  │                                           │ 1. Validates 3-way handshake completion     │
  │                                           │ 2. Removes socket from SYN Queue             │
  │                                           │ 3. Moves socket into Accept Queue (Full)     │
  │                                           │    Limit: min(somaxconn, app_backlog)        │
  │                                           │                                              │
  │                                           │<────── [4] accept() Syscall ─────────────────│
  │                                           │        Pulls established socket from queue   │
  │                                           │                                              │
```

#### 1. The SYN Queue (Half-Open Sockets / `SYN_RECV`)
When a client sends an initial `SYN` packet, the kernel creates a lightweight `request_sock` data structure and assigns the socket to the `SYN_RECV` state within the SYN queue. The ceiling of this queue is governed by:
* `net.ipv4.tcp_max_syn_backlog` (Historically defaulted to 128 or 1024).

#### 2. The Accept Queue (Fully Established Sockets / `ESTABLISHED`)
When the client replies with the final `ACK` packet completing the three-way handshake, the kernel moves the connection from the SYN queue into the Accept Queue (`icsk_accept_queue`). The socket enters the `ESTABLISHED` state, awaiting the user-space process to invoke `accept()` or `accept4()`. The maximum depth of this queue is:
* `min(net.core.somaxconn, backlog_parameter_in_listen_syscall)`
* The default `net.core.somaxconn` on older Linux kernels was 128, and on modern distributions is 4096.

### The Mechanism of Connection Drops During Traffic Surges

When a sudden traffic spike arrives:
1. Thousands of connections finish their 3-way handshake almost instantaneously.
2. If application worker threads are momentarily blocked by garbage collection, database connection pool locks, or slow I/O, the rate of `accept()` syscalls drops below the incoming connection rate.
3. The Accept Queue fills to its capacity:

$$\text{Current Queue Depth} \ge \min(\text{somaxconn}, \text{backlog})$$

4. When a new ACK packet arrives for a half-open socket, the kernel detects that the Accept Queue is saturated in `tcp_v4_syn_recv_sock()`.
5. Instead of rejecting the connection outright (unless `tcp_abort_on_overflow=1`), the kernel drops the ACK packet and leaves the socket in the SYN queue, or drops new incoming SYN packets altogether.
6. The client waits for `TCP Initial Retransmission Timeout` (typically 1 second, then 3 seconds, then 9 seconds). From the client's perspective, the connection attempts hang, leading to timeout errors in reverse proxies and connection failure cascades.
7. Concurrently, the kernel increments the `ListenOverflows` and `ListenDrops` SNMP counters.

---

## 4. Step-by-Step Remediation & Unified Diff

To eliminate connection drops under burst traffic, we executed a synchronized remediation across the host operating system kernel, the ingress reverse proxy, and the application runtime.

### Step 1: Kernel Parameter Tuning via Sysctl
We tuned host networking limits to accommodate burst depths up to 65,535 connections per socket, while maintaining SYN cookies enabled to handle hostile connection patterns:

```diff
--- a/etc/sysctl.d/99-network-tuning.conf
+++ b/etc/sysctl.d/99-network-tuning.conf
@@ -1,8 +1,20 @@
-# Legacy Default Networking Configuration
-net.core.somaxconn = 4096
-net.ipv4.tcp_max_syn_backlog = 1024
-net.ipv4.tcp_syncookies = 1
-net.ipv4.tcp_abort_on_overflow = 0
+# High-Throughput Production Tuning for Burst Connections
+# 1. Enlarge Accept Queue ceiling for all listening sockets
+net.core.somaxconn = 65535
+
+# 2. Enlarge SYN Queue capacity for half-open handshakes
+net.ipv4.tcp_max_syn_backlog = 65535
+
+# 3. Expand incoming packet queue on the network interface layer
+net.core.netdev_max_backlog = 16384
+
+# 4. Keep SYN cookies enabled as fallback when SYN queue saturates
+net.ipv4.tcp_syncookies = 1
+
+# 5. Maintain tcp_abort_on_overflow at 0 to drop rather than RST
+net.ipv4.tcp_abort_on_overflow = 0
+
+# 6. Reuse TIME_WAIT sockets for outgoing connections safely
+net.ipv4.tcp_tw_reuse = 1
```

### Step 2: Nginx Ingress Controller Socket Configuration
We updated Nginx listen directives to explicitly set the socket backlog to match the kernel limit, preventing the 511 default clamp:

```diff
--- a/k8s/ingress/nginx-configmap.yaml
+++ b/k8s/ingress/nginx-configmap.yaml
@@ -10,6 +10,12 @@ data:
   worker-processes: "auto"
   worker-connections: "65535"
   worker-rlimit-nofile: "131072"
+  
+  # Socket Backlog and Buffer Optimization
+  backlog: "65535"
+  reuse-port: "true"
+  keepalive-requests: "10000"
+  keepalive-timeout: "65s"
```

### Step 3: Application Server Socket Backlog Tuning (Spring Boot / Netty)
We increased the application-level listen backlog in Spring Boot to ensure that when Tomcat initializes the server socket, it requests an expanded buffer from the operating system:

```diff
--- a/src/main/resources/application.yml
+++ b/src/main/resources/application.yml
@@ -14,6 +14,11 @@ server:
   port: 8080
   tomcat:
     threads:
       max: 400
       min-spare: 50
-    accept-count: 100
+    # Matches kernel somaxconn capacity to prevent early drops
+    accept-count: 8192
+    max-connections: 16384
```

---

## 5. Verification Record & Live CLI Diagnostics

After applying the configuration changes via a rolling update, we performed comprehensive diagnostic checks on the production clusters using standard network utilities.

### Verifying Socket Queue Capacity with `ss`

We used `ss -lnt` to inspect the `Send-Q` column, which indicates the maximum backlog capacity of a socket in the `LISTEN` state:

```text
$ ss -lnt '( sport = :8080 or sport = :80 )'
State      Recv-Q  Send-Q   Local Address:Port   Peer Address:Port  Process
LISTEN     0       8192           0.0.0.0:8080        0.0.0.0:*      users:(("java",pid=14201,fd=48))
LISTEN     0       65535          0.0.0.0:80          0.0.0.0:*      users:(("nginx",pid=819,fd=6))
```

* **Prior to fix**: `Send-Q` for port 8080 was clamped at `100`, and port 80 was clamped at `511`.
* **Post-fix**: `Send-Q` accurately reflects the tuned application backlog (`8192` for Tomcat, `65535` for Nginx).

### Verification of Kernel Counter Stability

During a follow-up 90,000 req/sec synthetic load injection using k6 and Locust, we monitored kernel SNMP drops continuously:

```bash
# Monitor socket queue overflows and drops in real-time
watch -n 1 "netstat -s | grep -E -i 'overflowed|dropped|cookies'"
```

Output recorded over a 30-minute stress window:

```text
Every 1.0s: netstat -s | grep -E -i 'overflowed|dropped|cookies'
    0 times the listen queue of a socket overflowed
    0 SYNs to LISTEN sockets dropped
    0 TCP sockets finished a connect()
```

### End-to-End Metric Comparison Table

| Metric | Before Tuning (Default Stack) | After Tuning (Synchronized Stack) | Verification Tool / Command |
| :--- | :--- | :--- | :--- |
| **Accept Queue Limit (`Send-Q`)** | 100 (Tomcat) / 511 (Nginx) | 8,192 (Tomcat) / 65,535 (Nginx) | `ss -lnt` |
| **`ListenOverflows` Rate** | ~1,200 events / sec | 0 events / sec | `netstat -s \| grep overflowed` |
| **`ListenDrops` Rate** | ~1,200 events / sec | 0 events / sec | `netstat -s \| grep dropped` |
| **Ingress 502 / 504 Errors** | 4.82% of all burst requests | 0.00% across 500k requests | Prometheus / Envoy metrics |
| **Upstream p99 Latency** | 3,240 ms (3s SYN backoff) | 22 ms | Edge Gateway access logs |
| **Client Connection Success Rate**| 95.18% | 100.00% | k6 Distributed Load Test |

---

## 6. Long-Term Architectural Recommendations

Preventing connection queue starvation requires proactive architectural practices beyond simple sysctl modifications.

1. **Synchronize OS and Application Limits via Baseline Images**: Ensure that base container images or node initialization DaemonSets standardize `net.core.somaxconn=65535` and `net.ipv4.tcp_max_syn_backlog=65535` across all infrastructure nodes. Always audit application server templates to ensure their embedded backlog parameters match.
2. **Implement Automated Socket Overflow Prometheus Alerts**: Deploy node-exporter alert rules that trigger on non-zero rates of `node_netstat_TcpExt_ListenOverflows` and `node_netstat_TcpExt_ListenDrops`. These counters indicate socket starvation before user-facing error rates spike.
3. **Employ HTTP Keep-Alive and Connection Pooling**: High connection churn is the primary trigger of listen queue overflow. By maintaining persistent HTTP keep-alive connections between reverse proxies and upstream services, backend pods process requests over existing sockets rather than conducting a fresh 3-way handshake for every transaction.
4. **Tune Worker Processing Threads**: A large listen queue provides a buffer against temporary spikes, but if application threads cannot keep pace with incoming throughput, even an expanded queue will eventually fill. Ensure that CPU reservations, thread pools, and non-blocking I/O routines are sized appropriately to continuously drain the accept queue.
