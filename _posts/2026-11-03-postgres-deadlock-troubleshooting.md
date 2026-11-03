---
title: "Debugging PostgreSQL Deadlocks: Root Cause, Row-Level Lock Queues & Advisory Locks"
category: "Database & Backend"
tags: [postgresql, database, backend, sql, troubleshooting]
author: "Justin (IdeaSpot360 Lead Engineer)"
excerpt: "When PostgreSQL throws 'deadlock detected: Process 4120 waits for ShareLock on transaction', simply retrying hides race conditions. Here is how row-level lock trees and foreign key validation actually behave."
---

When concurrent database transactions attempt to acquire conflicting row-level or table-level locks in cyclic dependencies, the PostgreSQL lock manager throws:

```text
ERROR:  deadlock detected
DETAIL:  Process 21402 waits for ShareLock on transaction 849201; blocked by process 21408.
Process 21408 waits for ExclusiveLock on tuple (42, 18) of relation "orders" of database 16384; blocked by process 21402.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (42, 18) in relation "orders"
```

A common anti-pattern is wrapping queries in exponential backoff retry loops. While retrying mitigates transient collisions, it drastically increases query latency tail percentiles ($P_{99}$) and conceals architectural race conditions under peak traffic.

Here is the exact diagnostic workflow to pinpoint deadlocking queries and restructure locking order.

---

## 1. Verified Production Environment

* **Database Engine:** PostgreSQL 16.3 (x86_64 Linux on AWS RDS / Self-hosted)
* **Transaction Isolation Level:** `READ COMMITTED` (default)
* **Connection Pooler:** PgBouncer 1.22.x in transaction pooling mode
* **Application Framework:** Spring Boot 3.3.x (HikariCP 5.1.0) / Node.js `pg-promise`

---

## 2. Common False Fix: Why Application-Level Retries Fail

Consider two microservice endpoints updating orders and inventory balances concurrently:

```python
# WRONG FIX: Blind retry loops without lock order synchronization
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

If Service A locks `user_balance` while Service B locks `orders`, both workers block each other. After `deadlock_timeout` (default `1s`), PostgreSQL aborts one transaction. Retrying merely repeats the contention cycle under high throughput, creating database CPU spikes.

---

## 3. Investigating Lock Contention with `pg_locks`

To inspect live lock wait queues before the deadlock detector terminates transactions, execute:

```sql
SELECT
    blocked_locks.pid     AS blocked_pid,
    blocked_activity.usename  AS blocked_user,
    blocking_locks.pid    AS blocking_pid,
    blocking_activity.usename AS blocking_user,
    blocked_activity.query    AS blocked_statement,
    blocking_activity.query   AS blocking_statement
FROM  pg_catalog.pg_locks         blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks         blocking_locks 
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
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

---

## 4. Architectural Solutions

### Solution A: Strict Deterministic Ordering (Alphabetical / ID Sort)
Whenever updating multiple rows in batch, **always sort primary keys in ascending order** prior to issuing SQL statements:

```diff
- UPDATE accounts SET balance = balance - 100 WHERE id IN (85, 12, 44);
+ -- Sort IDs beforehand in application memory: [12, 44, 85]
+ UPDATE accounts SET balance = balance - 100 WHERE id = 12;
+ UPDATE accounts SET balance = balance - 100 WHERE id = 44;
+ UPDATE accounts SET balance = balance - 100 WHERE id = 85;
```

When every worker acquires row locks in identical numerical sequence ($12 \to 44 \to 85$), cyclic deadlocks become mathematically impossible.

### Solution B: Application-Level Advisory Locks
For complex workflows spanning multiple tables where row sorting is impractical, use PostgreSQL advisory locks:

```sql
-- Acquire transactional advisory lock based on user_id hash
SELECT pg_advisory_xact_lock(hashtext('user_account_' || :userId));

-- Proceed with safe multi-table operations
UPDATE accounts SET balance = balance - :amount WHERE user_id = :userId;
UPDATE orders SET status = 'PAID' WHERE user_id = :userId;

-- Lock automatically releases upon COMMIT or ROLLBACK
```
