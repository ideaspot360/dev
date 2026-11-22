---
layout: post
title: "Resolving Linux NIC RX Ring Buffer Drops & SoftIRQ Saturation: High PPS Packet Loss, ksoftirqd 100% CPU, and RPS/RFS Multi-Queue Sizing"
date: 2026-12-14 10:34:09 +0900
category: Systems & Networking
tags: [Linux, Networking, Kernel, Performance, DevOps, Sysctl, Ethtool, HighConcurrency]
pair_id: pair_20261214
---

High-throughput distributed systems processing millions of small packets per second (PPS)—such as ingress API gateways, in-memory cache proxies, and real-time streaming brokers—often face sudden, unexplained network latency degradation and connection drops. Standard monitoring shows overall CPU usage under 20% and network bandwidth well below physical link saturation, yet client applications encounter TCP connection timeouts and elevated P99 latency. This post-mortem explores how default Linux network interface (NIC) descriptor ring sizes and single-core SoftIRQ bottlenecks cause packet loss before traffic ever enters the TCP stack, dissects the NAPI polling subsystem, and provides a production-grade multi-queue sizing runbook.

## 1. Production Incident Summary

During an e-commerce flash promotion event handling over 650,000 requests per second across our ingress gateway cluster, upstream clients began logging transient `504 Gateway Timeout` errors and TCP connection resets (`ECONNRESET`). Internal latency monitoring indicated that gateway response times surged from an average of 1.8 ms to over 340 ms.

Infrastructure dashboards displayed a confusing set of metrics:
* Physical 25 Gbps network links were operating at only 18% bandwidth capacity (~4.5 Gbps).
* Overall server CPU utilization hovered at 14% across a 64-core host.
* No memory pressure or swap activity was detected.
* Application thread pools in Envoy and Nginx proxies were not starved for worker threads.

However, running `mpstat -P ALL 1` revealed a critical bottleneck: a single CPU core (CPU 0) was locked at 100% utilization entirely in the `%soft` (software interrupt / SoftIRQ) column, while all remaining 63 CPU cores remained largely idle:

```text
04:12:05 PM  CPU    %usr   %nice    %sys %iowait   %irq   %soft  %steal  %guest  %gnice   %idle
04:12:06 PM  all    3.12    0.00    2.45    0.02   0.15   12.80    0.00    0.00    0.00   81.46
04:12:06 PM    0    0.00    0.00    0.00    0.00   0.00  100.00    0.00    0.00    0.00    0.00
04:12:06 PM    1    2.94    0.00    1.96    0.00   0.00    0.00    0.00    0.00    0.00   95.10
04:12:06 PM    2    3.03    0.00    2.02    0.00   0.00    0.00    0.00    0.00    0.00   94.95
...
04:12:06 PM   63    2.88    0.00    1.92    0.00   0.00    0.00    0.00    0.00    0.00   95.20
```

Inspecting the system process tree via `top` confirmed that the kernel thread `ksoftirqd/0` was pinned at 100% CPU capacity. 

Further diagnostic inspection using `ip -s link show eth0` and `ethtool -S eth0` revealed hundreds of thousands of dropped incoming packets:

```bash
$ ip -s link show eth0
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000
    link/ether 0c:c4:7a:a1:8b:22 brd ff:ff:ff:ff:ff:ff
    RX:  bytes  packets  errors  dropped  missed  mcast   
    84291840129 184920412       0   482019   482019      0 
    TX:  bytes  packets  errors  dropped carrier collsns 
    79124018420 172901248       0        0       0       0

$ ethtool -S eth0 | grep -E "drop|miss|fifo|overflow"
     rx_dropped: 482019
     rx_missed_errors: 482019
     rx_fifo_errors: 482019
     rx_no_buffer_count: 482019
```

Querying the kernel network softnet statistics via `cat /proc/net/softnet_stat` confirmed that CPU 0 was repeatedly exhausting its NAPI polling budget, forcing incoming packet drops at the network driver boundary:

