---
layout: post
title: "PostgreSQL Production Emergency: Transaction ID Wraparound and Autovacuum Freeze Starvation"
date: 2026-11-17 11:08:00 +0900
categories: [Database, PostgreSQL]
tags: [PostgreSQL, Autovacuum, TXID, Wraparound, Database, Troubleshooting]
---

A high-throughput write-heavy PostgreSQL cluster abruptly shut down and refused connections during peak traffic hours. The database engine initiated an emergency forced shutdown to prevent silent catastrophic data loss caused by 32-bit transaction ID (txid) wraparound.

```text
2026-11-17 01:42:19.412 UTC [31842] LOG:  database "analytics_events" must be vacuumed within 1000000 transactions
2026-11-17 01:58:04.108 UTC [31842] WARNING:  database "analytics_events" must be vacuumed within 100000 transactions
2026-11-17 02:04:12.891 UTC [1082] FATAL:  database is not accepting commands to avoid wraparound data loss in database "analytics_events"
2026-11-17 02:04:12.891 UTC [1082] HINT:  Stop the postmaster and vacuum that database in single-user mode.
```

## Production Specs
- **Engine**: PostgreSQL 16.3 on Debian 12 (Bookworm)
- **Linux Kernel**: 6.6.21-cloud-amd64
- **Database Size**: 4.8 TB (NVMe RAID 10)
- **Workload**: ~45,000 write ops/sec (Time-series event ingestion)
- **Active Connections**: 650 via PgBouncer (Transaction Pooling)

## The Underlying System Failure: 32-Bit Cyclic TXID Space
PostgreSQL uses 32-bit unsigned integers for transaction IDs (`TransactionId`). A 32-bit counter supports $2^{32} \approx 4.29 \times 10^9$ unique IDs. To maintain Multi-Version Concurrency Control (MVCC) without overflowing, PostgreSQL treats transaction comparison modularly: any given transaction ID has 2 billion older transaction IDs and 2 billion newer transaction IDs relative to itself.

If uncleaned rows remain older than $2^{31}$ transactions back, a newly created transaction ID will loop around and appear to be *in the past* relative to the old rows. Old rows would become invisible, effectively vanishing from queries.

```
       [Past: 2 Billion TXIDs]        [Current TXID]       [Future: 2 Billion TXIDs]
<--------------------------------------------*------------------------------------------->
                      Txid Wraparound Danger: (Old TXID + 2^31) loops to Future!
```

To prevent this, the engine relies on **VACUUM FREEZE**. Freezing replaces an explicit `xmin` transaction ID with `FrozenTransactionId` (value 2), indicating the row is older than all possible transactions and always visible.

In this incident, autovacuum workers were starved due to overly conservative cost limit throttle parameters and aggressive table-level exclusive locks held by long-running reporting queries.

## Root Cause Analysis
1. **Autovacuum Cost Throttling**: The global `autovacuum_vacuum_cost_limit` was left at default (200), with `autovacuum_vacuum_cost_delay` at 2ms. Scanning large 200GB heap segments choked down throughput to less than 15 MB/s of I/O.
2. **Lock Starvation**: A nightly analytical ETL job ran `LOCK TABLE raw_events IN SHARE UPDATE EXCLUSIVE MODE` for 4 hours, blocking autovacuum worker processes from acquiring cleanup locks.
3. **Oldest TXID Distance Exceeded**:
   `datfrozenxid` in `pg_database` drifted past `autovacuum_freeze_max_age` (200,000,000), crossing into emergency failsafe territory.

## Incident Resolution & Single-User Recovery
Because the engine entered `FATAL` emergency mode, all TCP/Unix-socket client connections were rejected. Recovery required executing `VACUUM FREEZE` in standalone single-user mode.

```bash
# 1. Stop systemd PostgreSQL service
sudo systemctl stop postgresql

# 2. Launch single-user backend as postgres user
sudo -u postgres postgres --single -D /var/lib/postgresql/16/main analytics_events

# 3. Inside the single-user shell, run aggressive manual freeze
backend> VACUUM FREEZE VERBOSE raw_events;
backend> VACUUM FREEZE VERBOSE event_aggregates;
backend> CHECKPOINT;
backend> ^D (Ctrl+D to exit)

# 4. Restart PostgreSQL daemon
sudo systemctl start postgresql
```

## Production Autovacuum Hardening (Before vs After)

```diff
--- /etc/postgresql/16/main/postgresql.conf.orig
+++ /etc/postgresql/16/main/postgresql.conf
@@ -140,8 +140,8 @@
 # Default autovacuum settings choked NVMe storage throughput
-autovacuum_max_workers = 3
-autovacuum_vacuum_cost_limit = 200
-autovacuum_vacuum_cost_delay = 2ms
-autovacuum_vacuum_scale_factor = 0.2
+autovacuum_max_workers = 8
+autovacuum_vacuum_cost_limit = 3000
+autovacuum_vacuum_cost_delay = 0ms
+autovacuum_vacuum_scale_factor = 0.05
+autovacuum_freeze_max_age = 250000000
+vacuum_freeze_min_age = 10000000
+vacuum_freeze_table_age = 150000000
```

## Proactive Monitoring Query
Run this query via Prometheus `postgres_exporter` to alert well before reaching failsafe:

```sql
SELECT
    datname,
    age(datfrozenxid) AS age_datfrozenxid,
    current_setting('autovacuum_freeze_max_age')::bigint AS max_age,
    round(100.0 * age(datfrozenxid) / current_setting('autovacuum_freeze_max_age')::bigint, 2) AS pct_towards_wraparound
FROM pg_database
WHERE datallowconn
ORDER BY 2 DESC;
```
Alert when `pct_towards_wraparound` exceeds 75%.
