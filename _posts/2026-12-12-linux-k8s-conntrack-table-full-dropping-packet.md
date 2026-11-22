---
layout: post
title: "Resolving Linux & Kubernetes Conntrack Table Saturation: nf_conntrack: table full, dropping packet and Hash Bucket Sizing"
date: 2026-12-12 11:34:58 +0900
category: Systems & Networking
tags: [Linux, Kubernetes, Networking, DevOps, Sysctl, Conntrack, Performance, Netfilter]
pair_id: pair_20261212
---

## 1. Production Incident Summary

During peak morning ingress traffic on our production Kubernetes cluster (spanning 48 worker nodes and over 1,400 active microservice pods), multiple frontend gateway pods experienced intermittent 502 Bad Gateway and 504 Gateway Timeout errors. Within a four-minute window, downstream client connection failures spiked while internal RPC calls between service meshes reported connection timeouts.

Node CPU utilization across the worker pool remained below 45%, and memory consumption had over 50% head-room. However, containerized services began failing DNS lookups against CoreDNS, and inter-pod TCP handshakes exhibited periodic packet loss and multi-second latencies.

Inspecting the Linux kernel ring buffer on affected worker nodes via `dmesg -T` immediately isolated the kernel subsystem responsible for the packet drops:

```text
[Fri Dec 12 02:18:41 2026] net_ratelimit: 894 callbacks suppressed
[Fri Dec 12 02:18:41 2026] nf_conntrack: table full, dropping packet
[Fri Dec 12 02:18:41 2026] nf_conntrack: table full, dropping packet
[Fri Dec 12 02:18:42 2026] nf_conntrack: table full, dropping packet
[Fri Dec 12 02:18:43 2026] nf_conntrack: table full, dropping packet
[Fri Dec 12 02:18:44 2026] net_ratelimit: 1205 callbacks suppressed
[Fri Dec 12 02:18:44 2026] nf_conntrack: table full, dropping packet
```

Simultaneously, CoreDNS client logs inside application pods recorded severe lookup timeouts when querying internal cluster services:

```text
2026-12-12T02:18:42.108Z [ERROR] plugin/errors: 2 order-service.prod.svc.cluster.local. A: read udp 10.244.14.88:41209->10.96.0.10:53: i/o timeout
2026-12-12T02:18:44.612Z [ERROR] plugin/errors: 2 inventory-service.prod.svc.cluster.local. A: read udp 10.244.14.88:58302->10.96.0.10:53: i/o timeout
```

At the ingress proxy layer, Nginx recorded upstream connection timeouts:

```text
2026-12-12T02:18:45.319Z [error] 72#72: *192841 upstream timed out (110: Connection timed out) while connecting to upstream, client: 198.51.100.42, server: api.internal.store, request: "POST /v1/payments HTTP/1.1", upstream: "http://10.244.28.19:8080/v1/payments", host: "api.internal.store"
```

Checking conntrack statistics on the host confirmed massive table saturation:

```text
$ conntrack -S
cpu=0   found=2819024 invalid=102 insert=0 insert_failed=148192 drop=148192 early_drop=0 error=0 search_restart=410
cpu=1   found=2791402 invalid=89  insert=0 insert_failed=152011 drop=152011 early_drop=0 error=0 search_restart=392
```

### Production Environment Specifications
* **Host Operating System**: Ubuntu 22.04.4 LTS (Linux Kernel 5.15.0-105-generic)
* **Kubernetes Version**: AWS EKS v1.28.7
* **Worker Node Type**: AWS EC2 m6i.4xlarge (16 vCPU, 64 GiB RAM, 12.5 Gbps network)
* **Network Plugin**: AWS VPC CNI v1.16.2
* **Proxy Component**: kube-proxy v1.28.7 in iptables mode
* **Ingress / Mesh**: Ingress-Nginx Controller 1.9.5 & Envoy proxy sidecars

---

## 2. Common Missteps & Failed Troubleshooting Attempts

When facing `nf_conntrack: table full, dropping packet` errors, engineering teams often apply hasty fixes that either degrade packet routing performance or break container networking entirely.

### Misstep 1: Doubling `nf_conntrack_max` Without Scaling `nf_conntrack_buckets`
* **Attempted Action**: To halt immediate drops, an operator increased `net.netfilter.nf_conntrack_max` from 262,144 to 1,048,576 via `sysctl -w net.netfilter.nf_conntrack_max=1048576`.
* **Failure Outcome**: While packet drops temporarily paused, node kernel CPU time (`%softirq`) spiked from 4% to over 38%. Because the underlying hash table bucket count (`nf_conntrack_buckets`) remained locked at its boot-time default of 65,536, the average length of the collision linked list in each bucket expanded from 4 entries to over 16 entries. Every incoming packet traversal required traversing long doubly-linked lists under kernel spinlocks, creating severe network latency and packet jitter.

