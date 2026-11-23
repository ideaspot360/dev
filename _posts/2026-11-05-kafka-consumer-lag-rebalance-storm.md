---
layout: post
title: "Fixing Kafka Consumer Lag & Rebalance Storms: CommitFailedException, max.poll.interval.ms, and Cooperative Sticky Assignor"
date: 2026-11-05 10:18:42 +0900
category: "Systems & Networking"
tags: [kafka, distributed-systems, backend, spring-boot, microservices, troubleshooting]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When Kafka consumers repeatedly crash with CommitFailedException and trigger rebalance storms, increasing max.poll.interval.ms masks thread starvation. Here is how decoupled heartbeat threads, bounded poll records sizing, KIP-345 static membership, and CooperativeStickyAssignor eliminate cascading rebalances."
verification_date: "2026-11-23"
fact_check_sources:
  - "https://kafka.apache.org/documentation/#consumerconfigs"
  - "https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol"
  - "https://cwiki.apache.org/confluence/display/KAFKA/KIP-345%3A+Introduce+static+membership+protocol+to+reduce+consumer+rebalances"
  - "https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol"
  - "https://docs.spring.io/spring-kafka/reference/kafka/receiving-messages/message-listeners.html"
---

Under sudden ingestion spikes or downstream database latency degradation, Apache Kafka consumer instances frequently fail to commit consumer offsets, resulting in cascading group rebalances and unbounded consumer lag [Source: Apache Kafka Documentation - Consumer Configurations](https://kafka.apache.org/documentation/#consumerconfigs). When an offset commit is rejected by the broker-side Group Coordinator because the consumer's polling threshold has elapsed, the consumer runtime throws `org.apache.kafka.clients.consumer.CommitFailedException`:

```text
org.apache.kafka.clients.consumer.CommitFailedException: Commit cannot be completed since the group has already rebalanced and assigned the partitions to another member. This means that the time between subsequent calls to poll() was longer than the configured max.poll.interval.ms, which typically implies that the poll loop is spending too much time processing messages. You can address this either by increasing max.poll.interval.ms or by reducing the maximum size of batches returned in poll() with max.poll.records.
[Consumer clientId=consumer-order-service-1, groupId=order-fulfillment-group] OffsetCommit failed on partition order-events-4 at offset 1892014: This is likely due to the consumer being kicked out of the group.
```

Concurrently, sibling consumers in the cluster that attempt to commit their existing assigned partition offsets or join synchronization phases encounter secondary coordinator exceptions:

```text
org.apache.kafka.common.errors.RebalanceInProgressException: Offset commit cannot be completed since the group is already rebalancing for generation 142.
    at org.apache.kafka.clients.consumer.internals.ConsumerCoordinator.sendOffsetCommitRequest(ConsumerCoordinator.java:1280)
    at org.apache.kafka.clients.consumer.internals.ConsumerCoordinator.commitOffsetsSync(ConsumerCoordinator.java:1145)
    at org.apache.kafka.clients.consumer.KafkaConsumer.commitSync(KafkaConsumer.java:1520)
    at org.springframework.kafka.listener.KafkaMessageListenerContainer$ListenerConsumer.commitSync(KafkaMessageListenerContainer.java:2790)
```

At the broker layer, the Apache Kafka Group Coordinator marks the stalled consumer as dead, evicts it from the generation metadata, and triggers a group-wide partition revocation:

```text
2026-11-05T10:14:02.148Z [GroupCoordinator id=1]: Member consumer-order-service-1 in group order-fulfillment-group has failed, removing it from the group. Reason: Member poll timeout expired (max.poll.interval.ms=300000ms exceeded).
2026-11-05T10:14:02.152Z [GroupCoordinator id=1]: Preparing rebalance for group order-fulfillment-group with generation 143; reason: removing member consumer-order-service-1 on heartbeat expiration or poll timeout.
2026-11-05T10:14:02.160Z [GroupCoordinator id=1]: Stabilized group order-fulfillment-group generation 143 with 3 members.
```

When this eviction occurs, the partitions consumer #1 was actively handling are revoked immediately. Those partitions and their uncommitted message backlogs are redistributed to neighboring consumers. Those neighboring consumers, already operating near processing saturation, inherit the uncommitted backpressure. As a consequence, their own processing loops breach `max.poll.interval.ms`, creating a cascading **Rebalance Storm** where the entire consumer pool stops processing application messages and instead endlessly cycles through group join and synchronization handshakes [Source: Apache Kafka KIP-429 - Incremental Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol).

---

## 1. Verified Production Specs

The diagnostic profiles, error reproductions, and configuration benchmarks documented below were verified against the following production baseline:

* **Kafka Cluster:** Apache Kafka v3.7.0 / v3.8.0 / v4.0.0-RC (KRaft metadata quorum, 3-broker cluster, partition count 24, replication factor 3, `min.insync.replicas=2`)
* **Client Framework:** Spring for Apache Kafka v3.1.5 & v3.2.x (Spring Boot 3.3.x) / Java `kafka-clients` 3.7.0+
* **Runtime Stack:** Eclipse Temurin OpenJDK 21.0.4 (LTS) on Linux Kernel 6.6.x LTS (Ubuntu 24.04 LTS / Amazon Linux 2023)
* **Topic Profile:** Topic `order-events` (24 partitions, single-message payload 4.2 KiB average, gzip compression, `cleanup.policy=delete`)
* **Infrastructure Layer:** Kubernetes EKS cluster v1.30, consumer deployed as a 4-pod `StatefulSet` with dedicated resource requests (2 vCPU, 4 GiB RAM per pod)

---

## 2. The Wrong Fix (Initial Misdiagnosis & Why Bumping max.poll.interval.ms Fails)

When on-call engineers receive alerts indicating recurring `CommitFailedException` occurrences, the most common naive fix is to inflate `max.poll.interval.ms` to an arbitrary multi-hour window [Source: Apache Kafka Documentation - Consumer Configurations](https://kafka.apache.org/documentation/#consumerconfigs):

```yaml
# THE FLAWED FIX: Expanding poll interval without bounding batch size or isolating worker threads
spring:
  kafka:
    consumer:
      properties:
        max.poll.interval.ms: 3600000 # 1 hour (ANTI-PATTERN)
        session.timeout.ms: 120000     # 2 minutes
```

While expanding `max.poll.interval.ms` from 300,000 ms (5 minutes) to 3,600,000 ms (1 hour) temporarily suppresses the exception during moderate traffic spikes, this approach introduces severe production failure modes:

### Why this naive fix causes catastrophic production blindness:

1. **Failure Detection Black Hole:**  
   `max.poll.interval.ms` is the primary mechanism by which the Kafka Group Coordinator detects deadlocks or wedged worker threads. If a consumer thread deadlocks on an unreleased HikariCP database connection pool, hangs on an un-timeouted HTTP call, or enters an infinite regex processing loop, **Kafka will wait an entire hour before declaring the consumer dead**.
2. **Unbounded Lag Accumulation:**  
   During that 60-minute window, the partitions assigned to the wedged consumer receive zero message consumption. Total topic lag grows linearly. Downstream data pipelines, order fulfillment workflows, and analytics tables suffer severe SLA breaches while monitoring dashboards show the consumer container as technically "running".
3. **Rebalance Shock on Restart:**  
   When the stalled container is finally terminated by Kubernetes liveness probes or human intervention, restarting the container forces an enormous rebalance. The successor consumer inherits 60 minutes worth of accumulated backlog, instantly breaches its own processing thresholds, and reignites the rebalance storm with greater intensity.

Bumping `max.poll.interval.ms` merely masks downstream execution latency while destroying the cluster's ability to detect dead workers in real time.

---

## 3. Root Cause Analysis: Heartbeat Thread Decoupling, Eager Rebalance Cascades & Poll Starvation

Three distinct architectural mechanisms interact to trigger rebalance storms under heavy load:

### A. Decoupled Architecture: Heartbeat Thread vs. Application Poll Thread
A frequent source of confusion among backend engineers is assuming that network TCP connectivity or JVM liveness prevents Kafka consumer evictions.

In the official Java Kafka consumer client, liveness verification is split across two independent execution contexts [Source: Apache Kafka Documentation - Consumer Configurations](https://kafka.apache.org/documentation/#consumerconfigs):

```
┌────────────────────────────────────────────────────────────────────────┐
│ JVM Process (KafkaConsumer Client)                                     │
│                                                                        │
│  ┌───────────────────────────┐    Periodic Heartbeats (every 3s)       │
│  │ Background Thread         │ ──────────────────────────────────────► ┌────────────────────┐
│  │ (HeartbeatThread)         │    Validates socket liveness            │ Group Coordinator  │
│  │ session.timeout.ms (45s)  │ ◄────────────────────────────────────── │ (Kafka Broker)     │
│  └───────────────────────────┘    broker keeps member in group         │                    │
│                                                                        │                    │
│  ┌───────────────────────────┐    OffsetCommitRequest                  │                    │
│  │ Application Poll Thread   │ ──────────────────────────────────────► │                    │
│  │ (Main Worker Loop)        │    Validates record processing progress │                    │
│  │ max.poll.interval.ms(300s)│                                         │                    │
│  └───────────────────────────┘                                         │                    │
│                │                                                       │                    │
│                ▼ Worker loop blocks on DB/API (> 300s)                 │                    │
│         [POLL TIMEOUT EXPIRED] ──────────────────────────────────────► └────────────────────┘
│                                                                                  │
│                               Coordinator evicts member and revokes partitions  │
│                                                                                  ▼
│         [CommitFailedException] ◄────────────────────────────────────────────────┘
└────────────────────────────────────────────────────────────────────────┘
```

1. **The Background `HeartbeatThread` (`session.timeout.ms`):**  
   Runs in an asynchronous daemon thread. It transmits low-overhead heartbeat frames to the Group Coordinator broker at fixed intervals defined by `heartbeat.interval.ms` (typically 3,000 ms, or one-third of `session.timeout.ms`). Its purpose is strictly to confirm that the container network interface, TCP socket, and JVM process are physically responsive.
2. **The Application Poll Thread (`max.poll.interval.ms`):**  
   Executes user business logic (deserialization, database updates, external REST calls) sequentially between subsequent invocations of `KafkaConsumer.poll()`.

The Group Coordinator requires **both** criteria to maintain group membership:
* Heartbeats must arrive within `session.timeout.ms` (network/process liveness).
* Subsequent `poll()` calls must arrive within `max.poll.interval.ms` (business logic progress).

When a consumer fetches a batch of records, the total elapsed time before the next `poll()` is:

$$T_{\text{batch}} = \sum_{i=1}^{N_{\text{records}}} t_{\text{record}, i} + t_{\text{overhead}}$$

If `max.poll.records` is left at the default of **500**, and an upstream database slowdown increases single-record processing time to $750\text{ ms}$:

$$T_{\text{batch}} = 500 \times 0.750\text{ s} = 375\text{ seconds (6.25 minutes)}$$

Because the default `max.poll.interval.ms` is **300,000 ms (5 minutes)**, the poll thread overshoots the deadline by 75 seconds. Even though the background `HeartbeatThread` successfully delivered pings every 3 seconds, the broker coordinator detects that the poll thread failed to call `poll()` within 300 seconds. The broker marks the consumer `DEAD`, revokes its partitions, and advances the group generation from 142 to 143. When the poll thread completes record #500 and attempts to commit offsets via `commitSync()`, the coordinator rejects the request with `CommitFailedException`.

### B. The Classic Eager Rebalance "Stop-The-World" Cascade
Prior to incremental rebalancing, Kafka consumer groups utilized the **Eager Rebalance Protocol** (used by legacy assignors such as `RangeAssignor` and `RoundRobinAssignor`) [Source: Apache Kafka KIP-429 - Incremental Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol).

Under eager rebalancing, when any consumer joins, leaves, or times out:
1. Every consumer in the entire group must completely **revoke all assigned partitions**.
2. All data ingestion halts across all partitions ("Stop-The-World" phase).
3. All consumers send `JoinGroup` requests to the coordinator.
4. The Group Leader computes the full partition distribution map.
5. All consumers send `SyncGroup` requests to receive their new assignments.

```
[Legacy Eager Protocol: Global Revocation]
Consumer 1 (Slow):  ──[Revoke All Partitions]──► [JoinGroup] ──► [SyncGroup] ──► [Resume]
Consumer 2 (Busy):  ──[Revoke All Partitions]──► [JoinGroup] ──► [SyncGroup] ──► [Resume]
Consumer 3 (Idle):  ──[Revoke All Partitions]──► [JoinGroup] ──► [SyncGroup] ──► [Resume]
                     ▲                                                    ▲
                     └──────── STOP-THE-WORLD PAUSE (Zero Ingestion) ─────┘
```

When one consumer is evicted due to poll timeout, eager rebalancing pauses every healthy consumer in the cluster. While waiting for group synchronization, records continue piling up on brokers. When consumers resume, they face a massive backlog, immediately trigger new poll timeouts, and restart the rebalance cycle.

### C. Dynamic Membership Churn in Kubernetes Deployments
By default, Kafka consumers use dynamic membership. Each consumer generates a randomized member ID upon startup (for example, `consumer-1-d64e9a07-88ab-4ecb-99f8-b34e2621945a`). When a Kubernetes pod restarts during a rolling deployment, the terminating pod sends a `LeaveGroup` request, triggering Rebalance #1. When the new replacement pod starts with a fresh UUID, it sends a `JoinGroup` request, triggering Rebalance #2. For a 10-replica consumer deployment, a routine rolling update creates **20 consecutive cluster-wide stop-the-world rebalances** [Source: Apache Kafka KIP-345 - Static Membership Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-345%3A+Introduce+static+membership+protocol+to+reduce+consumer+rebalances).

---

## 4. Rebalance Protocol Architecture: Eager vs. Cooperative Sticky vs. KIP-848

To eliminate rebalance storms, modern Kafka architectures decouple partition assignment from global synchronization barriers across three generational phases:

```
[Generational Evolution of Kafka Consumer Rebalancing]

1. Classic Eager Protocol (Kafka 0.9 - 2.3)
   - Assignors: RangeAssignor, RoundRobinAssignor
   - Protocol: Eager (Stop-the-world, revoke all partitions, client-computed)

2. Incremental Cooperative Rebalancing (Kafka 2.4 - 3.x, KIP-429)
   - Assignor: CooperativeStickyAssignor
   - Protocol: Cooperative (Two-phase handoff, unaffected partitions keep processing)

3. Next-Generation Broker-Side Protocol (Kafka 4.0+ GA, KIP-848)
   - Property: group.protocol=consumer
   - Protocol: Server-side coordination (No client leader, continuous heartbeat-driven)
```

### Architectural Comparison Matrix

| Protocol Dimension | Classic Eager Protocol (Legacy) | Incremental Cooperative (KIP-429) | Next-Gen Consumer Protocol (KIP-848) |
| :--- | :--- | :--- | :--- |
| **Introduced In** | Kafka 0.9 | Kafka 2.4 / 3.x [Source: KIP-429] | Kafka 4.0 GA [Source: KIP-848] |
| **Partition Assignment Class** | `RangeAssignor` / `RoundRobinAssignor` | `CooperativeStickyAssignor` | Broker-side assignor (`uniform`, `range`) |
| **Rebalance Scope** | Global Stop-The-World (all partitions revoked) | Incremental (only reassigned partitions pause) | Asynchronous partition migrations via heartbeat frames |
| **Ingestion During Rebalance** | 0% (Halted across entire group) | 100% on unaffected partitions | 100% uninterrupted processing |
| **Assignment Computation** | Client Group Leader | Client Group Leader | Broker Group Coordinator |
| **Pod Rolling Update Impact** | $2N$ full cluster rebalances | Minimized via Sticky logic | Zero stop-the-world pauses |
| **Static Membership (KIP-345)** | Supported (`group.instance.id`) | Fully supported (`group.instance.id`) | Native support built into broker metadata |

### How `CooperativeStickyAssignor` Operates
Under `CooperativeStickyAssignor`, rebalancing shifts from a single destructive sweep into a two-phase non-blocking negotiation [Source: Apache Kafka KIP-429 - Incremental Rebalance Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol):
1. **Phase 1 (Discovery & Revocation):** When a member changes, consumers submit their existing partition assignments in their join requests. Unaffected partitions **continue reading and processing records without interruption**. Consumers owning partitions that must be reassigned revoke only those specific partitions and commit their offsets.
2. **Phase 2 (Assignment):** A second lightweight rebalance occurs where only the revoked partitions are assigned to their new target consumers.

---

## 5. Production Solution: 4-Step Remediation & Configuration Hardening

Eliminating rebalance storms requires tuning batch boundaries, switching to incremental assignment, stabilizing pod membership identities, and adopting manual offset acknowledgment.

### Step 1: Enforce Strict Mathematical Bounds on `max.poll.records`
Never leave `max.poll.records` at 500 when individual message processing incurs network I/O or database contention. Size `max.poll.records` such that worst-case processing duration consumes no more than **30%** of `max.poll.interval.ms` [Source: Apache Kafka Documentation - Consumer Configurations](https://kafka.apache.org/documentation/#consumerconfigs):

$$N_{\text{max.poll.records}} \le \frac{\text{max.poll.interval.ms} \times 0.30}{t_{\text{worst-case single record latency}}}$$

If `max.poll.interval.ms` is maintained at 300,000 ms (5 minutes), and external dependency degradation pushes single-record processing latency to $2.0\text{ seconds}$:

$$N_{\text{max.poll.records}} \le \frac{300 \times 0.30}{2.0} = \frac{90}{2.0} = 45\text{ records}$$

Setting `max.poll.records: 45` (or rounding down to `40`) guarantees that even under a triple-sigma database latency spike, the entire batch finishes within 90 seconds, leaving a 210-second safety buffer before tripping the poll timeout.

### Step 2: Implement Static Consumer Group Membership (KIP-345) & Kubernetes Lifecycle Tuning
In Kubernetes deployments, utilize `StatefulSet` with stable network identifiers (`order-service-0`, `order-service-1`) and inject the pod name into `group.instance.id` [Source: Apache Kafka KIP-345 - Static Membership Protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-345%3A+Introduce+static+membership+protocol+to+reduce+consumer+rebalances):

```yaml
# In Kubernetes StatefulSet pod template:
env:
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
  - name: KAFKA_GROUP_INSTANCE_ID
    value: "order-service-$(POD_NAME)"
```

When a static consumer pod shuts down gracefully, it deliberately suppresses the `LeaveGroupRequest` frame sent to the Group Coordinator broker. Instead, the coordinator preserves its partition assignments in state and waits for `session.timeout.ms`.

#### Sizing `session.timeout.ms` Against the Kubernetes Pod Lifecycle:
To prevent false evictions during rolling deployments, `session.timeout.ms` must satisfy the following inequality:

$$\text{session.timeout.ms} > \text{terminationGracePeriodSeconds} + t_{\text{scheduling}} + t_{\text{JVM startup}}$$

In Kubernetes, default `terminationGracePeriodSeconds` is 30 seconds. If a Spring Boot application requires 20 seconds to drain active batches (`spring.lifecycle.timeout-per-shutdown-phase: 20s`), and subsequent pod scheduling plus JVM initialization requires 25 seconds, the total recycling duration is $45\text{ seconds}$. Setting `session.timeout.ms: 45000` leaves zero headroom; any minor image pull delay causes the broker to expire the session and trigger a full rebalance.

Therefore, for containerized static consumers, raise `session.timeout.ms` to **`60000`** (60 seconds) with `heartbeat.interval.ms: 15000` (strictly maintaining the $\le 1/3$ ratio), ensuring the value remains within the broker-side `group.max.session.timeout.ms` boundary.

#### Fencing Collisions and `FencedInstanceIdException`:
If a slow pod restarts after `session.timeout.ms` has elapsed, or if a misconfigured deployment (such as a standard Kubernetes `Deployment` with rolling `maxSurge: 1`) starts a second pod sharing the identical `group.instance.id`, the Kafka broker detects an epoch violation and instantly terminates the rogue consumer:

```text
org.apache.kafka.common.errors.FencedInstanceIdException: The broker rejected this static consumer since another consumer with the same group.instance.id has registered with a newer member.id epoch.
```

This fencing mechanism guarantees data integrity and prevents split-brain partition writes. To avoid epoch collisions, static consumers must always be deployed via `StatefulSet` rather than surge-based `Deployment` controllers.

### Step 3: Production Configuration Unified Diff

Apply the following hardening diff to `application.yml` and client properties:

```diff
# application.yml (Spring Boot / Apache Kafka Consumer)
spring:
  kafka:
+   listener:
+     # REQUIRED: Explicit MANUAL_IMMEDIATE mode allows Acknowledgment injection in listeners
+     ack-mode: manual_immediate
    consumer:
-     # VULNERABLE: Automatic offset commits hide batch processing failures and cause duplicate processing
-     enable-auto-commit: true
-     auto-commit-interval: 5000
+     # RESILIENT: Disable auto-commit to hand offset management over to application transaction boundaries
+     enable-auto-commit: false
      auto-offset-reset: earliest
      
      properties:
-       # VULNERABLE: Default 500 records easily breaches 300s under downstream latency spikes
-       max.poll.records: 500
-       # VULNERABLE: Eager RangeAssignor triggers global Stop-The-World rebalance cascades
-       partition.assignment.strategy: org.apache.kafka.clients.consumer.RangeAssignor
-       session.timeout.ms: 10000
-       heartbeat.interval.ms: 3000

+       # RESILIENT: Bounded batch size ensures processing completes well within the 300s window
+       max.poll.records: 40
+       max.poll.interval.ms: 300000
+       # RESILIENT: Extended session timeout accommodates Kubernetes StatefulSet pod restart grace windows
+       session.timeout.ms: 60000
+       heartbeat.interval.ms: 15000
+       # RESILIENT: Zero-downtime incremental partition rebalancing
+       partition.assignment.strategy: org.apache.kafka.clients.consumer.CooperativeStickyAssignor
+       # RESILIENT: Static membership prevents pod restart rebalance storms (StatefulSet pod ID)
+       group.instance.id: ${KAFKA_GROUP_INSTANCE_ID:}
        
        # Socket transport and buffer safety
        receive.buffer.bytes: 1048576       # 1 MiB socket receive buffer
        max.partition.fetch.bytes: 1048576  # 1 MiB per-partition fetch buffer
```

### Step 4: Java Listener Implementation with Manual Immediate Acknowledgment

When operating with `enable-auto-commit: false`, configure the listener container with `AckMode.MANUAL_IMMEDIATE` to ensure that offsets are committed synchronously only after all records in the bounded batch have processed successfully [Source: Spring for Apache Kafka Documentation - Message Listeners](https://docs.spring.io/spring-kafka/reference/kafka/receiving-messages/message-listeners.html):

```java
package com.ideaspot360.orders.consumer;

import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class ResilientOrderEventListener {

    private static final Logger log = LoggerFactory.getLogger(ResilientOrderEventListener.class);
    private final OrderProcessingService orderProcessingService;

    public ResilientOrderEventListener(OrderProcessingService orderProcessingService) {
        this.orderProcessingService = orderProcessingService;
    }

    @KafkaListener(
        topics = "order-events",
        groupId = "order-fulfillment-group",
        containerFactory = "batchKafkaListenerContainerFactory"
    )
    public void consumeBatch(List<ConsumerRecord<String, OrderEventPayload>> records, Acknowledgment ack) {
        if (records == null || records.isEmpty()) {
            return;
        }

        long startTime = System.currentTimeMillis();
        int recordCount = records.size();

        log.info("Received bounded batch of {} records from partition {}", 
                 recordCount, records.get(0).partition());

        try {
            for (ConsumerRecord<String, OrderEventPayload> record : records) {
                // Execute business logic with strict circuit-breaker timeouts
                orderProcessingService.processOrder(record.key(), record.value());
            }

            // Acknowledge offsets immediately after bounded batch completes
            ack.acknowledge();

            long duration = System.currentTimeMillis() - startTime;
            log.info("Successfully committed offsets for {} records in {}ms", recordCount, duration);

        } catch (Exception ex) {
            log.error("Fatal processing error at offset {}. Halting commit to prevent data loss: {}", 
                      records.get(0).offset(), ex.getMessage(), ex);
            throw ex; // Delegate backoff retry to Spring Kafka CommonErrorHandler
        }
    }
}
```

---

## 6. Verification & Observability CLI Runbook

To verify consumer cluster stability, diagnose partition assignment health, and measure socket buffer saturation post-deployment, execute the following commands [Source: Apache Kafka Documentation - Consumer Configurations](https://kafka.apache.org/documentation/#consumerconfigs):

### Step 1: Inspect Consumer Group State and Partition Lag via Kafka Admin CLI

```bash
# Interrogate the Kafka coordinator broker directly via Kubernetes CLI
kubectl exec -it kafka-broker-0 -n kafka -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe --group order-fulfillment-group \
  --state
```

Expected diagnostic output confirming `Stable` state and assigned static member instances:

```text
GROUP                   COORDINATOR (ID)          ASSIGNMENT-STRATEGY   STATE           #MEMBERS
order-fulfillment-group kafka-broker-1:9092 (1)   cooperative-sticky    Stable          4

GROUP                   TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG             CONSUMER-ID                                     HOST            CLIENT-ID
order-fulfillment-group order-events    0          1892015         1892015         0               order-service-0-3f41a                           /10.244.3.14    consumer-1
order-fulfillment-group order-events    1          1745902         1745902         0               order-service-0-3f41a                           /10.244.3.14    consumer-1
order-fulfillment-group order-events    2          1620984         1620985         1               order-service-1-8a90b                           /10.244.4.22    consumer-2
order-fulfillment-group order-events    3          1902110         1902110         0               order-service-1-8a90b                           /10.244.4.22    consumer-2
```

### Step 2: Validate TCP Socket Recv-Q/Send-Q Health on Consumer Pods

Verify that TCP socket buffers are not saturating due to unacknowledged broker frames:

```bash
# Inspect active TCP socket connections to the Kafka broker port 9092
kubectl exec -it order-service-0 -n production -- ss -tna '( dport = :9092 or sport = :9092 )'
```

Output confirming empty `Recv-Q` and `Send-Q` buffers with zero socket backlog:

```text
State       Recv-Q Send-Q  Local Address:Port   Peer Address:Port
ESTAB       0      0       10.244.3.14:48292    10.244.1.10:9092
ESTAB       0      0       10.244.3.14:48294    10.244.1.11:9092
ESTAB       0      0       10.244.3.14:48296    10.244.1.12:9092
```

### Step 3: Query Prometheus Metrics for Rebalance Latency and Evictions

Execute an instant Prometheus vector query via `curl` to verify that failed rebalances remain strictly zero:

```bash
# Query Prometheus query API for failed rebalances and average rebalance duration
curl -s "http://prometheus-k8s.monitoring.svc:9090/api/v1/query?query=kafka_consumer_coordinator_failed_rebalance_total%7Bgroup%3D%22order-fulfillment-group%22%7D" | jq .
```

Expected JSON response confirming zero rebalance failures:

```json
{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {
        "metric": {
          "__name__": "kafka_consumer_coordinator_failed_rebalance_total",
          "client_id": "consumer-1",
          "group": "order-fulfillment-group",
          "instance": "10.244.3.14:8080"
        },
        "value": [
          1763857122.418,
          "0"
        ]
      }
    ]
  }
}
```

---

## 7. Production Hardening Checklist

Before deploying Kafka consumer updates to production, audit your configuration against this reference checklist:

1. **Batch Bounds:** Is `max.poll.records` sized such that $N \times t_{\text{max single record latency}} \le \text{max.poll.interval.ms} \times 0.30$?
2. **Assignor Strategy:** Is `partition.assignment.strategy` set to `org.apache.kafka.clients.consumer.CooperativeStickyAssignor` (or `group.protocol=consumer` for Kafka 4.0+)?
3. **Heartbeat & Session Alignment:** Is `heartbeat.interval.ms` maintained strictly at one-third or less of `session.timeout.ms` (e.g., 15s / 60s), with `session.timeout.ms` dimensioned to exceed Kubernetes `terminationGracePeriodSeconds` plus pod startup latency?
4. **Static Identity:** Are consumer pods configured with `group.instance.id` derived from stable Kubernetes StatefulSet pod names?
5. **Acknowledgment Semantics:** Is `enable-auto-commit: false` active with manual acknowledgment executed only after batch processing completes?
