---
layout: post
title: "Redis Distributed Lock Timeout & Redlock Clock Drift Pitfalls in Distributed Systems"
date: 2026-12-04 10:18:37 +0900
category: "Database & Storage"
tags: ['Redis', 'DistributedSystems', 'Redlock', 'Concurrency', 'Troubleshooting', 'Redisson']
---

## Production Incident Summary

During an automated end-of-month batch settlement running concurrently with an ongoing flash promotional campaign processing 4,800 checkout requests per second, our distributed settlement engine experienced severe consistency anomalies. Audit ledgers flagged duplicate credit disbursements totaling over $84,000 across 210 merchant accounts. Telemetry indicated that multiple worker pods executing within our Kubernetes cluster acquired exclusive distributed locks for the exact same resource identifier simultaneously.

The distributed lock implementation, managed via Redisson against a 5-node Redlock ensemble, threw lock acquisition timeouts and emitted warning logs indicating lock expiration prior to transaction completion:

```text
[2026-12-04T01:18:22.419Z] [pool-8-thread-42] ERROR org.redisson.RedissonLock - 
org.redisson.client.RedisTimeoutException: Redis server response timeout (3000 ms) occurred for command: 
(EVAL) "if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then redis.call('hincrby', KEYS[1], ARGV[2], 1); redis.call('pexpire', KEYS[1], ARGV[1]); return nil; end; if (redis.call('setnx', KEYS[1], ARGV[2]) == 1) then redis.call('pexpire', KEYS[1], ARGV[1]); return 1; end; return 0;" 
with params: [lock:settlement:merchant:99481, 10000, 7f1a3b8c-5d2e-4f11-9a72-bc91a45e3100:42]
at org.redisson.command.CommandAsyncService.checkTimeout(CommandAsyncService.java:312)
at org.redisson.RedissonLock.tryLockInner(RedissonLock.java:214)
[WARN] Lock lease expired before release: key=lock:settlement:merchant:99481, holder=pod-settlement-79d8c-xzp2
[ERROR] Concurrent execution detected on protected section: resource=settlement:merchant:99481
```

Subsequent database inspection revealed that two separate thread workers had entered the critical section and executed ledger insertions within an overlapping 420-millisecond execution window.

## Production Specs
* **Redis Cluster**: 5 independent single-instance nodes running Redis 7.2.4 (Standalone instances for Redlock consensus, not master-replica)
* **Application Framework**: Spring Boot 3.3.0 on JDK 21 (Temurin)
* **Redis Client**: Redisson v3.31.0 utilizing Netty 4.1.110.Final
* **Infrastructure**: AWS EC2 `c6i.2xlarge` (8 vCPU, 16 GiB RAM) worker nodes in `us-east-1`
* **Time Synchronization**: Amazon Time Sync Service managed via `chronyd`

---

## 1. Architectural Cause & Root Cause Analysis: The Two-Headed Monster of TTL & Clock Skew

The distributed lock failure stemmed from two compounding design flaws: **premature lease expiration under long tail latency** and **asymmetric clock drift across Redis nodes during NTP synchronization adjustments**.

```text
Client 1                        Redis Node 1..5                     Client 2
   │                                   │                                │
   ├─── 1. Acquire Lock (TTL: 10s) ────►│                                │
   │    Consensus achieved (3/5 nodes) │                                │
   │                                   │                                │
   │ ── [Long GC Pause / DB IO Stall] ──                                │
   │    Execution takes 12 seconds     │                                │
   │                                   │                                │
   │                                   ├── 2. TTL expires / Clock jumps  │
   │                                   │    Lock auto-released on Redis │
   │                                   │                                │
   │                                   │◄── 3. Acquire Lock (Same Key) ──┤
   │                                   │    Consensus achieved (3/5)    │
   │                                   │    Lock granted to Client 2!   │
   │                                   │                                │
   ├─── 4. Mutate Shared Resource ─────┼────────────────────────────────┤ (Split Brain)
   │    [Both Clients In Critical Section Concurrently!]                │
```

