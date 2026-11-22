---
layout: post
title: "Resolving Linux Page Cache Dirty Memory Writeback Throttling: High I/O Wait, D-State Thread Freezes, and vm.dirty_ratio Sizing"
date: 2026-12-13 10:18:25 +0900
category: Systems & Networking
tags: [Linux, Kernel, Performance, Storage, DevOps, Sysctl, Architecture, HighConcurrency]
pair_id: pair_20261213
---

Production Linux systems processing heavy write workloads can suffer sudden multi-second freezes where application processes stall in uninterruptible sleep (`D` state) and CPU I/O wait spikes above 90%. This post-mortem examines why default Linux page cache writeback ratios stall high-memory servers, dissects the `balance_dirty_pages()` throttling mechanism, and details how switching from percentage ratios to absolute byte thresholds eliminates I/O stalls.

## 1. Production Incident Summary

During a scheduled data migration and heavy write ingestion pipeline on our distributed analytics cluster (running Kafka brokers and PostgreSQL backends on bare-metal worker nodes with 128 GiB RAM), the primary database cluster began experiencing severe query latency spikes. Client applications reported connection timeouts exceeding 30,000 ms, and internal health checks failed across 12 services simultaneously.

Monitoring graphs showed that CPU utilization dropped to single digits, while system I/O wait (`%iowait`) surged from 1.2% to over 94%. Memory usage appeared stable with zero swap activity, yet critical server processes—including PostgreSQL backends and Kafka disk flush workers—entered an uninterruptible sleep state (`D` state) and stopped accepting incoming TCP connections.

Checking host health on affected bare-metal nodes via `dmesg -T` revealed kernel hung task warnings originating from disk writeback paths:

```text
[Sun Dec 13 03:42:19 2026] INFO: task postgres:28941 blocked for more than 120 seconds.
[Sun Dec 13 03:42:19 2026]       Not tainted 5.15.0-105-generic #115-Ubuntu
[Sun Dec 13 03:42:19 2026] "echo 0 > /proc/sys/kernel/hung_task_timeout_secs" disables this message.
[Sun Dec 13 03:42:19 2026] task:postgres        state:D stack:    0 pid:28941 ppid:  1042 flags:0x00004000
[Sun Dec 13 03:42:19 2026] Call Trace:
[Sun Dec 13 03:42:19 2026]  <TASK>
[Sun Dec 13 03:42:19 2026]  __schedule+0x24e/0x590
[Sun Dec 13 03:42:19 2026]  schedule+0x43/0xb0
[Sun Dec 13 03:42:19 2026]  io_schedule+0x16/0x40
[Sun Dec 13 03:42:19 2026]  balance_dirty_pages+0x7b2/0xbd0
[Sun Dec 13 03:42:19 2026]  balance_dirty_pages_ratelimited+0x2cf/0x3d0
[Sun Dec 13 03:42:19 2026]  generic_perform_write+0x16b/0x1c0
[Sun Dec 13 03:42:19 2026]  ext4_buffered_write_iter+0x6d/0x130
[Sun Dec 13 03:42:19 2026]  ext4_file_write_iter+0x58/0x740
[Sun Dec 13 03:42:19 2026]  new_sync_write+0x112/0x1a0
[Sun Dec 13 03:42:19 2026]  vfs_write+0x1d3/0x270
[Sun Dec 13 03:42:19 2026]  ksys_write+0x67/0xf0
[Sun Dec 13 03:42:19 2026]  __x64_sys_write+0x1a/0x20
[Sun Dec 13 03:42:19 2026]  do_syscall_64+0x59/0xc0
[Sun Dec 13 03:42:19 2026]  entry_SYSCALL_64_after_hwframe+0x61/0xcb
[Sun Dec 13 03:42:19 2026]  </TASK>
```

Running `vmstat 1` on the node while the write stall occurred demonstrated that blocked processes (`b` column) jumped to 48, while dirty page counters climbed uncontrollably:

```text
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 1 48      0 2194028  8412 118492048    0    0     0 312480 18420 12040  2  6  0 92  0
 0 52      0 2191884  8412 118494112    0    0     0 324100 19102 12480  1  5  0 94  0
 0 51      0 2189940  8412 118496180    0    0     0 308940 17992 11820  1  5  0 94  0
```

Inspecting `/proc/vmstat` confirmed that dirty pages occupied over 24 GiB of system memory:

```text
$ grep -E "nr_dirty|nr_writeback" /proc/vmstat
nr_dirty 6291456
nr_writeback 184920
```

### Production Environment Specifications
* **Host Operating System**: Ubuntu 22.04.4 LTS (Linux Kernel 5.15.0-105-generic)
* **Hardware Profile**: Dell PowerEdge R650, 2x Intel Xeon Gold 6338 (64 vCPUs), 128 GiB DDR4 RAM
* **Storage Configuration**: Hardware RAID-10 (4x Enterprise SATA SSDs, sustained write throughput: ~400 MB/s)
* **File System**: Ext4 mounted with `noatime,nodiratime,data=ordered`
* **Workload**: Mixed OLTP and high-volume batch ingestion (PostgreSQL 15 + Apache Kafka 3.6)

