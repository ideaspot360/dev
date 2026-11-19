---
layout: post
title: "Resolving gRPC HTTP/2 Flow Control Window Exhaustion and Stream Deadlocks Under High-Throughput Streaming"
date: 2026-11-30 10:52:43 +0900
category: "Systems & Networking"
tags: ['gRPC', 'HTTP2', 'FlowControl', 'Streaming', 'Microservices', 'Troubleshooting']
---

## Production Incident Summary

During an end-of-quarter high-throughput batch processing event across our real-time telemetry pipeline, multiple gRPC bidirectional streaming workers abruptly stopped processing ingest events. TCP connections remained in an `ESTABLISHED` state, CPU utilization on worker nodes dropped to near zero, but ingest queues backed up, and edge gateways started returning upstream timeouts:

```text
[ERROR] 2026-11-30T01:14:22.841Z [transport] transport: http2Client.notifyFunctions: stream flow control window depleted (stream_id=187, conn_window=65535, stream_window=0)
[ERROR] 2026-11-30T01:14:25.102Z [grpc-worker-04] rpc error: code = ResourceExhausted desc = stream flow control window exhausted: failed sending 131072 bytes frame
[WARN]  2026-11-30T01:14:32.419Z [envoy-proxy] [source/common/router/router.cc:1290] [upstream] upstream timed out (504 gateway timeout) after 10000ms, stream_id=187
[FATAL] 2026-11-30T01:14:40.012Z [telemetry-sink] stream deadlock detected: worker goroutine blocked indefinitely on ClientStream.SendMsg() for 120s
```

Clients were unable to push new payload chunks, while consumer threads appeared stuck waiting for frames that the transport layer refused to dispatch.

## Production Specs
* **Host Operating System**: Ubuntu 22.04 LTS (Linux Kernel 5.15.0-1053-aws)
* **gRPC Runtime**: gRPC-Go v1.62.0 / gRPC C++ Core 1.62.0
* **Edge Proxy**: Envoy Gateway v1.29.1
* **Network Topology**: AWS EKS VPC CNI with 10 Gbps enhanced networking between worker pods
* **Workload Characteristics**: Bidirectional gRPC streaming with uncompressed telemetry chunks varying from 32 KB to 256 KB per message

---

## 1. Architectural Cause & Root Cause: HTTP/2 Dual-Layer Flow Control Window Collapse

The root cause resides in the interplay between HTTP/2 stream-level flow control, connection-level flow control, and slow consumer processing loops in gRPC.

```text
+-----------------------------------------------------------------------------------+
|                            HTTP/2 TCP Connection                                  |
|   Connection-Level Flow Control Window (Default: 65,535 Bytes)                    |
|                                                                                   |
|   +---------------------------------------------------------------------------+   |
|   | Stream 1 Window: 65,535 B  -> [Send 64KB Frame] -> Stream Window: 0 B     |   |
|   | (Producer BLOCKS waiting for WINDOW_UPDATE from consumer application)     |   |
|   +---------------------------------------------------------------------------+   |
|   | Stream 3 Window: 65,535 B  -> Multiplexed over same socket               |   |
|   | (Shared Connection Window depleted -> Entire TCP connection stalls!)       |   |
|   +---------------------------------------------------------------------------+   |
+-----------------------------------------------------------------------------------+
```

HTTP/2 (RFC 7540 Section 5.2) mandates flow control to prevent a fast sender from overwhelming a receiver that operates with bounded memory:

1. **Dual Window Hierarchy**: HTTP/2 maintains two separate flow control windows:
   - **Stream Flow Control Window**: Regulates bytes transmitted on an individual stream.
   - **Connection Flow Control Window**: Regulates aggregate bytes transmitted across all concurrent streams on the entire TCP connection.
2. **Default Window Size of 64 KB**: By default, the initial window size for both streams and connections is exactly $65,535$ bytes ($64\text{ KB} - 1\text{ byte}$).
3. **Chunk Ingestion Dynamics**: Our telemetry producer generated messages sized between 64 KB and 256 KB. A single message exceeded the entire initial stream window.
4. **Buffer Backpressure and `WINDOW_UPDATE` Starvation**: When downstream ingestion workers performed synchronous JSON decoding or batch database inserts, they read messages off the transport slower than the network rate. The receiver's userspace buffer filled up, delaying the emission of HTTP/2 `WINDOW_UPDATE` frames.
5. **Stream Deadlock**: Once the stream's window credits dropped to 0, gRPC's transport layer paused writing. Because the application was blocked synchronously on `SendMsg()`, downstream buffers could not drain, creating a distributed lockup across all streams sharing that TCP connection.

---

## 2. Common Missteps: What We Tried First (And Why It Didn't Work)

During initial troubleshooting, several conventional tuning tactics were attempted that failed to resolve the stall.

### Misstep 1: Expanding OS Kernel TCP Socket Buffers via Sysctl
A common wrong fix was assuming that socket-level TCP receive/transmit buffers were saturated. The team increased `net.ipv4.tcp_rmem` and `net.ipv4.tcp_wmem` to 16 MB.
* **Why It Didn't Work**: TCP socket buffers and HTTP/2 flow control windows are completely decoupled. Inspection with `ss -ti` proved that TCP send/receive queues had zero backlog and TCP window scaling remained wide open ($>1\text{ MB}$). The bottleneck was an application-layer credit depletion inside the HTTP/2 state machine, which the OS kernel cannot override.

