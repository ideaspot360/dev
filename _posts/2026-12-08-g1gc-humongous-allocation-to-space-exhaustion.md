---
layout: post
title: "Troubleshooting JVM G1GC Humongous Allocation Spikes & To-space Exhausted Latency Pauses"
date: 2026-12-08 10:22:41 +0900
category: "Systems & Networking"
tags: ['Java', 'JVM', 'GarbageCollection', 'G1GC', 'Performance', 'Troubleshooting']
---

## Production Incident Summary

During peak morning order ingestion on our distributed event processing cluster, latency across high-throughput Kafka consumer microservices spiked violently. Tail latencies (P99) surged from a baseline of 18ms to over 3,200ms, triggering upstream HTTP 504 gateway timeouts and cascading worker thread pool saturation.

Application telemetry confirmed that service threads were repeatedly halted by Stop-The-World (STW) pauses. Inspection of the HotSpot garbage collection logs (`-Xlog:gc*,gc+phases=debug:file=/var/log/jvm/gc.log:time,uptime,pid:filecount=5,filesize=100M`) revealed chronic `to-space exhausted` evacuation failures followed by single-threaded Full GC fallback:

```text
2026-12-08T01:14:22.841+0000: 4128.192: [GC pause (G1 Evacuation Pause) (young) (to-space exhausted)
  [Parallel Time: 1842.1 ms, GC Workers: 8]
    [GC Worker Start (ms): Min: 4128193.1, Avg: 4128193.4, Max: 4128193.8, Diff: 0.7]
    [Ext Root Scanning (ms): Min: 12.1, Avg: 14.5, Max: 18.2, Diff: 6.1, Sum: 116.0]
    [Update RS (ms): Min: 45.2, Avg: 48.1, Max: 52.0, Diff: 6.8, Sum: 384.8]
    [Scan RS (ms): Min: 28.4, Avg: 31.2, Max: 35.1, Diff: 6.7, Sum: 249.6]
    [Object Copy (ms): Min: 1720.4, Avg: 1735.8, Max: 1752.1, Diff: 31.7, Sum: 13886.4]
  [Code Root Fixup: 0.8 ms]
  [Clear CT: 1.2 ms]
  [Other: 98.4 ms]
    [Evacuation Failure: 89.2 ms]
  [Eden: 8192.0M(8192.0M)->0.0B(7168.0M) Survivors: 512.0M->0.0B Heap: 15.2G(16.0G)->14.8G(16.0G)]
 [Times: user=14.21 sys=0.38, real=1.94 secs]
2026-12-08T01:14:24.784+0000: 4130.135: [Full GC (Allocation Failure)  14.8G->3.2G(16.0G), 2.8471234 secs]
   [Eden: 0.0B(7168.0M)->0.0B(8192.0M) Survivors: 0.0B->0.0B Heap: 14.8G(16.0G)->3.2G(16.0G)], [Metaspace: 184210KB->184210KB(1228800KB)]
 [Times: user=2.79 sys=0.04, real=2.85 secs]
```

At the exact moment of failure, young generation collection could not find free destination regions to copy surviving objects into, triggering immediate promotion abort, emergency compaction, and a multi-second stop-the-world Full GC event.

## Production Specs
* **Runtime**: OpenJDK 64-Bit Server VM (build 21.0.4+7-LTS)
* **Garbage Collector**: G1GC (`-XX:+UseG1GC`)
* **JVM Heap Config**: `-Xms16g -Xmx16g -XX:MaxGCPauseMillis=200`
* **Container Environment**: Kubernetes Pod (16 CPU cores limit, 20Gi memory limit)
* **Workload**: Spring Boot 3.3.4 processing Avro-serialized JSON telemetry payloads via Kafka

---

## 1. Architectural Cause & Root Cause Analysis: Humongous Region Fragmentation

The root cause of the evacuation failures was **chronic heap fragmentation caused by G1 Humongous Object allocations**.

In the G1 collector, the heap is dynamically partitioned into equal-sized contiguous memory blocks called **regions**. By default, for a 16GB heap, the HotSpot JVM automatically calculates the region size as:

$$\text{Region Size} = \frac{\text{Heap Size}}{2048} = \frac{16\text{ GB}}{2048} = 8\text{ MB}$$

Under G1GC specification, any object whose serialized payload exceeds **50% of a single region size (4MB)** is classified as a **Humongous Object**.

```text
Default Heap Partitioning (Region Size = 8MB):
┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│  Eden 1  │  Eden 2  │Survivor 1│  Old 1   │ Humongous│ Humongous│ Free 1   │ Free 2   │
│  (8 MB)  │  (8 MB)  │  (8 MB)  │  (8 MB)  │  Head    │  Cont.   │ (8 MB)   │ (8 MB)   │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
                                            ▲
                                            │ Direct Allocation into Old Gen!
                                 [ 5.2 MB Payload Buffer ]
```

