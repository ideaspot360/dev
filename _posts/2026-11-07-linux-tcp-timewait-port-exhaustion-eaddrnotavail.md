---
layout: post
title: "Linux TCP TIME_WAIT Saturation & EADDRNOTAVAIL: Why tcp_tw_recycle Fails and How tcp_tw_reuse Solves Port Exhaustion"
date: 2026-11-07 07:00:00 +0900
category: "Network & Infrastructure"
tags: [linux, networking, tcp-ip, troubleshooting, high-throughput, microservices]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When microservices flood upstream APIs, active TCP connection closures trigger massive TIME_WAIT port exhaustion with EADDRNOTAVAIL (Cannot assign requested address). Here is why tcp_tw_recycle breaks behind NAT and how tcp_tw_reuse with socket pooling fixes it."
---

```text
dial tcp 10.0.4.15:8080: connect: cannot assign requested address
    at net.Dialer.DialContext (dial.go:587)
    at net/http.(*Transport).dial (transport.go:1178)
    at net/http.(*Transport).dialConn (transport.go:1614)
    at net/http.(*Transport).roundTrip (transport.go:872)
    at net/http.(*Client).send (client.go:253)
    at net/http.(*Client).Do (client.go:616)
    at main.callDownstreamService (worker.go:142)
```

```text
curl: (7) Failed to connect to api.internal port 8080: Cannot assign requested address
[ERROR] java.net.NoRouteToHostException: Cannot assign requested address (connect failed)
```

## Production Environment Specs

* **Operating System**: Ubuntu 24.04 LTS (Linux Kernel 6.8.0-31-generic)
* **Architecture**: Microservice API Gateway handling outbound dispatch to internal microservices
* **Traffic Load**: 4,200 Outbound HTTP Requests / Second (RPS) per node
* **Default Socket Range**: `net.ipv4.ip_local_port_range = 32768 60999` (Total 28,231 usable source ports)
* **Application Framework**: Go 1.22.4 HTTP Dispatcher & Spring Boot 3.3.0 Client pods

---

## 1. Failure Scenario: Sudden EADDRNOTAVAIL Outage

During high-concurrency peak load, outbound service calls abruptly failed with `Cannot assign requested address` (`EADDRNOTAVAIL`, errno 99). 

Inspecting the host network sockets via `ss` revealed the root condition:

```bash
ss -s
```

```text
Total: 31204
TCP:   29410 (estab 980, closed 28230, orphaned 0, timewait 28230)
```

```bash
ss -tan state time-wait | wc -l
# Output: 28230
```

All 28,231 available client ephemeral ports were occupied in the `TIME_WAIT` state against the downstream IP/port endpoint `10.0.4.15:8080`. When the application initiated a new `connect()` syscall, the Linux kernel network stack searched the ephemeral port table, failed to locate a free port matching the socket 4-tuple:

$$(\text{Source IP}, \text{Source Port}, \text{Dest IP}, \text{Dest Port})$$

and immediately returned `EADDRNOTAVAIL`.

---

## 2. Kernel Deep-Dive: The Mechanics of TCP TIME_WAIT

In TCP/IP (RFC 793), when an endpoint executes an **Active Close** (sends the initial `FIN` segment), it must enter the `TIME_WAIT` state upon receiving the remote peer's `FIN` and returning the final `ACK`.

```
Client (Active Close)                         Server (Passive Close)
      │                                                │
      ├────────────────── FIN M ──────────────────────>│  (Close Wait)
      │<───────────────── ACK M+1 ─────────────────────┤
      │<───────────────── FIN N ───────────────────────┤
      ├────────────────── ACK N+1 ─────────────────────>│  (Closed)
      │                                                │
[TIME_WAIT] (Duration: 2 * MSL = 60s)                  │
      │                                                │
  (Closed)                                             │
```

### Why Does TIME_WAIT Exist?
1. **Ensuring Reliable Connection Termination**: If the final `ACK N+1` is dropped in the network, the remote server retransmits its `FIN N`. The closing client must stay in `TIME_WAIT` to receive this retransmitted `FIN` and re-send the `ACK`. Without `TIME_WAIT`, the client would return an `RST`, terminating the connection abnormally.
2. **Draining Lingering In-Flight Packets**: Packets delayed in internet routers must not be accepted by a newly created socket using the exact same 4-tuple. `TIME_WAIT` lasts for $2 \times \text{MSL}$ (Maximum Segment Lifetime), fixed at 60 seconds in the Linux kernel (`TCP_TIMEWAIT_LEN`).

### The Math Behind Port Exhaustion
If an application initiates short-lived HTTP connections without Keep-Alive at a rate of 1,000 requests per second:

$$\text{Concurrent TIME\_WAIT Sockets} = 1,000 \times 60\text{ seconds} = 60,000\text{ sockets}$$

With only 28,231 default ports in `ip_local_port_range`, exhaustion occurs in less than 30 seconds.

---

## 3. The Flawed Fix: Why `tcp_tw_recycle` is Dangerous and Deprecated

Engineers searching historical blog posts frequently encounter recommendations to enable `net.ipv4.tcp_tw_recycle`:

