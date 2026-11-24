---
layout: post
title: "Troubleshooting MongoDB WiredTiger Cache Eviction Starvation & Read/Write Ticket Depletion"
date: 2026-12-01 10:38:19 +0900
category: "Database & Storage"
tags: ['MongoDB', 'WiredTiger', 'Database', 'CacheEviction', 'Performance', 'Troubleshooting']
fact_check_sources:
  - "https://www.mongodb.com/docs/manual/core/wiredtiger-storage-engine/"
  - "https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerConcurrentWriteTransactions"
  - "https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerConcurrentReadTransactions"
  - "https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerEngineRuntimeConfig"
  - "https://www.mongodb.com/docs/manual/reference/command/serverStatus/#mongodb-serverstatus-serverstatus.wiredtiger"
  - "https://www.mongodb.com/docs/database-tools/mongostat/"
  - "https://source.wiredtiger.com/develop/tune_cache.html"
verification_date: "2026-11-23"
---

During peak ingestion traffic across a primary sharded MongoDB cluster, client microservices reported cascading connection drops and latency spikes exceeding 30 seconds. Incoming database commands queued uncontrollably, throwing client-side `ExceededTimeLimit` exceptions. Concurrently, the primary `mongod` instance stopped servicing write transactions while storage engine metrics indicated that available concurrency tickets had completely collapsed to zero.

## 1. Production Incident Summary

Under a steady ingress rate of 18,000 upsert operations per second, client request latency escalated from a baseline of 4.2ms to over 15,000ms. Application worker pools saturated their thread limits, triggering cascading timeouts across upstream API gateways:

```text
{"t":{"$date":"2026-12-01T02:14:38.102+00:00"},"s":"E", "c":"STORAGE",  "id":22435,   "ctx":"WTWorker.evict-server","msg":"WiredTiger error (-31802) [WT_VERB_EVICT] WT_CACHE: [ERROR] cache eviction failure: cache is full with dirty pages"}
{"t":{"$date":"2026-12-01T02:14:38.103+00:00"},"s":"F", "c":"COMMAND",  "id":51803,   "ctx":"conn14829","msg":"Slow query or lock acquisition failure","attr":{"type":"write","ticketsRemaining":{"read":128,"write":0},"waitTimeMicros":15002000,"command":{"update":"orders","ordered":true}}}
{"t":{"$date":"2026-12-01T02:14:40.512+00:00"},"s":"E", "c":"NETWORK",  "id":22943,   "ctx":"listener","msg":"Connection refused or timed out acquiring execution ticket","attr":{"error":"ExceededTimeLimit: operation exceeded time limit while waiting for a ticket"}}
{"t":{"$date":"2026-12-01T02:14:42.891+00:00"},"s":"W", "c":"STORAGE",  "id":22430,   "ctx":"WTWorker.evict-server","msg":"Eviction server stalled waiting for clean memory; forcing application threads to evict"}
```