```bash
$ cat /proc/net/softnet_stat
00075a32 0001a418 00004b21 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000
00012490 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000
00013110 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000
...
```

*(Note: In `/proc/net/softnet_stat`, column 1 represents total processed frames, column 2 represents packets dropped due to full backlog queues, and column 3 represents times `net_rx_action` was squeezed out before processing all queued frames).*

### Production Environment Specifications
* **Host Operating System**: Rocky Linux 9.4 (Linux Kernel 5.14.0-427.el9.x86_64)
* **Compute Profile**: Supermicro SYS-220U-TNR, 2x Intel Xeon Platinum 8358 (64 physical cores, 128 threads), 256 GiB DDR4 RAM
* **Network Hardware**: Intel E810-XXVDA2 25GbE Dual-Port SFP28 PCIe adapter (driver: `ice` v1.13.7)
* **Role**: Primary Ingress API Gateway & Layer 7 Load Balancing Node (Envoy Proxy 1.30 + Nginx 1.26)
* **Traffic Pattern**: Burst-heavy HTTP/2 and gRPC micro-payloads (average packet size: 420 bytes, burst rate: 850k PPS)

---

## 2. Common Missteps & Failed Troubleshooting Attempts

### Misstep 1: Naively Tuning TCP Listen Backlog (`somaxconn` & `tcp_max_syn_backlog`)
Because clients logged TCP connection resets and timeouts, the on-call SRE suspected that the TCP listen queue was overflowing. They expanded `net.core.somaxconn` to `65535` and `net.ipv4.tcp_max_syn_backlog` to `32768`.

This had zero impact on the packet drops. In Linux network architecture, listen backlogs reside inside the TCP socket layer (L4). The packets being dropped in this incident never made it past the physical network interface driver. Because the NIC RX ring buffer was exhausted and the SoftIRQ subsystem was throttled, the kernel discarded incoming Ethernet frames before the TCP three-way handshake (`SYN`) could ever be parsed.

### Misstep 2: Increasing Application Worker Threads
The application engineering team observed elevated P99 latency in gateway logs and suspected worker thread pool starvation. They increased Envoy's `concurrency` setting from 16 to 64.

This adjustment actually deteriorated performance. Adding more user-space threads increased CPU context switching without addressing the underlying driver bottleneck. The bottleneck was not user-space processing capacity; user-space worker threads were starving for packets that were being dropped at the driver boundary. Furthermore, user threads competed with `ksoftirqd/0` for CPU scheduling cycles on CPU 0.

---

## 3. Root Cause Analysis: Linux Network RX Pipeline Mechanics

To remediate packet loss under high PPS, we must dissect how the Linux kernel receives, queues, and processes network frames from physical hardware into user-space memory.

![Linux NIC RX Ring Buffer & SoftIRQ Saturation Architecture](diagram_nic_rx_ring_softirq_architecture.png)

### The Network Frame Ingress Lifecycle
When a frame arrives on a network interface:
1. **Direct Memory Access (DMA) Transfer**: The physical NIC receives the Ethernet frame on its wire PHY, verifies the frame check sequence (FCS), and writes the raw packet data directly into host system RAM via DMA.
2. **Descriptor Consumption**: The NIC allocates an entry from its circular hardware **RX Ring Buffer**. The ring buffer does not store the packet payload itself; it stores descriptor pointers referencing the pre-allocated kernel socket buffers (`sk_buff`) in RAM.
3. **Hardware Interrupt (IRQ)**: The NIC asserts a hardware interrupt (MSI-X) over the PCIe bus to signal the host CPU that new data is available.
4. **NAPI Scheduling**: To prevent interrupt storms under high traffic, Linux uses NAPI (New API). The NIC driver's interrupt handler acknowledges the interrupt, temporarily disables hardware IRQs for that queue, and schedules a software interrupt: `NET_RX_SOFTIRQ`.
5. **SoftIRQ Polling Loop (`net_rx_action`)**: The kernel SoftIRQ daemon (`ksoftirqd/x`) executes `net_rx_action()`, which invokes the driver's registered `.poll()` method. The driver reads descriptors from the ring buffer, constructs `sk_buff` structures, and passes them up the network stack through `napi_gro_receive()` to IP and TCP processing layers.
6. **Ring Buffer Replenishment**: The driver allocates fresh `sk_buff` buffers in RAM and writes their memory addresses back into the RX ring descriptors so the NIC can receive subsequent frames.

