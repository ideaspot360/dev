---
layout: post
title: "Fixing Redis OOM: maxmemory-policy & Volatile-TTL Eviction Under High Write Loads"
date: 2026-11-16 10:14:00 +0900
categories: ["Database & Storage"]
tags: [redis, in-memory, memory-leak, performance, devops, database]
---

```text
(error) OOM command not allowed when used memory > 'maxmemory'.
[14285:M 16 Nov 2026 01:14:22.842] # Out of memory allocating 65536 bytes!
[14285:M 16 Nov 2026 01:14:22.843] # Client id=4988 addr=10.244.3.112:51442 fd=18 name=worker-pool age=428 idle=0 flags=N db=0 sub=0 psub=0 multi=-1 qbuf=26 qbuf-free=40928 argv-mem=10 obl=0 oll=0 omem=0 tot-mem=61466 events=r cmd=set user=default
```

### Production Environment Specs
* **In-Memory Store**: Redis Standalone / Cluster v7.2.4
* **Operating System**: Ubuntu 24.04 LTS (Noble Numbat)
* **Linux Kernel**: 6.6.0-41-generic x86_64
* **Allocated RAM**: 16 GB Physical Host (`maxmemory 8gb`)
* **Memory Allocator**: jemalloc 5.3.0

---

## 1. Failure Scenario & System Symptoms

During a scheduled flash sale campaign at 01:14 UTC, a high-throughput write surge hit the caching layer. Over 45,000 requests/sec were directed to Redis clusters caching dynamic user shopping cart tokens and fast-expiring inventory reservations. 

Within 4 minutes of peak traffic, application microservices began throwing `JedisDataException` / `RedisSystemException`:
```text
redis.clients.jedis.exceptions.JedisDataException: OOM command not allowed when used memory > 'maxmemory'.
	at redis.clients.jedis.Protocol.processError(Protocol.java:132)
	at redis.clients.jedis.Protocol.process(Protocol.java:166)
	at redis.clients.jedis.Connection.readProtocolWithCheckingBroken(Connection.java:318)
```

Read operations (`GET`, `MGET`, `EXISTS`) continued returning stale data, but all mutating commands (`SET`, `HSET`, `LPUSH`, `SADD`) were blocked, dropping checkout availability to 0%.

---

## 2. Root Cause Analysis: Jemalloc Fragmentation & Eviction Bottleneck

Inspection of `redis-cli info memory` revealed that physical resident set size (`used_memory_rss`) had breached 13.8 GB, while `used_memory` was fluctuating exactly at the 8.0 GB `maxmemory` threshold:

```text
# Memory
used_memory:8589934592
used_memory_human:8.00G
used_memory_rss:14818836480
used_memory_rss_human:13.80G
used_memory_peak:8589934592
used_memory_peak_human:8.00G
total_system_memory:16823488512
maxmemory:8589934592
maxmemory_human:8.00G
maxmemory_policy:noeviction
mem_fragmentation_ratio:1.72
mem_allocator:jemalloc-5.3.0
```

Three compounding architectural defects triggered the complete halt:

1. **Default `noeviction` Strategy in Production**:
   The cluster configuration retained the default vanilla policy `maxmemory-policy noeviction`. When keys reached `maxmemory`, instead of discarding expired or least-recently-used (LRU) records, Redis rejected every mutating command with `OOM command not allowed`.
2. **Severe Memory Fragmentation (Ratio 1.72)**:
   The application stored variable-sized JSON tokens ranging from 128 bytes to 32 KB without memory recycling. Jemalloc allocated memory in discrete chunk bins (slab classes). Frequent rapid key creations and deletions left thousands of half-filled pages that could not be returned to the OS.
3. **Active Defrag Disabled**:
   `activedefrag` was set to `no`. Consequently, memory compaction was never initiated during runtime, causing RSS to swell until Linux cgroup OOM Killer thresholds were endangered.

---

## 3. The Wrong Fix (Antipattern)

A standard knee-jerk reaction in production is simply upgrading instance RAM or setting `maxmemory-policy allkeys-lru` indiscriminately:

```ini
# WRONG FIX: Indiscriminate eviction can flush critical state
maxmemory-policy allkeys-lru
maxmemory 14gb
```

**Why this fails:**
Setting `allkeys-lru` flushes mission-critical session tokens and rate-limiter buckets that lack TTL along with simple cache keys. Furthermore, increasing `maxmemory` to 14 GB on a 16 GB host leaves insufficient headroom for `BGSAVE` fork page table duplications and jemalloc overhead, causing the Linux kernel OOM-Killer to forcefully kill the Redis daemon with `SIGKILL` (`Exit Code 137`).

---

## 4. Production Remediation: Configuration Diff

To safely mitigate the write deadlock and enforce stable memory reclamation, apply the following kernel and daemon adjustments:

### Redis Daemon Configuration (`/etc/redis/redis.conf`)
```diff
--- redis.conf.orig	2026-11-16 01:20:00.000000000 +0000
+++ redis.conf	2026-11-16 01:25:00.000000000 +0000
@@ -1012,8 +1012,8 @@
 # Leave 25-30% of system RAM free for fork copy-on-write & jemalloc buffers
-maxmemory 8gb
-maxmemory-policy noeviction
+maxmemory 6442450944
+maxmemory-policy volatile-lru
+maxmemory-samples 10
 
 # Dynamic Active Memory Defragmentation
-activedefrag no
+activedefrag yes
+active-defrag-ignore-bytes 100mb
+active-defrag-threshold-lower 10
+active-defrag-threshold-upper 30
+active-defrag-cycle-min 5
+active-defrag-cycle-max 25
```

### Linux Kernel Memory Overcommit (`/etc/sysctl.d/99-redis.conf`)
```diff
--- /etc/sysctl.conf.orig	2026-11-16 01:20:00.000000000 +0000
+++ /etc/sysctl.d/99-redis.conf	2026-11-16 01:25:00.000000000 +0000
@@ -0,0 +1,5 @@
+# Allow kernel overcommit for safe background fork snapshots
+vm.overcommit_memory = 1
+# Prevent kernel swapping active memory pages to disk
+vm.swappiness = 1
```

Apply immediately at runtime without restart:
```bash
# Update runtime Redis settings
redis-cli -a "<SECRET_PASSWORD>" config set maxmemory 6442450944
redis-cli -a "<SECRET_PASSWORD>" config set maxmemory-policy volatile-lru
redis-cli -a "<SECRET_PASSWORD>" config set activedefrag yes

# Apply kernel parameters
sudo sysctl -p /etc/sysctl.d/99-redis.conf
```

---

## 5. Verification & Post-Fix Telemetry

Post-deployment monitoring under 50,000 ops/sec confirmed zero write failures and stable slab recycling:

```bash
redis-cli info stats | grep -E "evicted_keys|keyspace_hits|keyspace_misses"
```
```text
evicted_keys:184920
keyspace_hits:9812402
keyspace_misses:41209
```

`used_memory_rss` dropped from 13.80 GB to 7.15 GB within 12 minutes of active defragmentation, and `mem_fragmentation_ratio` stabilized at 1.18.

