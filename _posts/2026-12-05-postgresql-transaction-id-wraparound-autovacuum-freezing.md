---
layout: post
pair_id: pair_20261205
title: "PostgreSQL Transaction ID Wraparound & Autovacuum Freezing Failure"
date: 2026-12-05 10:27:14 +0900
category: "Database & Storage"
tags: ['PostgreSQL', 'Autovacuum', 'DatabaseInternals', 'Performance', 'Troubleshooting', 'DBA']
fact_check_sources:
  - "https://www.postgresql.org/docs/16/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND"
  - "https://www.postgresql.org/docs/16/runtime-config-autovacuum.html"
  - "https://www.postgresql.org/docs/16/app-postgres.html"
  - "https://www.postgresql.org/docs/16/view-pg-prepared-xacts.html"
  - "https://www.postgresql.org/docs/16/view-pg-replication-slots.html"
  - "https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/access/transam/varsup.c"
verification_date: "2026-11-23"
---

During sustained high-velocity write throughput processing 8,500 transactions per second (TPS) across our core transactional database, our primary PostgreSQL cluster abruptly locked out all write transactions, transitioning into a fail-safe read-only state. Applications executing `INSERT`, `UPDATE`, or `DELETE` statements received immediate fatal errors, halting payment processing, ledger settlements, and order ingestion [Source: PostgreSQL Routine Vacuuming Documentation (https://www.postgresql.org/docs/16/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND)].

Inspection of the PostgreSQL server logs on the primary instance revealed that the storage engine triggered an emergency protective shutdown to avert silent data corruption resulting from 32-bit Transaction ID (XID) wraparound [Source: PostgreSQL Server Configuration - Autovacuum (https://www.postgresql.org/docs/16/runtime-config-autovacuum.html)]:

```text
2026-12-05 01:26:48.112 UTC [14822] WARNING:  database "prod_financial_db" must be vacuumed within 982104 transactions
2026-12-05 01:26:48.112 UTC [14822] HINT:  To avoid a database shutdown, execute a database-wide VACUUM in that database.
2026-12-05 01:27:19.458 UTC [14901] ERROR:  database is not accepting commands to avoid wraparound data loss in database "prod_financial_db"
2026-12-05 01:27:19.458 UTC [14901] HINT:  Stop the postmaster and vacuum that database in single-user mode.
2026-12-05 01:27:19.459 UTC [14901] STATEMENT:  INSERT INTO financial_ledger (account_id, amount, balance_after, created_at) VALUES ($1, $2, $3, NOW())
2026-12-05 01:27:19.460 UTC [14901] FATAL:  canceling authentication; system is in recovery mode or emergency wraparound shutdown
```

Database catalog queries against `pg_database` confirmed that the transaction age of `datfrozenxid` exceeded 2,144,483,647 transactions, crossing the emergency stop threshold ($2^{31} - 3,000,000$) where relative MVCC tuple visibility fails [Source: PostgreSQL GitHub Repository - varsup.c (https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/access/transam/varsup.c)].

---

## Production Incident Summary

Under a sustained ingestion load of 8,500 write TPS distributed across 32 application connection pools, our database cluster stopped processing mutations. Read-only queries continued to execute successfully, but every write transaction was rejected by the PostgreSQL postmaster.

Prometheus metrics scraped from `postgres_exporter` and local host socket diagnostics documented the instantaneous drop in write commits and the surge in client connection errors:

```text
# HELP postgres_xid_age Age of the oldest transaction ID across all databases
# TYPE postgres_xid_age gauge
postgres_xid_age{datname="prod_financial_db"} 2144483648
# HELP postgres_deadlocks_total Total number of detected transaction deadlocks
# TYPE postgres_deadlocks_total counter
postgres_deadlocks_total{datname="prod_financial_db"} 0
# HELP postgres_connections_active Current active backend connections
# TYPE postgres_connections_active gauge
postgres_connections_active{datname="prod_financial_db"} 800
# ERROR: database is not accepting commands to avoid wraparound data loss in database "prod_financial_db"
# Critical alert threshold breached: age(datfrozenxid) >= 2144483647
```

---

## Production Specs
* **Database Engine**: PostgreSQL 16.3 running on Linux 6.6.30 kernel
* **Instance Hardware**: AWS EC2 `r6i.4xlarge` (Dedicated DB Host / RDS Custom, 16 vCPUs, 128 GiB RAM, Provisioned 10,000 IOPS gp3 EBS)
* **Storage Footprint**: 1.4 TB primary database volume containing `financial_ledger` (185 million rows, 380 GB relation size including B-tree indexes)
* **Write Workload**: Continuous 8,500 TPS (75% INSERT, 25% UPDATE) mediated through PgBouncer in transaction pooling mode
* **Replication Architecture**: 2x asynchronous physical streaming read replicas and 1x CDC logical replication slot for Apache Kafka Debezium streaming

---

## 1. Architectural Cause & Root Cause Analysis: The 32-Bit Circular XID Horizon

PostgreSQL Multi-Version Concurrency Control (MVCC) tracks data modification through tuple-level transaction visibility metadata. Every tuple header stores two internal fields: `xmin` (the inserting transaction identifier) and `xmax` (the deleting or updating transaction identifier) [Source: PostgreSQL Documentation - MVCC Internals (https://www.postgresql.org/docs/16/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND)].

```text
               PostgreSQL 32-Bit Circular XID Horizon (4.29 Billion Space)
               
                         [ Current XID: 100,000,000 ]
                                      ▲
                                      │
              "PAST" (Visible)        │        "FUTURE" (Invisible)
          ◄───────────────────────────┴───────────────────────────►
          [ Current - 2^31 ]                         [ Current + 2^31 ]
          (Older than 2.14B XIDs)                    (Newer than 2.14B XIDs)
                     │
                     ▼
          Without FREEZING:
          Old tuples wrap around into the "FUTURE" and become COMPLETELY INVISIBLE!
```

### 1. 32-Bit Integer Limit and Modulo $2^{31}$ Arithmetic
Transaction IDs in PostgreSQL are unsigned 32-bit integers (`TransactionId` typedef in C), providing a total range of $2^{32} \approx 4,294,967,296$ unique IDs. To permit databases to process trillions of transactions over years of continuous operation, PostgreSQL models the transaction space as a circle using modulo $2^{31}$ signed arithmetic [Source: PostgreSQL Core Source - varsup.c (https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/access/transam/varsup.c)].

The core comparison function `TransactionIdPrecedes` in `src/include/access/transam.h` evaluates relative temporal order:

```c
/* Core transaction order evaluation in PostgreSQL storage engine */
static inline bool
TransactionIdPrecedes(TransactionId id1, TransactionId id2)
{
    return ((int32) (id1 - id2)) < 0;
}
```

For any active transaction `CurrentXID`:
* Exactly $2^{31} - 1 \approx 2,147,483,647$ transaction IDs preceding `CurrentXID` are treated as the **past** (visible to active snapshots).
* Exactly $2^{31} \approx 2,147,483,648$ transaction IDs succeeding `CurrentXID` are treated as the **future** (invisible to active snapshots).

If a table remains un-vacuumed while the cluster generates $2^{31}$ new transactions, ancient tuples whose `xmin` was committed billions of transactions prior will cross the horizon. The arithmetic difference `(int32)(xmin - CurrentXID)` shifts from negative to positive. As a consequence, the storage engine perceives the row as belonging to an uncommitted future transaction, rendering existing historical data invisible to queries.

### 2. Tuple Freezing Mechanism: relfrozenxid vs. datfrozenxid
To prevent tuples from slipping into the future, PostgreSQL uses `VACUUM` to freeze old row versions [Source: PostgreSQL Routine Vacuuming (https://www.postgresql.org/docs/16/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND)]:
1. **Freezing Flag**: Modern PostgreSQL sets the `HEAP_XMIN_FROZEN` bit in the tuple's `t_infomask` header flag (or writes `FrozenTransactionId = 2`), designating the row as older than any past, present, or future transaction.
2. **Per-Table Horizon (`relfrozenxid`)**: Stored in `pg_class.relfrozenxid`, tracking the oldest un-frozen transaction ID remaining in that specific relation.
3. **Cluster-Wide Horizon (`datfrozenxid`)**: Stored in `pg_database.datfrozenxid`, tracking the lowest `relfrozenxid` among all tables in the database.

When `age(relfrozenxid)` reaches `autovacuum_freeze_max_age` (default: 200,000,000 transactions), autovacuum triggers an aggressive anti-wraparound vacuum. This worker ignores table-skipping visibility maps and cannot be cancelled or disabled even when `autovacuum = off` [Source: PostgreSQL Autovacuum Settings (https://www.postgresql.org/docs/16/runtime-config-autovacuum.html)].

### 3. Fail-Safe Vacuuming (vacuum_failsafe_age)
Introduced in PostgreSQL 14, `vacuum_failsafe_age` (default: 1,600,000,000 transactions) acts as an automated emergency override. When a table's XID age reaches this threshold, the vacuum engine bypasses all non-essential operations [Source: PostgreSQL 16 Release Documentation (https://www.postgresql.org/docs/16/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND)]:
* Cost-based delay throttling is disabled (`autovacuum_vacuum_cost_delay = 0`).
* Buffer access strategies are bypassed, allowing vacuum to consume all shared buffers.
* Index vacuuming and dead tuple cleanup passes are skipped if possible, focusing 100% of I/O on advancing `relfrozenxid`.

### 4. Emergency Stop Thresholds and The Root Cause Blockades
PostgreSQL enforces hard safety ceilings in `src/backend/access/transam/varsup.c`:
* **Warning Limit (`xid_warn_limit`)**: When `2147483647 - age(datfrozenxid) <= 10,000,000`, PostgreSQL logs `WARNING: database must be vacuumed within ... transactions`.
* **Shutdown Limit (`xid_stop_limit`)**: When `2147483647 - age(datfrozenxid) <= 3,000,000`, the postmaster rejects all new write transactions with `ERROR: database is not accepting commands to avoid wraparound data loss`.

In our incident, autovacuum attempted to run anti-wraparound freezing, but the freeze horizon was pinned by three compounding root cause blockades:
1. **Abandoned CDC Logical Replication Slot**: A Debezium replication slot created three months prior was disconnected, holding `catalog_xmin` at transaction 1,120,440. PostgreSQL cannot advance `datfrozenxid` past the oldest catalog snapshot pinned by an active or inactive slot [Source: PostgreSQL Replication Slots (https://www.postgresql.org/docs/16/view-pg-replication-slots.html)].
2. **Abandoned Two-Phase Prepared Transactions (`pg_prepared_xacts`)**: An orphaned distributed transaction generated via `PREPARE TRANSACTION 'tx_settlement_8821'` was abandoned without a matching `COMMIT PREPARED` or `ROLLBACK PREPARED`, anchoring the global oldest active transaction horizon [Source: PostgreSQL Prepared Transactions (https://www.postgresql.org/docs/16/view-pg-prepared-xacts.html)].
3. **Severe Vacuum Throttling**: Uncalibrated conservative throttling parameters (`autovacuum_vacuum_cost_limit = 200` with legacy `autovacuum_vacuum_cost_delay = 20ms` carried over from PostgreSQL 11 defaults, whereas modern PostgreSQL 12+ defaults to 2ms) capped vacuum I/O to less than 10 MB/s, unable to keep pace with 8,500 continuous write TPS.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

Faced with impending wraparound warnings, operators frequently take actions that prolong downtime or worsen table bloat:

### Anti-Pattern 1: Executing a Blocking VACUUM FULL
* **The Attempted Fix**: In an attempt to freeze all tuples and reclaim storage space, an engineer ran `VACUUM FULL financial_ledger;`.
* **Why this wrong fix failed**: `VACUUM FULL` requests an exclusive `AccessExclusiveLock` on the relation, blocking all concurrent read queries. Furthermore, `VACUUM FULL` rewrites the entire 380 GB table into a new physical file on disk, requiring double the storage volume and saturating write-ahead log (WAL) generation. Because client connection pools held active read locks on the table, the `VACUUM FULL` was blocked in the lock queue while subsequent incoming queries queued behind it, exhausting the cluster connection pool.

### Anti-Pattern 2: Arbitrarily Raising autovacuum_freeze_max_age
* **The Attempted Fix**: To clear the warning logs and defer maintenance, an administrator modified `postgresql.conf` to increase `autovacuum_freeze_max_age` from 200,000,000 to 1,800,000,000.
* **Why this wrong fix failed**: Modifying `autovacuum_freeze_max_age` does not advance `relfrozenxid` by a single transaction. It merely delays the trigger point closer to the unyielding hardware limit of $2^{31}$ (2.147 billion). When the database subsequently approached the 3,000,000 transaction shutdown boundary, the backlog of unfrozen pages across 185 million rows was so large that recovery required hours of emergency processing.

### Anti-Pattern 3: Restarting the PostgreSQL Service
* **The Attempted Fix**: An operator attempted a cluster restart via `systemctl restart postgresql` in an effort to clear hung workers.
* **Why this wrong fix failed**: Restarting does not reset transaction counters. Worse, once `age(datfrozenxid)` has breached the 3M remaining threshold, PostgreSQL restarts in emergency mode where all standard client connections attempting transactions are refused immediately upon authentication.

---

## 3. Production Remediation: Before vs. After Unified Diff

To remediate the cluster without table locking and prevent future wraparound stalls, we executed a four-step recovery plan:
1. Terminate orphaned prepared transactions and drop abandoned replication slots holding `xmin`.
2. Reconfigure autovacuum cost delays and freeze thresholds for high NVMe I/O throughput.
3. Apply aggressive per-table storage options to `financial_ledger`.
4. Run parallel online non-blocking `VACUUM (FREEZE, VERBOSE)` to advance `relfrozenxid`.

Apply the following unified diff to `postgresql.conf` (or custom parameter group configuration):

```diff
--- postgresql.conf.orig
+++ postgresql.conf
@@ -140,15 +140,28 @@
 # Autovacuum Worker and Cost Throttling Tuning
 autovacuum = on
-autovacuum_max_workers = 3
-autovacuum_vacuum_cost_delay = 20ms
-autovacuum_vacuum_cost_limit = 200
+autovacuum_max_workers = 8
+autovacuum_vacuum_cost_delay = 2ms
+autovacuum_vacuum_cost_limit = 3000
 
-# Freezing Thresholds
-autovacuum_freeze_max_age = 200000000
-vacuum_freeze_min_age = 50000000
-vacuum_freeze_table_age = 150000000
+# Freezing Horizon Thresholds
+autovacuum_freeze_max_age = 150000000
+vacuum_freeze_min_age = 10000000
+vacuum_freeze_table_age = 100000000
+vacuum_failsafe_age = 1600000000
+
+# Safety Timeouts to Prevent Horizon Pinning
+idle_in_transaction_session_timeout = '10min'
+statement_timeout = '30min'
+max_prepared_transactions = 100
```

Apply table-level storage parameters to `financial_ledger` to eliminate throttling delays and enforce proactive page scanning:

```sql
ALTER TABLE financial_ledger SET (
    autovacuum_vacuum_cost_delay = 0,
    autovacuum_vacuum_cost_limit = 10000,
    autovacuum_freeze_min_age = 5000000,
    autovacuum_freeze_table_age = 50000000,
    autovacuum_vacuum_scale_factor = 0.05
);
```

---

## 4. Verification CLI & Live Cluster Diagnostics

Execute the following commands via bash and `psql` to inspect connection sockets, clear horizon blockers, verify XID progression, and execute emergency online freezing:

```bash
# 1. Inspect host disk I/O throughput and active database connection sockets
vmstat 1 5
ss -tan '( sport = :5432 or dport = :5432 )'

# 2. Check Prometheus exporter health and current replication metrics
curl -s http://localhost:9187/metrics | grep -E "postgres_xid_age|postgres_up"

# 3. Query database-level XID age and calculate transactions remaining until shutdown
psql -U postgres -d prod_financial_db -c "
SELECT datname, age(datfrozenxid) AS xid_age,
       2147483647 - age(datfrozenxid) AS tx_until_wraparound,
       current_setting('autovacuum_freeze_max_age')::bigint - age(datfrozenxid) AS tx_until_autovacuum
FROM pg_database
ORDER BY xid_age DESC;"

# 4. Detect and drop abandoned replication slots pinning catalog_xmin
psql -U postgres -d prod_financial_db -c "
SELECT slot_name, plugin, active, catalog_xmin, age(catalog_xmin) AS slot_xid_age
FROM pg_replication_slots
WHERE age(catalog_xmin) > 10000000;"

# Drop the abandoned Debezium CDC slot identified as the horizon blocker
psql -U postgres -d prod_financial_db -c "SELECT pg_drop_replication_slot('debezium_cdc_stale');"

# 5. Detect and remove orphaned prepared two-phase transactions
psql -U postgres -d prod_financial_db -c "
SELECT gid, prepared, owner, database, age(transaction) AS prep_xid_age
FROM pg_prepared_xacts
ORDER BY prep_xid_age DESC;"

# Roll back the orphaned prepared transaction pinning the global horizon
psql -U postgres -d prod_financial_db -c "ROLLBACK PREPARED 'tx_settlement_8821';"

# 6. Execute multi-core parallel online vacuum freeze using vacuumdb CLI
vacuumdb -U postgres -d prod_financial_db --table='financial_ledger' --freeze --verbose -j 4

# 7. Fallback: Emergency recovery in single-user mode (if postmaster refuses connections)
# Note: Execute only if normal psql connections are completely locked out
# sudo systemctl stop postgresql
# Ensure no stale postmaster PID lock exists and execute as postgres system user:
# sudo -u postgres test ! -f /var/lib/postgresql/data/postmaster.pid || sudo -u postgres rm -f /var/lib/postgresql/data/postmaster.pid
# sudo -u postgres postgres --single -D /var/lib/postgresql/data prod_financial_db
# backend> VACUUM (FREEZE, VERBOSE);
# backend> \q
# sudo systemctl start postgresql

# 8. Monitor real-time progress and page processing rates during freezing
psql -U postgres -d prod_financial_db -c "
SELECT pid, phase, heap_blks_total, heap_blks_scanned, heap_blks_vacuumed
FROM pg_stat_progress_vacuum;"
```

Following the removal of the stale replication slot and execution of `vacuumdb -j 4 --freeze`, the table was scanned and frozen in 38 minutes. The cluster metric `age(datfrozenxid)` dropped from 2,144,483,648 down to 14,210,500, immediately clearing the emergency shutdown flag and resuming full write operations.

---

## 5. Long-Term Architectural Safeguards & Operating Runbook

To ensure transaction ID wraparound never threatens cluster availability under sustained write workloads:

1. **Automated Prometheus Alerting**: Configure alerting rules on `max(age(datfrozenxid))` with warning notifications at 100,000,000 transactions and paging critical alerts at 150,000,000 transactions.
2. **Replication Slot Hygiene Daemon**: Implement a scheduled job that monitors `pg_replication_slots` and automatically notifies engineers or invalidates slots whose `age(catalog_xmin)` exceeds 50,000,000 transactions.
3. **Session and Prepared Transaction Guards**: Enforce `idle_in_transaction_session_timeout = '10min'` in parameter groups and audit `pg_prepared_xacts` continuously to prevent uncommitted two-phase transactions from surviving beyond application restarts.
4. **Time-Based Table Partitioning**: Partition high-churn financial tables by month (`PARTITION BY RANGE (created_at)`). Once a month partition becomes read-only, execute a final `VACUUM (FREEZE)` on that partition; PostgreSQL will freeze it permanently, eliminating repeated freeze scans on cold historical partitions.
