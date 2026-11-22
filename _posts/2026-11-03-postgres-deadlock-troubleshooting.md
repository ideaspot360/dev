---
layout: post
title: "Debugging PostgreSQL Deadlocks: Root Cause, Row-Level Lock Queues & Advisory Locks"
date: 2026-11-03 14:18:27 +0900
category: "Database & Storage"
tags: [postgresql, database, backend, sql, troubleshooting]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When PostgreSQL throws 'deadlock detected: Process waits for ShareLock on transaction', simply retrying hides race conditions. Here is how row-level lock trees, tuple headers, and advisory locks actually behave."
verification_date: "2026-11-23"
fact_check_sources:
  - "https://www.postgresql.org/docs/current/explicit-locking.html"
  - "https://www.postgresql.org/docs/current/view-pg-locks.html"
  - "https://www.postgresql.org/docs/current/functions-info.html"
  - "https://www.postgresql.org/docs/current/monitoring-stats.html"
  - "https://www.postgresql.org/docs/current/errcodes-appendix.html"
  - "https://www.postgresql.org/docs/current/pgrowlocks.html"
---

When concurrent database transactions attempt to acquire conflicting row-level or table-level locks in cyclic dependencies, the PostgreSQL lock manager throws error code `40P01` [Source: PostgreSQL Documentation - Error Codes & Deadlocks](https://www.postgresql.org/docs/current/errcodes-appendix.html):

```text
ERROR:  deadlock detected
DETAIL:  Process 21402 waits for ShareLock on transaction 849201; blocked by process 21408.
Process 21408 waits for ExclusiveLock on tuple (42, 18) of relation "orders" of database 16384; blocked by process 21402.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (42, 18) in relation "orders"
```

A common anti-pattern is wrapping queries in exponential backoff retry loops. While retrying mitigates transient collisions, it drastically increases query latency tail percentiles ($P_{99}$) and conceals architectural race conditions under peak traffic.

Instead of papering over lock contention with blind application retries, solving deadlocks requires inspecting PostgreSQL lock wait queues, understanding tuple storage internals, and enforcing consistent resource ordering across transactions [Source: PostgreSQL Documentation - Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html).

---

## 1. Verified Production Environment

The diagnostic rules and architectural remedies documented here were verified on:

* **Database Engine:** PostgreSQL 16.3 (x86_64 Linux on AWS RDS & Self-hosted EC2)
* **Transaction Isolation Level:** `READ COMMITTED` (default)
* **Connection Pooler:** PgBouncer 1.22.x in transaction pooling mode
* **Application Framework:** Spring Boot 3.3.x (HikariCP 5.1.0) / Node.js `pg-promise` / Python SQLAlchemy 2.0.x

---

## 2. The Wrong Fix (Initial Misdiagnosis & Why Application-Level Retries Fail)

A standard instinctive reaction to deadlocks in high-throughput microservices is simply wrapping queries in exponential backoff retry loops:

```python
# The Wrong Fix (Initial Incorrect Approach): Blind retry loops without lock order synchronization
@retry(exceptions=DeadlockDetected, max_attempts=5, backoff=0.2)
def execute_order_settlement(order_id, user_id, amount):
    with db.transaction():
        # Service A: Locks user balance first, then updates order status
        update_user_balance(user_id, amount)
        update_order_status(order_id, 'COMPLETED')
```

```python
# Concurrently executed by automated invoice reconciliation job:
with db.transaction():
    # Service B: Locks order status first, then audits user balance
    update_order_status(order_id, 'PROCESSING')
    audit_user_balance(user_id)
```

### Why this failed in production:
If Service A locks `user_balance` while Service B locks `orders`, both workers block each other. After `deadlock_timeout` (default `1s`), PostgreSQL aborts one transaction. Retrying merely repeats the contention cycle under high throughput, creating database CPU spikes, thread pool exhaustion in HikariCP, and $P_{99}$ latency degradation across all dependent microservices.

---

## 3. Root Cause Analysis: Row Locks, Tuple Headers & Cyclic Wait Graphs

At the PostgreSQL storage engine level, row-level locks behave fundamentally differently from table-level locks. Unlike table-level or explicit advisory locks, PostgreSQL does **not** store granted row-level locks inside the shared memory lock table (`LockManager`). Tracking millions of individual row locks in shared memory would quickly exhaust server RAM. Instead, PostgreSQL writes row-level lock metadata directly into the storage layer within the tuple header fields on disk—specifically `t_xmax` and the `t_infomask`/`t_infomask2` status bits (or a `MultiXactId` pointer if multiple concurrent transactions hold shared locks) [Source: PostgreSQL Documentation - Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html).

Because active row locks reside on disk in tuple headers, they do not appear as granted entries in the `pg_locks` view [Source: PostgreSQL Documentation - The pg_locks View](https://www.postgresql.org/docs/current/view-pg-locks.html). However, when concurrent transactions attempt to update or lock tuples held by one another, PostgreSQL coordinates contention through a two-tiered locking protocol:

1. **Tuple Lock Queue:** When a backend attempts to modify a row already locked by an uncommitted transaction, it first requests an ephemeral `tuple` lock in shared memory (`locktype = 'tuple'`) on the target physical tuple (`ctid`). This establishes a fair, sequential queue of transactions waiting for that physical row.
2. **Transaction Lock Wait:** Once it secures its place in the tuple queue, the waiting backend requests a `ShareLock` on the `transactionid` of the transaction currently holding the row lock (the transaction ID stamped into `t_xmax`).

In our production deadlock incident:
- **Process 21402** held the row lock on `tuple (42, 18)` in `orders` and attempted to update a balance record held by Transaction `849201`. Thus, Process 21402 waited for `ShareLock on transaction 849201` (blocked by Process 21408).
- **Process 21408** (owning Transaction `849201`) attempted to update `tuple (42, 18)` in `orders`. Because Process 21402 held the tuple lock, Process 21408 queued up and waited for `ExclusiveLock on tuple (42, 18)` (blocked by Process 21402).

```text
       ┌─────────────────────────────────────────────────────────┐
       │                      Process 21402                      │
       │  - Holds: Lock on tuple (42, 18) in "orders" table      │
       │  - Requests: Row held by active Transaction 849201      │
       └──────────────┬───────────────────────────▲──────────────┘
                      │                           │
    Waits for         │                           │  Blocks Process 21408
    ShareLock on      │                           │  on ExclusiveLock
    Transaction 849201│                           │  for tuple (42, 18)
                      │                           │
                      ▼                           │
       ┌──────────────────────────────────────────┴──────────────┐
       │                      Process 21408                      │
       │  - Holds: Transaction 849201 (user balance row)         │
       │  - Requests: ExclusiveLock on tuple (42, 18) in "orders"│
       └─────────────────────────────────────────────────────────┘
```

When two or more transactions acquire locks in asymmetric order, neither transaction can make progress. When `deadlock_timeout` (default `1s`) elapses without progress, the PostgreSQL deadlock detector executes a cycle-detection search across the wait-for dependency graph. It selects one transaction as the victim, aborts it, rolls back its modifications, and raises `ERROR: 40P01 deadlock detected`.

---

## 4. Investigating Lock Contention with `pg_locks`, `pg_blocking_pids` & `pgrowlocks`

To identify blocked and blocking queries in real time before the deadlock detector terminates transactions, use PostgreSQL's built-in session diagnostics and contrib tools.

### Method 1: Fast Lock Inspection via `pg_blocking_pids`
PostgreSQL provides the `pg_blocking_pids(pid)` session information function, which directly returns an array of backend PIDs blocking the given process [Source: PostgreSQL Documentation - Session Information Functions](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-INFO-SESSION-TABLE):

```sql
SELECT
    blocked.pid AS blocked_pid,
    blocked.usename AS blocked_user,
    blocked.client_addr,
    blocked.wait_event_type,
    blocked.wait_event,
    pg_blocking_pids(blocked.pid) AS blocking_pids,
    blocked.query AS blocked_statement
FROM pg_catalog.pg_stat_activity blocked
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;
```

### Method 2: Comprehensive Wait Queue Analysis via `pg_locks`
For granular visibility into specific relations, tuple pointers (`page`, `tuple`), and lock modes, join `pg_locks` against itself [Source: PostgreSQL Documentation - The pg_locks View](https://www.postgresql.org/docs/current/view-pg-locks.html):

```sql
SELECT
    blocked_locks.pid          AS blocked_pid,
    blocked_activity.usename   AS blocked_user,
    blocking_locks.pid         AS blocking_pid,
    blocking_activity.usename  AS blocking_user,
    blocked_locks.locktype     AS wait_lock_type,
    blocked_locks.mode         AS requested_mode,
    blocked_activity.query     AS blocked_statement,
    blocking_activity.query    AS blocking_statement
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity 
    ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks 
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity 
    ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted
  AND blocking_locks.granted;
```

### Method 3: Direct On-Disk Row Lock Inspection with `pgrowlocks`
Because active row locks reside on disk in tuple headers rather than in `pg_locks`, inspecting which specific rows are locked requires the official `pgrowlocks` extension [Source: PostgreSQL Documentation - pgrowlocks](https://www.postgresql.org/docs/current/pgrowlocks.html):

```sql
-- Enable the official contrib extension
CREATE EXTENSION IF NOT EXISTS pgrowlocks;

-- Inspect on-disk tuple locking states, holding XIDs, modes, and PIDs for relation "orders"
SELECT locked_row, locker, multi, modes, pids 
FROM pgrowlocks('orders');
```

This returns the exact tuple ID (`locked_row` as `ctid`), the locker transaction ID (`locker`), whether it involves a multi-transaction (`multi`), held lock modes, and the operating backend PIDs.

---

## 5. Architectural Solutions

### Solution A: Strict Deterministic Ordering (Global Hierarchy & Primary Key Sorting)
The primary defense against cyclic deadlocks is ensuring that all concurrent transactions access and lock shared entities in a strictly identical order.

#### 1. Cross-Table Deterministic Ordering (Fixing the Service A vs Service B Deadlock)
In workflows touching multiple tables, enforce a global resource acquisition hierarchy across all application services:

```diff
  # Service B: Reconcile and audit
  with db.transaction():
-     # Flawed: Inverted table order acquires locks on 'orders' before 'user_balance'
-     update_order_status(order_id, 'PROCESSING')
-     audit_user_balance(user_id)
+     # Correct: Enforce global table hierarchy across all services: accounts/balance FIRST, orders SECOND
+     audit_user_balance(user_id)
+     update_order_status(order_id, 'PROCESSING')
```

#### 2. Intra-Table Batch Ordering (Primary Key Sorting)
When updating multiple rows in the same table, sort keys deterministically before execution:

```diff
- -- Unsorted batch updates risk circular lock order acquisition across threads
- UPDATE accounts SET balance = balance - 100 WHERE id IN (85, 12, 44);
+ -- Sort IDs deterministically beforehand in application memory: [12, 44, 85]
+ UPDATE accounts SET balance = balance - 100 WHERE id = 12;
+ UPDATE accounts SET balance = balance - 100 WHERE id = 44;
+ UPDATE accounts SET balance = balance - 100 WHERE id = 85;
```

Alternatively, acquire explicit row locks upfront using `ORDER BY id FOR UPDATE`:

```sql
-- Explicitly lock required rows in ascending ID order before processing
SELECT id, balance 
FROM accounts 
WHERE id IN (12, 44, 85) 
ORDER BY id 
FOR UPDATE;
```

When every concurrent transaction requests row locks in identical numerical order ($12 \to 44 \to 85$), cyclic dependency graphs become mathematically impossible.

### Solution B: Collision-Free Transactional Advisory Locks
When business workflows involve operations across multiple distinct tables where row sorting is impractical, acquire an explicit transactional advisory lock (`pg_advisory_xact_lock`) [Source: PostgreSQL Documentation - Explicit Locking: Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).

Advisory locks live entirely in shared memory (`LockManager`) and release automatically at transaction termination when invoked with the `_xact_` suffix.

#### Eliminating 32-bit Hash Collision Vulnerabilities
Using `hashtext('user_' || :userId)` outputs a signed 32-bit integer ($2^{32} \approx 4.29 \times 10^9$). Due to the Birthday Paradox, a 50% collision probability occurs at approximately $2^{16} = 65,536$ concurrent distinct keys, risking false serialization where unrelated users block each other.

To prevent hash collisions, use PostgreSQL's built-in 2-key integer namespacing or direct 64-bit keys:

```sql
-- Option 1: Two-key namespacing (classid integer, objid integer) - Zero hash collision risk
-- classid 1001 represents USER_ACCOUNT_LOCK, objid is the numeric user ID
SELECT pg_advisory_xact_lock(1001, :userId);

-- Option 2: Direct 64-bit bigint key for BIGSERIAL or Snowflake primary keys
SELECT pg_advisory_xact_lock(:userBigIntId);

-- Proceed with safe multi-table operations
UPDATE accounts SET balance = balance - :amount WHERE user_id = :userId;
UPDATE orders SET status = 'PAID' WHERE user_id = :userId;
-- Lock automatically releases upon transaction COMMIT or ROLLBACK
```

If string keys (such as UUIDs) must be hashed, use a 64-bit hash instead of 32-bit `hashtext`:

```sql
-- 64-bit hash key from UUID to minimize collision probability to near-zero
SELECT pg_advisory_xact_lock(('x' || substr(md5('user_account_' || :userUuid), 1, 16))::bit(64)::bigint);
```

### Solution C: Fine-Grained Locking with `FOR NO KEY UPDATE` & `SKIP LOCKED`
In PostgreSQL 9.3 and later, `UPDATE` statements that do not modify unique index columns acquire `FOR NO KEY UPDATE` locks rather than exclusive locks. When writing explicit row-locking queries for rows referenced by foreign keys, use:

```sql
-- Does not block concurrent SELECT ... FOR KEY SHARE or foreign key validation
SELECT * FROM orders WHERE id = :orderId FOR NO KEY UPDATE;
```

This prevents unnecessary deadlocks caused by concurrent foreign key validation checks on referenced parent records [Source: PostgreSQL Documentation - Explicit Locking: Row-Level Locks](https://www.postgresql.org/docs/current/explicit-locking.html).

For asynchronous task queues and job processing workers, use `SKIP LOCKED` to eliminate lock waits entirely:

```sql
-- Worker retrieves next available pending order without blocking or deadlocking concurrent workers
SELECT id, payload 
FROM background_tasks 
WHERE status = 'PENDING' 
ORDER BY id 
LIMIT 1 
FOR UPDATE SKIP LOCKED;
```

---

## 6. Verification CLI & Production Monitoring

Verify PostgreSQL runtime lock contention and monitor deadlock frequency using command-line administrative tools:

```bash
# 1. Verify PostgreSQL service status
systemctl status postgresql

# 2. Inspect active deadlock timeout configuration and enable lock wait logging
psql -h 127.0.0.1 -U postgres -d production_db -c "SHOW deadlock_timeout;"

# Enable automatic logging of statements waiting longer than deadlock_timeout (default 1s)
psql -h 127.0.0.1 -U postgres -d production_db -c "ALTER SYSTEM SET log_lock_waits = 'on';"
psql -h 127.0.0.1 -U postgres -d production_db -c "SELECT pg_reload_conf();"

# 3. Query historical deadlock counters from pg_stat_database
psql -h 127.0.0.1 -U postgres -d production_db -c "
SELECT datname, deadlocks, conflicts, temp_files 
FROM pg_stat_database 
WHERE datname = current_database();"

# 4. Monitor active lock wait events in real time
psql -h 127.0.0.1 -U postgres -d production_db -c "
SELECT count(*) AS active_lock_waiters 
FROM pg_stat_activity 
WHERE wait_event_type = 'Lock';"

# 5. Check blocking PID chains dynamically
psql -h 127.0.0.1 -U postgres -d production_db -c "
SELECT pid, wait_event, pg_blocking_pids(pid) AS blocked_by, query 
FROM pg_stat_activity 
WHERE cardinality(pg_blocking_pids(pid)) > 0;"
```

---

## 7. References & Official Specifications

* [Source: PostgreSQL Official Documentation - Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
* [Source: PostgreSQL Official Documentation - The pg_locks System View](https://www.postgresql.org/docs/current/view-pg-locks.html)
* [Source: PostgreSQL Official Documentation - Session Information Functions](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-INFO-SESSION-TABLE)
* [Source: PostgreSQL Official Documentation - The Statistics Collector](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-DATABASE-VIEW)
* [Source: PostgreSQL Official Documentation - PostgreSQL Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)
* [Source: PostgreSQL Official Documentation - pgrowlocks](https://www.postgresql.org/docs/current/pgrowlocks.html)