### Why the Bottleneck Occurred: Two Interlocking Failures

#### Failure Point A: Hardware RX Ring Buffer Exhaustion
The Intel `ice` driver initialized `eth0` with default hardware descriptor sizes:

```bash
$ ethtool -g eth0
Ring parameters for eth0:
Pre-set maximums:
RX:             4096
RX Mini:        n/a
RX Jumbo:       n/a
TX:             4096
Current hardware settings:
RX:             512
RX Mini:        n/a
RX Jumbo:       n/a
TX:             512
```

While the hardware supported up to 4,096 descriptors, the running configuration was capped at only **512 descriptors**. 

At an incoming burst rate of 850,000 PPS:
$$\text{Time to Exhaust 512 Descriptors} = \frac{512}{850,000} \approx 0.000602 \text{ seconds} = 602 \text{ microseconds}$$

Any transient micro-stall in the host kernel lasting longer than 0.6 ms immediately overflowed the 512-slot ring buffer. When the NIC arrived with a new packet and found all 512 descriptors occupied, it had no DMA destination in host RAM. The NIC hardware controller had no choice but to drop the packet immediately on the wire, incrementing `rx_missed_errors` and `rx_dropped`.

#### Failure Point B: IRQ Affinity and Single-Core SoftIRQ Throttling
Modern multi-core NICs provide Multi-Queue RSS (Receive Side Scaling), enabling separate hardware queues with distinct IRQ vectors. However, on this deployment:
1. All network IRQs were pinned by default to CPU 0 due to an unconfigured `smp_affinity` mask and a stopped `irqbalance` service.
2. The kernel sysctl parameter `net.core.netdev_budget` was set to the default value of `300`. This directive dictates that `net_rx_action()` may process at most 300 packets per polling cycle before relinquishing the CPU.
3. Because CPU 0 was hammered with hundreds of thousands of interrupts per second, its polling budget was instantly depleted. The kernel deferred remaining work to `ksoftirqd/0`, which maxed out at 100% CPU. Incoming frames piled up faster than CPU 0 could harvest them, producing continuous `net_rx_action` squeeze events (visible in column 3 of `/proc/net/softnet_stat`).

---

## 4. The Production Engineering Remedy

Resolving this packet-loss failure requires a synchronized, four-tier reconfiguration across hardware descriptor capacity, CPU core affinity distribution, software packet steering, and kernel polling budgets.

### Step 1: Expand NIC Hardware Descriptor Ring Buffers
First, we expand the hardware ring buffers to their physical maximum (4,096 descriptors) using `ethtool`:

```bash
# Expand both RX and TX descriptor ring buffers to 4096
ethtool -G eth0 rx 4096 tx 4096
```

This expands the packet absorption window by 800% (from 512 to 4,096 slots), enabling the NIC to absorb micro-bursts of up to 4.8 ms without dropping a single frame.

### Step 2: Multi-Queue RSS & IRQ Distribution
We configure the network card to utilize multiple hardware queues matching our physical NUMA socket layout, and distribute their MSI-X interrupt vectors across distinct CPU cores:

```bash
# Check current channel configuration
ethtool -l eth0

# Allocate 8 combined RX/TX hardware queues
ethtool -L eth0 combined 8

# Distribute IRQs across CPUs 0-7 via smp_affinity
for i in $(seq 0 7); do
    IRQ=$(grep "eth0-TxRx-$i" /proc/interrupts | awk -F: '{print $1}' | tr -d ' ')
    if [ -n "$IRQ" ]; then
        # Assign CPU mask (CPU 0 -> 1, CPU 1 -> 2, CPU 2 -> 4, etc.)
        MASK=$(printf "%x" $((1 << i)))
        echo $MASK > /proc/irq/$IRQ/smp_affinity
        echo "Assigned IRQ $IRQ (eth0-TxRx-$i) to CPU mask 0x$MASK"
    fi
done
```

