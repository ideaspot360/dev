---
title: "Fixing Redis OOM: 'command not allowed when used memory > maxmemory' - Eviction Policies and jemalloc Fragmentation"
category: "Database & Backend"
tags: [redis, caching, backend, devops, database, troubleshooting]
author: "Justin (IdeaSpot360 Lead Engineer)"
excerpt: "When Redis throws 'OOM command not allowed', increasing instance RAM often triggers catastrophic latency spikes during BGSAVE. Here is how jemalloc memory fragmentation and maxmemory-policy actually interact under heavy write load."
---

During a sudden surge in session validation traffic on an e-commerce checkout cluster, every write command (`SET`, `HSET`, `LPUSH`) sent to the primary Redis node was abruptly rejected. Application workers began throwing cascading timeouts, while the Redis CLI returned the following raw terminal error:

```text
(error) OOM command not allowed when used memory > 'maxmemory'.
```

Simultaneously, `redis-cli INFO memory` reported:

```text
# Memory
used_memory:17180422144
used_memory_human:16.00G
used_memory_rss:24696061952
used_memory_rss_human:23.00G
used_memory_peak_human:16.00G
maxmemory:17179869184
maxmemory_human:16.00G
maxmemory_policy:noeviction
mem_fragmentation_ratio:1.44
mem_allocator:jemalloc-5.3.0
```

Redis refused all writes because `used_memory` crossed the `16.00GB` hard threshold. However, the operating system's resident set size (`used_memory_rss`) was sitting at **23.00GB**, creating an alarming **1.44 fragmentation ratio** ($7.00\text{GB}$ of memory stranded in dirty allocator arenas).

---

## 1. Verified Production Specs

The diagnostic rules and remediation steps below were tested on:

* **Redis Engine:** Redis Server v7.2.4 (Standalone & AWS ElastiCache Cluster Mode)
* **Underlying Host OS:** Linux Kernel 6.6.x (Ubuntu 24.04 LTS / Amazon Linux 2023)
* **Memory Allocator:** `jemalloc-5.3.0`
* **Application Framework:** Spring Boot 3.3.x (`Lettuce 6.3.x` with connection pooling) & Node.js `ioredis 5.4.x`

---

## 2. Common False Fix: Why Simply Bumping `maxmemory` Caused a Complete Node Freeze

The intuitive reaction of many on-call engineers is to double the instance size or dynamically adjust `maxmemory` via CLI:

```bash
# WRONG FIX: Expanding maxmemory without addressing allocator behavior
127.0.0.1:6379> CONFIG SET maxmemory 24gb
```

### Why this led to a cluster-wide outage:
1. **Copy-on-Write (COW) Exhaustion during BGSAVE:**  
   Redis persists snapshots using a `fork()` system call. While modern Linux kernels optimize this through Copy-on-Write, high write rates during flash sales force page duplication across memory pages. When Redis allocated 24GB on a 32GB instance, the background RDB snapshot worker triggered an OS-level Out-of-Memory event (`mm/oom_kill.c`), causing the Linux kernel to abruptly kill the Redis master daemon (`SIGKILL`).
2. **The `noeviction` Default Trap:**  
   The default Redis eviction policy is `noeviction`. Under `noeviction`, Redis will never delete keys—even expired ones—when `maxmemory` is reached. It simply returns errors for any command requiring memory allocation while serving reads. Bumping limits merely delayed the crash by 20 minutes.

---

## 3. Root Cause Deep Dive: jemalloc Arenas & Ephemeral Key Churn

Two distinct architectural bottlenecks caused this failure:

### A. Memory Fragmentation in `jemalloc`
Redis uses `jemalloc` to allocate discrete blocks (bins of 8, 16, 32, 64, 128 bytes, etc.). When your application repeatedly overwrites strings or hashes with variable-sized JSON payloads, `jemalloc` cannot return released memory back to the Linux kernel immediately because neighboring slots in the same memory page remain active.  
Notice the metric:

$$\text{mem\_fragmentation\_ratio} = \frac{\text{used\_memory\_rss}}{\text{used\_memory}} = \frac{23.00\text{GB}}{16.00\text{GB}} = 1.44$$

A ratio above **1.35** indicates critical fragmentation where over 30% of system RAM is wasted in allocator padding.

### B. Missing TTLs on Temporary Session & Idempotency Keys
An audit of Redis keys using `redis-cli --bigkeys` and `SCAN` revealed that millions of idempotency keys (`idemp:req:*`) were being inserted without an expiration time (`EXPIRE`). Because the eviction policy was `noeviction`, these zombie keys consumed 100% of the available keyspace.

---

## 4. Production Solution: Before vs After Configuration

### Step 1: Enforce Safe Key Eviction Policy
Switch from `noeviction` to `volatile-lru` (or `allkeys-lru` for pure caches). `volatile-lru` only evicts keys with an explicit TTL, protecting persistent configuration tokens:

```diff
# /etc/redis/redis.conf
- maxmemory-policy noeviction
+ maxmemory-policy volatile-lru

# Reserve 25% of total system RAM for jemalloc overhead and BGSAVE fork buffers
- maxmemory 28gb
+ maxmemory 22gb
```

### Step 2: Enable Active Defragmentation
Redis 4.0+ features an online defragmenter that reorganizes memory allocations without requiring server restarts:

```diff
# /etc/redis/redis.conf
+ activedefrag yes
+ active-defrag-ignore-bytes 200mb
+ active-defrag-threshold-lower 10
+ active-defrag-threshold-upper 30
+ active-defrag-cycle-min 5
+ active-defrag-cycle-max 25
```

### Step 3: Application-Side Atomic TTL Enforcement

Always set TTLs atomically during key creation (`SET ... EX`). Never send `SET` followed by a detached `EXPIRE`:

```diff
// Java Lettuce / Spring Data Redis
- redisTemplate.opsForValue().set(key, sessionData);
- redisTemplate.expire(key, Duration.ofMinutes(30)); // VULNERABLE: Network blip leaves immortal key

+ // ATOMIC: Guarantee TTL is set on wire protocol
+ redisTemplate.opsForValue().set(key, sessionData, Duration.ofMinutes(30));
```

---

## 5. Live Memory Diagnosis Script

Run this diagnostic command directly in your staging or production bastion to identify which key prefixes dominate memory consumption:

```bash
# Scan and report top memory-consuming keys without locking the single-threaded event loop
redis-cli -h 127.0.0.1 -p 6379 --memkeys
```

```text
-------- summary -------
Sampled 1840212 keys in the keyspace!
Total key length in bytes is 45892102 (avg len 24.94)

Biggest string found 'session:user:984210' has 184291 bytes
Biggest list found 'mq:events:deadletter' has 42918 items
Biggest hash found 'cart:items:582109' has 821 fields
```

Treat Redis memory not as an infinite sink, but as an active buffer. Without proper `maxmemory-policy` and active defragmentation, horizontal scaling only scales your memory waste.