Real-time monitoring via `mongostat` confirmed that the active write queue (`qw`) surged past 1,400 pending requests while available write tickets dropped to zero [Source: MongoDB Database Tools - mongostat (https://www.mongodb.com/docs/database-tools/mongostat/)]:

```text
insert query update delete getmore command dirty  used flushes  vsize    res qrw  arw net_in net_out conn     time
     0     0    120      0       0   410|0 22.4% 95.8%       0 102.4G  48.2G 0|1420 12|128  1.2M    4.8M 3200 02:14:41
     0     0     45      0       0   280|0 23.1% 96.2%       0 102.4G  48.2G 0|1485  8|128  840k    3.1M 3200 02:14:42
     0     0      0      0       0   120|0 23.8% 96.5%       0 102.4G  48.2G 0|1540  0|128  310k    1.2M 3200 02:14:43
```

The metric `wiredTiger.concurrentTransactions.write.available` remained pinned at `0` for over 180 seconds, starving all subsequent mutations across the cluster.

## 2. Production System Specifications

* **MongoDB Version**: v6.0.14 Enterprise Edition
* **Storage Engine**: WiredTiger 11.0 with Snappy block compression
* **Compute Instance**: AWS EC2 `i3en.3xlarge` (12 vCPUs, 96 GiB RAM, 1x 7.5 TB NVMe SSD)
* **Storage Filesystem**: XFS mounted with `noatime,nodiratime,allocsize=64M,logbufs=8,logbsize=256k`
* **Operating System**: Ubuntu 22.04 LTS (Linux Kernel 5.15.0-1049-aws)
* **WiredTiger Cache Configuration**: 45 GiB (`storage.wiredTiger.engineConfig.cacheSizeGB: 45`)
* **Workload Characteristics**: High-concurrency upserts with frequent `$inc` and `$set` operators across unsegmented order documents

---

## 3. Root Cause: Dirty Page Accumulation and Application Thread Eviction Hijacking

The root cause of write ticket depletion was **dirty page accumulation breaching the emergency eviction trigger, forcing WiredTiger to co-opt incoming application client threads for synchronous NVMe disk reconciliation** [Source: WiredTiger Cache Tuning Architecture (https://source.wiredtiger.com/develop/tune_cache.html)].

```text
[ Client Requests (18,000 upsert/s) ]
                │
                ▼
[ WiredTiger Concurrency Gate (128 Read / 128 Write Tickets) ]
                │
                ├─────────────────────────────────────────────┐
                ▼ (Write Ticket Granted: 128/128)             ▼
[ Cache Allocation (45 GiB Total RAM) ]          [ Application Worker Threads ]
                │                                             │
   Dirty Pages Accumulate (> 20%)                             │
                │                                             │
                ▼                                             │
[ WT Eviction Server Stalls ]                                 │
                │                                             │
                └───────────────► [ CO-OPTED INTO EVICTION ] ◄┘
                                              │
                              (Synchronous Page Disk Flush)
                                              │
                                              ▼
                                 Ticket Held for 150ms+
                                              │
                                              ▼
                                 Available Tickets = 0!
                               (Incoming Queries Timed Out)
```

### WiredTiger Cache Sizing and Memory Architecture

By default, MongoDB calculates the WiredTiger internal cache size using the following formula [Source: MongoDB WiredTiger RAM Allocation (https://www.mongodb.com/docs/manual/core/wiredtiger-storage-engine/)]:

$$\text{WiredTiger Cache Size} = \max\left(0.5 \times (\text{Total RAM} - 1\text{ GB}), 256\text{ MB}\right)$$

On an AWS EC2 instance with 96 GiB of RAM, this default yields:

$$0.5 \times (96\text{ GiB} - 1\text{ GiB}) = 47.5\text{ GiB}$$

The instance was explicitly pinned to 45 GiB (`cacheSizeGB: 45`) to preserve remaining system RAM for OS page cache, network socket buffers, and connection state memory.

### Concurrency Tickets vs. Cache Watermarks

WiredTiger regulates internal concurrency and memory pressure using two interconnected systems:

1. **Concurrency Tickets**: MongoDB enforces admission control through concurrency tickets [Source: MongoDB Server Parameters (https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerConcurrentWriteTransactions)]. In MongoDB 6.0 (and as an upper bound in MongoDB 7.0 dynamic scheduling), the engine allocates **128 read tickets** and **128 write tickets**. Every operation executing inside WiredTiger must check out a ticket from `wiredTiger.concurrentTransactions.write` or `read`. When an operation completes, the ticket is immediately returned to the pool.
2. **Eviction Thresholds & Watermarks**: WiredTiger regulates cache fullness and dirty data via four core watermarks [Source: WiredTiger Cache Tuning (https://source.wiredtiger.com/develop/tune_cache.html)]:
   * `eviction_target` (Default: **80%**): Cache fullness percentage that background eviction worker threads strive to maintain.
   * `eviction_trigger` (Default: **95%**): Cache fullness threshold. If total cache usage hits 95%, application threads are forced to assist background workers in evicting clean and dirty pages.
   * `eviction_dirty_target` (Default: **5%**): Percentage of cache containing modified (unwritten) data that triggers background dirty eviction.
   * `eviction_dirty_trigger` (Default: **20%**): Emergency threshold. If dirty cache reaches 20%, application threads are hijacked to flush modified pages to disk.

### The Mechanism of the Collapse

Under our bursty write workload, random upsert operations modified documents across hundreds of disparate collection pages. Because modified pages remain in memory until written out during checkpoint intervals (which run every 60 seconds by default), dirty cache utilization rapidly surged past `eviction_dirty_target` (5% = 2.25 GiB) and breached `eviction_dirty_trigger` (20% of 45 GiB = 9.0 GiB of dirty pages).

When dirty data crossed 20%, WiredTiger entered emergency throttling mode. The dedicated background eviction workers (configured with only 1 minimum thread) could not keep pace with the influx of dirty memory. Consequently, WiredTiger invoked the **application thread eviction penalty**:

1. Incoming application client threads that requested write tickets were co-opted directly into WiredTiger's storage eviction pipeline (`pages evicted by application threads`).
2. Instead of completing in-memory B-Tree pointer updates in microseconds, application threads were forced to serialize modified B-Tree leaf pages, compress them via Snappy, and perform synchronous write calls against the NVMe filesystem.
3. Because NVMe disk I/O and checkpoint write reconciliation required 50ms to 200ms per flush, the 128 application threads held onto their checked-out write tickets for orders of magnitude longer than normal.
4. Within 300 milliseconds, all 128 write tickets (`write.out = 128`) were exhausted, and `write.available` dropped to `0`.
5. Subsequent client operations accumulated in the incoming command queue until their execution deadlines (`maxTimeMS` or socket timeout) elapsed, causing cluster-wide connection churn and service failure.

---

## 4. Common Missteps: What We Tried First (And Why It Failed)

During initial incident triage, several conventional remedies were attempted that exacerbated the underlying starvation.

### Misstep 1: Naive Cache Expansion (Wrong Fix)

The initial instinct was to expand `storage.wiredTiger.engineConfig.cacheSizeGB` from 45 GiB to 80 GiB, assuming that additional memory would absorb the burst of write operations [Source: MongoDB WiredTiger Storage Engine (https://www.mongodb.com/docs/manual/core/wiredtiger-storage-engine/)]:

```yaml
# Flawed configuration attempt
storage:
  wiredTiger:
    engineConfig:
      cacheSizeGB: 80 # Naive expansion on a 96 GiB host
```

* **Why It Backfired**: Increasing cache size did not resolve eviction starvation; it compounded the latency stall. At 80 GiB, the 20% `eviction_dirty_trigger` allowed $80\text{ GiB} \times 0.20 = 16.0\text{ GiB}$ of dirty pages to accumulate. When dirty data crossed the 16 GiB mark, application threads were recruited to flush an enormous backlog of dirty pages. Disk write stalls lengthened from 30 seconds to over 2 minutes. Furthermore, allocating 80 GiB left only 16 GiB for the operating system, starving the Linux kernel page cache and causing severe memory fragmentation.

### Misstep 2: Increasing `wiredTigerConcurrentWriteTransactions` to 512

Another failed remedy was artificially increasing concurrency tickets from 128 to 512 via `setParameter.wiredTigerConcurrentWriteTransactions: 512` [Source: MongoDB Server Parameters Reference (https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerConcurrentWriteTransactions)]:

```javascript
// Flawed runtime parameter attempt
db.adminCommand({
  "setParameter": 1,
  "wiredTigerConcurrentWriteTransactions": 512
});
```

* **Why It Backfired**: Concurrency tickets are an admission control throttle designed to protect hardware from thrashing. When NVMe disk write bandwidth and eviction threads were already fully saturated, granting 512 concurrent write tickets allowed 512 threads to fight for WiredTiger internal B-Tree bucket spinlocks simultaneously. Context switching spiked by 400%, CPU time transitioned into kernel lock spinning (`spin_lock`), and ticket wait latency escalated from 15 seconds to complete cluster deadlocks.

### Misstep 3: Disabling Journaling (`storage.journal.enabled: false`)

To reduce write overhead, journaling was temporarily toggled off in staging. While write throughput initially appeared to rise, dirty cache accumulation remained completely unchanged because memory page reconciliation operates independently of write-ahead logging. Disabling journaling compromised ACID durability and exposed the deployment to unrecoverable data corruption in the event of an OS panic.

---

## 5. Production Remediation & Unified Diffs

A durable remediation required:
1. Tightening WiredTiger dirty cache eviction thresholds so background flushing starts well before application threads are hijacked.
2. Expanding dedicated background eviction threads.
3. Tuning the Linux kernel dirty page writeback ratios to prevent OS-level I/O buffering deadlocks.
4. Bounding client-side application connection pools to match storage capacity.

### Step 1: WiredTiger Eviction Parameters and Worker Expansion

We tuned `eviction_dirty_target` down to 3%, `eviction_dirty_trigger` down to 10%, and expanded dedicated eviction background workers from minimum 1 to minimum 4 / maximum 8 threads [Source: WiredTiger Cache Tuning Guide (https://source.wiredtiger.com/develop/tune_cache.html)]:

```diff
--- /etc/mongod.conf.orig	2026-11-23 09:12:00.000000000 +0000
+++ /etc/mongod.conf	2026-11-23 09:45:00.000000000 +0000
@@ -28,8 +28,15 @@
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
+  # Lower dirty triggers to prevent application thread hijacking (defaults: dirty_target=5, dirty_trigger=20)
+  wiredTigerEngineRuntimeConfig: "eviction_target=75,eviction_trigger=90,eviction_dirty_target=3,eviction_dirty_trigger=10"
+  wiredTigerConcurrentWriteTransactions: 128
+  wiredTigerConcurrentReadTransactions: 128
```

Applying this dynamically via `mongosh` during runtime without instance restarts [Source: MongoDB Parameters (https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerEngineRuntimeConfig)]:

```javascript
// Dynamic runtime calibration on primary and secondary replica set members
db.adminCommand({
  "setParameter": 1,
  "wiredTigerEngineRuntimeConfig": "eviction_target=75,eviction_trigger=90,eviction_dirty_target=3,eviction_dirty_trigger=10"
});
```

### Step 2: Linux Kernel Dirty Writeback Calibration

Linux default `vm.dirty_ratio` (20%) and `vm.dirty_background_ratio` (10%) allow huge bursts of dirty pages in the OS page cache before pdflush/flush threads activate. On a 96 GiB host, 20% represents nearly 19 GiB of buffered writes, triggering OS-level sync pauses. We tuned the kernel to flush continuously [Source: Linux Kernel Virtual Memory Documentation (https://docs.kernel.org)]:

```diff
--- /etc/sysctl.d/99-mongodb.conf.orig	2026-11-23 09:15:00.000000000 +0000
+++ /etc/sysctl.d/99-mongodb.conf	2026-11-23 09:48:00.000000000 +0000
@@ -1,5 +1,8 @@
 fs.file-max = 64000
 vm.max_map_count = 262144
-vm.dirty_ratio = 20
-vm.dirty_background_ratio = 10
+vm.dirty_ratio = 8
+vm.dirty_background_ratio = 3
+vm.swappiness = 1
+vm.zone_reclaim_mode = 0
```

### Step 3: Application Microservice Connection Pool Constraint

To prevent thousands of application worker threads from overwhelming the 128 storage tickets during transient checkpoint write bursts, connection pools across all microservice replicas were capped:

```diff
--- src/main/resources/application.yml.orig	2026-11-23 09:20:00.000000000 +0000
+++ src/main/resources/application.yml	2026-11-23 09:50:00.000000000 +0000
@@ -12,7 +12,11 @@
   data:
     mongodb:
       uri: mongodb://cluster-primary:27017,cluster-sec01:27017/orders?replicaSet=rs0
+      # Constrain client connection pool to prevent ticket acquisition stampedes
+      max-connection-pool-size: 50
+      min-connection-pool-size: 10
+      max-wait-time-ms: 2000
+      socket-timeout-ms: 5000
```

---

## 6. Verification CLI & Runtime Diagnostics

Execute the following commands on the database host to inspect active ticket utilization, application thread eviction counters, and kernel memory flush behavior:

```bash
# 1. Measure real-time WiredTiger ticket availability and dirty cache state
mongosh --quiet --eval '
  const status = db.serverStatus();
  const wt = status.wiredTiger;
  print("Write Tickets Checked Out: " + wt.concurrentTransactions.write.out);
  print("Write Tickets Available:   " + wt.concurrentTransactions.write.available);
  print("Write Tickets Total:       " + wt.concurrentTransactions.write.totalTickets);
  print("Read Tickets Available:    " + wt.concurrentTransactions.read.available);
  print("Tracked Dirty Bytes:       " + (wt.cache["tracked dirty bytes in the cache"] / 1024 / 1024).toFixed(2) + " MB");
  print("App Threads Evicting:      " + wt.cache["pages evicted by application threads"]);
'

# 2. Inspect active mongostat feed to verify queue backlog (qr|qw) and dirty percentage
mongostat --rowcount 5 1

# 3. Verify kernel memory dirty page ratios and virtual memory I/O stalls
vmstat 1 5

# 4. Inspect active dirty ratio kernel configuration via sysctl
sudo sysctl -p /etc/sysctl.d/99-mongodb.conf
sysctl -a | grep -E "vm.dirty_(background_)?ratio|vm.swappiness"

# 5. Inspect NVMe disk write latency and queue depth via iostat
iostat -xkz 1 5

# 6. Check active MongoDB incoming TCP socket connection queues and backlog
ss -ti '( sport = :27017 or dport = :27017 )'

# 7. Check administrative health endpoint and active tickets via curl
curl -s http://127.0.0.1:28017/serverStatus | grep -A 10 "concurrentTransactions" || true
```

---

## 7. Verification Results & Production Recovery

Following the deployment of the calibrated eviction watermarks and kernel sysctl parameters, the database cluster was subjected to a synthetic write load of 22,000 upserts per second:

* **Elimination of Thread Hijacking**: `pages evicted by application threads` remained at **0** throughout the test window. Background eviction workers actively managed dirty page reconciliation.
* **Ticket Availability Preserved**: Available write tickets (`wiredTiger.concurrentTransactions.write.available`) stayed consistently **above 105 out of 128**, completely preventing ticket exhaustion.
* **P99 Latency Compression**: Write latency dropped from over **15,000ms down to 3.8ms**.
* **Zero Socket Timeouts**: Monitored over 48 hours of continuous production peak traffic with **zero client-side `ExceededTimeLimit` errors**.

---

## 8. Architectural Checklist for High-Throughput Write Workloads

1. **Tighten Dirty Watermarks Early**: Never leave `eviction_dirty_trigger` at the default 20% on large-memory instances ($>32\text{ GiB}$). Configure `eviction_dirty_target: 3` and `eviction_dirty_trigger: 10` so dedicated workers flush continuously [Source: WiredTiger Cache Tuning Architecture (https://source.wiredtiger.com/develop/tune_cache.html)].
2. **Scale Eviction Worker Threads**: Set `configString: "eviction=(threads_min=4,threads_max=8)"` in `mongod.conf` to provide sufficient background worker capacity for multi-core systems.
3. **Align Linux Kernel Page Cache Ratios**: Set `vm.dirty_background_ratio = 3` and `vm.dirty_ratio = 8` to synchronize OS writeback with storage engine flush cadences [Source: Linux Kernel Virtual Memory Documentation (https://docs.kernel.org)].
4. **Constrain Application Connection Pools**: Maintain strict client connection caps (e.g., maximum 50 connections per replica) to prevent client stampedes during scheduled storage checkpoints.
5. **Monitor Eviction Telemetry**: Trigger PagerDuty alerts whenever `pages evicted by application threads > 0` or `wiredTiger.concurrentTransactions.write.available < 20` for more than 5 consecutive seconds.

---

## 9. References & Fact-Check Sources

* [MongoDB Manual: WiredTiger Storage Engine RAM & Architecture](https://www.mongodb.com/docs/manual/core/wiredtiger-storage-engine/)
* [MongoDB Manual: Server Parameters - wiredTigerConcurrentWriteTransactions](https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerConcurrentWriteTransactions)
* [MongoDB Manual: Server Parameters - wiredTigerConcurrentReadTransactions](https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerConcurrentReadTransactions)
* [MongoDB Manual: Server Parameters - wiredTigerEngineRuntimeConfig](https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerEngineRuntimeConfig)
* [MongoDB Manual: Database Command serverStatus - WiredTiger Metrics](https://www.mongodb.com/docs/manual/reference/command/serverStatus/#mongodb-serverstatus-serverstatus.wiredtiger)
* [MongoDB Database Tools Documentation: mongostat](https://www.mongodb.com/docs/database-tools/mongostat/)
* [WiredTiger Storage Engine Official Source Documentation: Tuning Cache Eviction](https://source.wiredtiger.com/develop/tune_cache.html)
* [Linux Kernel Documentation: Documentation for /proc/sys/vm/](https://docs.kernel.org)