When our Kafka consumer received batch payloads containing uncompressed batch documents (ranging between 4.8MB and 6.2MB), the Netty byte buffer allocations bypassed the Eden generation entirely. Instead of following the standard Eden -> Survivor -> Old promotion lifecycle:

1. **Direct Old Generation Allocation**: Humongous objects are immediately allocated into contiguous free regions within the Old Generation.
2. **Region Fragmentation**: An object of 5.2MB claims two full contiguous 8MB regions (16MB total), straddling them and wasting ~10.8MB of unclaimable region tail space.
3. **Premature Concurrent Mark**: G1 tracks humongous occupancy against `InitiatingHeapOccupancyPercent` (IHOP, default 45%). Rapid humongous allocations caused IHOP to be breached within seconds, keeping concurrent marking threads running continuously.
4. **Evacuation Failure (`to-space exhausted`)**: When a normal Young GC evacuation pause occurred, the allocator attempted to find empty regions for surviving Eden objects. Because humongous allocations had consumed and fragmented all contiguous unallocated regions, no destination regions existed. G1 aborted evacuation and fell back to an expensive single-threaded Full GC.

---

## 2. Failed Hypotheses & Counterproductive Fixes

Before isolating the region geometry and buffer sizing, two emergency interventions failed to restore stability:

### Failed Attempt 1: Doubling Heap Size (`-Xmx32g`)
* **Hypothesis**: Expanding the heap from 16GB to 32GB would provide adequate buffer space for humongous allocations and prevent free region exhaustion.
* **Failure Outcome**: G1 recalculated region size to 16MB. While the frequency of Full GCs decreased from once every 4 minutes to once every 12 minutes, the duration of each Full GC pause doubled from 2.8 seconds to 6.4 seconds. When the 32GB heap eventually fragmented, the STW blast radius breached the Kubernetes liveness probe timeout (5 seconds), causing kubelet to terminate the pods with SIGKILL.

### Failed Attempt 2: Aggressive IHOP Lowering (`-XX:InitiatingHeapOccupancyPercent=30`)
* **Hypothesis**: Starting the concurrent marking cycle earlier at 30% heap occupancy would clear dead old objects before evacuation space ran out.
* **Failure Outcome**: Marking cycles were triggered back-to-back without idle intervals. Concurrent marking worker threads (`ConcGCThreads`) consumed 4 full CPU cores constantly, stealing compute from business worker threads and reducing message ingestion throughput by 34% without resolving the fundamental lack of contiguous free blocks.

---

## 3. Step-by-Step Resolution & Unified Diff

The production issue required a two-pronged solution: tuning the JVM G1 region geometry to avoid spurious humongous classification, and eliminating monolithic byte array allocations in the Kafka message deserializer.

### Step 1: Explicit G1 Region Sizing and IHOP Optimization
By setting `-XX:G1HeapRegionSize=32m`, the threshold for humongous classification was raised to:

$$\text{Humongous Threshold} = \frac{32\text{ MB}}{2} = 16\text{ MB}$$

Because our maximum batch ingestion payload was 6.2MB, every single batch buffer was now treated as a standard short-lived young generation object. Objects were allocated in Eden and reclaimed during minor GCs without ever touching Old Generation contiguous space.

### Step 2: Stream-based Chunking in Consumer Deserializer
Rather than materializing full batch messages into single contiguous `byte[]` arrays in memory, the consumer was refactored to decode streams incrementally using pooled Netty `ByteBufSlice`:

```diff
--- a/src/main/java/com/enterprise/telemetry/consumer/KafkaBatchPayloadDecoder.java
+++ b/src/main/java/com/enterprise/telemetry/consumer/KafkaBatchPayloadDecoder.java
@@ -14,14 +14,24 @@ import org.apache.kafka.clients.consumer.ConsumerRecord;
 import java.io.ByteArrayInputStream;
 import java.io.InputStream;
 import java.util.List;
+import io.netty.buffer.ByteBuf;
+import io.netty.buffer.PooledByteBufAllocator;
 
 public class KafkaBatchPayloadDecoder {
 
-    public TelemetryBatch decode(byte[] rawPayload) throws Exception {
-        // WRONG: Monolithic byte array allocation creates massive contiguous heap footprint
-        byte[] clonedBuffer = new byte[rawPayload.length];
-        System.arraycopy(rawPayload, 0, clonedBuffer, 0, rawPayload.length);
-        try (InputStream is = new ByteArrayInputStream(clonedBuffer)) {
-            return TelemetryBatch.parseFrom(is);
+    public TelemetryBatch decode(ConsumerRecord<String, byte[]> record) throws Exception {
+        // FIXED: Stream payload directly from pooled off-heap slice without contiguous LOB allocation
+        byte[] rawPayload = record.value();
+        ByteBuf nettyBuf = PooledByteBufAllocator.DEFAULT.directBuffer(rawPayload.length);
+        try {
+            nettyBuf.writeBytes(rawPayload);
+            try (InputStream is = new io.netty.buffer.ByteBufInputStream(nettyBuf)) {
+                return TelemetryBatch.parseFrom(is);
+            }
+        } finally {
+            nettyBuf.release();
         }
     }
 }
```

