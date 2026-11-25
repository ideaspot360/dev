---
layout: post
title: "Production Post-Mortem: Linux TCP TIME_WAIT Socket Exhaustion, 2MSL Mechanics, and tcp_tw_reuse Pitfalls"
date: 2026-11-18 10:37:42 +0900
category: "Systems & Networking"
categories: ["Systems & Networking"]
tags: [Linux, Networking, TCP, Kernel, TIME_WAIT, sysctl, Troubleshooting, DevOps]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When high-throughput API gateway nodes communicate with downstream microservices, rapid connection churn consumes ephemeral ports and triggers catastrophic TIME_WAIT socket exhaustion with 'Cannot assign requested address (errno 99)'. Here is an architectural deep dive into 2MSL lifecycle physics (RFC 9293), TCP timestamps and PAWS (RFC 7323), tcp_twsk_unique kernel logic (tcp_ipv4.c) with CVE-2024-36904 refcounting hardening, why tcp_tw_recycle was excised in Linux 4.12, why tcp_tw_reuse=2 fails outside loopback, why SO_REUSEADDR does not prevent outbound port starvation, and how to achieve zero-handshake upstream pooling with NGINX, Go, and Envoy."
verification_date: "2026-11-23"
fact_check_sources:
  - "https://docs.kernel.org/networking/ip-sysctl.html"
  - "https://www.rfc-editor.org/rfc/rfc9293.html"
  - "https://www.rfc-editor.org/rfc/rfc7323.html"
  - "https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=4396e46187ca5070219b81773c3caf238348d6de"
  - "https://github.com/torvalds/linux/blob/master/net/ipv4/tcp_ipv4.c"
  - "https://github.com/torvalds/linux/blob/master/include/net/tcp.h"
  - "https://man7.org/linux/man-pages/man7/tcp.7.html"
  - "https://nginx.org/en/docs/http/ngx_http_upstream_module.html"
---

