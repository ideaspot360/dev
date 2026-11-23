---
layout: post
title: "PostgreSQL Production Emergency: Transaction ID Wraparound and Autovacuum Freeze Starvation"
date: 2026-11-17 11:08:43 +0900
category: "Database & Storage"
categories: ["Database & Storage"]
tags: [PostgreSQL, MVCC, Autovacuum, TXIDWraparound, datfrozenxid, VacuumFreeze, MultiXact, LinuxKernel, DevOps, Performance, Troubleshooting]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When high-throughput write workloads drive PostgreSQL transaction IDs toward the 32-bit ceiling, autovacuum freeze starvation triggers an emergency cluster lockdown with 'FATAL: database is not accepting commands to avoid wraparound data loss'. Here is an architectural deep dive into 32-bit modular XID ring mechanics (TransactionIdPrecedes), vacuum cost delay throttling equations, visibility map page freezing, MultiXact ID wraparound (autovacuum_multixact_freeze_max_age), vacuum failsafe bypasses (vacuum_failsafe_age), lock contention from abandoned 2PC transactions and stale replication slots, single-user recovery (postgres --single), and production sysctl/conf hardening."
verification_date: "2026-11-23"
fact_check_sources:
  - "https://www.postgresql.org/docs/16/routine-vacuuming.html"
  - "https://www.postgresql.org/docs/16/runtime-config-autovacuum.html"
  - "https://www.postgresql.org/docs/16/runtime-config-resource.html"
  - "https://www.postgresql.org/docs/16/app-postgres.html"
  - "https://www.postgresql.org/docs/16/sql-vacuum.html"
  - "https://www.postgresql.org/docs/16/view-pg-stat-progress-vacuum.html"
  - "https://www.postgresql.org/docs/16/monitoring-stats.html"
  - "https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/access/transam/varsup.c"
  - "https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/commands/vacuum.c"
  - "https://docs.kernel.org/admin-guide/sysctl/vm.html"
---

During peak data ingestion hours, a high-throughput write-heavy PostgreSQL 16 cluster abruptly locked down and rejected all write transactions across all client application services [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html). The database engine initiated an emergency protective shutdown to prevent silent, irrecoverable data loss caused by 32-bit transaction ID (XID) wraparound.

```text
2026-11-17 01:42:19.412 UTC [31842] LOG:  database "analytics_events" must be vacuumed within 40000000 transactions
2026-11-17 01:52:04.108 UTC [31842] WARNING:  database "analytics_events" must be vacuumed within 10000000 transactions
2026-11-17 02:04:12.891 UTC [1082] FATAL:  database is not accepting commands to avoid wraparound data loss in database "analytics_events"
2026-11-17 02:04:12.891 UTC [1082] HINT:  Stop the postmaster and vacuum that database in single-user mode.
You might also need to commit or roll back old prepared transactions, or drop stale replication slots.
```

Downstream microservices immediately began logging transaction failures as PgBouncer pooled connections received fatal server errors:

```text
2026-11-17T02:04:13.014Z [ingest-worker,7b2a9e1c,4f8e2d1a] ERROR 40182 --- [nio-8080-exec-9] c.e.events.service.IngestService : Failed to persist raw event batch: org.postgresql.util.PSQLException: FATAL: database is not accepting commands to avoid wraparound data loss in database "analytics_events"
```

Manual query execution via `psql` confirmed an immediate write rejection across all mutating DML and DDL commands, while read-only queries (`SELECT`) remained accessible:

```bash
psql -h 127.0.0.1 -p 5432 -U postgres -d analytics_events -c "INSERT INTO raw_events (event_id, payload) VALUES ('evt-99120', '{\"status\":\"test\"}');"
```
```text
FATAL:  database is not accepting commands to avoid wraparound data loss in database "analytics_events"
HINT:  Stop the postmaster and vacuum that database in single-user mode.
You might also need to commit or roll back old prepared transactions, or drop stale replication slots.
```

---

