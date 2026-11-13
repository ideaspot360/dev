---
layout: post
title: "Production Post-Mortem: Kubernetes 5-Second DNS Latency Spikes and ndots:5 CoreDNS Saturation"
date: 2026-11-21 11:15:00 +0900
categories: [DevOps, Kubernetes, Networking]
tags: [Kubernetes, CoreDNS, DNS, Networking, Latency, Troubleshooting, DevOps]
---

In a production Kubernetes cluster with 2,400 active pods, an internal checkout checkout worker experienced periodic, catastrophic 5,000ms latency spikes when calling external cloud payment endpoints. Network metrics showed no packet loss, but application logs were riddled with exact 5-second DNS resolution timeouts.

```text
2026-11-21 02:14:05.001 [error] 1842#0: dial tcp: lookup api.stripe.com on 10.96.0.10:53: read udp 10.244.12.8:49182->10.96.0.10:53: i/o timeout
2026-11-21 02:14:10.002 [warn] CoreDNS-metrics: [WARNING] plugin/loop: Seen "api.stripe.com.production.svc.cluster.local." 5 times, forwarding loop or NXDOMAIN deluge!
2026-11-21 02:14:10.003 [error] worker-payment: HTTP POST https://api.stripe.com/v1/charges failed after 5003ms.
```

## Production Specs
- **Kubernetes**: v1.30.2 on AWS EKS
- **DNS Core**: CoreDNS v1.11.1 (4 replicas, horizontal pod autoscaler up to 16)
- **Node CNI**: AWS VPC CNI with Calico Network Policies
- **Client Library**: Go standard library `net/http` and Java OpenJDK 21
- **Traffic**: ~75,000 internal outbound requests/sec

## System Mechanism: The `ndots:5` Resolution Cascading Hell
By default, Kubernetes injects a restrictive resolver configuration into `/etc/resolv.conf` for every running pod:

```text
nameserver 10.96.0.10
search production.svc.cluster.local svc.cluster.local cluster.local us-west-2.compute.internal
options ndots:5
```

The `ndots:5` directive mandates: **"If a queried hostname contains fewer than 5 dots, the resolver MUST first append every search domain in order before trying the raw query as an absolute FQDN."**

When an application resolves `api.stripe.com` (which contains only 2 dots), the glibc/Go resolver fires queries sequentially:

```
1. api.stripe.com.production.svc.cluster.local.  ---> NXDOMAIN (Non-Existent Domain)
2. api.stripe.com.svc.cluster.local.             ---> NXDOMAIN
3. api.stripe.com.cluster.local.                 ---> NXDOMAIN
4. api.stripe.com.us-west-2.compute.internal.    ---> NXDOMAIN
5. api.stripe.com.                               ---> SUCCESS! (203.0.113.10)
```

For every single outbound external API call, **4 wasted NXDOMAIN UDP packets** flooded the CoreDNS pods! With 75,000 req/sec, CoreDNS received:

$$75,000 \times 4 = 300,000 \text{ useless NXDOMAIN queries/sec}$$

## The Linux Conntrack Race Condition (The 5-Second Hang)
Why exactly 5 seconds?
Linux Netfilter conntrack historically suffered from a race condition when two UDP packets (such as simultaneous `A` and `AAAA` IPv4/IPv6 DNS queries) are sent over the same socket at the exact same microsecond.

Both packets attempt to insert a new conntrack entry for the same unconfirmed flow. One packet wins; the second is silently dropped by the Linux kernel with `NF_CT_STAT_INSERT_FAILED`.

Under the standard DNS resolver timeout, glibc waits exactly **5.000 seconds** before retransmitting the dropped UDP query!

## Production Fixes & Architectural Overhaul

### Fix 1: FQDN Trailing Dots in Application Config
For static endpoints, appending a trailing dot (`.`) tells the resolver the hostname is already fully qualified, immediately bypassing all `ndots` search paths:

```diff
--- config/production.yaml.orig
+++ config/production.yaml
@@ -12,2 +12,2 @@
 payment:
-  gateway_url: "https://api.stripe.com/v1"
+  gateway_url: "https://api.stripe.com./v1"
```

### Fix 2: Pod Spec `dnsConfig` Override
For dynamic workloads, customize `ndots:2`:

```yaml
spec:
  dnsPolicy: "ClusterFirst"
  dnsConfig:
    options:
      - name: ndots
        value: "2"
      - name: single-request-reopen
```

### Fix 3: Deploying NodeLocal DNSCache (DaemonSet)
The definitive infrastructure solution is deploying **NodeLocal DNSCache** as a DaemonSet on every Kubernetes worker node. NodeLocal DNSCache listens on a local link IP (`169.254.20.10`), terminating UDP queries right on the loopback/veth interface and upgrading upstream communication to TCP, completely bypassing Netfilter conntrack race conditions and slashing DNS latency from 5,000ms to **0.4ms**.

```diff
--- deploy/coredns-nodelocal.yaml.orig
+++ deploy/coredns-nodelocal.yaml
@@ -45,6 +45,8 @@
     cache 30
     reload
     loop
+    bind 169.254.20.10
+    forward . /etc/resolv.conf { prefer_udp }
```

Deploying NodeLocal DNSCache eliminated 98.5% of CoreDNS network queries and permanently banished 5-second DNS timeouts from production logs.