During a sudden traffic surge scaling to 62,000 requests per second across an internal edge routing cluster, an API gateway proxy cluster began dropping outbound backend RPC calls [Source: Linux Programmer's Manual — tcp(7)](https://man7.org/linux/man-pages/man7/tcp.7.html). System latency spiked from 3.8ms to over 3,200ms before client HTTP calls cascaded into `502 Bad Gateway` failures caused by OS-level socket allocation rejections:

```text
2026-11-18 01:21:05.109 [error] 14210#14210: *2891901 connect() to 10.244.3.45:8080 failed (99: Cannot assign requested address) while connecting to upstream, client: 10.244.0.1, server: api.internal.svc, request: "POST /v1/orders/validate HTTP/1.1", upstream: "http://10.244.3.45:8080/v1/orders/validate"
2026-11-18 01:21:05.112 [alert] 14210#14210: worker process 14212 exited on signal 11
kernel: [104921.218] TCP: request_sock_TCP: Possible SYN flooding on port 8080. Sending cookies. Check SNMP counters.
```

Concurrent Go backend clients running inside the service mesh recorded matching transport-level dialing aborts:

```text
2026-11-18T01:21:05.114Z ERROR worker/pool.go:184 failed to dispatch request to checkout backend {"error": "dial tcp 10.244.3.45:8080: connect: cannot assign requested address", "attempt": 3, "endpoint": "10.244.3.45:8080"}
net/http.(*Transport).dialConn(0xc00045e000, {0x18e76a0, 0xc00012e180})
    /usr/local/go/src/net/http/transport.go:1614 +0xc45
net/http.(*Transport).roundTrip(0xc00045e000, 0xc000520000)
    /usr/local/go/src/net/http/transport.go:872 +0x3c8
```

Direct probing with `curl` from the gateway host confirmed complete ephemeral port starvation against that upstream endpoint:

```bash
curl -Iv http://10.244.3.45:8080/health
# Output:
# *   Trying 10.244.3.45:8080...
# * Immediate connect fail for 10.244.3.45: Cannot assign requested address
# * Closing connection 0
# curl: (7) Failed to connect to 10.244.3.45 port 8080: Cannot assign requested address
```

---

## Production Environment Specs

* **Operating System**: Ubuntu 24.04 LTS (Linux Kernel 6.8.0-31-generic x86_64) [Source: Linux Kernel Documentation — ip-sysctl](https://docs.kernel.org/networking/ip-sysctl.html)
* **Compute Infrastructure**: 8x AWS EC2 `c6i.4xlarge` (16 vCPU, 32 GiB RAM, 12.5 Gbps network interface)
* **Ingress / Edge Tier**: NGINX 1.26.0 Reverse Proxy forwarding to internal Go 1.22.4 microservices
* **Service Mesh & Proxy**: Envoy Proxy v1.30.1 sidecars running within Kubernetes v1.30 on AWS EKS
* **Network Stack Defaults**:
  * Ephemeral Port Range: `net.ipv4.ip_local_port_range = 32768 60999` (Total 28,232 source ports)
  * TCP Timestamps: `net.ipv4.tcp_timestamps = 1` (RFC 7323 enabled)
  * TIME_WAIT Reuse: `net.ipv4.tcp_tw_reuse = 2` (Linux kernel default: loopback only)
  * Connection Tracking: `net.netfilter.nf_conntrack_max = 524288`
* **Upstream Topology**: Single virtual IP / Kubernetes ClusterIP (`10.244.3.45:8080`) backed by 24 container pods

---

## 1. Root Cause Analysis: The 2MSL State Machine and Ephemeral Port Mathematics

When an application socket closes, the underlying transport protocol must satisfy strict data integrity guarantees established in RFC 9293 (which formally replaced RFC 793) [Source: RFC 9293 — Transmission Control Protocol Specification](https://www.rfc-editor.org/rfc/rfc9293.html).

### 1.1 The TCP 4-Tuple and Active Close Sequence

Every active TCP session across an IP network is uniquely indexed in kernel hash tables by an immutable 4-tuple:

$$(\text{Source IP}, \text{Source Port}, \text{Destination IP}, \text{Destination Port})$$

In a reverse proxy or API gateway architecture connecting to a consolidated internal backend service:
* $\text{Source IP} = 10.244.0.15$ (Gateway node egress IP, constant)
* $\text{Destination IP} = 10.244.3.45$ (Internal Service ClusterIP, constant)
* $\text{Destination Port} = 8080$ (Service HTTP port, constant)

Because three parameters of the 4-tuple remain fixed, **the kernel possesses only one degree of freedom: the ephemeral Source Port**.

The endpoint that sends the initial `FIN` segment initiates an **Active Close** and transitions through the following finite state machine:

```
Gateway Proxy (Active Closer)                            Upstream Backend (Passive Closer)
     |                                                                   |
     |--- [FIN] (seq=u, ack=v) ----------------------------------------->|  (ESTABLISHED -> CLOSE_WAIT)
     |    (ESTABLISHED -> FIN_WAIT_1)                                    |
     |<-- [ACK] (seq=v, ack=u+1) ----------------------------------------|
     |    (FIN_WAIT_1 -> FIN_WAIT_2)                                     |
     |                                                                   |
     |<-- [FIN] (seq=w, ack=u+1) ----------------------------------------|  (CLOSE_WAIT -> LAST_ACK)
     |--- [ACK] (seq=u+1, ack=w+1) ------------------------------------->|  (LAST_ACK -> CLOSED)
     |    (FIN_WAIT_2 -> TIME_WAIT)                                      |
     |                                                                   |
 [TIME_WAIT]                                                          [CLOSED]
 (Dwells for 2 * MSL = 60s)
     |
  [CLOSED]
```

### 1.2 Why the 2MSL Timer Exists

Under RFC 9293, the `TIME_WAIT` state serves two distinct safety requirements:

1. **Graceful Teardown of the 4-Way Handshake**: If the gateway's final `ACK` is dropped by the underlying network, the upstream backend times out and re-transmits its `FIN`. If the gateway closed the socket immediately, it would respond to the re-transmitted `FIN` with a `RST`, informing the backend that an unhandled transport error occurred rather than a clean closure.
2. **Preventing Stray Duplicate Segment Corruption**: IP packets can be delayed, buffered, or routed across divergent paths. If a new connection were permitted to immediately reuse the identical 4-tuple `(10.244.0.15:42100, 10.244.3.45:8080)`, a delayed duplicate segment from the prior incarnation could arrive within the new connection's sequence window, injecting corrupt payload data directly into application memory.

In the Linux kernel, Maximum Segment Lifetime ($MSL$) is defined as 30 seconds [Source: Linux Kernel Source — include/net/tcp.h](https://github.com/torvalds/linux/blob/master/include/net/tcp.h). The total duration for `TIME_WAIT` ($2 \times MSL$) is hardcoded in the kernel source:

```c
/* include/net/tcp.h */
#define TCP_TIMEWAIT_LEN (60*HZ) /* how long to wait to destroy TIME-WAIT state, about 60 seconds */
```

### 1.3 Mathematical Proof of Port Exhaustion Rate

Under default Linux parameters, the ephemeral port allocation pool is governed by:

$$\text{Port Count } N = \text{ip\_local\_port\_range}_{\text{high}} - \text{ip\_local\_port\_range}_{\text{low}} + 1$$
$$N = 60,999 - 32,768 + 1 = 28,232\text{ ports}$$

If an upstream HTTP client or reverse proxy disables HTTP keep-alive, each request demands an independent TCP 3-way handshake and 4-way teardown. Each completed request leaves one ephemeral port trapped in `TIME_WAIT` for exactly 60 seconds.

The steady-state saturation threshold of concurrent `TIME_WAIT` sockets under request rate $R$ (requests/second) is:

$$S_{\text{timewait}} = R \times 2MSL = R \times 60$$

Setting $S_{\text{timewait}} = N = 28,232$ yields the critical throughput limit before total starvation:

$$R_{\text{max}} = \frac{28,232\text{ ports}}{60\text{ seconds}} \approx 470.53\text{ requests/second per target IP:port}$$

When the API gateway routed 4,200 non-pooled requests per second to `10.244.3.45:8080`, all 28,232 ephemeral ports were exhausted in:

$$t_{\text{exhaustion}} = \frac{28,232}{4,200} \approx 6.72\text{ seconds}$$

Once all 28,232 ports were occupied, every subsequent `connect()` syscall issued by NGINX or Go failed immediately with `EADDRNOTAVAIL` (Errno 99: *Cannot assign requested address*).

---

## 2. Kernel Deep Dive: `tcp_twsk_unique` and the `tcp_tw_reuse` Decision Logic

To mitigate ephemeral port depletion without breaking data integrity, the Linux kernel provides socket recycling logic implemented in `net/ipv4/tcp_ipv4.c` [Source: Linux Kernel Source — net/ipv4/tcp_ipv4.c](https://github.com/torvalds/linux/blob/master/net/ipv4/tcp_ipv4.c).

### 2.1 The Outbound Socket Allocation Path

When an application invokes `connect()`, the kernel path traverses:

$$\text{sys\_connect()} \longrightarrow \text{tcp\_v4\_connect()} \longrightarrow \text{inet\_hash\_connect()} \longrightarrow \text{\_\_inet\_check\_established()} \longrightarrow \text{tcp\_twsk\_unique()}$$

Inside `__inet_check_established()`, the kernel scans hash buckets for matching 4-tuples. If an existing socket in `TIME_WAIT` (`struct inet_timewait_sock`) matches the requested 4-tuple, the kernel invokes the protocol handler's `twsk_unique` callback:

```c
/* net/ipv4/tcp_ipv4.c - Kernel 6.8 Implementation */
int tcp_twsk_unique(struct sock *sk, struct sock *sktw, void *twp)
{
    const struct inet_timewait_sock *tw = inet_twsk(sktw);
    const struct tcp_timewait_sock *tcptw = tcp_twsk(sktw);
    struct tcp_sock *tp = tcp_sk(sk);
    int reuse = READ_ONCE(sock_net(sk)->ipv4.sysctl_tcp_tw_reuse);

    /* Disallow reuse if socket transitioned via FIN_WAIT_2 abort */
    if (READ_ONCE(tw->tw_substate) == TCP_FIN_WAIT2)
        reuse = 0;

    /* tcp_tw_reuse = 2 restricts reuse strictly to loopback traffic */
    if (reuse == 2) {
        struct inet_sock *inet = inet_sk(sk);

        if (READ_ONCE(tw->tw_substate) != TCP_TIME_WAIT ||
            !ipv4_is_loopback(inet->inet_daddr))
            return 0;
    }

    if (tcptw->tw_ts_recent_stamp &&
        (!twp || (reuse && (ktime_get_seconds() - tcptw->tw_ts_recent_stamp > 1)))) {
        /* Safe atomic refcount acquisition to prevent hashdance race (CVE-2024-36904) */
        if (unlikely(!refcount_inc_not_zero(&sktw->sk_refcnt)))
            return 0;

        /* Advance sequence number beyond max unscaled window (65535) + 2 */
        u32 seq = tcptw->tw_snd_nxt + 65535 + 2;

        if (!seq)
            seq = 1;
        WRITE_ONCE(tp->write_seq, seq);
        tp->rx_opt.ts_recent = tcptw->tw_ts_recent;
        tp->rx_opt.ts_recent_stamp = tcptw->tw_ts_recent_stamp;
        return 1;
    }
    return 0;
}
```

### 2.2 PAWS Verification (RFC 7323) and Sequence Spacing

Socket reuse via `tcp_twsk_unique` is safe only because of **PAWS (Protection Against Wrapped Sequences)**, standardized in RFC 7323 (which obsoleted RFC 1323) [Source: RFC 7323 — TCP Extensions for High Performance](https://www.rfc-editor.org/rfc/rfc7323.html), combined with explicit sequence space offsets:

1. **TCP Timestamp Options**: Each TCP segment transmits a 32-bit timestamp option: `TSval` (sender clock) and `TSecr` (echoed receiver clock).
2. **Initial Sequence Offset**: When `tcp_twsk_unique()` recycles a `TIME_WAIT` socket, it advances the outgoing sequence number:
   $$\text{seq} = tcptw\to\text{tw\_snd\_nxt} + 65,535 + 2$$
   $$\text{WRITE\_ONCE}(tp\to\text{write\_seq}, \text{seq})$$
   The $+65,535$ component matches the maximum unscaled TCP receive window ($2^{16} - 1$), while $+2$ ensures strict sequence progression. This guarantees that even if the remote peer's receive window remained completely open, delayed duplicate segments from the old incarnation cannot fall within the initial sequence window of the new connection.
3. **Timestamp Invalidation**: If an old, wandering duplicate segment arrives from the previous incarnation, the receiver compares the segment's `TSval` against `ts_recent`. Because the new incarnation uses strictly newer timestamps ($TSval_{\text{new}} > TSval_{\text{old}}$), the receiver identifies the stray segment as stale via PAWS and drops it immediately.
4. **Refcount Race Safety (CVE-2024-36904)**: During the `inet_twsk_hashdance()` table insertion, `tcp_twsk_unique` uses `refcount_inc_not_zero(&sktw->sk_refcnt)` rather than an unconditional `sock_hold()`. If another CPU core is concurrently freeing or initializing the socket (`refcnt == 0`), the kernel safely aborts recycling rather than corrupting memory with a Use-After-Free.

---

## 3. Common Missteps: Five Dangerous Workarounds and Flawed Fixes

During the incident triage, engineering teams attempted several common workarounds that introduced severe regressions or failed to resolve the outage.

### Misstep 1: Attempting to Enable the Excised `tcp_tw_recycle`

* **The Flawed Fix**: Engineers attempted to enable rapid socket recycling by injecting the removed and deprecated `net.ipv4.tcp_tw_recycle = 1` parameter into sysctl.
* **Why It Failed**: 
  1. `net.ipv4.tcp_tw_recycle` was **permanently removed from the Linux kernel in release 4.12** via commit `4396e46187ca5070219b81773c3caf238348d6de` authored by Eric Dumazet [Source: Linux Kernel Commit 4396e46187ca — tcp: remove tcp_tw_recycle](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=4396e46187ca5070219b81773c3caf238348d6de). Running `sysctl -w net.ipv4.tcp_tw_recycle=1` on Linux 6.8 yields `sysctl: cannot stat /proc/sys/net/ipv4/tcp_tw_recycle: No such file or directory`.
  2. Historically, `tcp_tw_recycle` cached per-host timestamps in `tcpm_ts`. When client traffic passed through NAT gateways (such as AWS NAT Gateway or cloud firewalls), multiple client machines shared the same public IP. Because individual clients have unsynchronized hardware clocks, packets arriving with smaller timestamp values were dropped by PAWS as duplicates, causing widespread connection drops for end users.

### Misstep 2: Reducing `net.ipv4.tcp_fin_timeout`

* **The Flawed Fix**: Attempting to shorten the 60-second `TIME_WAIT` timer by configuring `net.ipv4.tcp_fin_timeout = 15`.
* **Why It Failed**: As documented in the Linux kernel networking specification, `tcp_fin_timeout` governs the duration an orphaned socket remains in the **`FIN_WAIT_2`** state before kernel abort [Source: Linux Kernel Documentation — ip-sysctl](https://docs.kernel.org/networking/ip-sysctl.html). It has **zero effect on the `TIME_WAIT` timer**, which is hardcoded in `TCP_TIMEWAIT_LEN` (`60*HZ`). The sockets continued lingering for 60 seconds.

### Misstep 3: Forcing Abrupt Socket Abort via `SO_LINGER` (Linger 0)

* **The Flawed Fix**: Modifying backend code to set the socket option `SO_LINGER` with `l_onoff = 1, l_linger = 0`.
* **Why It Failed**: Setting `l_linger = 0` forces the operating system to send a `TCP RST` packet instead of executing the standard 4-way `FIN` handshake, tearing down the connection abruptly and skipping `TIME_WAIT`. This breaks RFC 9293 compliance. Any unread data residing in network transit buffers was purged, triggering `ECONNRESET` (Connection reset by peer) exceptions across upstream clients and corrupting transactions in flight.

### Misstep 4: Relying on Default `tcp_tw_reuse = 2` for Non-Loopback Pod Traffic

* **The Flawed Fix**: Assuming that modern Linux distributions already enable socket reuse by default.
* **Why It Failed**: In modern Linux kernels (including Ubuntu 24.04 and Debian 12), `net.ipv4.tcp_tw_reuse` defaults to `2` [Source: Linux Kernel Documentation — ip-sysctl](https://docs.kernel.org/networking/ip-sysctl.html). Value `2` restricts reuse exclusively to loopback addresses (`127.0.0.1` / `::1`) via `ipv4_is_loopback()`. In Kubernetes and cloud architectures, microservice traffic traverses overlay network interfaces (`eth0`, `cali+`, `cni0`), meaning value `2` actively blocked socket reuse for all inter-pod traffic.

### Misstep 5: Conflating `SO_REUSEADDR` with `net.ipv4.tcp_tw_reuse`

* **The Flawed Fix**: Adding `SO_REUSEADDR` socket options to client connection pools in application code (`setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, ...)`), expecting it to unlock ephemeral port reuse for outbound `connect()` calls.
* **Why It Failed**: 
  1. `SO_REUSEADDR` is predominantly a **server-side listening socket** flag. It permits a daemon to `bind()` to a local IP:port even if existing connections on that port are in `TIME_WAIT` (preventing `EADDRINUSE` after service restarts).
  2. For outbound client sockets, `SO_REUSEADDR` only permits binding to the same local port if the **target destination 4-tuple is different**. When connecting repeatedly to the identical upstream cluster IP and port (`10.244.3.45:8080`), `SO_REUSEADDR` does **not** bypass RFC 9293 `TIME_WAIT` protection. Only `net.ipv4.tcp_tw_reuse` coupled with RFC 7323 PAWS timestamps can recycle a matching 4-tuple during `connect()`.

---

## 4. Remediation Strategy & Production Implementation

A resilient production architecture addresses socket exhaustion at both layers: tuning kernel socket recycling for outbound clients and eliminating connection churn through upstream HTTP keepalive pooling.

### 4.1 Step 1: OS Kernel Tuning (`/etc/sysctl.d/99-networking.conf`)

Expand ephemeral port availability, enable global `tcp_tw_reuse = 1`, and ensure TCP timestamps are active:

```diff
--- /etc/sysctl.d/99-networking.conf.orig	2026-11-18 01:30:00.000000000 +0900
+++ /etc/sysctl.d/99-networking.conf	2026-11-18 01:45:00.000000000 +0900
@@ -12,2 +12,12 @@
-# Default Linux ephemeral port allocation range (28,232 ports)
-net.ipv4.ip_local_port_range = 32768 60999
+# Expanded ephemeral port allocation range (55,296 usable source ports)
+net.ipv4.ip_local_port_range = 10240 65535
+
+# Enable TCP Timestamps (RFC 7323) - MANDATORY prerequisite for tcp_tw_reuse
+net.ipv4.tcp_timestamps = 1
+
+# Set tcp_tw_reuse to 1 (Global enable across all interfaces, not loopback only)
+net.ipv4.tcp_tw_reuse = 1
+
+# Elevate maximum socket backlog queues for high burst volume
+net.core.somaxconn = 65535
+net.ipv4.tcp_max_syn_backlog = 32768
```

Apply the updated kernel sysctl configuration:

```bash
sudo sysctl -p /etc/sysctl.d/99-networking.conf
```

### 4.2 Step 2: NGINX Reverse Proxy Upstream Connection Pooling

The primary architectural fix is eliminating short-lived connection turnover by establishing persistent HTTP/1.1 upstream pools [Source: NGINX Upstream Module Documentation](https://nginx.org/en/docs/http/ngx_http_upstream_module.html):

```diff
--- /etc/nginx/conf.d/upstream.conf.orig	2026-11-18 01:30:00.000000000 +0900
+++ /etc/nginx/conf.d/upstream.conf	2026-11-18 01:45:00.000000000 +0900
@@ -1,12 +1,23 @@
 upstream order_backend {
     server 10.244.3.45:8080 max_fails=3 fail_timeout=10s;
+
+    # Maintain a pool of up to 512 idle keepalive connections per worker
+    keepalive 512;
+    keepalive_requests 20000;
+    keepalive_timeout 65s;
 }
 
 server {
     listen 80;
     server_name api.internal.svc;
 
     location / {
         proxy_pass http://order_backend;
+
+        # Clear Connection header and enforce HTTP/1.1 for upstream keepalive
+        proxy_http_version 1.1;
+        proxy_set_header Connection "";
+        proxy_set_header Host $host;
+        proxy_next_upstream error timeout http_502 http_503;
     }
 }
```

### 4.3 Step 3: Go Client `http.Transport` Connection Pooling & Response Body Drain

For microservices communicating over HTTP, Go's default `http.Transport` caps idle connections per host to `2`, triggering massive connection teardowns under high concurrency. Furthermore, **failing to read the response body to EOF (`io.Copy(io.Discard, resp.Body)`) and close it (`resp.Body.Close()`) prevents connection reuse entirely**, forcing Go to tear down the socket and flood the kernel with `TIME_WAIT` states:

```diff
--- client/transport.go.orig	2026-11-18 01:30:00.000000000 +0900
+++ client/transport.go	2026-11-18 01:45:00.000000000 +0900
@@ -10,9 +10,16 @@
 func NewBackendHTTPClient() *http.Client {
 	return &http.Client{
 		Transport: &http.Transport{
-			// Default MaxIdleConnsPerHost is 2, leading to severe socket churn
-			MaxIdleConnsPerHost: 2,
+			Proxy: http.ProxyFromEnvironment,
+			DialContext: (&net.Dialer{
+				Timeout:   5 * time.Second,
+				KeepAlive: 30 * time.Second,
+			}).DialContext,
+			MaxIdleConns:        1024,
+			MaxIdleConnsPerHost: 256,
+			IdleConnTimeout:     90 * time.Second,
+			DisableKeepAlives:   false,
 		},
 		Timeout: 10 * time.Second,
 	}
 }
```

Ensure application caller routines strictly drain and close response bodies:

```go
resp, err := client.Do(req)
if err != nil {
    return err
}
// MANDATORY: Drain response body to EOF before closing so Transport can recycle the TCP connection
_, _ = io.Copy(io.Discard, resp.Body)
_ = resp.Body.Close()
```

### 4.4 Step 4: Envoy Proxy Cluster Connection Lifecycle Tuning

For Envoy mesh sidecars, configure idle connection timeouts and maximum requests per connection nested properly within `HttpProtocolOptions` to prevent thundering herd reconnections and configuration validation failures:

```diff
--- envoy-cluster.yaml.orig	2026-11-18 01:30:00.000000000 +0900
+++ envoy-cluster.yaml	2026-11-18 01:45:00.000000000 +0900
@@ -10,6 +10,10 @@
     dns_lookup_family: V4_ONLY
     lb_policy: ROUND_ROBIN
     typed_extension_protocol_options:
       envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
         "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
         use_downstream_protocol_config: {}
+        common_http_protocol_options:
+          idle_timeout: 60s
+          max_connection_duration: 300s
+          max_requests_per_connection: 50000
```

---

## 5. Verification & Diagnostics Runbook

To confirm that socket recycling and connection pooling are operating correctly across all cluster nodes, execute the following operational runbook.

### Step 1: Inspect Socket Summary and `TIME_WAIT` Allocation

Execute `ss -s` to inspect the macro-level TCP allocation:

```bash
ss -s
```

```text
Total: 3120
TCP:   1210 (estab 890, closed 202, orphaned 0, timewait 118)

Transport Total     IP        IPv6
RAW	      1         1         0
UDP	      14        10        4
TCP	      1210      1172      38
INET	  1225      1183      42
FRAG	  0         0         0
```

Filter specifically for sockets lingering in `TIME_WAIT` targeted at the upstream microservice:

```bash
ss -tan state time-wait '( dport = :8080 )' | wc -l
# Expected output under steady state: < 200 sockets (down from 28,000+)
```

### Step 2: Validate Kernel Recycling Metrics via `nstat`

Verify that the Linux kernel is actively recycling `TIME_WAIT` sockets via `tcp_twsk_unique`:

```bash
nstat -az TcpExtTW* TcpExtTCPTimeWaitOverflow
```

```text
#kernel
TcpExtTW                            14892              0.0
TcpExtTWRecycled                    12841              0.0
TcpExtTWKilled                      0                  0.0
TcpExtTCPTimeWaitOverflow           0                  0.0
```

* `TcpExtTW`: Total sockets that entered the `TIME_WAIT` state.
* `TcpExtTWRecycled`: Total sockets safely recycled for new outbound connections via `tcp_tw_reuse`.
* `TcpExtTCPTimeWaitOverflow`: Should remain **0**. A non-zero value indicates that `tcp_max_tw_buckets` was exceeded, forcing premature destruction without protocol safety checks.

### Step 3: End-to-End Keepalive Verification via `curl`

Verify that sequential HTTP requests to the upstream backend reuse the identical underlying TCP connection:

```bash
curl -v -X POST --http1.1 http://10.244.3.45:8080/v1/orders/validate \
  -H "Connection: keep-alive" \
  --next -X POST http://10.244.3.45:8080/v1/orders/validate
```

```text
* Connected to 10.244.3.45 (10.244.3.45) port 8080
> POST /v1/orders/validate HTTP/1.1
> Host: 10.244.3.45:8080
> Connection: keep-alive
< HTTP/1.1 200 OK
< Connection: keep-alive
* Connection #0 to host 10.244.3.45 left intact
* Re-using existing connection #0 with host 10.244.3.45
> POST /v1/orders/validate HTTP/1.1
> Host: 10.244.3.45:8080
< HTTP/1.1 200 OK
* Connection #0 to host 10.244.3.45 left intact
```

---

## 6. Prometheus Alerting Rules & Production Runbook Checklist

Configure Prometheus monitoring rules to alert before ephemeral port starvation causes connection drops:

```yaml
groups:
  - name: tcp_socket_exhaustion_alerts
    rules:
      - alert: HighTcpTimeWaitSockets
        expr: node_sockstat_TCP_tw > 20000
        for: 2m
        labels:
          severity: warning
          tier: networking
        annotations:
          summary: "Host {{ $labels.instance }} has over 20,000 TCP TIME_WAIT sockets"
          description: "Active TIME_WAIT sockets exceed safe thresholds. Check upstream keepalive pools and verify net.ipv4.tcp_tw_reuse."

      - alert: TcpTimeWaitOverflowDetected
        expr: rate(node_netstat_TcpExt_TCPTimeWaitOverflow[1m]) > 0
        for: 30s
        labels:
          severity: critical
          tier: networking
        annotations:
          summary: "TCP TIME_WAIT overflow on {{ $labels.instance }}"
          description: "tcp_max_tw_buckets limit reached. Kernel is dropping TIME_WAIT sockets prematurely."
```

### Incident Verification Runbook Checklist

* [x] **Verify Ephemeral Port Range**: Ensure `net.ipv4.ip_local_port_range` is expanded to `10240 65535` (55,296 ports).
* [x] **Verify TCP Timestamps**: Verify `net.ipv4.tcp_timestamps = 1` across both client and server hosts.
* [x] **Verify `tcp_tw_reuse` Mode**: Confirm `net.ipv4.tcp_tw_reuse = 1` (global enable), rather than `2` (loopback only).
* [x] **Verify NGINX Keepalive**: Validate `keepalive` directive is declared in `upstream` block and `proxy_set_header Connection ""` is applied.
* [x] **Verify Client Pooling**: Ensure Go client `MaxIdleConnsPerHost` is raised from default `2` to `256+`.
* [x] **Verify Metrics**: Confirm `TcpExtTWRecycled` increases under load and `TcpExtTCPTimeWaitOverflow` remains 0.
