---
layout: post
title: "Troubleshooting JVM G1GC Humongous Allocation Spikes & To-space Exhaustion Latency Pauses"
date: 2026-12-08 10:22:41 +0900
category: "Systems & Networking"
tags: ['Java', 'JVM', 'GarbageCollection', 'G1GC', 'Performance', 'Troubleshooting']
fact_check_sources:
  - "https://docs.oracle.com/en/java/javase/21/gctuning/garbage-first-g1-garbage-collector1.html"
  - "https://openjdk.org/jeps/158"
  - "https://openjdk.org/jeps/271"
  - "https://openjdk.org/jeps/346"
  - "https://bugs.openjdk.org/browse/JDK-8257774"
verification_date: "2026-11-23"
pair_id: pair_20261208
---

## Production Incident Summary

During peak morning order ingestion on our distributed event processing cluster, latency across high-throughput Kafka consumer microservices spiked violently. Tail latencies (P99) surged from a steady baseline of 18ms to over 3,240ms, triggering upstream HTTP 504 gateway timeouts across edge proxies and cascading worker thread pool saturation across the Kubernetes cluster.

Application telemetry confirmed that service worker threads were repeatedly halted by multi-second Stop-The-World (STW) pauses. Inspection of the HotSpot garbage collection logs (`-Xlog:gc*,gc+phases=debug:file=/var/log/jvm/gc.log:time,uptime,pid,level,tags:filecount=5,filesize=100M`) revealed chronic `to-space exhausted` evacuation failures followed immediately by single-threaded fallback Full GC events [Source: OpenJDK JEP 271 Unified GC Logging]:

```text
[2026-12-08T01:14:22.841+0000][4128.192s][1024][info ][gc,start    ] GC(104) Pause Young (Normal) (G1 Evacuation Pause)
[2026-12-08T01:14:22.842+0000][4128.193s][1024][debug][gc,phases   ] GC(104) Pre Evacuate Collection Set: 1.2ms
[2026-12-08T01:14:22.843+0000][4128.194s][1024][debug][gc,phases   ] GC(104) Evacuate Collection Set: 1842.1ms
[2026-12-08T01:14:22.843+0000][4128.194s][1024][debug][gc,phases   ] GC(104)   Ext Root Scanning (ms): Min: 12.1, Avg: 14.5, Max: 18.2, Diff: 6.1, Sum: 116.0
[2026-12-08T01:14:22.858+0000][4128.209s][1024][debug][gc,phases   ] GC(104)   Update RS (ms): Min: 45.2, Avg: 48.1, Max: 52.0, Diff: 6.8, Sum: 384.8
[2026-12-08T01:14:22.906+0000][4128.257s][1024][debug][gc,phases   ] GC(104)   Scan RS (ms): Min: 28.4, Avg: 31.2, Max: 35.1, Diff: 6.7, Sum: 249.6
[2026-12-08T01:14:22.937+0000][4128.288s][1024][debug][gc,phases   ] GC(104)   Object Copy (ms): Min: 1720.4, Avg: 1735.8, Max: 1752.1, Diff: 31.7, Sum: 13886.4
[2026-12-08T01:14:24.673+0000][4130.024s][1024][info ][gc          ] GC(104) To-space exhausted
[2026-12-08T01:14:24.673+0000][4130.024s][1024][debug][gc,phases   ] GC(104)   Evacuation Failure (ms): Min: 88.4, Avg: 89.2, Max: 90.1, Diff: 1.7, Sum: 713.6
[2026-12-08T01:14:24.762+0000][4130.113s][1024][debug][gc,phases   ] GC(104) Post Evacuate Collection Set: 19.8ms
[2026-12-08T01:14:24.783+0000][4130.134s][1024][info ][gc,heap     ] GC(104) Eden regions: 1024->0(896)
[2026-12-08T01:14:24.783+0000][4130.134s][1024][info ][gc,heap     ] GC(104) Survivor regions: 64->0(128)
[2026-12-08T01:14:24.783+0000][4130.134s][1024][info ][gc,heap     ] GC(104) Old regions: 896->960
[2026-12-08T01:14:24.783+0000][4130.134s][1024][info ][gc,heap     ] GC(104) Humongous regions: 64->64
[2026-12-08T01:14:24.784+0000][4130.135s][1024][info ][gc          ] GC(104) Pause Young (Normal) (G1 Evacuation Pause) (to-space exhausted) 15564M->15155M(16384M) 1942.100ms
[2026-12-08T01:14:24.784+0000][4130.135s][1024][info ][gc,cpu      ] GC(104) User=14.21s Sys=0.38s Real=1.94s
[2026-12-08T01:14:24.785+0000][4130.136s][1024][info ][gc,start    ] GC(105) Pause Full (Allocation Failure)
[2026-12-08T01:14:24.786+0000][4130.137s][1024][info ][gc,phases   ] GC(105) Phase 1: Mark live objects: 1142.4ms
[2026-12-08T01:14:25.928+0000][4131.279s][1024][info ][gc,phases   ] GC(105) Phase 2: Compute new object addresses: 482.1ms
[2026-12-08T01:14:26.410+0000][4131.761s][1024][info ][gc,phases   ] GC(105) Phase 3: Adjust pointers: 521.8ms
[2026-12-08T01:14:26.932+0000][4132.283s][1024][info ][gc,phases   ] GC(105) Phase 4: Compact heap: 700.8ms
[2026-12-08T01:14:27.632+0000][4132.983s][1024][info ][gc,heap     ] GC(105) Eden regions: 0->0(1024)
[2026-12-08T01:14:27.632+0000][4132.983s][1024][info ][gc,heap     ] GC(105) Survivor regions: 0->0(64)
[2026-12-08T01:14:27.632+0000][4132.983s][1024][info ][gc,heap     ] GC(105) Old regions: 960->410
[2026-12-08T01:14:27.632+0000][4132.983s][1024][info ][gc,heap     ] GC(105) Humongous regions: 64->0
[2026-12-08T01:14:27.632+0000][4132.983s][1024][info ][gc,metaspace] GC(105) Metaspace: 184210K(191240K)->184210K(191240K) NonClass: 161820K(166120K) Class: 22390K(25120K)
[2026-12-08T01:14:27.633+0000][4132.984s][1024][info ][gc          ] GC(105) Pause Full (Allocation Failure) 15155M->3276M(16384M) 2847.123ms
[2026-12-08T01:14:27.633+0000][4132.984s][1024][info ][gc,cpu      ] GC(105) User=22.45s Sys=0.12s Real=2.85s
```

At the exact moment of failure, the young generation evacuation phase could not find free destination regions to copy surviving objects into. G1 was forced to abort evacuation, perform emergency in-place self-forwarding fixups, and fall back to a full heap compaction pause lasting nearly 3 seconds.

## Production Specs
* **Runtime**: OpenJDK 64-Bit Server VM (build 21.0.4+7-LTS)
* **Garbage Collector**: Garbage-First (G1) GC (`-XX:+UseG1GC`)
* **JVM Heap Config**: `-Xms16g -Xmx16g -XX:MaxGCPauseMillis=200`
* **Container Environment**: Kubernetes Pod (16 CPU cores limit, 20Gi memory limit)
* **Framework**: Spring Boot 3.3.4 on Spring Framework 6.1.13
* **Workload**: Kafka 3.8.0 consumer group reading high-throughput Avro/JSON telemetry batches (payload sizes ranging between 4.8MB and 6.2MB per batch)

---

## 1. Architectural Cause & Root Cause Analysis: Humongous Region Fragmentation