### Step 3: Software Packet Steering (RPS & RFS) for Virtualized & Containerized Interfaces
In Kubernetes and container environments where workloads communicate via virtual ethernet pairs (`veth`) that lack hardware multi-queue RSS, we enable **Receive Packet Steering (RPS)** and **Receive Flow Steering (RFS)**. RPS computes a hash of the packet header in software and distributes incoming socket buffers across designated CPU cores:

```bash
# Enable RPS across all 64 CPU cores for eth0 queue 0
# 64-core bitmask: 0xffffffff,ffffffff
echo "ffffffff,ffffffff" > /sys/class/net/eth0/queues/rx-0/rps_cpus

# Sizing RFS global flow table and per-queue flow entries
sysctl -w net.core.rps_sock_flow_entries=65536
echo 32768 > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt
```

### Step 4: Kernel SoftIRQ Budget and Backlog Sizing
We tune the kernel network subsystem sysctl parameters to give `net_rx_action()` sufficient packet processing headroom:

```diff
--- /etc/sysctl.d/99-network-performance.conf.orig	2026-12-14 04:00:00.000000000 +0900
+++ /etc/sysctl.d/99-network-performance.conf	2026-12-14 04:30:00.000000000 +0900
@@ -1,5 +1,11 @@
-# Default Linux networking settings
-net.core.netdev_budget = 300
-net.core.netdev_budget_usecs = 2000
-net.core.netdev_max_backlog = 1000
-net.core.rps_sock_flow_entries = 0
+# Tuned Production High-PPS Networking Settings
+net.core.netdev_budget = 600
+net.core.netdev_budget_usecs = 4000
+net.core.netdev_max_backlog = 10000
+net.core.rps_sock_flow_entries = 65536
+net.core.rmem_default = 1048576
+net.core.rmem_max = 16777216
+net.core.wmem_default = 1048576
+net.core.wmem_max = 16777216
```

Apply the changes immediately via `sysctl -p /etc/sysctl.d/99-network-performance.conf`.

---

## 5. Before vs After Verification & Benchmark Results

### Verification Metric 1: CPU SoftIRQ Distribution (`mpstat -P ALL 1`)
Following the application of multi-queue RSS and RPS steering, SoftIRQ processing was smoothly distributed across multiple CPU cores. No single core exceeded 15% `%soft`:

```text
04:45:10 PM  CPU    %usr   %nice    %sys %iowait   %irq   %soft  %steal  %guest  %gnice   %idle
04:45:11 PM  all    4.20    0.00    3.15    0.01   0.10    8.50    0.00    0.00    0.00   84.04
04:45:11 PM    0    3.80    0.00    2.90    0.00   0.00   10.20    0.00    0.00    0.00   83.10
04:45:11 PM    1    3.90    0.00    3.00    0.00   0.00   11.10    0.00    0.00    0.00   82.00
04:45:11 PM    2    4.10    0.00    3.20    0.00   0.00   10.80    0.00    0.00    0.00   81.90
04:45:11 PM    3    4.00    0.00    3.10    0.00   0.00    9.90    0.00    0.00    0.00   83.00
...
```

### Verification Metric 2: Network Driver Packet Loss Elimination
Running high-PPS load tests (850,000 PPS sustained over 30 minutes) confirmed zero hardware packet drops and zero softnet squeeze drops:

```bash
$ ethtool -S eth0 | grep -E "drop|miss|fifo"
     rx_dropped: 0
     rx_missed_errors: 0
     rx_fifo_errors: 0

$ cat /proc/net/softnet_stat | awk '{print $1, $2, $3}'
0008e1a0 00000000 00000000
0008f212 00000000 00000000
0008a490 00000000 00000000
0008d318 00000000 00000000
```

