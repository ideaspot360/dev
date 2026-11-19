---
layout: post
title: "Fixing Kafka Producer BufferExhaustedException & Record Expiring Batch Timeouts Under Heavy Ingestion"
date: 2026-12-02 10:14:52 +0900
category: "Cloud & DevOps"
tags: ['Kafka', 'Producer', 'BufferExhausted', 'Backpressure', 'DistributedSystems', 'Troubleshooting']
---

## Production Incident Summary

During a scheduled stress test simulating flash-sale traffic on an event-driven ingestion pipeline, our telemetry microservice suddenly stopped accepting incoming requests. Worker threads handling HTTP ingestion backed up until the Tomcat thread pool was saturated, and API gateways began dropping requests with HTTP 504 Gateway Timeout.

Inspection of the application stdout logs revealed an avalanche of `TimeoutException` and `BufferExhaustedException` traces originating from the Kafka client internals:

```text
2026-12-02 10:31:14.812 ERROR [http-nio-8080-exec-42] o.a.k.c.p.KafkaProducer : [Producer clientId=producer-telemetry-ingest-1] Exception occurred during message send
org.apache.kafka.common.errors.TimeoutException: Failed to allocate memory within the configured max blocking time 60000 ms.
	at org.apache.kafka.clients.producer.internals.BufferPool.allocate(BufferPool.java:164)
	at org.apache.kafka.clients.producer.internals.RecordAccumulator.append(RecordAccumulator.java:232)
	at org.apache.kafka.clients.producer.KafkaProducer.doSend(KafkaProducer.java:1002)
	at org.apache.kafka.clients.producer.KafkaProducer.send(KafkaProducer.java:947)
	at com.company.telemetry.ingest.service.EventPublisher.publishEvent(EventPublisher.java:68)
Caused by: org.apache.kafka.common.errors.BufferExhaustedException: Failed to allocate 16384 bytes within the configured max blocking time 60000 ms.
	... 18 common frames omitted
```

Simultaneously, the Kafka producer background Sender I/O thread started logging batch expiry failures for records that had successfully entered the accumulator but could not be transmitted:

```text
2026-12-02 10:31:19.405 ERROR [kafka-producer-network-thread | producer-telemetry-ingest-1] o.a.k.c.p.i.Sender : [Producer clientId=producer-telemetry-ingest-1] Expiring 45 batches for telemetry-ingest-topic-8: 62410 ms has passed since batch creation
org.apache.kafka.common.errors.TimeoutException: Expiring 45 batches for telemetry-ingest-topic-8: 62410 ms has passed since batch creation
```

## Production Specs
* **Kafka Broker Cluster**: Apache Kafka 3.6.0 running on AWS MSK (3x `kafka.m5.4xlarge` brokers, KRaft metadata mode)
* **Client Framework**: Java 17, Spring Boot 3.2.2, `spring-kafka` 3.1.2 (Apache Kafka Client 3.6.1)
* **Ingestion Workload**: 55,000 JSON telemetry events/sec, average payload size 1.2 KB
* **Target Topic**: `telemetry-ingest-topic` with 24 partitions, replication factor 3, `min.insync.replicas=2`
* **Producer JVM Settings**: `-Xms8g -Xmx8g -XX:+UseG1GC -XX:MaxGCPauseMillis=50`
* **Baseline Producer Config**: `buffer.memory=33554432` (32 MB), `batch.size=16384` (16 KB), `linger.ms=0`, `max.block.ms=60000`, `compression.type=none`, `acks=all`

---

## 1. Root Cause: Internal RecordAccumulator Allocation Lock & Network Client Congestion

The architectural cause of this incident stems from the interplay between the `RecordAccumulator` memory buffer pool and the producer background `Sender` thread under heavy write saturation.

```text
[ Application HTTP Threads ] ───> producer.send(record)
                                         │
                                         ▼
                            [ RecordAccumulator ]
                             │  BufferPool (32 MB)  │
                             │  [Batch 1] [Batch 2] │
                             └──────────┬───────────┘
                                        │  (buffer.memory exhausted!)
                                        ▼
                            BufferPool.allocate() Blocked
                             │  WAITING on Condition Lock
                             │  max.block.ms (60s) Expires
                             ▼
                 BufferExhaustedException / TimeoutException
```

### The BufferPool Allocation Mechanism
The Kafka Producer does not write records directly to TCP sockets. Instead, `KafkaProducer.send()` places each record into a partition-specific deque of batches inside the `RecordAccumulator`. 

Memory for these batches is managed by `org.apache.kafka.clients.producer.internals.BufferPool`. The pool has a hard ceiling defined by `buffer.memory` (default 32 MB). Whenever a thread writes a message that does not fit into an active `ProducerBatch`, the `RecordAccumulator` asks `BufferPool` to allocate a new byte buffer of size `batch.size` (default 16 KB).

If the available memory in `BufferPool` drops below the requested byte size, the allocating thread acquires a `ReentrantLock` and calls `Condition.await()`:

```java
// Simplified snippet from org.apache.kafka.clients.producer.internals.BufferPool
this.lock.lock();
try {
    while (accumulated < size) {
        long elapsedNano = time.nanoseconds() - startNano;
        long remainingNano = maxTimeToBlockNs - elapsedNano;
        if (remainingNano <= 0) {
            throw new TimeoutException("Failed to allocate memory within the configured max blocking time " + maxBlockTimeMs + " ms.");
        }
        this.waiters.addLast(moreMemory);
        moreMemory.await(remainingNano, TimeUnit.NANOSECONDS);
    }
} finally {
    this.lock.unlock();
}
```

### Why the Queue Collapsed
Three compounding factors caused the buffer pool to empty and lock up:

1. **Uncompressed Payloads & Zero Linger**: Because `compression.type` was set to `none` and `linger.ms=0`, each 16 KB batch contained only ~13 uncompressed messages (1.2 KB each) before the `Sender` thread attempted transmission. Producing 55,000 messages/sec generated over 4,200 micro-batches per second across 24 partitions, overwhelming socket write queues with high TCP packet overhead.
2. **Broker Page Cache & Disk Write Slower Rates**: Under peak ingest, the brokers experienced elevated disk write latencies (rising from 2 ms to 45 ms on EBS gp3 volumes) due to I/O saturation. The brokers slowed down their acknowledgment rate for `acks=all`.
3. **Cascading Thread Starvation**: Because broker acknowledgments slowed down, batches accumulated inside the `RecordAccumulator`. The 32 MB `buffer.memory` limit was exhausted in less than 2.5 seconds of high-rate ingress. Once the buffer filled, all 200 Tomcat worker threads calling `producer.send()` blocked on the `BufferPool` condition lock. After 60 seconds, threads timed out and crashed, throwing `BufferExhaustedException`.
4. **Batch Expiry**: Batches already trapped in the queue waited longer than `delivery.timeout.ms` (configured at 120,000 ms) before getting an in-flight socket window, triggering client-side batch expiry.

---

## 2. Common Missteps: What We Tried First (And Why It Failed)

During initial troubleshooting, several conventional tuning tactics were attempted that failed to stabilize the pipeline.

### Misstep 1: Blindly Increasing max.block.ms
A common wrong fix is raising `max.block.ms` from 60 seconds to 180 seconds to "give the producer more time to drain."
* **Why this naive attempt failed**: Extending `max.block.ms` did not increase throughput by a single byte. Instead, it held application threads hostage three times longer. With threads frozen waiting for buffer allocation, incoming HTTP traffic backed up into kernel TCP accept queues, triggering connection drops and ALB 504 timeouts across all upstream clients.

### Misstep 2: Increasing buffer.memory to 2 GB Without Batch or Compression Tuning
Another anti-pattern is ballooning `buffer.memory` to 2 GB while keeping default batch sizes and uncompressed payloads.
* **What didn't work**: The enlarged buffer acted as a temporary sponge, delaying the memory exhaustion by roughly two minutes. However, because network transmission capacity remained bottlenecked by millions of tiny uncompressed packets, the 2 GB buffer eventually filled up completely. Once full, the JVM suffered massive GC pauses attempting to manage millions of small heap objects, resulting in container OOMKilled events.

---

## 3. Production Remediation & Configuration Tuning

To permanently resolve the bottleneck, we tuned message batching, compression, buffer headroom, and fail-fast backpressure semantics.

### Key Changes
1. **LZ4 Compression**: Enabling `compression.type=lz4` reduced wire payload volume by 68% with negligible CPU overhead.
2. **Increased Batch Size & Linger**: Setting `batch.size=65536` (64 KB) and `linger.ms=20` allowed the `RecordAccumulator` to coalesce hundreds of messages into fewer, denser TCP packets.
3. **Balanced Buffer Memory**: Expanding `buffer.memory` from 32 MB to 128 MB gave sufficient absorption capacity during brief broker disk spikes without endangering container memory bounds.
4. **Fast-Failing max.block.ms**: Reducing `max.block.ms` from 60,000 ms to 15,000 ms allowed the producer to fail fast, allowing upstream Resilience4j circuit breakers to shed load instead of locking Tomcat worker threads.

### Configuration Patch

```diff
--- src/main/resources/application.yml.orig
+++ src/main/resources/application.yml
@@ -14,12 +14,14 @@
       producer:
         acks: all
         retries: 5
-        batch-size: 16384
-        buffer-memory: 33554432
-        linger-ms: 0
-        compression-type: none
-        max-block-ms: 60000
+        batch-size: 65536
+        buffer-memory: 134217728
+        linger-ms: 20
+        compression-type: lz4
+        max-block-ms: 15000
+        delivery-timeout-ms: 180000
+        request-timeout-ms: 30000
         properties:
-          max.in.flight.requests.per.connection: 5
+          max.in.flight.requests.per.connection: 5
           enable.idempotence: true
```

---

## 4. Verification CLI & Operating Metrics

After deploying the configuration updates, we verified socket states, broker connectivity, and producer Prometheus metrics.

### Verification Commands

```bash
# 1. Verify TCP socket buffer sizes and connection state to Kafka brokers (port 9092)
ss -t -a '( dport = :9092 )'

# 2. Inspect kernel TCP write socket buffers to prevent socket stalls
sysctl net.ipv4.tcp_wmem

# 3. Scrape Prometheus metrics to verify buffer pool availability and record queue latency
curl -s http://localhost:8080/actuator/prometheus | grep -E "kafka_producer_record_queue_time_ms|kafka_producer_bufferpool_wait_time_ms|kafka_producer_record_size_avg"

# 4. Verify pod memory utilization and ensure no container restarts
kubectl top pod -l app=telemetry-ingest-service -n production
```

### Production Validation Results

* **Buffer Wait Time**: `kafka_producer_bufferpool_wait_time_ms_avg` plummeted from over 45,000 ms to less than 0.8 ms under peak 60,000 msg/sec load.
* **Batch Density**: Average records per batch surged from 13.1 to 142.8 messages per batch.
* **Network Egress**: Outbound bandwidth dropped from 66 MB/s to 21 MB/s due to LZ4 compression.
* **Error Rate**: Zero occurrences of `BufferExhaustedException` or batch timeout errors across 48 continuous hours of production load.