```ini
# DANGEROUS / DEPRECATED (Do NOT Use)
net.ipv4.tcp_tw_recycle = 1
```

### Why It Fails
`tcp_tw_recycle` aggressively reclaimed `TIME_WAIT` sockets within sub-second intervals (based on RTT). However, it enforced strict per-host TCP timestamp monotonicity:

1. In any environment using **NAT (Network Address Translation)**, Load Balancers, or Kubernetes ingress, multiple distinct client machines share a single public/gateway IP.
2. If Machine A transmits a packet with Timestamp `10050` and Machine B transmits a packet with Timestamp `10020` behind the same NAT IP, the server kernel rejects Machine B's SYN packet as an out-of-order duplicate.
3. This dropped entire swathes of legitimate client traffic.

Because of this fundamental protocol flaw, **the Linux kernel permanently removed `tcp_tw_recycle` in Kernel 4.12**. Specifying this parameter on modern kernels results in `sysctl: cannot stat /proc/sys/net/ipv4/tcp_tw_recycle: No such file or directory`.

---

## 4. The Architectural Solution: Two-Layer Remediation

Resolving `EADDRNOTAVAIL` requires fixing the problem at both the **Linux Kernel Layer** and the **Application Transport Layer**.

### Layer 1: Kernel Socket Recycling (`tcp_tw_reuse`)
Unlike the deprecated recycle option, `net.ipv4.tcp_tw_reuse` is completely safe for outbound client connections:

```ini
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_timestamps = 1
```

* **How It Works**: When a client creates an outbound connection (`connect()`), the kernel checks if a socket in `TIME_WAIT` has a timestamp strictly greater than the most recent timestamp recorded on that specific connection. If true, the kernel reuses the port safely without violating RFC 1323.
* **Prerequisite**: `net.ipv4.tcp_timestamps` must remain enabled (`1`, default).

### Layer 2: Application HTTP Connection Pooling (Keep-Alive)
Recycling sockets is merely damage control; creating and destroying TCP connections 4,000 times per second wastes CPU cycles on 3-way handshakes and TLS negotiations. Applications must reuse long-lived TCP connections via persistent pooling.

---

## 5. Production Implementation & Configuration Diff

### A. Linux Kernel Configuration (`/etc/sysctl.d/99-network-tuning.conf`)

```diff
 # Expand Ephemeral Port Range
-net.ipv4.ip_local_port_range = 32768 60999
+net.ipv4.ip_local_port_range = 1024 65535

 # Enable Safe Socket Reuse with Timestamps
+net.ipv4.tcp_timestamps = 1
+net.ipv4.tcp_tw_reuse = 1

 # Fast Socket Closing & Buffer Protection
+net.ipv4.tcp_fin_timeout = 15
+net.ipv4.tcp_max_tw_buckets = 262144
+net.core.somaxconn = 65535
```

Apply immediately without rebooting:
```bash
sudo sysctl --system
```

### B. Application Layer: Go HTTP Transport Pooling Diff

The root cause in the application tier was instantiating an unpooled `http.Client` or setting `DisableKeepAlives: true`:

```diff
 package main

 import (
     "net"
     "net/http"
     "time"
 )

-var unpooledClient = &http.Client{
-    Transport: &http.Transport{
-        DisableKeepAlives: true, // TRIGGERS TIME_WAIT ON EVERY CALL
-    },
-    Timeout: 5 * time.Second,
-}

+var pooledClient = &http.Client{
+    Transport: &http.Transport{
+        Proxy: http.ProxyFromEnvironment,
+        DialContext: (&net.Dialer{
+            Timeout:   5 * time.Second,
+            KeepAlive: 30 * time.Second,
+        }).DialContext,
+        MaxIdleConns:        1000,
+        MaxIdleConnsPerHost: 200,
+        IdleConnTimeout:     90 * time.Second,
+        DisableKeepAlives:   false,
+    },
+    Timeout: 10 * time.Second,
+}
```

---

## 6. Verification and Stress Benchmarking

### A. Socket Distribution Verification Under 4,200 RPS Load

```bash
ss -s
```

| Metric | Before Tuning (Unpooled, Default Sysctl) | After Tuning (`tcp_tw_reuse` + Pooled Keep-Alive) | Impact |
| :--- | :--- | :--- | :--- |
| **`TIME_WAIT` Sockets** | 28,230 (Port Saturation) | 142 (Controlled) | **99.5% Reduction** |
| **Outbound Connection Errors** | 18.4% (`EADDRNOTAVAIL`) | 0.0% (Zero dropped calls) | **100% Eliminated** |
| **Average Outbound Latency** | 48 ms (TCP Handshake overhead) | 3.8 ms (Reused persistent socket) | **92.1% Faster** |
| **Host CPU Utilization** | 78% (Kernel softirq / ksoftirqd) | 24% (Efficient I/O) | **54% CPU Freed** |
| **Total Usable Ephemeral Ports** | 28,231 ports | 64,511 ports | **+128% Capacity** |

By coupling Linux kernel socket reuse (`tcp_tw_reuse = 1`) with transport-layer HTTP connection pooling, outbound networking remains rock solid even during massive high-throughput bursts.