### Misstep 2: Applying `NOTRACK` in raw iptables to Bypass Conntrack
* **Attempted Action**: An engineer attempted to exempt high-volume backend traffic from connection tracking by injecting `iptables -t raw -A PREROUTING -p tcp --dport 8080 -j NOTRACK`.
* **Failure Outcome**: In Kubernetes iptables mode, `kube-proxy` relies directly on Netfilter conntrack to execute NAT (Network Address Translation) for ClusterIP and NodePort Services. Bypassing conntrack meant the return packets from destination pods were not reverse-NATed back to the ClusterIP VIP. Client pods received responses originating from unknown pod IPs and immediately issued TCP RST packets, causing immediate connection termination.

### Misstep 3: Relying Solely on Kubelet Garbage Collection Defaults
* **Attempted Action**: Assuming Kubernetes kubelet or kube-proxy would automatically resize conntrack settings without host sysctl tuning.
* **Failure Outcome**: Kube-proxy only manages conntrack if `--conntrack-max-per-core` is configured and permissions allow sysctl writes inside host namespaces. On locked-down AMI configurations, kube-proxy was failing silently to override host sysctl limits, leaving the node constrained by conservative OS distribution defaults.

---

## 3. Deep Architectural Root Cause Analysis

The Linux Netfilter connection tracking subsystem (`conntrack`) tracks the state of all network flows passing through the host network namespace. This tracking is mandatory for stateful firewalls (iptables `state` or `conntrack` matches) and Source/Destination NAT.

![Netfilter Conntrack Table Architecture](diagram_conntrack_table_architecture.png)

### 1. Hash Table Layout & Linked-List Buckets
The conntrack state table is implemented as an in-kernel hash table array consisting of `nf_conntrack_buckets` slots. Each slot points to a doubly-linked list (`hlist_nulls_head`) of connection tracking entries (`struct nf_conn`).

When a packet arrives at the network interface:
1. The kernel calculates a Jenkins/jhash hash over the packet's 5-tuple:
   $$\text{Hash} = \text{jhash}(\text{Src IP}, \text{Dst IP}, \text{Src Port}, \text{Dst Port}, \text{Protocol})$$
2. The hash modulo bucket size yields the target bucket index:
   $$\text{Bucket Index} = \text{Hash} \pmod{\text{nf\_conntrack\_buckets}}$$
3. The kernel walks the linked list at that bucket index, verifying if an existing `nf_conn` matches the tuple.
4. If no matching entry exists and the packet represents a new flow (e.g. TCP SYN or initial UDP datagram), a new `nf_conn` structure is allocated and inserted.

### 2. Sizing Formula & Memory Overhead
The maximum capacity of the tracking table is governed by `net.netfilter.nf_conntrack_max`. The ideal ratio between capacity and hash buckets is:

$$\text{nf\_conntrack\_max} = \text{nf\_conntrack\_buckets} \times 4 \quad (\text{or } 8)$$

On a 64-bit Linux architecture:
* `sizeof(struct nf_conn)` $\approx$ 320 bytes (slab cache `nf_conntrack`)
* `sizeof(struct hlist_nulls_head)` $\approx$ 16 bytes per bucket

If `nf_conntrack_max` is set to 1,048,576 and `nf_conntrack_buckets` is set to 262,144:
$$\text{Memory} \approx (1{,}048{,}576 \times 320\text{ B}) + (262{,}144 \times 16\text{ B}) \approx 335.5\text{ MB} + 4.2\text{ MB} \approx 340\text{ MB}$$

For modern worker nodes with 32 GiB to 128 GiB of RAM, reserving 340 MB of non-swappable kernel slab memory to support 1 million concurrent tracked connections is negligible.

### 3. Connection Accumulation via Ephemeral UDP and Long TCP Timeouts
In Kubernetes clusters, two primary factors accelerate conntrack table exhaustion:
1. **Short-lived UDP DNS queries**: Applications without DNS caching or connection pooling initiate high volumes of UDP queries. Conntrack tracks UDP as pseudo-connections. By default, `nf_conntrack_udp_timeout` and `nf_conntrack_udp_timeout_stream` can keep entries alive for 30 to 120 seconds after transmission.
2. **Lingering TCP TIME_WAIT / CLOSE_WAIT**: Standard kernel defaults maintain established TCP connections in conntrack for up to 432,000 seconds (5 days!) and TIME_WAIT for 120 seconds. Under high traffic churn, closed sockets accumulate in the table long after user sessions terminate.

When `nf_conntrack_count` reaches `nf_conntrack_max`, the kernel executes `early_drop()` to evict unconfirmed or older low-priority flows. If `early_drop()` cannot reclaim space within its scan window, the kernel drops the packet immediately, emitting `nf_conntrack: table full, dropping packet`.

---

## 4. Remediation & Configuration Tuning (Unified Diff)

Resolving conntrack saturation permanently requires a two-fold approach:
1. Sizing the hash table (`buckets`) and maximum entries (`max`) proportionally based on physical RAM.
2. Aggressively trimming default timeout windows for idle TCP sessions, TIME_WAIT states, and UDP lookups.

