---
layout: post
title: "Production Post-Mortem: Silent Goroutine Leak via Unbuffered Channel Deadlocks"
date: 2026-11-19 11:25:00 +0900
categories: [Backend, Golang, Concurrency]
tags: [Go, Golang, Goroutine, MemoryLeak, pprof, Concurrency, Troubleshooting]
---

A high-concurrency notification routing service written in Go experienced linear memory degradation over a 72-hour period. Memory consumption swelled from 350 MB to 28 GB until the host Linux kernel triggered an OOM-killer termination (`kill -9`, exit code 137).

```text
2026-11-19 02:14:18.812 UTC kernel: [214012.912] Out of memory: Killed process 39182 (notification-srv) total-vm:29812400kB, anon-rss:27891200kB, file-rss:1240kB, shmem-rss:0kB
2026-11-19 02:14:18.890 UTC systemd[1]: notification-srv.service: Main process exited, code=killed, status=9/KILL
2026-11-19 02:14:18.891 UTC systemd[1]: notification-srv.service: Failed with result 'oom-kill'.
```

## Production Specs
- **Runtime**: Go 1.22.4 (linux/amd64)
- **Container**: Kubernetes Pod (Memory limit: 28 GiB, Request: 8 GiB)
- **Host**: AWS c6i.4xlarge (16 vCPU, 32 GiB RAM)
- **Traffic**: ~18,000 push dispatch requests/sec

## System Mechanism: Goroutine Stack Growth and Channel Synchronization
In Go, a goroutine is an extraordinarily lightweight user-space thread. While an OS thread requires 1 MB to 8 MB of stack space, a newly spawned goroutine starts with only **2 KB of stack** (`runtime.newstack`).

However, goroutines are **not garbage collected** while they remain blocked on a channel send or receive operation. Even if the outer function exits and all references to the spawned goroutine go out of scope, the Go runtime scheduler keeps the blocked goroutine alive in memory, along with any variables captured by its closure.

```
       [HTTP Request Handler]
                 │
                 ├─► spawns child goroutine: ch <- doWork()
                 │
      (Timeout Occurs: return!)
                 │
                 ▼
       (Caller returns 504)
                 
       [Abandoned Goroutine] ──────► BLOCKED FOREVER on `ch <- res`
       (2 KB Stack + Heap Closure = Cannot be GC'd!)
```

Over 72 hours, with a 0.2% downstream vendor timeout rate across 18,000 req/sec:

$$\text{Leak Rate} = 18,000 \times 0.002 = 36 \text{ leaked goroutines/sec}$$

$$36 \times 86,400 \text{ sec/day} \approx 3,110,400 \text{ leaked goroutines/day}$$

Each goroutine, having expanded its segmented stack and holding payload buffers, consumed ~3.2 KB. Over 3 days, over 9.3 million goroutines accumulated, locking down 28+ GB of RSS.

## Diagnosis via `net/http/pprof`
Connecting to the internal telemetry endpoint exposed the catastrophic goroutine buildup:

```bash
# Capture goroutine count profile
curl -s http://localhost:6060/debug/pprof/goroutine?debug=1 | grep -E '^#.*goroutine'
# Output: # goroutine profile: total 9341829
```

Analyzing the stack traces pinpointed the exact channel deadlock line:

```text
9341802 @ 0x43a850 0x431b92 0x431b71 0x7a892b 0x471d41
#   0x7a892a    internal/dispatcher.sendWithTimeout.func1+0x6a  /app/internal/dispatcher/worker.go:58
```

## The Anti-Pattern: Unbuffered Channel with Context Timeout

```go
// ANTIPATTERN: Unbuffered channel blocks if caller leaves early!
func sendWithTimeout(ctx context.Context, payload []byte) error {
    ch := make(chan error) // Unbuffered! Capacity is 0

    go func() {
        // If ctx expires before this finishes, no receiver will ever read from ch!
        ch <- dispatchExternalVendor(payload) // BLOCKS FOREVER!
    }()

    select {
    case err := <-ch:
        return err
    case <-ctx.Done():
        return ctx.Err() // Caller exits, abandoning the goroutine above
    }
}
```

## The Production Fix (Before vs After)

```diff
--- a/internal/dispatcher/worker.go
+++ b/internal/dispatcher/worker.go
@@ -52,14 +52,15 @@ func sendWithTimeout(ctx context.Context, payload []byte) error {
-	ch := make(chan error)
+	// Buffered channel of capacity 1 ensures sender never blocks
+	ch := make(chan error, 1)

 	go func() {
+		defer close(ch)
 		ch <- dispatchExternalVendor(payload)
 	}()

 	select {
 	case err := <-ch:
 		return err
 	case <-ctx.Done():
 		return ctx.Err()
 	}
 }
```

By changing `make(chan error)` to `make(chan error, 1)`, the child goroutine can always write its result to the 1-slot buffer non-blockingly and terminate cleanly, allowing the garbage collector to reclaim the goroutine's stack and memory.

After applying this single-line patch, goroutines remained flat at ~450 across all traffic spikes, and memory consumption stabilized under 420 MB.