---

## 2. Common Missteps & Failed Troubleshooting Attempts

### Misstep 1: Increasing `vm.dirty_ratio` and Adding More RAM (The Flawed Fix)
The initial incorrect diagnosis assumed that the system ran out of dirty page write cache. The on-call operations engineer hypothesized that because write volume was high, the kernel needed a larger buffer to absorb traffic bursts before hitting disk limits. Consequently, they executed:

```bash
# Naive attempt: Increasing dirty ratio from 20% to 40%
sysctl -w vm.dirty_ratio=40
sysctl -w vm.dirty_background_ratio=20
```

This failed approach severely aggravated the problem. On a 128 GiB RAM node, setting `vm.dirty_ratio = 40` allowed the kernel to accumulate over 51 GiB of unwritten dirty pages. During the next ingestion spike, applications wrote at RAM speeds (several gigabytes per second) until the 51 GiB limit was reached.

Once the hard threshold was breached, the storage controller—capable of sustaining only 400 MB/s—was forced to flush 51 GiB of dirty pages to disk while `balance_dirty_pages()` completely blocked every writing thread. Instead of a 30-second freeze, the entire operating system locked up for over 125 seconds ($51,000 \text{ MB} \div 400 \text{ MB/s} \approx 127.5 \text{ seconds}$), triggering Linux hung task panic reboots and cluster quorum loss.

### Misstep 2: Misdiagnosing as JVM Garbage Collection Pauses
Because client applications recorded 30-second HTTP gateway timeouts, the application team initially assumed that JVM microservices were experiencing Stop-The-World (STW) garbage collection pauses. Engineers increased JVM heap sizes from 16 GiB to 32 GiB and tweaked G1GC pause targets (`-XX:MaxGCPauseMillis=200`). 

GC logs showed that maximum pause times never exceeded 45 ms. The latency was not originating from application runtimes; threads were simply frozen inside kernel write syscalls (`write()` and `fsync()`), unable to return to user space.

---

## 3. Root Cause Analysis: Linux Page Cache Writeback Mechanics

To understand why large-memory servers freeze under default settings, we must trace how the Linux Virtual File System (VFS) and Memory Management (MM) subsystems handle buffered writes.

![Linux Page Cache Dirty Writeback Architecture](diagram_dirty_writeback_architecture.png)

### The Page Cache Writeback Lifecycle
When an application invokes `write()` on a buffered file descriptor, the kernel does not write directly to disk. Instead:
1. **Allocation**: The kernel allocates physical pages in the Page Cache and copies data from user space.
2. **Marking Dirty**: The modified pages are marked with the `PG_dirty` flag in the page table struct. The `write()` syscall returns immediately to user space with sub-millisecond latency.
3. **Background Flush (`vm.dirty_background_ratio`)**: When the ratio of dirty memory relative to available system memory exceeds `vm.dirty_background_ratio` (default: 10%), the kernel wakes up dedicated background kernel flusher threads (`kworker/flush`). These threads asynchronously serialize dirty pages to disk in the background while application threads continue writing uninterrupted.
4. **Foreground Synchronous Throttling (`vm.dirty_ratio`)**: If application write throughput exceeds storage flush bandwidth, dirty pages continue to accumulate. When total dirty memory reaches `vm.dirty_ratio` (default: 20%), the kernel initiates emergency braking.

### The Mechanism of `balance_dirty_pages()`
Inside the kernel source (`mm/page-writeback.c`), every buffered write operation executes `balance_dirty_pages_ratelimited()`. When dirty memory crosses the `dirty_ratio` threshold:

```c
/* mm/page-writeback.c excerpt */
static void balance_dirty_pages(struct bdi_writeback *wb, unsigned long pages_dirtied)
{
    ...
    if (dirty > dirty_limit) {
        /* Force calling task to pause and flush pages synchronously */
        io_schedule_timeout(pause);
    }
}
```

The calling task is forced out of the CPU runqueue and into `TASK_UNINTERRUPTIBLE` (`D` state). The application thread is no longer allowed to execute user-space code; it is commandeered by the kernel to perform synchronous disk writeback. Because all writing threads hit this barrier simultaneously, hundreds of worker processes freeze at once, leading to cascading connection drops and service unavailability.

### The Architectural Flaw: Percentage Ratios on High-Memory Systems
Linux kernel defaults were designed decades ago when server memory was measured in megabytes:
* On a server with **1 GiB RAM**, `vm.dirty_ratio = 20` equates to **200 MiB**. Flushing 200 MiB on a 50 MB/s hard drive takes 4 seconds—a minor jitter.
* On a modern node with **128 GiB RAM**, `vm.dirty_ratio = 20` equates to **25.6 GiB**.
* On a high-spec node with **512 GiB RAM**, `vm.dirty_ratio = 20` equates to **102.4 GiB**.