### Mechanism 1: Garbage Collection Pauses and Long I/O Stalls
1. **The Fixed TTL Trap**: Client 1 acquired a distributed lock with a hardcoded lease time of 10,000 ms (`leaseTime = 10s`). Under normal conditions, database settlement transactions complete in 120 ms.
2. **Stop-the-World Jitter**: During the end-of-month batch, a combination of heavy parallel stream processing and concurrent database connection pool contention triggered a 7.8-second JVM Young Generation and Metaspace GC sweep pause on Client 1's pod.
3. **Lease Expiration in Flight**: By the time Client 1 regained CPU execution context, the 10-second TTL on the Redis lock had already expired. Unaware of the time elapsed during its suspended execution, Client 1 proceeded to perform write operations against the database.
4. **Second Client Entry**: During Client 1's pause, Client 2 requested the identical lock. Redis found no active key (as it had expired), successfully granted the lock to Client 2, and both clients executed overlapping mutations against the same merchant ledger.

### Mechanism 2: Clock Drift and NTP Monotonic Violations
1. **Redlock Consensus Invalidation**: The Redlock algorithm relies on wall-clock time across distinct nodes to calculate lock validity:
   $$\text{Validity Time} = \text{Initial TTL} - (\text{Acquisition Elapsed Time}) - \text{Clock Drift}$$
2. **The NTP Step Hazard**: During hypervisor maintenance, one of the five independent Redis host instances experienced clock desynchronization. The local `chronyd` daemon, improperly configured with aggressive stepping rules, stepped the local clock forward by 3,200 ms instead of slewing the clock gradually.
3. **Premature Key Eviction**: Keys that were meant to persist for another 4 seconds were instantaneously evicted on that node. When a subsequent lock acquisition cycle executed, Client 2 achieved a quorum of 3 out of 5 nodes prematurely because the evicted node voted in favor, violating mutual exclusion guarantees.
4. **Lack of Fencing Tokens**: Because the downstream relational database accepted writes without monotonically increasing version verification, the database could not differentiate whether Client 1 or Client 2 held valid authority.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

During emergency triage, the operations team deployed multiple superficial adjustments that failed to resolve the concurrency risk:

### Anti-Pattern 1: Arbitrarily Inflating Lock TTL to 120 Seconds
* **The Attempted Fix**: The lock lease duration was increased from 10 seconds to 120 seconds (`leaseTime = 120000`) to guarantee that transactions would finish before the lock expired.
* **Why this wrong fix failed**: While this reduced the probability of TTL expiration during moderate pauses, it introduced a catastrophic availability failure. When a worker pod running Client 1 crashed with an `OOMKilled` signal halfway through execution, the lock remained held in Redis for the full 2 minutes. Hundreds of downstream merchant settlement requests backed up in thread pools, exhausting HTTP connection pools and causing cascading system-wide timeouts. Furthermore, it did not solve the fundamental flaw: if a thread paused for 121 seconds, data corruption would still occur.

### Anti-Pattern 2: Replacing Redlock with Raw SETNX Without Watchdog or Renewal
* **The Attempted Fix**: In an attempt to avoid Redlock multi-node network latency, an engineer replaced the distributed lock with a single Redis instance executing `SET resource_key my_random_token NX PX 30000`.
* **Why this wrong fix failed**: Single-instance `SETNX` without automatic heartbeat renewal suffers from the identical time-drift vulnerability. When that single Redis instance experienced failover or master-replica promotion, the asynchronous replication lag caused the new master to grant the identical lock to a second client before the replication stream synchronized, multiplying split-brain occurrences.

---

## 3. Production Remediation: Before vs. After Unified Diff

To eliminate both TTL exhaustion and split-brain execution, we implemented a three-tier architecture:
1. **Redisson Automatic Watchdog Renewal**: Set `leaseTime = -1` to delegate lease management to Redisson's internal background watchdog thread, which continuously refreshes the lock TTL every `lockWatchdogTimeout / 3` (defaulting to 10 seconds) as long as the holding thread remains alive.
2. **Monotonic Fencing Tokens**: Every lock acquisition yields a strictly monotonic sequence token from Redis. The downstream database enforces optimistic fencing checks (`WHERE fencing_token < :newToken`).
3. **NTP Slew Enforcement via Chrony**: Configure host OS time daemons to strictly forbid clock stepping, enforcing gradual frequency slew for all adjustments.

Apply the following production patch to the settlement locking service:

```diff
--- service/SettlementLockManager.java.orig
+++ service/SettlementLockManager.java
@@ -18,18 +18,34 @@
     @Autowired
     private RedissonClient redissonClient;
 
-    public boolean processWithLock(String merchantId, Runnable task) {
+    @Autowired
+    private StringRedisTemplate redisTemplate;
+
+    public boolean processWithFencedLock(String merchantId, Consumer<Long> task) {
         String lockKey = "lock:settlement:merchant:" + merchantId;
+        String tokenKey = "token:settlement:merchant:" + merchantId;
         RLock lock = redissonClient.getLock(lockKey);
+
         try {
-            // WRONG: Hardcoded leaseTime disables watchdog auto-renewal!
-            boolean acquired = lock.tryLock(3000, 10000, TimeUnit.MILLISECONDS);
+            // Correct: Pass -1 as leaseTime to enable Redisson Watchdog auto-extension
+            boolean acquired = lock.tryLock(5000, -1, TimeUnit.MILLISECONDS);
             if (!acquired) {
                 log.warn("Failed to acquire distributed lock for merchant {}", merchantId);
                 return false;
             }
-            task.run();
+
+            // Generate strictly monotonic fencing token
+            Long fencingToken = redisTemplate.opsForValue().increment(tokenKey);
+            if (fencingToken == null) {
+                throw new IllegalStateException("Failed to generate monotonic fencing token");
+            }
+
+            // Pass fencing token into critical section for database optimistic locking
+            task.accept(fencingToken);
             return true;
         } catch (InterruptedException e) {
             Thread.currentThread().interrupt();
             return false;
```

And update the underlying database settlement update statement:

```diff
--- repository/MerchantLedgerRepository.xml.orig
+++ repository/MerchantLedgerRepository.xml
@@ -4,6 +4,8 @@
     <update id="applySettlement">
         UPDATE merchant_ledger
         SET balance = balance + #{amount},
+            last_fencing_token = #{fencingToken},
             updated_at = NOW()
         WHERE merchant_id = #{merchantId}
+          AND last_fencing_token < #{fencingToken}
     </update>
```

Update the Linux host `/etc/chrony/chrony.conf` configuration across all Redis and worker instances:

```diff
--- /etc/chrony/chrony.conf.orig
+++ /etc/chrony/chrony.conf
@@ -12,4 +12,6 @@
 server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4
-makestep 1.0 3
+# Disable step jumping; force gradual frequency slew under all circumstances
+makestep 0 0
+maxslewrate 500
```

---

## 4. Verification CLI & Live Cluster Diagnostics

Execute the following diagnostic commands to verify watchdog lock extension, monitor NTP frequency stability, and test fencing token rejection:

```bash
# 1. Verify Chrony time sync status and confirm clock is not stepping
chronyc tracking
chronyc sources -v

# 2. Inspect active Redlock key TTL dynamically to confirm Watchdog renewal is active
# The TTL should cycle between 20,000ms and 30,000ms and never hit 0 while thread lives
redis-cli -h 10.0.1.15 -p 6379 PTTL "lock:settlement:merchant:99481"
sleep 5
redis-cli -h 10.0.1.15 -p 6379 PTTL "lock:settlement:merchant:99481"

# 3. Simulate delayed split-brain worker using curl to test fencing token rejection
curl -v -X POST http://settlement-service.prod.svc.cluster.local:8080/v1/settlement/execute \
  -H "Content-Type: application/json" \
  -d '{"merchant_id":"99481","amount":1500.00,"stale_fencing_token":102}'

# 4. Check Redis Slowlog to ensure Lua scripts are executing within single-digit milliseconds
redis-cli -h 10.0.1.15 -p 6379 SLOWLOG GET 10
```

Following the deployment, synthetic fault injection introducing 12-second thread stalls resulted in **zero** duplicate settlements. The stale worker's database update returned an update count of `0` due to `last_fencing_token < #{fencingToken}`, successfully preventing write corruption.

---

## 5. Long-Term Architectural Safeguards & Operating Runbook

To maintain continuous data integrity across distributed state boundaries, enforce the following production guidelines:

1. **Watchdog Heartbeat Protocol**: Never specify an explicit `leaseTime` unless the enclosed business logic has zero external I/O and strict bounded execution. Always allow Redisson's Watchdog to extend lock ownership until explicit release.
2. **Database Fencing as the Source of Truth**: Treat Redis distributed locks as an **optimization filter**, not a guarantee of storage correctness. The storage engine (PostgreSQL/MySQL) must validate monotonic fencing tokens on every mutation.
3. **NTP Step Ban**: Strictly prohibit `makestep` in production environments handling financial ledgers. Slew-only clock synchronization protects distributed consensus algorithms from time-travel anomalies.
4. **Lock Holder Thread Binding**: Always ensure the releasing thread matches the acquiring thread identifier using cryptographic UUID tokens to prevent cross-worker unlock operations.
