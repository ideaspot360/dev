---
layout: post
title: "Production Post-Mortem: Linux TCP TIME_WAIT Socket Exhaustion and tcp_tw_reuse Pitfalls"
date: 2026-11-18 10:37:00 +0900
categories: [DevOps, Linux, Networking]
tags: [Linux, TCP, TIME_WAIT, Kernel, Networking, Troubleshooting]
---

An internal microservice API gateway handling 60,000 requests per second suddenly began throwing sporadic connection failures to downstream gRPC and HTTP backends. Latency spiked from 4ms to 3,200ms before client HTTP calls started cascading with `502 Bad Gateway` and `Cannot assign requested address (errno 99)`.

```text
2026-11-18 01:21:05.109 [error] 14210#14210: *2891901 connect() to 10.244.3.45:8080 failed (99: Cannot assign requested address) while connecting to upstream, client: 10.244.0.1, server: api.internal.svc, request: "POST /v1/orders/validate HTTP/1.1", upstream: "http://10.244.3.45:8080/v1/orders/validate"
2026-11-18 01:21:05.112 [alert] 14210#14210: worker process 14212 exited on signal 11
kernel: [104921.218] TCP: request_sock_TCP: Possible SYN flooding on port 8080. Sending cookies. Check SNMP counters.
```

## Production Specs
- **OS**: Ubuntu 24.04 LTS
- **Kernel**: Linux 6.8.0-31-generic x86_64
- **Architecture**: NGINX Ingress Proxy $\to$ Envoy Mesh $\to$ Go Backends
- **Ephemerial Port Range**: `ip_local_port_range = 32768 60999` (28,231 ports)
- **Active Outbound Connections**: ~28,000 in `TIME_WAIT` state

## System Mechanism: The 2MSL Timer & Quadruple Uniqueness
Under TCP (RFC 793), a connection is identified by a 4-tuple: `(src_ip, src_port, dst_ip, dst_port)`. When an active close is initiated (typically by the reverse proxy closing downstream HTTP/1.1 connections without keep-alive), the socket enters the `TIME_WAIT` state for `2 * MSL` (Maximum Segment Lifetime), which is hard-coded to 60 seconds in the Linux kernel (`TCP_TIMEWAIT_LEN`).

```
Proxy (Client)                                          Upstream Backend
      |                                                         |
      |------------------ FIN (Active Close) ------------------>|
      |<----------------- ACK ----------------------------------|
      |<----------------- FIN ----------------------------------|
      |------------------ ACK --------------------------------->|
      |                                                         |
  [TIME_WAIT]                                                [CLOSED]
  (Duration: 60s)
      |
   [CLOSED]
```

Why does `TIME_WAIT` exist?
1. **Preventing Stray Duplicate Segments**: To ensure delayed segments from the previous connection incarnation do not arrive and corrupt a new connection reusing the same 4-tuple.
2. **Reliable Termination**: If the proxy's final `ACK` is lost in transit, the upstream re-transmits its `FIN`. The proxy must remain in `TIME_WAIT` to respond with another `ACK`.

Because the proxy made short-lived connections to a single backend IP and port (`10.244.3.45:8080`), all 28,231 available ephemeral source ports were consumed in under 30 seconds:

$$\text{Port Exhaustion Rate} = \frac{28,231 \text{ ports}}{60 \text{ sec}} \approx 470 \text{ req/sec per backend}$$

Once the pool hit 28,231, kernel `connect()` syscalls failed immediately with `EADDRNOTAVAIL` (Errno 99: Cannot assign requested address).

## Common Anti-Patterns & Catastrophes
- **Enabling `tcp_tw_recycle`**: Deprecated and removed in Linux kernel 4.12+. If clients sit behind NAT, `tcp_tw_recycle` drops valid SYN packets due to per-IP timestamp skew.
- **Blindly lowering timeout via `so_linger`**: Setting `l.l_onoff = 1, l.l_linger = 0` sends a TCP `RST` to terminate abruptly without `TIME_WAIT`, breaking RFC compliance and causing data corruption on in-flight buffers.

## Root Cause & True Production Fixes
The outage was triggered because upstream HTTP client pools had keep-alive disabled (`Connection: close`), forcing tens of thousands of daily TCP handshakes and teardowns.

### Step 1: Kernel Tuning with `tcp_tw_reuse` and TCP Timestamps
Linux offers `net.ipv4.tcp_tw_reuse = 1`. Unlike the removed `tcp_tw_recycle`, `tcp_tw_reuse` is completely safe for outbound connections. It allows reusing a `TIME_WAIT` socket if the new outgoing timestamp is strictly greater than the last timestamp recorded on that connection (RFC 1323 / RFC 7323 PAWS).

```diff
--- /etc/sysctl.d/99-networking.conf.orig
+++ /etc/sysctl.d/99-networking.conf
@@ -10,6 +10,12 @@
 # Expand ephemeral port range
-net.ipv4.ip_local_port_range = 32768 60999
+net.ipv4.ip_local_port_range = 10240 65535
+
+# Enable safe TIME_WAIT reuse for outgoing sockets
+net.ipv4.tcp_timestamps = 1
+net.ipv4.tcp_tw_reuse = 1
+
+# Increase TCP backlog queue
+net.core.somaxconn = 65535
+net.ipv4.tcp_max_syn_backlog = 32400
```

Apply immediately:
```bash
sudo sysctl -p /etc/sysctl.d/99-networking.conf
```

### Step 2: Enabling HTTP Persistent Connections (Keep-Alive) in Reverse Proxy
The definitive architectural fix is reusing TCP sessions across requests:

```diff
--- /etc/nginx/conf.d/upstream.conf.orig
+++ /etc/nginx/conf.d/upstream.conf
@@ -2,6 +2,8 @@
 upstream order_backend {
     server 10.244.3.45:8080;
+    keepalive 256;
+    keepalive_requests 10000;
+    keepalive_timeout 65s;
 }

 server {
@@ -12,6 +14,8 @@
     location / {
         proxy_pass http://order_backend;
+        proxy_http_version 1.1;
+        proxy_set_header Connection "";
     }
 }
```

After deploying NGINX keep-alive and kernel `tcp_tw_reuse`, active `TIME_WAIT` sockets collapsed from 28,000+ to under 120, eliminating 99% of TCP handshake overhead and dropping p99 latency to 3.8ms.