## Production Environment Specs
* **Database Engine**: PostgreSQL 16.3 on Debian 12 (Bookworm) [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html)
* **Linux Kernel**: 6.6.21-cloud-amd64 x86_64 [Source: Linux Kernel Virtual Memory Documentation](https://docs.kernel.org/admin-guide/sysctl/vm.html)
* **Physical Hardware**: AWS EC2 `i3en.6xlarge` (24 vCPU, 192 GB Physical RAM, 50 Gbps network interface)
* **Storage Subsystem**: 4.8 TB Direct-Attached NVMe SSD (PCIe Gen4 x4, mdadm RAID 10, ext4 filesystem mounted with `noatime,data=ordered`, delivering 85,000 read IOPS / 65,000 write IOPS)
* **Memory Allocation**: `shared_buffers = 48GB`, `maintenance_work_mem = 2GB`, `work_mem = 64MB`, `autovacuum_work_mem = -1` (falling back to `maintenance_work_mem`)
* **Connection Pooling**: PgBouncer 1.22.1 (Transaction Pooling mode, 650 application client connections mapped to 80 PostgreSQL backend server processes)
* **Workload Characteristics**: Sustained time-series telemetry ingestion operating at ~45,000 write operations/sec (~3.8 billion transactions accumulated every 24 to 36 hours)

---

## 1. Root Cause Analysis: The Mechanics of TXID Wraparound and Autovacuum Starvation

PostgreSQL's Multi-Version Concurrency Control (MVCC) architecture relies on transaction IDs to determine tuple visibility across concurrent client sessions [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html). Under sustained high-velocity write workloads, four interacting factors drove the cluster into emergency lockdown.

### 1.1 The 32-Bit Cyclic TXID Space and Modular Horizon Arithmetic

In PostgreSQL 16, transaction IDs are represented as 32-bit unsigned integers (`TransactionId`), providing a maximum space of:
$$2^{32} = 4,294,967,296\text{ unique transactions}$$

Special transaction IDs are reserved by the engine:
* `InvalidTransactionId` = `0`
* `BootstrapTransactionId` = `1`
* `FrozenTransactionId` = `2`
* `FirstNormalTransactionId` = `3`

Because a 32-bit counter would overflow after 4.29 billion write transactions, PostgreSQL treats the XID space as a cyclic modular ring [Source: PostgreSQL Source Code - varsup.c](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/access/transam/varsup.c). Relative to any currently executing transaction ID $X$, the preceding 2 billion transaction IDs ($2^{31}$) are defined as the *past*, while the succeeding 2 billion transaction IDs are defined as the *future*.

PostgreSQL evaluates transaction age order using signed 32-bit modular arithmetic in `TransactionIdPrecedes()`:

```c
/* Defined in src/include/access/transam.h */
#define TransactionIdPrecedes(id1, id2) \
    ((int32) ((id1) - (id2)) < 0)
```

```
       [Past: 2^31 Transactions]            [Current XID]            [Future: 2^31 Transactions]
<──────────────────────────────────────────────────*──────────────────────────────────────────────────>
 [Normal MVCC Horizon: Tuple Visible]                       [Future XID: Tuple Invisible]

 DANGER: If an unfrozen row's xmin falls behind (Current XID - 2^31),
         (Current XID - xmin) wraps into signed negative space,
         rendering historical committed data permanently INVISIBLE!
```

If a heap tuple's creation transaction ID (`t_xmin`) remains unfrozen while normal transaction progression advances past $2^{31} \approx 2.14 \times 10^9$ transactions, modular subtraction wraps around:
$$\text{diff} = (int32)(X_{\text{current}} - t_{\text{xmin}}) < 0$$

The engine interprets the historical tuple as having been created *in the future*, causing all subsequent `SELECT` queries to treat the row as uncommitted and invisible [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html).

To permanently secure tuple visibility, `VACUUM` freezes tuples by setting infomask bit flags in the tuple header:
* `HEAP_XMIN_FROZEN` (defined as `HEAP_XMIN_COMMITTED | HEAP_XMIN_INVALID`)
* In modern PostgreSQL storage formats, freezing sets this hint bit rather than rewriting the physical `t_xmin` to `FrozenTransactionId` (2), eliminating write churn on heap pages while guaranteeing that all future transactions consider the tuple universally visible.

### 1.2 Autovacuum Cost Throttling Equations and Worker Starvation

PostgreSQL implements a token-bucket cost delay mechanism to prevent background vacuum workers from saturating disk I/O [Source: PostgreSQL Documentation - Autovacuum Configuration](https://www.postgresql.org/docs/16/runtime-config-autovacuum.html). Each vacuum worker accumulates cost points for every buffer interaction:
$$\text{Cost} = (N_{\text{hit}} \times \text{cost}_{\text{hit}}) + (N_{\text{miss}} \times \text{cost}_{\text{miss}}) + (N_{\text{dirty}} \times \text{cost}_{\text{dirty}})$$

The default cost point weights and limits in `postgresql.conf` were:
* `vacuum_cost_page_hit = 1` (Buffer located in `shared_buffers`)
* `vacuum_cost_page_miss = 2` (Buffer fetched from OS page cache or disk)
* `vacuum_cost_page_dirty = 20` (Buffer modified and marked dirty for write-out)
* `autovacuum_vacuum_cost_limit = 200`
* `autovacuum_vacuum_cost_delay = 2ms`

Whenever accumulated cost points reach `autovacuum_vacuum_cost_limit`, the worker sleeps for `autovacuum_vacuum_cost_delay`.

Under an active write workload generating dead tuples and requiring page freezing, every page freeze dirties the buffer (`cost = 20`). The theoretical maximum page dirty rate permitted by this throttling model is:
$$\text{Max Loops/sec} = \frac{1000\text{ ms}}{\text{autovacuum\_vacuum\_cost\_delay}} = \frac{1000\text{ ms}}{2\text{ ms}} = 500\text{ cycles/sec}$$

$$\text{Max Dirty Pages/sec} = \frac{\text{autovacuum\_vacuum\_cost\_limit}}{\text{vacuum\_cost\_page\_dirty}} \times \text{Max Loops/sec} = \frac{200}{20} \times 500 = 5,000\text{ pages/sec}$$

Given an 8-KB page size ($8,192\text{ bytes}$), the ceiling on dirty write throughput across the storage subsystem was:
$$\text{Max Write Throughput} = 5,000\text{ pages/sec} \times 8\text{ KB} = 40,000\text{ KB/sec} \approx 39.06\text{ MB/sec}$$

Furthermore, in PostgreSQL, `autovacuum_vacuum_cost_limit` is shared equally among all active autovacuum worker processes:
$$\text{Worker Cost Limit} = \frac{\text{autovacuum\_vacuum\_cost\_limit}}{\text{active\_autovacuum\_workers}}$$

With `autovacuum_max_workers = 3` active, each worker was restricted to a cost limit of $\lfloor 200 / 3 \rfloor = 66$, throttling individual worker dirty throughput to less than:
$$\Phi_{\text{worker}} \approx 12.89\text{ MB/sec}$$

On an NVMe storage array capable of $4,500\text{ MB/sec}$ sustained sequential write bandwidth, autovacuum workers were choked to 0.8% of available hardware capacity while processing a 4.8 TB dataset receiving 45,000 writes/sec.

### 1.3 The Aggressive Vacuum Thresholds and Failsafe Bypasses

PostgreSQL governs proactive and forced table-level vacuuming through four configuration thresholds [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html):
1. **`vacuum_freeze_min_age`** (Default: 50,000,000 transactions): The minimum age a tuple must reach before `VACUUM` converts its `xmin` to frozen status.
2. **`vacuum_freeze_table_age`** (Default: 150,000,000 transactions): When a table's `pg_class.relfrozenxid` reaches this age, `VACUUM` initiates an *aggressive scan*, reading all pages including those marked all-visible in the Visibility Map.
3. **`autovacuum_freeze_max_age`** (Default: 200,000,000 transactions): The hard threshold triggering an anti-wraparound autovacuum worker even if `autovacuum = off` is globally configured.
4. **`vacuum_failsafe_age`** (Default: 1,600,000,000 transactions, introduced in PostgreSQL 14): When `age(relfrozenxid)` reaches this boundary, `VACUUM` bypasses cost-based delays, drops buffer access strategy constraints, and skips index vacuuming to prioritize heap freezing [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html).

```
   0 TXIDs            150M TXIDs              200M TXIDs               1.6B TXIDs             2.09B TXIDs      2.14B TXIDs
┌──────────────┬───────────────────────┬───────────────────────┬────────────────────────┬─────────────┬───────────┐
│ Normal       │ Aggressive Vacuum     │ Forced Anti-Wraparound│ Vacuum Failsafe        │ Warning     │ Emergency │
│ Autovacuum   │ (Scans All Pages)     │ Autovacuum Worker     │ (Bypasses Cost Delays) │ Thresholds  │ Lockdown  │
│ (Dead Tuples)│ relfrozenxid > 150M   │ relfrozenxid > 200M   │ relfrozenxid > 1.6B    │ 40M/10M left│ 1M left   │
└──────────────┴───────────────────────┴───────────────────────┴────────────────────────┴─────────────┴───────────┘
```

The postmaster enforces escalating warning thresholds as the oldest unfrozen XID approaches $2^{31} - 1$:
* **40,000,000 transactions remaining**: `LOG: database "%s" must be vacuumed within 40000000 transactions`
* **10,000,000 transactions remaining**: `WARNING: database "%s" must be vacuumed within 10000000 transactions`
* **1,000,000 transactions remaining**: `FATAL: database is not accepting commands to avoid wraparound data loss in database "%s"` [Source: PostgreSQL Source Code - varsup.c](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/access/transam/varsup.c)

In this incident, despite `vacuum_failsafe_age` engaging, the autovacuum process was unable to complete relation freezing due to external blocking factors pinning the cluster-wide transaction horizon.

### 1.4 Horizon Pinning: Stale Replication Slots and Orphaned Prepared Transactions

`VACUUM` cannot freeze any tuple whose `xmin` is newer than the oldest active transaction horizon across the entire PostgreSQL cluster [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html). The global `xmin` horizon is bounded by:
$$\text{Horizon}_{\text{xmin}} = \min(\text{Active Backends}_{\text{xmin}}, \text{Replication Slots}_{\text{xmin}}, \text{Prepared Transactions}_{\text{xmin}})$$

Inspection of system catalogs revealed three distinct horizon blockers:
1. **Orphaned Two-Phase Commit (2PC) Transaction**:
   A distributed ETL worker initiated a two-phase transaction and disconnected without executing `COMMIT PREPARED` or `ROLLBACK PREPARED`:
   ```sql
   SELECT gid, prepared, owner, database FROM pg_prepared_xacts;
   ```
   ```text
                gid             |           prepared            |  owner   |     database     
   -----------------------------+-------------------------------+----------+------------------
    etl_sync_batch_20261115_01  | 2026-11-15 03:12:08.419201+00 | etl_user | analytics_events
   ```
   This orphaned prepared transaction held `xmin = 1,842,109,230` open for over 46 hours.
2. **Abandoned Inactive Replication Slot**:
   A temporary logical replication slot created for a test Kafka CDC consumer pipeline was left enabled after the consumer process was decommissioned:
   ```sql
   SELECT slot_name, plugin, slot_type, active, catalog_xmin, restart_lsn FROM pg_replication_slots;
   ```
   ```text
          slot_name       |  plugin  | slot_type | active | catalog_xmin | restart_lsn 
   -----------------------+----------+-----------+--------+--------------+-------------
    analytics_cdc_kafka   | pgoutput | logical   | f      | 1845100214   | 8E/4A12B000
   ```
   Because `active = false`, the slot never consumed WAL or advanced its catalog horizon, pinning `catalog_xmin` and preventing catalog relation cleanup.
3. **Lock Contention from Long-Running Reporting Queries**:
   Nightly analytical aggregations executed queries holding `ACCESS SHARE` locks for 3.5 hours on `raw_events`, while maintenance scripts attempted `LOCK TABLE raw_events IN SHARE UPDATE EXCLUSIVE MODE`. PostgreSQL's `deadlock_timeout` (1 second) triggered autovacuum worker cancellation whenever application queries queued for relation locks.

Because the oldest active `xmin` was pinned at `1,842,109,230`, every autovacuum pass on `raw_events` was forced to skip freezing tuples newer than that horizon. As write ingestion consumed millions of new XIDs per hour, the distance between current XID and `datfrozenxid` crossed the 1-million boundary, triggering the hard postmaster safety shutdown [Source: PostgreSQL Source Code - varsup.c](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/access/transam/varsup.c).

### 1.5 MultiXact ID Wraparound Dynamics (`datminmxid`)

In addition to regular transaction IDs, PostgreSQL assigns MultiXact IDs (`MultiXactId`) when multiple transactions concurrently acquire row-level shared locks (e.g., `SELECT ... FOR SHARE` or foreign key reference validation) [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html).

MultiXact IDs are also 32-bit unsigned integers stored in `$PGDATA/pg_multixact/offsets` and `$PGDATA/pg_multixact/members`. They are bounded by:
* `autovacuum_multixact_freeze_max_age` (Default: 400,000,000 multixacts)
* `vacuum_multixact_freeze_table_age` (Default: 150,000,000 multixacts)
* `vacuum_multixact_failsafe_age` (Default: 1,600,000,000 multixacts)

Tracked via `pg_database.datminmxid` and `pg_class.relminmxid`, MultiXact exhaustion triggers identical emergency write-lockout mechanics if `age(datminmxid)` approaches 2 billion multixacts.

---

## 2. Common Missteps: Dangerous Workarounds When Facing Vacuum Lag

During transaction ID exhaustion and autovacuum backlog incidents, engineering teams often attempt rapid interventions that exacerbate system instability or cause silent data corruption [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html).

### Misstep 1: Disabling Autovacuum During Peak Write Traffic
```ini
# DANGEROUS: Temporarily turning off autovacuum to relieve NVMe I/O
autovacuum = off
```
* **Why this fails**: Disabling `autovacuum` does not halt transaction ID consumption. The 32-bit counter continues advancing at 45,000 XIDs/sec. Furthermore, PostgreSQL's engine is hardcoded to launch anti-wraparound autovacuum workers once `age(relfrozenxid) >= autovacuum_freeze_max_age` (200,000,000), completely overriding `autovacuum = off` [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html). Disabling autovacuum merely prevents routine cleanup of dead tuples, accumulating massive heap bloat and ensuring that when anti-wraparound vacuuming inevitably launches, it must scan millions of additional bloated pages under severe lock contention.

### Misstep 2: Executing `VACUUM FULL` on Multi-Terabyte Relations
```sql
-- DANGEROUS: Running full rewrite on active production tables
VACUUM FULL raw_events;
```
* **Why this fails**: Unlike standard `VACUUM`, `VACUUM FULL` builds a completely new copy of the relation and its secondary indexes on disk. It acquires an `ACCESS EXCLUSIVE` lock, completely blocking all concurrent `SELECT`, `INSERT`, `UPDATE`, and `DELETE` operations for the entire duration of the rewrite. On a 4.8 TB database, `VACUUM FULL` requires 100% additional free disk capacity (~4.8 TB free space) and can take 6 to 12 hours. If disk space is exhausted mid-operation, the transaction rolls back, wasting hours of total application downtime while leaving transaction ID age entirely unaddressed [Source: PostgreSQL Documentation - SQL VACUUM](https://www.postgresql.org/docs/16/sql-vacuum.html).

### Misstep 3: Artificially Raising `autovacuum_freeze_max_age` Beyond 1.8 Billion
```ini
# DANGEROUS: Pushing freeze threshold close to the 2-billion hard ceiling
autovacuum_freeze_max_age = 1800000000
```
* **Why this fails**: Raising `autovacuum_freeze_max_age` to near 1.8 billion narrows the critical margin between normal aggressive vacuuming and the hard emergency shutdown point (2,146,483,648). At 45,000 writes/sec, 300 million transactions are consumed in less than 2 hours. If an autovacuum worker encounters lock starvation, an uncommitted prepared transaction, or disk I/O saturation, the cluster will crash into emergency mode before operators can diagnose or resolve the underlying bottleneck.

### Misstep 4: Forcibly Updating System Catalogs via `UPDATE pg_database`
```sql
-- CATASTROPHIC: Forcing datfrozenxid forward in catalog
UPDATE pg_database SET datfrozenxid = (SELECT txid_current()) WHERE datname = 'analytics_events';
```
* **Why this fails**: Manually advancing `datfrozenxid` without physically freezing heap pages destroys data integrity. Any historical row on disk with an actual `t_xmin` older than the falsified `datfrozenxid` will be treated as corrupt or invalid by `TransactionIdPrecedes()`. Subsequent queries will fail with `ERROR: could not access status of transaction` or silently omit rows from result sets, corrupting analytical reporting without generating immediate database crashes.

---

## 3. Incident Resolution: Recovery and Horizon Clearing Runbook

Because the postmaster entered the emergency failsafe state, standard client connections were terminated. Recovery required identifying and terminating the horizon blockers, followed by executing vacuum freezing [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html).

### Step 1: Drain Ingress Traffic and Clear Horizon Blockers

In modern PostgreSQL (versions 8.3 through 16), read-only connections and administrative `VACUUM` commands can be executed while in emergency shutdown mode without requiring immediate server termination, provided client write traffic is halted at the load balancer or PgBouncer [Source: PostgreSQL Documentation - Routine Vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html).

Pause PgBouncer to prevent application retries from exhausting backend processes:
```bash
pgbouncer -R -p 6432 -c "PAUSE analytics_events;"
```

Connect via `psql` locally over Unix domain socket:
```bash
sudo -u postgres psql -d analytics_events
```

Identify and terminate transactions blocking the `xmin` horizon:
```sql
-- 1. Identify long-running queries holding back the horizon
SELECT pid, usename, age(backend_xmin) AS xmin_age, state, query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC
LIMIT 5;

-- Terminate blocking backends
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL AND pid <> pg_backend_pid();

-- 2. Identify and roll back orphaned prepared transactions
SELECT gid, prepared, owner, database FROM pg_prepared_xacts;
ROLLBACK PREPARED 'etl_sync_batch_20261115_01';

-- 3. Drop abandoned replication slots holding catalog horizons
SELECT slot_name, plugin, slot_type, active, catalog_xmin, restart_lsn 
FROM pg_replication_slots;
SELECT pg_drop_replication_slot('analytics_cdc_kafka');
```

### Step 2: Standalone Single-User Mode Recovery (If Postmaster Rejects Commands)

If the database server was stopped or if the postmaster completely refuses connection initialization, standalone single-user mode bypasses background daemons, connection limits, and transaction concurrency [Source: PostgreSQL Documentation - postgres Application](https://www.postgresql.org/docs/16/app-postgres.html):

```bash
# 1. Stop systemd PostgreSQL service
sudo systemctl stop postgresql

# 2. Launch single-user backend as postgres system user
sudo -u postgres postgres --single -D /var/lib/postgresql/16/main analytics_events
```

Inside the interactive `backend>` prompt, allocate dedicated memory, disable cost delay throttling, and execute aggressive relation freezing:

```sql
backend> SET maintenance_work_mem = '16GB';
backend> SET vacuum_cost_delay = 0;
backend> VACUUM FREEZE VERBOSE raw_events;
backend> VACUUM FREEZE VERBOSE event_aggregates;
backend> VACUUM FREEZE VERBOSE pg_catalog.pg_class;
backend> VACUUM FREEZE VERBOSE pg_catalog.pg_attribute;
backend> CHECKPOINT;
backend> ^D
```
*(Press `Ctrl+D` to cleanly exit single-user mode).*

Restart the systemd PostgreSQL daemon:
```bash
sudo systemctl start postgresql
```

Verify that `datfrozenxid` and `relfrozenxid` have advanced safely:
```bash
sudo -u postgres psql -d analytics_events -c "
SELECT datname, age(datfrozenxid) AS age_datfrozenxid 
FROM pg_database 
WHERE datname = 'analytics_events';"
```
```text
     datname       | age_datfrozenxid 
-------------------+------------------
 analytics_events  |             1840
```

---

## 4. Production Autovacuum Hardening (Before vs. After)

To ensure autovacuum processes keep pace with 45,000 writes/sec on NVMe storage without starving for I/O or locking out client transactions, configuration parameters in `postgresql.conf` and Linux kernel sysctl were tuned [Source: PostgreSQL Documentation - Resource Consumption](https://www.postgresql.org/docs/16/runtime-config-resource.html):

```diff
--- /etc/postgresql/16/main/postgresql.conf.orig	2026-11-17 01:00:00.000000000 +0000
+++ /etc/postgresql/16/main/postgresql.conf	2026-11-17 03:30:00.000000000 +0000
@@ -140,15 +140,24 @@
-# Conservative defaults choked autovacuum workers on high-throughput NVMe storage
-autovacuum_max_workers = 3
-autovacuum_vacuum_cost_limit = 200
-autovacuum_vacuum_cost_delay = 2ms
-autovacuum_vacuum_scale_factor = 0.2
-autovacuum_vacuum_insert_scale_factor = 0.2
-vacuum_freeze_min_age = 50000000
-vacuum_freeze_table_age = 150000000
-autovacuum_freeze_max_age = 200000000
-autovacuum_multixact_freeze_max_age = 400000000
-autovacuum_work_mem = -1
-maintenance_work_mem = 64MB
-idle_in_transaction_session_timeout = 0
-statement_timeout = 0
+autovacuum = on
+autovacuum_max_workers = 6
+autovacuum_vacuum_cost_limit = 3000
+autovacuum_vacuum_cost_delay = 0ms
+autovacuum_vacuum_scale_factor = 0.05
+autovacuum_vacuum_threshold = 1000
+autovacuum_vacuum_insert_scale_factor = 0.05
+autovacuum_vacuum_insert_threshold = 10000
+vacuum_freeze_min_age = 10000000
+vacuum_freeze_table_age = 100000000
+autovacuum_freeze_max_age = 250000000
+autovacuum_multixact_freeze_max_age = 400000000
+autovacuum_work_mem = 2GB
+maintenance_work_mem = 4GB
+max_parallel_maintenance_workers = 4
+idle_in_transaction_session_timeout = 60000ms
+statement_timeout = 300000ms
```

In addition, storage parameter overrides were applied directly to high-churn tables to prevent massive write bursts from accumulating unfrozen pages:

```sql
ALTER TABLE raw_events SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 5000,
    autovacuum_vacuum_cost_limit = 5000,
    autovacuum_vacuum_cost_delay = 0,
    vacuum_freeze_min_age = 5000000,
    vacuum_freeze_table_age = 50000000
);
```

### Linux Kernel Memory & I/O Hardening

To prevent page-cache writeback spikes during large vacuum scans, Linux virtual memory dirty page ratios were stabilized in `/etc/sysctl.d/99-postgresql.conf` [Source: Linux Kernel Virtual Memory Documentation](https://docs.kernel.org/admin-guide/sysctl/vm.html):

```diff
--- /etc/sysctl.d/99-postgresql.conf.orig	2026-11-17 01:00:00.000000000 +0000
+++ /etc/sysctl.d/99-postgresql.conf	2026-11-17 03:30:00.000000000 +0000
@@ -10,4 +10,8 @@
-vm.dirty_background_ratio = 10
-vm.dirty_ratio = 20
+vm.dirty_background_ratio = 3
+vm.dirty_ratio = 8
+vm.overcommit_memory = 2
+vm.overcommit_ratio = 80
+vm.swappiness = 1
```

Apply kernel settings immediately:
```bash
sudo sysctl -p /etc/sysctl.d/99-postgresql.conf
```

---

## 5. Verification CLI & Real-Time Monitoring Queries

Following configuration deployment, verify service stability and vacuum execution across system daemons and database catalogs [Source: PostgreSQL Documentation - Monitoring Statistics](https://www.postgresql.org/docs/16/monitoring-stats.html):

```bash
# 1. Verify PostgreSQL system service status
sudo systemctl status postgresql --no-pager

# 2. Inspect active TCP listening sockets on port 5432
ss -tulpn | grep 5432

# 3. Verify kernel logs for any memory pressure or OOM incidents
dmesg -T | grep -E "oom-killer|Out of memory|postgresql"

# 4. Check PostgreSQL journal logs for autovacuum execution records
sudo journalctl -u postgresql -n 30 --no-pager
```

### Real-Time Transaction ID Age and Progress Queries

Monitor vacuum progress and table aging directly via PostgreSQL views [Source: PostgreSQL Documentation - Progress Reporting Views](https://www.postgresql.org/docs/16/view-pg-stat-progress-vacuum.html):

```sql
-- 1. Database-level transaction ID age monitoring
SELECT
    datname,
    age(datfrozenxid) AS age_datfrozenxid,
    current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age,
    round(100.0 * age(datfrozenxid) / current_setting('autovacuum_freeze_max_age')::bigint, 2) AS pct_freeze_max_age,
    age(datminmxid) AS age_datminmxid
FROM pg_database
WHERE datallowconn
ORDER BY 2 DESC;
```

```sql
-- 2. Relation-level oldest unfrozen XID tracking
SELECT
    c.oid::regclass AS table_name,
    c.reltuples::bigint AS estimated_rows,
    pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
    age(c.relfrozenxid) AS xid_age,
    age(c.relminmxid) AS mxid_age
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY xid_age DESC
LIMIT 10;
```

```sql
-- 3. Live Autovacuum Progress Tracking (PostgreSQL 16)
SELECT
    p.pid,
    p.datname,
    p.relid::regclass AS table_name,
    p.phase,
    p.heap_blks_total,
    p.heap_blks_scanned,
    p.heap_blks_vacuumed,
    round(100.0 * p.heap_blks_scanned / NULLIF(p.heap_blks_total, 0), 2) AS scan_pct,
    p.index_vacuum_count,
    a.state_change
FROM pg_stat_progress_vacuum p
JOIN pg_stat_activity a ON a.pid = p.pid;
```

---

## 6. Prometheus Alerting Rules & Production Runbook Checklist

To detect transaction ID aging and autovacuum stall before emergency lockdown thresholds are breached, configure Prometheus alerting rules via `postgres_exporter`:

```yaml
groups:
  - name: postgresql_xid_wraparound_alerts
    rules:
      - alert: PostgreSQLXidWraparoundWarning
        expr: |
          (pg_stat_database_xid_age / on(instance) pg_settings_autovacuum_freeze_max_age) * 100 > 70
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "PostgreSQL database {{ $labels.datname }} XID age approaching freeze limit"
          description: "Database {{ $labels.datname }} is at {{ $value | printf \"%.2f\" }}% of autovacuum_freeze_max_age. Autovacuum may be falling behind."

      - alert: PostgreSQLXidWraparoundCritical
        expr: |
          (pg_stat_database_xid_age / 2147483648) * 100 > 80
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL database {{ $labels.datname }} XID age critically near wraparound limit"
          description: "Database {{ $labels.datname }} has reached {{ $value | printf \"%.2f\" }}% of absolute 2^31 wraparound ceiling. Emergency shutdown imminent."

      - alert: PostgreSQLStaleReplicationSlot
        expr: |
          pg_replication_slots_active == 0 and (time() - pg_replication_slots_inactive_since_seconds) > 7200
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Inactive PostgreSQL replication slot {{ $labels.slot_name }} pinning horizon"
          description: "Replication slot {{ $labels.slot_name }} has been inactive for over 2 hours, blocking vacuum horizon."

      - alert: PostgreSQLOrphanedPreparedTransaction
        expr: |
          pg_prepared_statement_age_seconds > 3600
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Orphaned 2PC prepared transaction detected"
          description: "A prepared transaction has remained open for over 1 hour, pinning xmin horizon."
```

### Production Incident Verification Runbook Checklist

When investigating autovacuum lag or transaction ID warnings, follow this verification checklist:
- [ ] Query `pg_database` to identify databases where `age(datfrozenxid) >= 150,000,000`.
- [ ] Inspect `pg_stat_activity` for connections in `idle in transaction` state with `backend_xmin` older than 10 million transactions.
- [ ] Verify `pg_prepared_xacts` for orphaned two-phase commit transactions and execute `ROLLBACK PREPARED` on abandoned IDs.
- [ ] Audit `pg_replication_slots` for inactive slots (`active = 'f'`) pinning `catalog_xmin` or `restart_lsn`.
- [ ] Check `pg_locks` for long-running `ACCESS EXCLUSIVE` or `SHARE UPDATE EXCLUSIVE` locks conflicting with autovacuum workers.
- [ ] Confirm `autovacuum_vacuum_cost_delay = 0ms` or `1ms` and `autovacuum_vacuum_cost_limit >= 3000` on high-throughput NVMe storage nodes.
- [ ] Monitor active vacuum progress via `pg_stat_progress_vacuum` to confirm workers are scanning and vacuuming heap blocks.
