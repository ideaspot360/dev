---
layout: post
title: "Troubleshooting MongoDB WiredTiger Cache Eviction Starvation & Read/Write Ticket Depletion"
date: 2026-12-01 11:17:00 +0900
category: "Database & Storage"
tags: ['MongoDB', 'WiredTiger', 'Database', 'CacheEviction', 'Performance', 'Troubleshooting']
---

## Production Incident Summary

During peak ingestion traffic across a primary sharded cluster, client applications reported massive latency spikes and connection drops. Incoming operations queued indefinitely, returning `ExceededTimeLimit` errors. The database instance ceased servicing concurrent write operations while CPU utilization hovered around 100% across all cores due to storage worker thread contention.

Inspecting `mongod.log` revealed critical WiredTiger storage engine warnings and ticket exhaustion events:

```text
{"t":{"$date":"2026-12-01T02:14:38.102+00:00"},"s":"E", "c":"STORAGE",  "id":22435,   "ctx":"WTWorker.evict-server","msg":"WiredTiger error (-31802) [WT_VERB_EVICT] WT_CACHE: [ERROR] cache eviction failure: cache is full with dirty pages"}
{"t":{"$date":"2026-12-01T02:14:38.103+00:00"},"s":"F", "c":"COMMAND",  "id":51803,   "ctx":"conn14829","msg":"Slow query or lock acquisition failure","attr":{"type":"write","ticketsRemaining":{"read":128,"write":0},"waitTimeMicros":15002000,"command":{"update":"orders","ordered":true}}}
{"t":{"$date":"2026-12-01T02:14:40.512+00:00"},"s":"E", "c":"NETWORK",  "id":22943,   "ctx":"listener","msg":"Connection refused or timed out acquiring execution ticket","attr":{"error":"ExceededTimeLimit: operation exceeded time limit while waiting for a ticket"}}
```

The metric `wiredTiger.concurrentWriteTransactions.available` dropped to zero and stayed pinned at zero for over 180 seconds.

## Production Specs
* **MongoDB Version**: v6.0.14 Enterprise Edition
* **Storage Engine**: WiredTiger 11.0 (Snappy block compression enabled)
* **Compute Instance**: AWS EC2 `i3en.3xlarge` (12 vCPUs, 96 GiB RAM, 1x 7.5 TB NVMe SSD)
* **Storage Filesystem**: XFS mounted with `noatime,nodiratime,allocsize=64M`
* **Operating System**: Ubuntu 22.04 LTS (Linux Kernel 5.15.0-1049-aws)
* **Configured WiredTiger Cache**: 45 GiB (`storage.wiredTiger.engineConfig.cacheSizeGB: 45`)

---

## 1. Root Cause: WiredTiger Eviction Queue Saturation and Application Thread Hijacking

The root cause of write ticket exhaustion was **dirty page accumulation surpassing the emergency eviction threshold, causing WiredTiger to hijack client application request threads for disk reconciliation**.

```text
[ Client Application Threads ] ───(Write Queries)───> [ WiredTiger Concurrency Control (128 Tickets) ]
                                                                 │
                                                       (Ticket Granted: 128/128)
                                                                 ▼
[ Dirty Pages Accumulation ] ───(Exceeds 20% Dirty Trigger)───> [ Eviction Server Saturated ]
                                                                 │
                                                    ┌────────────┴────────────┐
                                                    ▼                         ▼
                                       [ Background Workers Stall ]   [ Client Threads Co-opted ]
                                                                              │
                                                              (Forced Disk Sync / Page Eviction)
                                                                              ▼
                                                                Write Tickets Depleted to 0!
                                                              (Incoming Queries Timed Out)
```

WiredTiger relies on two concurrency mechanisms that operate in tandem:
1. **Concurrency Tickets**: MongoDB constrains parallel execution inside WiredTiger via 128 read and 128 write tickets. Each active read or write operation must hold a ticket while executing inside the storage engine.
2. **Cache Eviction Watermarks**: WiredTiger regulates cache pressure through four tunable watermarks:
   * `eviction_target`: Percentage of total cache populated before background eviction activates (default 80%).
   * `eviction_trigger`: Percentage of total cache populated before aggressive eviction starts (default 95%).
   * `eviction_dirty_target`: Percentage of cache holding unwritten dirty data before dirty eviction begins (default 5%).
   * `eviction_dirty_trigger`: Percentage of cache holding dirty data before client threads are hijacked (default 20%).

Under bursty upsert workloads with unindexed update operators (`$inc`, `$set`), hundreds of unique collection pages were modified concurrently. Because modified pages remained in memory waiting for checkpoint intervals (every 60 seconds by default), dirty cache utilization rapidly escalated past `eviction_dirty_trigger` (20% of 45 GiB = 9.0 GiB of dirty pages).

When dirty cache crosses `eviction_dirty_trigger`, WiredTiger halts dedicated background flushing and commandeers incoming client request worker threads to perform synchronous page reconciliation against disk storage. Because client threads were forced into NVMe I/O operations and page serialization, they held their write tickets for hundreds of milliseconds instead of microseconds.

Within 400 milliseconds, all 128 write tickets were held by threads blocked in dirty page eviction. Subsequent write queries stacked up in MongoDB's incoming queue, eventually breaching client socket read timeouts.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