### Misstep 2: Aggressive gRPC Keepalive Ping Frequencies
Another failed attempt was shortening keepalive intervals (`keepalive.Time = 3s`, `keepalive.Timeout = 1s`) on the assumption that idle socket timeouts or intermediate NAT gateways were severing connections silently.
* **Why It Didn't Work**: The connection was not dead; it was flow-controlled. Injecting aggressive PING frames into an already stalled HTTP/2 connection triggered Envoy's `ENHANCE_YOUR_CALM` rate limiter (`too_many_pings`), causing the proxy to terminate the entire connection with a `GOAWAY` frame, making the outage worse.

---

## 3. Production Remediation: Flow Control Window Tuning & Unified Diff

To remediate the deadlock, we adjusted both the initial stream flow control window and the connection-level flow control window on both client dials and server listeners. We also configured asynchronous non-blocking stream processing on the receiver.

### Remediation Patch (Go gRPC Client & Server Configuration)

```diff
--- internal/transport/grpc_client.go.orig
+++ internal/transport/grpc_client.go
@@ -14,6 +14,19 @@
 func NewTelemetryClient(ctx context.Context, target string) (*grpc.ClientConn, error) {
-	// Default dialer without HTTP/2 window tuning (defaults: 64 KB stream / conn window)
-	return grpc.DialContext(ctx, target,
-		grpc.WithTransportCredentials(insecure.NewCredentials()),
-	)
+	// Configure high-throughput HTTP/2 flow control windows
+	const (
+		streamWindowSize = 4 * 1024 * 1024  // 4 MB initial stream window
+		connWindowSize   = 16 * 1024 * 1024 // 16 MB initial connection window
+	)
+
+	return grpc.DialContext(ctx, target,
+		grpc.WithTransportCredentials(insecure.NewCredentials()),
+		grpc.WithInitialWindowSize(streamWindowSize),
+		grpc.WithInitialConnWindowSize(connWindowSize),
+		grpc.WithDefaultCallOptions(
+			grpc.MaxCallRecvMsgSize(32*1024*1024),
+			grpc.MaxCallSendMsgSize(32*1024*1024),
+		),
+	)
 }
```

```diff
--- internal/transport/grpc_server.go.orig
+++ internal/transport/grpc_server.go
@@ -10,6 +10,17 @@
 func NewTelemetryServer() *grpc.Server {
-	// Default server with standard 64 KB flow control window
-	return grpc.NewServer()
+	const (
+		serverStreamWindowSize = 4 * 1024 * 1024  // 4 MB stream window
+		serverConnWindowSize   = 16 * 1024 * 1024 // 16 MB connection window
+	)
+
+	return grpc.NewServer(
+		grpc.InitialWindowSize(serverStreamWindowSize),
+		grpc.InitialConnWindowSize(serverConnWindowSize),
+		grpc.MaxConcurrentStreams(1000),
+	)
 }
```

### Remediation Patch (Envoy Edge Gateway Tuning)

```diff
--- deploy/envoy/envoy-config.yaml.orig
+++ deploy/envoy/envoy-config.yaml
@@ -18,6 +18,13 @@
         typed_config:
           "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
           http2_protocol_options:
-            # Default stream window is 65535 bytes (64 KB) causing rapid buffer starvation
-            initial_stream_window_size: 65535
+            # Explicitly scale up flow control windows to match ingress pipeline bandwidth
+            initial_stream_window_size: 4194304    # 4 MB
+            initial_connection_window_size: 16777216 # 16 MB
+            max_concurrent_streams: 1024
             hpack_table_size: 65536
```

---

## 4. Verification CLI Commands & Operational Runbook

After deploying the window adjustments, run the following diagnostic commands across the telemetry worker fleet to verify transport health and socket queue metrics:

```bash
# 1. Inspect kernel TCP buffer limits to ensure OS headroom
sysctl -a | grep -E "net\.ipv4\.tcp_(r|w)mem"

# 2. Inspect active gRPC connections on port 50051 with socket timers and window status
ss -ti '( sport = :50051 or dport = :50051 )'

# 3. Query Envoy upstream cluster health and HTTP/2 window depletion metrics via admin port
curl -s http://127.0.0.1:15000/stats | grep -E "upstream_cx_http2_flow_control|upstream_rq_timeout"

# 4. Validate end-to-end stream throughput without window stalls
curl -v http://localhost:8080/metrics | grep "grpc_server_handled_total"
```

## 5. Architectural Takeaways & Production Safeguards

1. **Bandwidth-Delay Product (BDP) Sizing**: When streaming high-throughput payloads across cloud subnets, flow control windows must be sized according to the link's BDP ($BDP = \text{Bandwidth} \times \text{RTT}$). A $64\text{ KB}$ default window throttles a 10 Gbps connection if RTT exceeds 0.05 milliseconds.
2. **Decouple Ingestion from I/O**: Stream handlers should decouple network frame reception from downstream database writes by placing incoming payloads into an in-memory ring buffer. This ensures `WINDOW_UPDATE` frames are transmitted back immediately, preserving pipeline throughput.
3. **Monitor Stream Window Exhaustion Counters**: Export transport metrics tracking `http2_flow_control_window_depleted` to trigger alerts before application threads experience synchronous backpressure deadlocks.
