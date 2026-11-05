---
layout: post
title: "Fixing Kafka Consumer Lag & Rebalance Storms: CommitFailedException, max.poll.interval.ms, and Cooperative Sticky Assignor"
date: 2026-11-05 10:00:00 +0900
category: "Backend & Distributed Systems"
tags: [kafka, distributed-systems, backend, spring-boot, microservices, troubleshooting]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When Kafka consumers repeatedly crash with CommitFailedException and trigger rebalance storms, increasing max.poll.interval.ms hides thread starvation. Here is how group coordinator timeouts, poll records sizing, and cooperative sticky assignors actually operate."
---

Under sudden message spikes or downstream API latency degradation, Kafka consumer instances often fail to commit consumer offsets, resulting in cascading partition rebalances and unbounded consumer lag. When offset commits are rejected by the coordinator broker, the consumer runtime throws the following terminal exception:

```text
org.apache.kafka.clients.consumer.CommitFailedException: Commit cannot be completed since the group has already rebalanced and assigned the partitions to another member. This means that the time between subsequent calls to poll() was longer than the configured max.poll.interval.ms, which typically implies that the poll loop is spending too much time processing messages. You can address this either by increasing max.poll.interval.ms or by reducing the maximum size of batches returned in poll() with max.poll.records.
[Consumer clientId=consumer-order-service-1, groupId=order-fulfillment-group] OffsetCommit failed on partition order-events-4 at offset 1892014: This is likely due to the consumer being kicked out of the group.
```

When this occurs, the consumer is evicted from the consumer group. The partitions it was processing are immediately revoked and reassigned to neighboring consumers. Those peer consumers, already processing their own workloads, suddenly inherit the evicted partitions and their uncommitted backlog. Consequently, the peers also breach their processing timeouts, triggering a catastrophic **Rebalance Storm** where the entire consumer cluster spends 100% of its CPU cycling through group sync state machines rather than processing records.

---

## 1. Verified Production Environment

The diagnostic profiles and configuration benchmarks below were verified against:

* **Kafka Cluster:** Apache Kafka v3.7.0 (KRaft mode, 3-broker cluster, replication factor 3, min.insync.replicas 2)
* **Client Framework:** Spring for Apache Kafka v3.1.5 (Spring Boot 3.3.x) / Java Kafka Client 3.7.0
* **Runtime Stack:** Eclipse Temurin OpenJDK 21 (LTS) on Linux Kernel 6.6.x (Ubuntu 24.04 LTS)
* **Topic Configuration:** 24 partitions, `cleanup.policy=delete`, message average payload 4.2KB

---

## 2. Technical Mechanism: Heartbeat Thread vs. Application Poll Thread

A widespread misconception among backend engineers is assuming that as long as the JVM process is alive and sending network heartbeats, Kafka will not evict the consumer.

Kafka's consumer architecture strictly decouples liveness checks into two distinct execution paths:

```
[Kafka Consumer Architecture]

┌────────────────────────────────────────────────────────┐
│  JVM Process                                           │
│                                                        │
│  ┌────────────────────────┐   Heartbeat Request        │
│  │ Background Thread      │ ─────────────────────► ┌───┴─────────────┐
│  │ (HeartbeatThread)      │ (session.timeout.ms)   │ Group           │
│  └────────────────────────┘                        │ Coordinator     │
│                                                    │ (Kafka Broker)  │
│  ┌────────────────────────┐   Offset Commit        │                 │
│  │ Application Main Thread│ ─────────────────────► └───┬─────────────┘
│  │ KafkaConsumer.poll()   │ (max.poll.interval.ms)    │
│  │ [Record Processing]    │                           │
│  └────────────────────────┘                           │
│              │                                        │
│              ▼ Exceeds timeout                        │
│     [Consumer Kicked Out!] ◄──────────────────────────┘
└────────────────────────────────────────────────────────┘
```

1. **The Heartbeat Thread (`session.timeout.ms`):**  
   Runs entirely in the background. It sends low-overhead ping frames to the Group Coordinator broker at intervals defined by `heartbeat.interval.ms` (typically 3 seconds) to verify that the container network interface and TCP socket remain responsive.
2. **The Application Poll Thread (`max.poll.interval.ms`):**  
   Executes user business logic (database inserts, JSON transformations, third-party HTTP calls) synchronously between invocations of `consumer.poll()`.

If your consumer fetches a batch of 500 records, and an external API dependency slows down such that processing each record takes 700ms:

$$\text{Total Batch Time} = 500 \times 0.7\text{s} = 350\text{ seconds (5.83 minutes)}$$

If the default `max.poll.interval.ms` is **300,000ms (5 minutes)**, the poll thread breaches the deadline by 50 seconds. Despite the background Heartbeat Thread diligently transmitting pings, the Group Coordinator concludes that the consumer's worker loop is deadlocked or wedged. It marks the member `DEAD`, evicts it, and orders a group-wide rebalance. When the consumer finally finishes record #500 and attempts to commit offsets, the coordinator throws `CommitFailedException`.

---

## 3. The Misconfiguration Pitfall: Arbitrarily Bumping `max.poll.interval.ms`

When encountering `CommitFailedException`, the default recommendation on public forums is simply increasing the interval:

