---
category: "Systems & Networking"
layout: post
title: "Resolving Kafka LeaderNotAvailableException: Under-Replicated Partitions & Min In-Sync Replicas"
date: 2026-11-14 11:05:00 +0900
categories: [Backend, Kafka]
tags: [Kafka, EventDriven, DistributedSystems, LeaderElection, KRaft]
---

During rolling broker restarts or transient network hiccups, Kafka producers often get hit with burst publish failures accompanied by `LeaderNotAvailableException` and `NotEnoughReplicasException`, while cluster dashboards flash spikes in `UnderReplicatedPartitions`.

The producer error log displays continuous record batch aborts:

```text
2026-11-14T11:02:41.109+09:00 ERROR 1 --- [kafka-producer-network-thread] o.a.k.clients.producer.internals.Sender : [Producer clientId=order-producer] Got error produce response with correlation id 84192 on topic-partition payment-events-2, retrying (9 attempts left). Error: LEADER_NOT_AVAILABLE
org.apache.kafka.common.errors.LeaderNotAvailableException: There is no leader for this topic-partition as we are in the middle of a leadership election.
    at org.apache.kafka.common.protocol.Errors.exception(Errors.java:319)

2026-11-14T11:02:44.204+09:00 ERROR 1 --- [kafka-producer-network-thread] o.a.k.clients.producer.internals.Sender : org.apache.kafka.common.errors.NotEnoughReplicasException: Messages are rejected since there are fewer in-sync replicas than required.
```

Checking cluster metrics via JMX:
* `kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions`: Spike to **42**.
* `kafka.controller:type=KafkaController,name=ActiveControllerCount`: 1 (Healthy).

## Production Specs
* **Kafka Cluster**: 3.7.0 in KRaft Mode (3 Controllers, 5 Brokers)
* **Topic Configuration**: `replication.factor=3`, `min.insync.replicas=2`
* **Producer Setting**: `acks=all`, `retries=10`, `delivery.timeout.ms=120000`
* **Throughput**: ~85,000 msg/sec

---

## 1. Root Cause: Misaligned ISR Shrinkage & Dirty Leader Election

When Broker 3 restarts for OS patching, its local partition replicas temporarily fall out of the **In-Sync Replicas (ISR)** pool due to replica fetch timeouts (`replica.lag.time.max.ms`).

1. A topic with `replication.factor=3` and `min.insync.replicas=2` operates safely with 3 in-sync replicas: `ISR=[1, 2, 3]`.
2. When Broker 3 restarts, `ISR=[1, 2]`. The cluster is still writable.
3. If Broker 2 suffers a temporary JVM Garbage Collection pause exceeding `replica.lag.time.max.ms=10000`, it is also kicked out: `ISR=[1]`.
4. Now, `current_isr_count (1) < min.insync.replicas (2)`.
5. Producers sending records with `acks=all` are **immediately rejected** with `NotEnoughReplicasException` or stuck in `LeaderNotAvailableException` during leader re-election.

---

## 2. Common Missteps: Dangerous Workarounds That Compromise Durability

When producers are blocked by `NotEnoughReplicasException`, the pressure to restore traffic often pushes teams toward dangerous shortcuts that trade durability for availability:

### Dangerous Shortcut 1: Downgrading Producer Durability (`acks=1` or `acks=0`)
The fastest way to silence producer errors in the short term is relaxing client acknowledgments—changing `acks=all` to `acks=1`.
* **The Danger**: When `acks=1`, the producer considers a message successfully sent the moment the single partition leader writes it to local disk, completely bypassing `min.insync.replicas`. If that leader broker crashes or restarts before follower replicas fetch the uncommitted log segments, those records are permanently lost. For financial ledgers, audit trails, or order event streams, silent data loss is far worse than transient backpressure.

### Dangerous Shortcut 2: Enabling `unclean.leader.election.enable=true`
Another tempting reflex is toggling `unclean.leader.election.enable=true` on the cluster to force partition availability at all costs when the in-sync replica count drops below quorum.
* **The Danger**: This allows an out-of-sync replica—one that may have missed thousands of committed records—to be elected partition leader. The moment the new unclean leader begins accepting writes, the high watermark resets, and all previous un-replicated records on the old leader are permanently truncated. This causes irreversible state divergence between producers and downstream consumers.

---

## 3. Before vs. After Remediation

### Approach A: Balance `replica.lag.time.max.ms` & Broker Heap GC
Short lag thresholds trigger premature ISR evictions during normal GC pauses. Adjust cluster-wide broker settings in `server.properties`:

```diff
# /etc/kafka/server.properties
# Give brokers sufficient time to catch up after minor GC hiccups
- replica.lag.time.max.ms = 10000
+ replica.lag.time.max.ms = 30000

# Optimize Controller metadata election timeout
- controller.quorum.election.timeout.ms = 1000
+ controller.quorum.election.timeout.ms = 5000

# Prevent data corruption: Never allow un-synced replicas to become leader
+ unclean.leader.election.enable = false
```

### Approach B: Producer Retry & Backoff Resilience
Harden the producer configuration to seamlessly absorb transient leader election windows without dropping events:

```diff
# application.yml
spring:
  kafka:
    producer:
      acks: all
-     retries: 3
-     retry.backoff.ms: 100
+     retries: 30                    # Max retries before fatal exception
+     retry.backoff.ms: 500          # Backoff between attempts
+     delivery.timeout.ms: 120000    # Allow 2 minutes buffer for leader failover
+     properties:
+       enable.idempotence: true     # Guaranteed exactly-once delivery
```

---

## Verification
* Simulated rolling broker restarts under 50,000 msg/sec load.
* Producer successfully buffered and retried in-flight batches during the 3.8-second leadership transition.
* Zero dropped messages across all critical financial topics.