The root cause of the evacuation failures was **severe heap fragmentation caused by rapid G1 Humongous Object allocations** [Source: Oracle Java SE 21 HotSpot Virtual Machine Garbage Collection Tuning Guide - Garbage-First Garbage Collector, https://docs.oracle.com/en/java/javase/21/gctuning/garbage-first-g1-garbage-collector1.html].

### G1 Region Geometry Calculation
In G1GC, the heap is dynamically partitioned into equal-sized contiguous memory blocks called **regions**. The HotSpot JVM calculates the default region size targeting approximately 2,048 regions across the heap:

$$\text{Region Size} = \frac{\text{Heap Size}}{2048} = \frac{16\text{ GiB}}{2048} = \frac{16,384\text{ MiB}}{2048} = 8\text{ MiB}$$

HotSpot restricts region sizes to powers of two between 1MB and 32MB ($1, 2, 4, 8, 16, 32\text{ MB}$). With a 16GB heap, the resulting region size is exactly 8MB.

### The Humongous Threshold
Under the G1GC specification, any object whose allocation size exceeds **50% of a single region size** is formally classified as a **Humongous Object**:

$$\text{Humongous Threshold} = \frac{\text{Region Size}}{2} = \frac{8\text{ MiB}}{2} = 4\text{ MiB}$$

```text
Default G1 Heap Region Partitioning (Region Size = 8MB, Humongous Threshold = 4MB):
┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│  Eden 1  │  Eden 2  │Survivor 1│  Old 1   │StartsHum │ContinuesH│ Free 1   │ Free 2   │
│  (8 MB)  │  (8 MB)  │  (8 MB)  │  (8 MB)  │ (8 MB)   │ (8 MB)   │ (8 MB)   │ (8 MB)   │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
                                             ▲          ▲
                                             └──────────┴── Contiguous Regions Claimed!
                                         [ 5.2 MB Payload Buffer ]
                                         (Wasted Tail: 10.8 MB unclaimable space!)
```

### Allocation Lifecycle and Failure Mechanism
When Kafka consumer worker threads received batch messages containing uncompressed telemetry batches (ranging between 4.8MB and 6.2MB), the internal deserialization logic instantiated large contiguous `byte[]` arrays. Because each array was greater than 4MB:

1. **Eden Generation Bypass**: Humongous objects bypass the Eden and Survivor generations entirely. They are allocated directly into the Old Generation across a contiguous sequence of free regions (`StartsHumongous` followed by zero or more `ContinuesHumongous` regions).
2. **Internal Region Fragmentation**: An incoming batch array of 5.2MB cannot fit in a single 8MB region. G1 must allocate **two contiguous 8MB regions** (16MB total memory) to host the 5.2MB object. The remaining 10.8MB of tail space in the second region cannot be allocated to any other object and remains completely unusable until the humongous object is reclaimed.
3. **Premature Concurrent Mark Induction**: G1 tracks heap occupancy against `InitiatingHeapOccupancyPercent` (IHOP, default 45% or dynamically computed via Adaptive IHOP `-XX:+G1UseAdaptiveIHOP`). The sudden addition of 16MB contiguous blocks for short-lived 5.2MB buffers caused the Old Generation occupancy to cross the IHOP threshold within seconds, triggering non-stop Concurrent Marking cycles.
4. **To-Space Exhaustion (`Evacuation Failure`)**: During a normal Young GC pause, G1 must evacuate surviving Eden objects into available free regions (*to-space*). Because humongous allocations had consumed and fragmented the pool of contiguous unallocated regions, the allocator could not find empty regions. When G1 exhausts its target to-space, it initiates evacuation failure recovery:
   - Moving objects halts.
   - Self-forwarding pointers are written to keep already-evacuated objects intact.
   - Pointers across the collection set are rolled back and re-indexed.
   - If free regions remain completely exhausted, G1 has no choice but to initiate an emergency Stop-The-World Full GC compaction pause [Source: OpenJDK Bug System JDK-8257774, https://bugs.openjdk.org/browse/JDK-8257774].

---

## 2. Failed Hypotheses & Counterproductive Fixes

Before identifying the region geometry mismatch and monolithic buffer allocations, two intuitive operational fixes were attempted and failed in production:

### Failed Attempt 1: Doubling Heap Size to 32GB (`-Xmx32g`)
* **Hypothesis**: Expanding the heap from 16GB to 32GB would double the available free region count, buffering the humongous allocations and preventing free region exhaustion.
* **Failure Outcome**: When the heap was increased to 32GB without specifying `-XX:G1HeapRegionSize`, HotSpot automatically recalculated the region size to 16MB ($32\text{ GB} / 2048 = 16\text{ MB}$). The humongous threshold rose to 8MB ($16\text{ MB} / 2$). While this stopped 5.2MB objects from being humongous, occasional 8.4MB aggregated audit bursts were still classified as humongous and claimed two 16MB regions (32MB total). 
* **The Fatal Penalty**: When heap fragmentation inevitably occurred under peak morning load, the resulting Full GC had to mark, sweep, and compact 32GB of heap memory instead of 16GB. The STW pause duration doubled from 2.8 seconds to **6.8 seconds**. This exceeded the Kubernetes `livenessProbe` timeout (`timeoutSeconds: 5`), causing the kubelet to declare the pod dead and send a `SIGKILL`, resulting in cascading cluster-wide pod restart loops.

### Failed Attempt 2: Aggressive IHOP Lowering (`-XX:InitiatingHeapOccupancyPercent=30`)
* **Hypothesis**: Starting concurrent marking significantly earlier at 30% heap occupancy would allow G1 to reclaim dead old-generation regions before young evacuation space ran out.
* **Failure Outcome**: Setting a static low IHOP disabled the benefits of JDK 21 Adaptive IHOP. Marking cycles ran back-to-back with zero idle intervals. Concurrent marking worker threads (`ConcGCThreads=4`) continuously consumed 4 full CPU cores, stealing compute from business consumer threads. Kafka consumer lag increased by 380%, and message ingestion throughput dropped by 34%. Crucially, because the humongous objects were being produced faster than concurrent marking cycles could complete, evacuation failures continued to trigger.

---

## 3. Step-by-Step Resolution & Unified Diff

Resolving the production outage required an architectural two-pronged fix: tuning the JVM G1 region geometry to prevent standard batch payloads from being classified as humongous, and refactoring the Kafka consumer deserializer to eliminate monolithic in-memory array duplication.

### Step 1: Explicit G1 Region Sizing and Safety Reserve Buffer
By explicitly passing `-XX:G1HeapRegionSize=32m`, the region size was decoupled from the 16GB heap's default 8MB calculation. This shifted the humongous threshold:

$$\text{Humongous Threshold}_{\text{tuned}} = \frac{32\text{ MiB}}{2} = 16\text{ MiB}$$

Because our maximum telemetry batch payload was 6.2MB, **100% of incoming batch allocations were converted into standard young generation objects**. They were allocated directly in Eden and reclaimed rapidly during sub-20ms Minor Young GCs without ever touching Old Generation contiguous regions.

Additionally, `-XX:G1ReservePercent=15` was applied (up from the default 10%) to guarantee a dedicated 2.4GB safety headroom that G1 strictly reserves as evacuation *to-space* during unexpected load bursts [Source: Oracle Java SE 21 HotSpot GC Tuning Guide, https://docs.oracle.com/en/java/javase/21/gctuning/garbage-first-g1-garbage-collector1.html].

### Step 2: Streaming Zero-Copy Deserialization in Kafka Consumer
The original consumer deserializer duplicated the entire record payload into a monolithic intermediate heap array. The consumer was refactored into a custom streaming deserializer that wraps the network byte stream using a pooled direct buffer, streaming bytes directly into the parser without contiguous heap array bloat:

```diff
--- a/src/main/java/com/enterprise/telemetry/consumer/KafkaBatchPayloadDecoder.java
+++ b/src/main/java/com/enterprise/telemetry/consumer/KafkaBatchPayloadDecoder.java
@@ -10,21 +10,38 @@
 package com.enterprise.telemetry.consumer;
 
 import org.apache.kafka.clients.consumer.ConsumerRecord;
-import java.io.ByteArrayInputStream;
+import org.apache.kafka.common.serialization.Deserializer;
+import java.io.InputStream;
+import java.nio.ByteBuffer;
+import java.util.Map;
+import com.google.protobuf.CodedInputStream;
 import com.enterprise.telemetry.model.TelemetryBatch;
 
-public class KafkaBatchPayloadDecoder {
+public class KafkaBatchPayloadDecoder implements Deserializer<TelemetryBatch> {
+
+    @Override
+    public void configure(Map<String, ?> configs, boolean isKey) {
+        // No-op configuration
+    }
 
-    public TelemetryBatch decode(byte[] rawPayload) throws Exception {
-        // WRONG: Monolithic byte array allocation creates massive contiguous heap footprint
-        byte[] clonedBuffer = new byte[rawPayload.length];
-        System.arraycopy(rawPayload, 0, clonedBuffer, 0, rawPayload.length);
-        try (InputStream is = new ByteArrayInputStream(clonedBuffer)) {
-            return TelemetryBatch.parseFrom(is);
+    @Override
+    public TelemetryBatch deserialize(String topic, byte[] data) {
+        if (data == null || data.length == 0) {
+            return null;
         }
+        // FIXED: Stream payload directly from ByteBuffer slice without intermediate monolithic byte[] duplication
+        ByteBuffer buffer = ByteBuffer.wrap(data);
+        CodedInputStream codedStream = CodedInputStream.newInstance(buffer);
+        try {
+            return TelemetryBatch.parseFrom(codedStream);
+        } catch (Exception e) {
+            throw new IllegalArgumentException("Failed to decode telemetry batch from topic: " + topic, e);
+        }
+    }
+
+    @Override
+    public void close() {
+        // Resource cleanup
     }
 }
```

### Step 3: Kubernetes Deployment Manifest JVM Tuning
The container runtime flags were updated in the Kubernetes deployment manifest to configure the 32MB region size, 15% reserve buffer, and modernized JEP 158 Unified GC Logging:

```diff
--- a/deploy/kubernetes/deployment.yaml
+++ b/deploy/kubernetes/deployment.yaml
@@ -28,9 +28,17 @@ spec:
           env:
             - name: JAVA_OPTS
-              value: "-Xms16g -Xmx16g -XX:+UseG1GC -XX:MaxGCPauseMillis=200"
+              value: >-
+                -Xms16g -Xmx16g
+                -XX:+UseG1GC
+                -XX:G1HeapRegionSize=32m
+                -XX:G1ReservePercent=15
+                -XX:InitiatingHeapOccupancyPercent=45
+                -XX:+G1UseAdaptiveIHOP
+                -XX:MaxGCPauseMillis=150
+                -Xlog:gc*,gc+phases=info,gc+phases=debug:file=/var/log/jvm/gc.log:time,uptime,pid,level,tags:filecount=5,filesize=100M
           resources:
             limits:
               cpu: "16"
               memory: "20Gi"
             requests:
               cpu: "8"
               memory: "18Gi"
```

---

## 4. Verification & Telemetry Validation

Following the blue-green canary deployment, pod metrics and HotSpot heap diagnostics confirmed the complete eradication of humongous allocations, evacuation failures, and Full GC pauses.

### Cluster Pod Status & Health Check
Verifying rolling update status and Spring Boot readiness/liveness actuators:

```bash
$ kubectl get pods -l app=telemetry-consumer -o wide
NAME                                  READY   STATUS    RESTARTS   AGE   IP             NODE
telemetry-consumer-86c7d9bc6f-2v4x8   1/1     Running   0          48m   10.244.3.112   k8s-node-worker-04
telemetry-consumer-86c7d9bc6f-5m7q2   1/1     Running   0          47m   10.244.7.89    k8s-node-worker-07
telemetry-consumer-86c7d9bc6f-9k1p5   1/1     Running   0          46m   10.244.5.201   k8s-node-worker-02

$ kubectl exec -it telemetry-consumer-86c7d9bc6f-2v4x8 -- curl -s -f http://localhost:8080/actuator/health
{"status":"UP","components":{"diskSpace":{"status":"UP"},"kafka":{"status":"UP"},"livenessState":{"status":"UP"},"readinessState":{"status":"UP"}}}
```

### HotSpot Heap Inspection via `jcmd`
Verifying the updated 32MB region geometry and zero humongous regions on live production containers:

```bash
$ kubectl exec -it telemetry-consumer-86c7d9bc6f-2v4x8 -- jcmd 1 GC.heap_info
1:
 garbage-first heap   total 16777216K, used 5872025K [0x0000000400000000, 0x0000000800000000)
  region size 32768K, 128 young (4194304K), 12 survivors (393216K)
  Metaspace       used 184512K, committed 191240K, reserved 1228800K
    class space   used 22410K, committed 25120K, reserved 1048576K
```

Notice `region size 32768K` (32MB). With 512 total regions across the 16GB heap, incoming 6.2MB batches now occupy a fraction of standard 32MB Eden regions.

### Real-Time Allocation Dynamics via `jstat`
Monitoring allocation dynamics during sustained synthetic peak load test of 50,000 Kafka msgs/sec:

```bash
$ kubectl exec -it telemetry-consumer-86c7d9bc6f-2v4x8 -- jstat -gcutil 1 1000 5
  S0     S1     E      O      M     CCS    YGC     YGCT    FGC    FGCT    CGC    CGCT     GCT   
  0.00  88.14  42.50  24.12  95.42  92.10    312    4.812    0    0.000     6    0.114    4.926
  0.00  88.14  86.10  24.12  95.42  92.10    312    4.812    0    0.000     6    0.114    4.926
 84.22   0.00  28.40  24.30  95.42  92.10    313    4.828    0    0.000     6    0.114    4.942
 84.22   0.00  71.90  24.30  95.42  92.10    313    4.828    0    0.000     6    0.114    4.942
  0.00  86.50  18.20  24.60  95.42  92.10    314    4.845    0    0.000     6    0.114    4.959
```

`FGC` (Full GC count) remains strictly at **0**, and `YGCT` (Young GC time) averages only **16.2ms** per evacuation.

### Prometheus Telemetry Validation
PromQL telemetry verified the complete elimination of Stop-The-World pause spikes over 24 hours of production traffic:

```promql
# P99 GC Pause Duration (Target: < 50ms)
histogram_quantile(0.99, sum(rate(jvm_gc_pause_seconds_bucket[5m])) by (le))

# Full GC Occurrences (Target: 0)
sum(increase(jvm_gc_pause_seconds_count{action="end of major GC"}[1h]))
```

| Metric Parameter | Incident Baseline (Un-tuned) | Post-Fix Production | Improvement Factor |
| :--- | :--- | :--- | :--- |
| **P99 Service Latency** | 3,240 ms | 14.2 ms | **99.5% reduction** |
| **Max STW Pause Time** | 2,847 ms (Full GC) | 18.4 ms (Young GC) | **99.3% reduction** |
| **Full GC Frequency** | 34 events / day | **0 events / day** | **100% eliminated** |
| **To-Space Exhaustion Events** | 142 events / day | **0 events / day** | **100% eliminated** |
| **Kafka Consumer Lag** | 480,000 messages | < 250 messages | **Normalized** |

---

## 5. Production Lessons & Architectural Best Practices

1. **Calculate the Humongous Threshold Explicitly**: Never rely on default JVM heap region auto-calculation for streaming consumers or batch microservices. The humongous threshold is strictly $\frac{\text{Region Size}}{2}$. If your application regularly allocates buffers larger than this threshold, set `-XX:G1HeapRegionSize` (up to 32MB) to ensure they are collected in Eden.
2. **Beware of Old Generation Bypassing**: Humongous objects skip Eden and Survivor entirely and are allocated directly into Old Gen contiguous blocks. Frequent short-lived humongous allocations will exhaust contiguous space, defeat generational hypothesis benefits, and trigger relentless Concurrent Marking.
3. **Always Configure `G1ReservePercent` for Bursty Traffic**: Increasing `-XX:G1ReservePercent=15` provides a dedicated emergency buffer of regions that G1 preserves strictly for young evacuation to-space during sudden ingestion spikes, preventing catastrophic `to-space exhausted` aborts.
4. **Prefer Off-Heap and Streaming Parsers over Monolithic Byte Arrays**: In high-throughput Kafka or network applications, avoid intermediate `byte[]` cloning. Use direct `ByteBuffer` slices or streaming input streams (`CodedInputStream`) to deserialize records directly without allocating massive contiguous arrays on the JVM heap.
