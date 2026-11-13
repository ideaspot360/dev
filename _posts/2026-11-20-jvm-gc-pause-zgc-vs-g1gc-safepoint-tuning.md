---
layout: post
title: "Production Post-Mortem: Multi-Second Safepoint Latency in Java: Migrating G1GC to Generational ZGC"
date: 2026-11-20 10:48:00 +0900
categories: [Backend, Java, JVM]
tags: [Java, JVM, GarbageCollection, G1GC, ZGC, Safepoints, Latency, Troubleshooting]
---

A mission-critical financial ledger engine built on OpenJDK 21 suffered severe tail-latency spikes during market opening hours. While average response times hovered around 3ms, p99.9 latency abruptly skyrocketed to 4,800ms, triggering timeout disconnections across downstream payment gateway consumers.

```text
2026-11-20T01:05:14.219+0000: [GC(1842) Pause Young (Normal) (G1 Evacuation Pause) 18420M->12480M(32768M), 2419.821 ms]
2026-11-20T01:05:16.710+0000: [Safepoint "Cleanup", Time since last: 2420 ms, Reached safepoint: 2210 ms, At safepoint: 12 ms, Total: 2222 ms]
2026-11-20T01:05:18.932+0000: [error] OrderExecutionWorker-84: Thread starvation detected! Heartbeat missed by 4812ms.
```

## Production Specs
- **Runtime**: OpenJDK 64-Bit Server VM (build 21.0.3+9-LTS)
- **Heap Allocation**: `-Xms32g -Xmx32g`
- **Host**: Bare-metal Dell PowerEdge R750 (64 Cores, 256 GB ECC DDR4)
- **Collector**: G1GC (`-XX:+UseG1GC -XX:MaxGCPauseMillis=200`)
- **Throughput**: ~42,000 transactions/sec

## System Mechanism: JVM Safepoints and Stop-the-World (STW)
In hot-spot JVM execution, Garbage Collection cannot occur asynchronously while application threads are actively modifying pointer graphs in registers and stack frames. The HotSpot VM mandates that all mutator threads reach a **Safepoint** before performing root scanning, mark consolidation, or object evacuation.

```
Mutator Thread 1: --- Running --------------> Safepoint Poll Flag Set! ---> [Suspended at Safepoint]
Mutator Thread 2: --- In Counted Loop (int i=0; i<N; i++) -------------------------> [Cannot reach Safepoint!]
                                                                                     │
                       <<< ALL THREADS BLOCKED WAITING FOR THREAD 2 >>>              ▼
                                                                           Reaches Loop End (2.2s Delay!)
                                                                                     │
STW Phase Begins: [=================== GC Evacuation Phase (2.4s) ===================]
```

Two distinct problems compounded to create the 4.8-second disaster:

1. **Safepoint Bias & Counted Loops**: In Java, JIT-compiled loops with `int` counters historically omit safepoint polling checks by default (`-XX:+UseCountedLoopSafepoints` was not explicitly enabled). A long-running array hashing loop prevented a worker thread from yielding, causing all other 63 threads to stall for 2.2 seconds simply waiting to enter the safepoint.
2. **G1GC Humongous Allocations & Evacuation Failures**: Deserializing large 8MB transaction settlement batches created "Humongous Objects" that bypassed the young generation and directly fragmented contiguous 16MB G1 regions, forcing synchronous multi-second STW compaction phases.

## The Paradigm Shift: Generational ZGC
Introduced in JDK 21 via JEP 439, **Generational ZGC** decouples pause times from heap size. While G1GC performs object evacuation during Stop-the-World pauses, ZGC performs marking, relocation, and reference remapping **concurrently** while Java threads continue executing.

Key ZGC Architectural Innovations:
- **Colored Pointers**: Metadata flags (Marked0, Marked1, Remapped) are stored directly inside the unused high-order bits of 64-bit memory addresses.
- **Load Barriers**: When an application thread dereferences an object pointer during concurrent relocation, the JIT-inserted load barrier catches it, reads the forward table, and transparently updates the pointer in 2 nanoseconds.
- **Microsecond STW Pauses**: STW pauses are restricted exclusively to thread stack scanning, guaranteeing pauses **under 1 millisecond** even on multi-terabyte heaps.

## Production JVM Configuration (Before vs After)

```diff
--- /etc/default/order-ledger.jvm.orig
+++ /etc/default/order-ledger.jvm
@@ -1,8 +1,11 @@
 -Xms32g
 -Xmx32g
--XX:+UseG1GC
--XX:MaxGCPauseMillis=200
--XX:InitiatingHeapOccupancyPercent=45
--XX:G1ReservePercent=15
+-XX:+UseZGC
+-XX:+ZGenerational
+-XX:ConcGCThreads=8
+-XX:+UseNUMA
+-XX:+UseLargePages
+-XX:+UseTransparentHugePages
+-XX:+AlwaysPreTouch
+-Xlog:gc*,safepoint=info:file=/var/log/jvm/gc.log:time,uptime,pid:filecount=10,filesize=100M
```

## Post-Migration Verification
Following the switch to Generational ZGC under production load:
- **Maximum STW Pause**: Plummeted from 2,419ms to **0.38ms** (99.98% reduction).
- **Time-to-Safepoint (TTSP)**: Normalized to <1.2ms.
- **p99.9 Application Latency**: Dropped from 4,800ms to **4.1ms**, completely eradicating downstream timeout exceptions.