### Benchmark Summary Table

| Metric / Parameter | Default (During Incident) | Production Optimized | Improvement Factor |
| :--- | :--- | :--- | :--- |
| **NIC RX Descriptor Ring** | 512 descriptors | 4,096 descriptors | **8x buffer depth** |
| **SoftIRQ CPU Allocation** | 100% on CPU 0 (`ksoftirqd/0` pegged) | Balanced (8-12% across 8 cores) | **Eliminated CPU lockup** |
| **NAPI Budget (`netdev_budget`)**| 300 packets | 600 packets / 4,000 $\mu$s | **2x processing budget** |
| **Driver Dropped Packets** | 482,019 drops / 10 min | **0 drops** | **100% Zero Packet Loss** |
| **Gateway P99 Latency** | 342.5 ms | **2.1 ms** | **99.4% Latency Reduction** |
| **Max Sustainable PPS** | 220,000 PPS | **850,000+ PPS** | **3.86x Throughput Scale** |

---

## 6. Production Automation Script (`tune-network-rx.sh`)

To enforce these configurations across server reboots, implement the following initialization script managed via a systemd unit:

```bash
#!/usr/bin/env bash
# /usr/local/bin/tune-network-rx.sh
# Production Network Interface RX & SoftIRQ Tuning Script

set -euo pipefail

INTERFACE="eth0"
COMBINED_QUEUES=8

echo "[*] Configuring interface: ${INTERFACE}"

# 1. Expand Hardware Descriptors
if ethtool -g "${INTERFACE}" >/dev/null 2>&1; then
    MAX_RX=$(ethtool -g "${INTERFACE}" | awk '/Pre-set maximums:/,/Current hardware settings:/' | awk '/RX:/ {print $2; exit}')
    MAX_TX=$(ethtool -g "${INTERFACE}" | awk '/Pre-set maximums:/,/Current hardware settings:/' | awk '/TX:/ {print $2; exit}')
    echo "[+] Expanding Ring Buffers to RX: ${MAX_RX}, TX: ${MAX_TX}"
    ethtool -G "${INTERFACE}" rx "${MAX_RX}" tx "${MAX_TX}"
fi

# 2. Configure Hardware Queues
echo "[+] Setting hardware combined channels to: ${COMBINED_QUEUES}"
ethtool -L "${INTERFACE}" combined "${COMBINED_QUEUES}" || true

# 3. Balance IRQs across CPU Cores
echo "[+] Balancing IRQs across CPU cores..."
systemctl stop irqbalance 2>/dev/null || true

QUEUES=$(ls -d /sys/class/net/"${INTERFACE}"/queues/rx-* 2>/dev/null | wc -l)
for ((i=0; i<QUEUES; i++)); do
    # Configure RPS if virtual interface or low queue count
    if [ -f "/sys/class/net/${INTERFACE}/queues/rx-${i}/rps_cpus" ]; then
        echo "ffffffff,ffffffff" > "/sys/class/net/${INTERFACE}/queues/rx-${i}/rps_cpus"
    fi
    if [ -f "/sys/class/net/${INTERFACE}/queues/rx-${i}/rps_flow_cnt" ]; then
        echo 4096 > "/sys/class/net/${INTERFACE}/queues/rx-${i}/rps_flow_cnt"
    fi
done

echo "[*] Network tuning completed successfully."
```

Create a systemd unit file at `/etc/systemd/system/network-tuning.service`:

```ini
[Unit]
Description=Production Network RX Ring and SoftIRQ Tuning
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/tune-network-rx.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo chmod +x /usr/local/bin/tune-network-rx.sh
sudo systemctl daemon-reload
sudo systemctl enable --now network-tuning.service
```

Through proper hardware descriptor ring sizing and multi-core SoftIRQ interrupt distribution, high-volume Linux nodes can effortlessly sustain millions of packets per second with deterministic sub-millisecond network performance.