Diagnosing ticket depletion often leads to dangerous anti-patterns and flawed remedies:

### Misstep 1: Naive Cache Expansion (Wrong Fix)
The initial wrong approach was increasing `storage.wiredTiger.engineConfig.cacheSizeGB` from 45 GiB to 80 GiB, assuming more memory would absorb the write volume.
* **Why It Fails**: Increasing cache size did not eliminate eviction starvation; it made it significantly worse. With an 80 GiB cache, 20% dirty trigger meant 16 GiB of dirty pages accumulated before throttling. When application threads were eventually recruited for eviction, the storage controller choked on 16 GiB of randomized flushing, prolonging server freezes from 30 seconds to over 2 minutes.

### Misstep 2: Increasing `wiredTigerConcurrentWriteTransactions` to 512
Another common flawed fix was raising concurrency tickets from 128 to 512 via `setParameter.wiredTigerConcurrentWriteTransactions: 512`.
* **Why It Fails**: Adding concurrency tickets to an engine whose storage pipeline is already saturated does not add throughput. Instead, 512 threads simultaneously contended for WiredTiger internal B-Tree bucket spinlocks and kernel page writeback locks. Context switching skyrocketed, memory bandwidth became bottlenecked, and ticket acquisition delays compounded.

---

## 3. Before vs. After Remediation

A durable resolution requires tuning the eviction thresholds to begin dirty page purging aggressively early, multiplying dedicated background eviction threads, and tuning the Linux kernel dirty writeback ratios to avoid OS-level buffer stalls.

### Step 1: WiredTiger Eviction Parameters and Thread Expansion

We lowered `eviction_dirty_target` from 5% to 3%, reduced `eviction_dirty_trigger` from 20% to 10%, and expanded background eviction worker threads from minimum 1/maximum 4 to minimum 4/maximum 8:

```diff
--- /etc/mongod.conf.orig
+++ /etc/mongod.conf
@@ -28,8 +28,14 @@
 storage:
   dbPath: /var/lib/mongodb
   journal:
     enabled: true
   wiredTiger:
     engineConfig:
       cacheSizeGB: 45
+      configString: "eviction=(threads_min=4,threads_max=8)"
+
+setParameter:
+  wiredTigerEngineRuntimeConfig: "eviction_target=75,eviction_trigger=90,eviction_dirty_target=3,eviction_dirty_trigger=10"
+  wiredTigerConcurrentWriteTransactions: 128
+  wiredTigerConcurrentReadTransactions: 128
```

### Step 2: Linux Kernel Dirty Writeback Calibration

Linux default `vm.dirty_ratio` (20%) allows large pagecache dirty spikes before forcing `sync`. We tuned the kernel to flush continuously in the background:

```diff
--- /etc/sysctl.d/99-mongodb.conf.orig
+++ /etc/sysctl.d/99-mongodb.conf
@@ -1,4 +1,7 @@
 fs.file-max = 64000
 vm.max_map_count = 262144
-vm.dirty_ratio = 20
-vm.dirty_background_ratio = 10
+vm.dirty_ratio = 8
+vm.dirty_background_ratio = 3
+vm.swappiness = 1
```

---

## 4. Verification CLI & Runtime Metrics

Run the following commands on the database host to verify kernel memory writeback behavior and monitor ticket health:

```bash
# 1. Verify kernel memory dirty page ratios and virtual memory I/O stalls
vmstat 1 5

# 2. Inspect active dirty ratio kernel configuration
sudo sysctl -p /etc/sysctl.d/99-mongodb.conf
sysctl -a | grep -E "vm.dirty_(background_)?ratio"

# 3. Check administrative health endpoint and active tickets via curl
curl -s http://127.0.0.1:28017/serverStatus | grep -A 10 "concurrentTransactions" || true

# 4. Measure real-time WiredTiger ticket availability and dirty cache state
mongosh --quiet --eval '
  const status = db.serverStatus();
  const wt = status.wiredTiger;
  print("Write Tickets Available: " + wt.concurrentTransactions.write.available);
  print("Read Tickets Available:  " + wt.concurrentTransactions.read.available);
  print("Tracked Dirty Bytes:     " + (wt.cache["tracked dirty bytes in the cache"] / 1024 / 1024).toFixed(2) + " MB");
  print("App Threads Evicting:    " + wt.cache["pages evicted by application threads"]);
'
```

Following the patch deployment, `pages evicted by application threads` remained at zero during identical synthetic load spikes. Available write tickets stayed above 110, completely eliminating client-side write timeouts.

---

## 5. Architectural Checklist for High-Throughput Write Workloads

1. **Keep Dirty Targets Tight**: Configure `eviction_dirty_target` at 3-5% and `eviction_dirty_trigger` at 8-10% to ensure dedicated background worker threads flush dirty pages continuously before client queries are interrupted.
2. **Cap Client Connections**: Keep application connection pools constrained (e.g., maximum 50 per application replica) to prevent stampedes when unexpected storage checkpoint pauses occur.
3. **Compound Index Precision**: Verify all upsert statements have exact matching prefix indexes. Unindexed updates force entire document scans into the WiredTiger cache, multiplying dirty page generation exponentially.