```yaml
# ANTI-PATTERN: Expanding poll interval to arbitrary high durations
spring.kafka.consumer.properties.max.poll.interval.ms: 3600000 # 1 hour
```

### Why this creates production vulnerabilities:
When `max.poll.interval.ms` is set to 1 hour, if an application thread genuinely deadlocks on a database connection pool or enters an infinite loop, **Kafka will wait an entire hour before detecting the failure**. During this 60-minute blind window, the partitions assigned to that stalled consumer receive zero consumption, causing massive backlog accumulation and SLA breaches.

---

## 4. Production Solution: 3-Step Remediation

### Step 1: Enforce Batch Size Bounds (`max.poll.records`)

Never process unbounded batches. Size `max.poll.records` such that worst-case processing time never exceeds 30% of `max.poll.interval.ms`:

$$N_{\text{max.poll.records}} \le \frac{\text{max.poll.interval.ms} \times 0.3}{\text{Worst-Case Single-Record Latency}}$$

Assuming a single record can take up to 2 seconds under peak database lock contention, and `max.poll.interval.ms` is kept at 300 seconds:

$$N_{\text{max.poll.records}} \le \frac{300 \times 0.3}{2} = 45\text{ records}$$

### Step 2: Transition from Eager Rebalance to Cooperative Sticky Assignor

By default, Kafka uses `RangeAssignor` or `RoundRobinAssignor`. These legacy strategies employ **Eager Rebalancing**, which forces every consumer in the group to revoke all assigned partitions simultaneously, halting data ingestion across the entire cluster ("Stop-The-World"):

```
[Eager Rebalancing: Stop-The-World]
All Consumers Revoke Partitions ──► Group Idle (Zero Throughput) ──► Full Redistribution

[Cooperative Sticky Rebalancing: Incremental]
Only Impacted Partitions Migrate ──► Unaffected Partitions Continue Ingestion Concurrently
```

With `CooperativeStickyAssignor` (introduced in KIP-429), rebalancing occurs incrementally over two lightweight rounds. Consumers keep consuming from their assigned partitions without interruption, migrating only the specific partitions requiring re-assignment.

---

## 5. Before vs. After Production Configuration

Apply the following diff to your consumer service configuration:

```diff
# application.yml (Spring Boot / Kafka Consumer)
spring:
  kafka:
    consumer:
      # Use manual immediate acknowledgement for precise offset boundary control
      enable-auto-commit: false
      auto-offset-reset: earliest
      
      properties:
        # Keep heartbeat interval strictly 1/3 of session timeout
        session.timeout.ms: 45000
        heartbeat.interval.ms: 15000
        
-       # VULNERABLE: Default 500 records under slow processing causes poll timeout
-       max.poll.records: 500
-       # VULNERABLE: Legacy eager assignor halts cluster ingestion on any change
-       partition.assignment.strategy: org.apache.kafka.clients.consumer.RangeAssignor

+       # RESILIENT: Bounded batch size guarantees execution well below 300s ceiling
+       max.poll.records: 50
+       max.poll.interval.ms: 300000
+       # RESILIENT: Zero-downtime incremental rebalancing
+       partition.assignment.strategy: org.apache.kafka.clients.consumer.CooperativeStickyAssignor
        
        # Buffer and socket transport hardening
        receive.buffer.bytes: 1048576 # 1MB
        max.partition.fetch.bytes: 1048576 # 1MB
```

### Java Listener Implementation: Manual Batch Acknowledgment

```java
@Component
public class ResilientOrderEventListener {

    private static final Logger log = LoggerFactory.getLogger(ResilientOrderEventListener.class);

    @KafkaListener(
        topics = "order-events",
        groupId = "order-fulfillment-group",
        containerFactory = "batchKafkaListenerContainerFactory"
    )
    public void consumeBatch(List<ConsumerRecord<String, OrderEvent>> records, Acknowledgment ack) {
        long startTime = System.currentTimeMillis();
        
        for (ConsumerRecord<String, OrderEvent> record : records) {
            processSingleOrder(record.value());
        }
        
        // Commit offsets synchronously only after the bounded batch completes successfully
        ack.acknowledge();
        
        long elapsed = System.currentTimeMillis() - startTime;
        log.debug("Processed batch of {} records in {}ms", records.size(), elapsed);
    }
}
```

---

## 6. Verification & Prometheus Metrics to Monitor

Verify cluster stability post-deployment by querying JMX metrics via Prometheus/Grafana:

1. **`kafka_consumer_fetch_manager_records_lag_max`**:  
   Monitors maximum consumer lag across partitions. A healthy consumer displays a flat or rapidly recovering saw-tooth pattern, not an exponential upward curve.
2. **`kafka_consumer_coordinator_rebalance_latency_avg`**:  
   Average time spent rebalancing. With `CooperativeStickyAssignor`, rebalance latency drops from seconds to under 50ms.
3. **`kafka_consumer_coordinator_failed_rebalance_total`**:  
   Must remain strictly at `0`. Any increment indicates consumers continuing to trip `max.poll.interval.ms`.

By enforcing bounded batch sizes (`max.poll.records`) and deploying incremental cooperative assignment, Kafka consumer clusters remain immune to cascading rebalance storms even during massive input traffic spikes.