No commodity disk array or cloud volume can absorb a sudden 25 GiB to 100 GiB burst of dirty data without massive queue congestion. When `balance_dirty_pages()` triggers on a large-memory host, it produces a catastrophic multi-minute I/O stall.

---

## 4. The Engineering Fix: Sizing via Absolute Byte Thresholds

The definitive architectural remedy is to decouple dirty memory writeback thresholds from system RAM capacity. Linux provides two pairs of mutually exclusive sysctl controls:
* Percentage-based: `vm.dirty_background_ratio` and `vm.dirty_ratio`
* Absolute byte-based: `vm.dirty_background_bytes` and `vm.dirty_bytes`

Setting the byte-based parameters automatically zeroes out and disables the ratio parameters.

### Sizing Formula for Absolute Dirty Bytes
To prevent application stalls, dirty memory must never exceed what the underlying storage subsystem can flush within an acceptable jitter window:

$$\text{Dirty Bytes Limit} \le \text{Sustained Disk Write Throughput} \times \text{Max Acceptable Stall Duration}$$

For our storage array with 400 MB/s sustained write throughput and a target maximum stall latency of under 1.5 seconds:
* `vm.dirty_bytes` target: $400 \text{ MB/s} \times 1.3 \text{ s} \approx 512 \text{ MiB} = 536,870,912 \text{ bytes}$
* `vm.dirty_background_bytes` target: Half of dirty bytes $\approx 256 \text{ MiB} = 268,435,456 \text{ bytes}$

Furthermore, we tune the flusher wake-up intervals:
* `vm.dirty_writeback_centisecs = 200`: Wakes the background flusher thread every 2 seconds (default is 5 seconds) to prevent large page accumulation.
* `vm.dirty_expire_centisecs = 1000`: Marks pages older than 10 seconds as expired and mandatory for flush (default is 30 seconds).

### Unified Diff Configuration
We created a dedicated system configuration file `/etc/sysctl.d/99-dirty-writeback.conf`:

```diff
--- /etc/sysctl.d/99-dirty-writeback.conf.orig
+++ /etc/sysctl.d/99-dirty-writeback.conf
@@ -1,8 +1,14 @@
-# Default Linux kernel page cache ratio configuration
-vm.dirty_background_ratio = 10
-vm.dirty_ratio = 20
-vm.dirty_expire_centisecs = 3000
-vm.dirty_writeback_centisecs = 500
+# High-throughput storage writeback tuning: absolute byte sizing
+vm.dirty_background_ratio = 0
+vm.dirty_ratio = 0
+vm.dirty_background_bytes = 268435456
+vm.dirty_bytes = 536870912
+vm.dirty_expire_centisecs = 1000
+vm.dirty_writeback_centisecs = 200
```

---

## 5. Verification & Production Runbook

To apply the configuration dynamically without rebooting production hosts, execute:

```bash
# Apply updated sysctl parameters immediately
sudo sysctl --system

# Verify active memory limits in kernel runtime
sysctl vm.dirty_bytes vm.dirty_background_bytes vm.dirty_ratio vm.dirty_background_ratio
```

Expected kernel output confirms the ratio values are deactivated (set to 0) while byte limits are enforced:

```text
vm.dirty_bytes = 536870912
vm.dirty_background_bytes = 268435456
vm.dirty_ratio = 0
vm.dirty_background_ratio = 0
```

### Stress Testing with fio
To validate behavior under sustained heavy write bursts, we ran an asynchronous write benchmark simulating unbuffered logging and database flushes:

```bash
# Run 16-thread random write workload generating 20 GiB of data
fio --name=dirty-test --ioengine=sync --rw=write --bs=64k --size=1250m --numjobs=16 --time_based --runtime=60 --group_reporting
```

During execution, we monitored kernel dirty counters and process states:

```bash
# Monitor blocked processes and dirty page writeback
vmstat 1
cat /proc/vmstat | grep -E "nr_dirty|nr_writeback"
ps -eo pid,stat,comm | grep -w D
```

### Benchmark Results Comparison

| Metric | Before Tuning (Default Ratios) | After Tuning (Absolute Bytes) | Improvement |
| :--- | :--- | :--- | :--- |
| **Max Dirty Pages in RAM** | 25.6 GiB (6,710,886 pages) | 512 MiB (131,072 pages) | **98.0% Reduction** |
| **P99 Write Latency** | 31,420 ms | 14.8 ms | **99.9% Lower** |
| **Max Uninterruptible D-state Tasks** | 52 threads | 0 threads | **Zero Kernel Stalls** |
| **Host %iowait Peak** | 94.2% | 18.4% | **Stable Throughput** |
| **Application Timeout Rate** | 14.8% during burst | 0.00% | **Eliminated Timeouts** |

By enforcing strict byte-level limits, the kernel continuously streams data to storage in small, manageable increments rather than delaying writes until massive multi-gigabyte flushes overwhelm disk controllers.