### Step 3: Production JVM Flags Update
The container startup script was updated with tuned G1GC parameters:

```diff
--- a/deploy/kubernetes/deployment.yaml
+++ b/deploy/kubernetes/deployment.yaml
@@ -28,9 +28,15 @@ spec:
           env:
             - name: JAVA_OPTS
-              value: "-Xms16g -Xmx16g -XX:+UseG1GC -XX:MaxGCPauseMillis=200"
+              value: >-
+                -Xms16g -Xmx16g
+                -XX:+UseG1GC
+                -XX:G1HeapRegionSize=32m
+                -XX:G1ReservePercent=15
+                -XX:InitiatingHeapOccupancyPercent=55
+                -XX:+ParallelRefProcEnabled
+                -XX:MaxGCPauseMillis=150
+                -Xlog:gc*,gc+phases=info:file=/var/log/jvm/gc.log:time,uptime,pid:filecount=5,filesize=100M
```

---

## 4. Verification & Telemetry Validation

Following the deployment, metrics and health checks confirmed complete elimination of Humongous allocations and `to-space exhausted` pauses.

### Cluster Verification & Pod Status Check
Inspecting the rolling deployment via `kubectl`:

```bash
$ kubectl get pods -l app=telemetry-consumer -o wide
NAME                                  READY   STATUS    RESTARTS   AGE
telemetry-consumer-7d8f99bc6c-4k2x1   1/1     Running   0          42m
telemetry-consumer-7d8f99bc6c-8m9p0   1/1     Running   0          41m
telemetry-consumer-7d8f99bc6c-v5t7q   1/1     Running   0          40m

$ kubectl exec -it telemetry-consumer-7d8f99bc6c-4k2x1 -- curl -s -f http://localhost:8080/actuator/health
{"status":"UP","components":{"diskSpace":{"status":"UP"},"kafka":{"status":"UP"},"ping":{"status":"UP"}}}
```

### Heap Inspection via `jcmd`
Verifying region size and humongous count on active pods:

```bash
$ kubectl exec -it telemetry-consumer-7d8f99bc6c-4k2x1 -- jcmd 1 GC.heap_info
1:
 garbage-first heap   total 16777216K, used 6842104K [0x0000000400000000, 0x0000000800000000)
  region size 32768K, 151 young (4947968K), 14 survivors (458752K)
  Metaspace       used 184512K, committed 191240K, reserved 1228800K
```

Notice `region size 32768K` (32MB).

### Real-Time GC Activity via `jstat`
Monitoring allocation dynamics during a synthetic load test of 45,000 msg/sec:

```bash
$ kubectl exec -it telemetry-consumer-7d8f99bc6c-4k2x1 -- jstat -gcutil 1 1000 10
  S0     S1     E      O      M     CCS    YGC     YGCT     FGC    FGCT    CGC    CGCT     GCT   
  0.00  92.14  48.21  21.34  95.42  92.10    241    4.218     0    0.000     4    0.082    4.300
  0.00  92.14  89.54  21.34  95.42  92.10    241    4.218     0    0.000     4    0.082    4.300
 88.42   0.00  32.10  21.80  95.42  92.10    242    4.234     0    0.000     4    0.082    4.316
 88.42   0.00  74.88  21.80  95.42  92.10    242    4.234     0    0.000     4    0.082    4.316
  0.00  91.08  22.14  22.10  95.42  92.10    243    4.251     0    0.000     4    0.082    4.333
```

Results over 24 hours of sustained load:
* **Full GC Count**: Dropped from 34 occurrences/day to **0**.
* **Average Young GC Pause**: Reduced to **16.8ms**.
* **P99 Service Latency**: Stabilized at **14.2ms**.
* **To-space Exhaustion Events**: **0**.

---

## 5. Production Lessons & Best Practices

1. **Calculate the Humongous Threshold Explicitly**: In G1GC, any object exceeding 50% of the region size is classified as humongous. Never rely on default auto-sizing for heaps with large streaming messages or document payloads.
2. **Beware of Old Generation Bypassing**: Humongous objects skip Eden and Survivor entirely. If your application allocates large temporary buffers frequently, Old Generation occupancy will surge spuriously, triggering endless concurrent marking and fragmentation.
3. **Set `G1ReservePercent` for Burst Safety**: Default G1 headroom is 10%. Increasing `-XX:G1ReservePercent=15` provides a dedicated emergency buffer of regions that G1 uses strictly during evacuation spikes, preventing `to-space exhausted` aborts.
4. **Prefer Off-Heap or Pooled Buffers**: For large streaming data or network deserialization, use Netty `PooledByteBufAllocator` or direct buffers to keep large transient allocations outside the JVM managed heap.