### Step 1: Kernel Sysctl Configuration Tuning

Apply the following modifications to `/etc/sysctl.d/99-conntrack.conf`:

```diff
--- /etc/sysctl.d/99-conntrack.conf.orig
+++ /etc/sysctl.d/99-conntrack.conf
@@ -1,7 +1,24 @@
-# Default conservative Linux distribution settings
-net.netfilter.nf_conntrack_max = 262144
-net.netfilter.nf_conntrack_tcp_timeout_established = 432000
-net.netfilter.nf_conntrack_tcp_timeout_time_wait = 120
-net.netfilter.nf_conntrack_tcp_timeout_close_wait = 60
+# Production High-Throughput Kubernetes Conntrack Tuning
+# Ratio: nf_conntrack_max = 4 * nf_conntrack_buckets (262144 buckets -> 1048576 max entries)
+net.netfilter.nf_conntrack_max = 1048576
+
+# Reduce established TCP tracking timeout from 5 days (432000s) to 12 hours (43200s)
+net.netfilter.nf_conntrack_tcp_timeout_established = 43200
+
+# Reduce TIME_WAIT and CLOSE_WAIT tracking windows to release dead sockets rapidly
+net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
+net.netfilter.nf_conntrack_tcp_timeout_close_wait = 15
+net.netfilter.nf_conntrack_tcp_timeout_fin_wait = 30
+
+# Trim UDP tracking windows to prevent ephemeral DNS query accumulation
+net.netfilter.nf_conntrack_udp_timeout = 10
+net.netfilter.nf_conntrack_udp_timeout_stream = 30
+
+# Enable TCP syncookies and TCP timestamps for clean connection recovery
+net.ipv4.tcp_syncookies = 1
+net.ipv4.tcp_timestamps = 1
```

### Step 2: Runtime Hash Bucket Adjustment
Because `nf_conntrack_buckets` cannot be altered through sysctl on all kernel versions, update the live module parameter in `/sys/module/nf_conntrack/parameters/hashsize`:

```diff
--- /etc/modprobe.d/nf_conntrack.conf.orig
+++ /etc/modprobe.d/nf_conntrack.conf
@@ -1 +1,2 @@
-# Set initial hash bucket size during module initialization
+options nf_conntrack hashsize=262144
```

### Step 3: Kube-Proxy Configuration Sync
Ensure `kube-proxy` does not overwrite kernel parameters with lower values by configuring `kube-proxy-config` ConfigMap:

```diff
--- kube-proxy-config.yaml.orig
+++ kube-proxy-config.yaml
@@ -14,5 +14,7 @@
 iptables:
   masqueradeAll: false
   syncPeriod: 30s
-conntrack:
-  maxPerCore: 32768
+conntrack:
+  maxPerCore: 65536
+  min: 1048576
+  tcpEstablishedTimeout: 43200s
+  tcpCloseWaitTimeout: 15s
```

---

## 5. Verification & Monitoring Runbook

After applying the configuration updates, verify host parameters and monitor connection tracking health using Linux CLI utilities.

### 1. Host Conntrack Sizing & Table Health Verification
Verify that both hash buckets and maximum entry limits are active:

```bash
# Verify maximum capacity and current active tracked connections
sysctl net.netfilter.nf_conntrack_max
cat /proc/sys/net/netfilter/nf_conntrack_count

# Verify runtime hash bucket allocation
cat /sys/module/nf_conntrack/parameters/hashsize

# Verify packet drop counters are zero
conntrack -S | grep -E "drop|insert_failed"
```

Expected output:

```text
net.netfilter.nf_conntrack_max = 1048576
341982
262144
cpu=0   found=3419820 invalid=0 insert=0 insert_failed=0 drop=0 early_drop=0 error=0 search_restart=0
cpu=1   found=3398102 invalid=0 insert=0 insert_failed=0 drop=0 early_drop=0 error=0 search_restart=0
```

### 2. Inspect Active Protocol Distributions
Examine the distribution of states across active connections to identify potential leak patterns:

```bash
# Group tracked connections by state
conntrack -L -p tcp | awk '{print $4}' | sort | uniq -c | sort -nr
```

### 3. Continuous Prometheus Alerting Metric
Instrument Prometheus and Node Exporter with alerting rules to prevent surprise overflows:

```yaml
- alert: HostConntrackTableNearSaturation
  expr: (node_nf_conntrack_entries / node_nf_conntrack_entries_limit) * 100 > 75
  for: 3m
  labels:
    severity: warning
  annotations:
    summary: "Host conntrack table usage exceeded 75% on {{ $labels.instance }}"
    description: "Current conntrack entries at {{ $value }}% of maximum capacity."
```

By maintaining the 4:1 ratio between `nf_conntrack_max` and `nf_conntrack_buckets` and tuning idle connection timeouts, Kubernetes nodes sustain over 100,000 connection handshakes per second without packet loss or softirq CPU degradation.
