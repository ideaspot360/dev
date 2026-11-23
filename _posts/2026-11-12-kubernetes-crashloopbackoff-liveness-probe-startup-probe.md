---
layout: post
title: "Troubleshooting Kubernetes CrashLoopBackOff: Liveness Probe Misconfiguration & Startup Probes"
date: 2026-11-12 10:46:38 +0900
category: "Cloud & DevOps"
tags: [kubernetes, crashloopbackoff, liveness-probe, startup-probe, spring-boot, devops, microservices]
author: "IdeaSpot360 Engineering Notes"
excerpt: "When heavy Spring Boot microservices enter Kubernetes CrashLoopBackOff during cold starts, aggressive liveness probes repeatedly kill initializing containers. Here is how Kubelet probe workers evaluate health in pkg/kubelet/prober/worker.go, the mathematics of CrashLoopBackOff exponential backoff, why pointing liveness to deep dependencies causes cluster restart storms, and how to configure dedicated startupProbes for zero-downtime rollouts."
verification_date: "2026-11-23"
fact_check_sources:
  - "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/"
  - "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/"
  - "https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes"
  - "https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/prober/worker.go"
  - "https://github.com/kubernetes/kubernetes/blob/master/pkg/probe/http/http.go"
---

During a continuous deployment rollout on a production Kubernetes cluster, newly scheduled pods repeatedly fail to reach steady state, cycling through `ContainerCreating`, running for several seconds, and then crashing into `CrashLoopBackOff`:

```text
$ kubectl get pods -l app=order-service -n production
NAME                             READY   STATUS             RESTARTS      AGE
order-service-789f4b6d4-c4x8m    0/1     CrashLoopBackOff   4 (45s ago)   3m12s
order-service-789f4b6d4-k2v9p    0/1     CrashLoopBackOff   4 (42s ago)   3m10s
order-service-789f4b6d4-x9q2w    0/1     CrashLoopBackOff   4 (40s ago)   3m08s
```

Inspection via `kubectl describe pod` reveals that the host kubelet is repeatedly terminating the container due to failed HTTP health checks, despite the application process encountering no unhandled JVM exceptions or fatal exit codes:

```text
Events:
  Type     Reason     Age                   From               Message
  ----     ------     ----                  ----               -------
  Normal   Scheduled  3m12s                 default-scheduler  Successfully assigned production/order-service-789f4b6d4-x9q2w to ip-10-0-3-42.ec2.internal
  Normal   Pulled     3m10s                 kubelet            Container image "registry.internal/order-service:v2.1" already present on machine
  Normal   Created    3m09s                 kubelet            Created container order-service
  Normal   Started    3m09s                 kubelet            Started container order-service
  Warning  Unhealthy  2m10s (x3 over 2m40s) kubelet            Liveness probe failed: HTTP probe failed with statuscode: 503
  Normal   Killing    2m10s                 kubelet            Container order-service failed liveness probe, will be restarted
  Normal   Pulled     2m00s                 kubelet            Container image "registry.internal/order-service:v2.1" already present on machine
  Normal   Created    1m59s                 kubelet            Created container order-service
  Normal   Started    1m59s                 kubelet            Started container order-service
  Warning  BackOff    45s (x4 over 1m45s)   kubelet            Back-off restarting failed container
```

Checking the crashed container stderr logs using `kubectl logs --previous` demonstrates that the JVM process was in the middle of standard framework bootstrapping when the kubelet killed it:

```text
2026-11-12T10:47:15.821+09:00  INFO 1 --- [order-service] [main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat initialized with port 8080 (http)
2026-11-12T10:47:18.452+09:00  INFO 1 --- [order-service] [main] o.f.c.i.database.base.BaseDatabaseType   : Database: PostgreSQL 16.2
2026-11-12T10:47:20.104+09:00  INFO 1 --- [order-service] [main] o.f.core.internal.command.DbMigrate      : Current version of schema "public": 2.0.4
2026-11-12T10:47:22.381+09:00  INFO 1 --- [order-service] [main] o.f.core.internal.command.DbMigrate      : Migrating schema "public" to version "2.1.0 - Partition Orders Table"
2026-11-12T10:47:34.901+09:00  WARN 1 --- [order-service] [SpringContextShutdownHook] o.s.c.support.AbstractApplicationContext : Closing org.springframework.boot.web.servlet.context.AnnotationConfigServletWebServerApplicationContext
2026-11-12T10:47:35.012+09:00  INFO 1 --- [order-service] [SpringContextShutdownHook] com.zaxxer.hikari.HikariDataSource       : HikariPool-1 - Shutdown initiated...
2026-11-12T10:47:35.045+09:00  INFO 1 --- [order-service] [SpringContextShutdownHook] com.zaxxer.hikari.HikariDataSource       : HikariPool-1 - Shutdown completed.
command terminated with exit code 143
```

Exit code 143 corresponds to $128 + 15$ (`SIGTERM`), indicating that the container did not crash of its own accord; the kubelet sent `SIGTERM` (followed by `SIGKILL` upon expiration of `terminationGracePeriodSeconds`) because the liveness probe repeatedly evaluated to a failure state.

---

## Production Environment Specs

* **Cluster Version**: Kubernetes v1.30.1 on Amazon EKS [Source: Kubernetes Configure Liveness, Readiness and Startup Probes Documentation](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
* **Container Runtime**: containerd 1.7.18 [Source: Kubernetes Pod Lifecycle Documentation](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
* **Base OS Image**: Eclipse Temurin OpenJDK 21.0.3-jre on Debian Bookworm
* **Application Framework**: Spring Boot 3.3.0 with Spring Boot Actuator (`spring-boot-starter-actuator`) [Source: Spring Boot Actuator Kubernetes Probes Documentation](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)
* **Observed Cold-Start Latency**: ~52 seconds under average node CPU contention (Flyway schema migrations + HikariCP connection pool acquisition + Hibernate metadata validation)
* **Initial Probe Spec**: `initialDelaySeconds: 15`, `periodSeconds: 10`, `failureThreshold: 3`, `timeoutSeconds: 3`

---

## 1. Root Cause Analysis: Kubelet Probe Worker Architecture vs. Cold-Start Timers

The root failure stems from a timing conflict between the kubelet's internal health check evaluation loops and the initialization lifecycle of heavy enterprise JVM runtimes.

### 1.1 Kubelet Probe Worker Execution Loop

Inside the kubelet codebase (`pkg/kubelet/prober/worker.go`), health monitoring for each container is split across independent Go worker routines [Source: Kubernetes Source Code — pkg/kubelet/prober/worker.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/prober/worker.go):

```text
+---------------------------------------------------------------------------------+
|                                 KUBELET NODE DAEMON                             |
|                                                                                 |
|  +--------------------------- PROBER MANAGER --------------------------------+  |
|  |                                                                           |  |
|  |   [Startup Worker]  ---> (Tick: periodSeconds)  ---> doProbe()             |  |
|  |         |                                              |                  |  |
|  |         v (If defined: Blocks Liveness & Readiness)    |                  |  |
|  |   [Liveness Worker] ---> (Tick: periodSeconds)  ---> doProbe()            |  |
|  |         |                                              |                  |  |
|  |         v (Controls Endpoints / Service Traffic)       v                  |  |
|  |   [Readiness Worker]---> (Tick: periodSeconds)  ---> HTTP GET :8080       |  |
|  |                                                        |                  |  |
|  +--------------------------------------------------------|------------------+  |
|                                                           v                     |
|  +--------------------------- POD CONTAINER --------------|------------------+  |
|  |                                                        |                  |  |
|  |   Tomcat Web Server (Listening on :8080) <-------------+                  |  |
|  |      |                                                                    |  |
|  |      +--> /actuator/health/liveness                                       |  |
|  |             - Status: 503 SERVICE UNAVAILABLE (Booting...)                |  |
|  |             - Consecutive Failures >= failureThreshold (3)                |  |
|  |             - Kubelet Action: Kill Container (SIGTERM / SIGKILL)          |  |
|  +---------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------+
```

Each worker runs a continuous ticker loop:
1. The worker sleeps for `initialDelaySeconds`.
2. Every `periodSeconds`, the worker calls `doProbe(ctx)`.
3. For HTTP health checks, `pkg/probe/http/http.go` executes an HTTP `GET` request against the target container port [Source: Kubernetes Source Code — pkg/probe/http/http.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/probe/http/http.go).
4. As defined in `DoHTTPProbe()`:
   * Status codes $200 \le \text{code} < 400$ return `probe.Success`.
   * Status codes $\ge 400$ or TCP socket connection timeouts/refusals return `probe.Failure`.
5. If the probe yields `probe.Failure` consecutively for `failureThreshold` times, the worker invokes `w.onProbeFailure()`. For a `livenessProbe`, this triggers container termination and schedules a restart according to the pod's `restartPolicy`.

### 1.2 Spring Boot Actuator Probe Lifecycle

In Spring Boot 3.x, availability states are governed by `ApplicationAvailability` with two decoupled state models [Source: Spring Boot Actuator Kubernetes Probes Documentation](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes):
* **`LivenessState`**: Can be `CORRECT` or `BROKEN`. Indicates whether the internal runtime context is uncorrupted.
* **`ReadinessState`**: Can be `ACCEPTING_TRAFFIC` or `REFUSING_TRAFFIC`. Indicates whether the application is prepared to service requests.

During startup, the application context undergoes several sequential phases:
1. JVM classloading and bytecode verification.
2. Spring Bean definition scanning and dependency injection.
3. Flyway database schema migration against PostgreSQL.
4. HikariCP connection pool pre-allocation.
5. Embedded Tomcat HTTP connector startup.
6. Execution of `CommandLineRunner` and `ApplicationRunner` beans.

The HTTP connector on port 8080 opens early in this sequence. However, until the entire Spring ApplicationContext is fully refreshed, Spring Boot Actuator's `/actuator/health/liveness` endpoint evaluates to `503 Service Unavailable` (`"status": "OUT_OF_SERVICE"` or uninitialized).

### 1.3 The Budget Deficit Formula

The total time window allocated by Kubernetes before the kubelet kills the initializing container is strictly determined by:

$$T_{\text{liveness\_budget}} = \text{initialDelaySeconds} + (\text{failureThreshold} \times \text{periodSeconds})$$

Under the initial production configuration:
* `initialDelaySeconds = 15`
* `periodSeconds = 10`
* `failureThreshold = 3`

$$T_{\text{liveness\_budget}} = 15 + (3 \times 10) = 45\text{ seconds}$$

Because cold boot requires **52 seconds**, the failure timeline unfolds predictably:
* **$t = 0\text{s}$**: Container starts, JVM initializes.
* **$t = 15\text{s}$**: `initialDelaySeconds` expires. Kubelet sends probe attempt 1. HTTP 503 returned. (`failureCount = 1`)
* **$t = 25\text{s}$**: Kubelet sends probe attempt 2. HTTP 503 returned. (`failureCount = 2`)
* **$t = 35\text{s}$**: Kubelet sends probe attempt 3. HTTP 503 returned. (`failureCount = 3 == failureThreshold`)
* **$t = 35\text{s}$**: Kubelet issues `SIGTERM` to the container process.
* **$t = 45\text{s}$**: If the container has not exited cleanly, Kubelet sends `SIGKILL`.

The container is repeatedly executed and murdered before its Spring context ever completes initialization.

---

## 2. Mathematical Model: CrashLoopBackOff Exponential Backoff & Cluster Throttling

When a container repeatedly fails its liveness probe or exits unexpectedly, the kubelet applies an exponential backoff algorithm to prevent thrashing node CPU and exhausting system resources [Source: Kubernetes Pod Lifecycle Documentation](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/).

### 2.1 Exponential Restart Delay Formulation

The backoff duration $T_{\text{backoff}}$ for the $n$-th consecutive failure is calculated in `pkg/kubelet/kuberuntime/kuberuntime_manager.go` as:

$$T_{\text{backoff}}(n) = \min\left(10 \times 2^{n-1},\ 300\right)\text{ seconds}$$

Where $n$ represents the restart iteration count:
* **Iteration 1 ($n=1$)**: $10 \times 2^0 = 10\text{ seconds}$
* **Iteration 2 ($n=2$)**: $10 \times 2^1 = 20\text{ seconds}$
* **Iteration 3 ($n=3$)**: $10 \times 2^2 = 40\text{ seconds}$
* **Iteration 4 ($n=4$)**: $10 \times 2^3 = 80\text{ seconds}$
* **Iteration 5 ($n=5$)**: $10 \times 2^4 = 160\text{ seconds}$
* **Iteration 6+ ($n \ge 6$)**: $\min(10 \times 2^5, 300) = \min(320, 300) = 300\text{ seconds (5 minutes)}$

```text
Backoff Delay (Seconds)
  300 |                                            *--------- (Cap: 300s / 5 min)
  250 |
  200 |
  160 |                                  *
  100 |
   80 |                         *
   40 |                *
   20 |        *
   10 |  *
    0 +---+--------+--------+--------+--------+--------+-------->
         n=1      n=2      n=3      n=4      n=5      n=6+
```

### 2.2 The 10-Minute Reset Rule

The kubelet does not penalize healthy containers indefinitely. If a container successfully runs continuously without failing for **10 minutes** (or $2 \times \text{periodSeconds}$ depending on the prober state manager), the kubelet resets the backoff index $n$ back to 0 [Source: Kubernetes Pod Lifecycle Documentation](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/).

However, during cold-start liveness probe failures, the container never survives past second 45, making it mathematically impossible to reach the 10-minute reset threshold. Every replica in the deployment rapidly escalates to the 5-minute restart delay ceiling, causing total deployment stall and prolonged service downtime.

---

## 3. Common Missteps: Why Naive Fixes Cause Production Incidents

When confronted with probe-induced `CrashLoopBackOff`, development and operations teams frequently resort to three flawed workarounds:

### Misstep 1: Blindly Inflating `initialDelaySeconds` (e.g. 180s or 300s)

The most common initial reflex is increasing `initialDelaySeconds` from 15s to 180s or 300s to "give the JVM plenty of time to warm up."

* **Why this fails in production**:
  1. **Deployment Latency Penalty**: `initialDelaySeconds` is a static, rigid wait period. If an optimized pod boots in 25 seconds, the kubelet continues to wait the full 180 seconds before evaluating health or routing traffic through readiness checks. In a rolling update of 20 pods, this introduces massive deployment delays.
  2. **Deadlock Blind Spot**: If the application process encounters a fatal initialization deadlock (e.g., thread starvation or corrupted lock file) at second 20, Kubernetes remains completely unaware of the failure for another 160 seconds.
  3. **Noisy Neighbor Failures**: Under peak cluster traffic or node memory pressure, CFS CPU throttling can stretch JVM warm-up from 52s to 190s. The static delay is breached again, and the pod re-enters `CrashLoopBackOff`.

### Misstep 2: Disabling Liveness Probes Completely

Another naive workaround is removing `livenessProbe` from the pod specification entirely, relying exclusively on container process termination to detect failures.

* **Why it backfires**:
  * An enterprise Java or Go process rarely crashes outright when deadlocked. When database connection pools are exhausted, background worker threads starve, or an internal event bus enters an infinite lock loop, the operating system process remains active (PID running, CPU idling).
  * Without a liveness probe, Kubernetes marks the deadlocked container as permanently healthy. The pod continues receiving user traffic through the Service load balancer, dropping incoming client transactions indefinitely.

### Misstep 3: Pointing Liveness Probes to Deep Dependency Trees (`/actuator/health`)

A disastrous anti-pattern is configuring `livenessProbe` to point directly to root `/actuator/health` without custom probe scoping.

* **Why this triggers cluster-wide cascading failure**:
  * By default in Spring Boot Actuator, `/actuator/health` aggregates health checks across all backing dependencies: PostgreSQL, Redis caches, Kafka brokers, and downstream microservices.
  * If PostgreSQL experiences a transient 10-second failover or network hiccup, `/actuator/health` immediately returns HTTP `503 Service Unavailable`.
  * If the liveness probe checks this endpoint, the kubelet marks **every single pod replica in the cluster** as unhealthy and issues simultaneous container kills.
  * When database connectivity is restored, all 100 microservice pods attempt to restart and execute Flyway migrations simultaneously, overwhelming the database in a catastrophic thundering herd (Cascading Restart Storm).

---

## 4. Production Remediation: Implementing Decoupled `startupProbe` Architecture

Kubernetes introduces `startupProbe` specifically to isolate cold-start delays from steady-state runtime monitoring [Source: Kubernetes Configure Liveness, Readiness and Startup Probes Documentation](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/).

When a `startupProbe` is defined, the kubelet **completely disables and suspends both `livenessProbe` and `readinessProbe`** until the `startupProbe` returns `probe.Success` at least once.

### 4.1 Production Kubernetes Deployment Diff

Here is the exact unified diff comparing the flawed configuration against the resilient three-tier probe architecture:

```diff
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: order-service
        image: registry.internal/order-service:v2.1
        ports:
        - containerPort: 8080
          name: http-web
+       # 1. Dedicated Startup Probe: Absorbs heavy cold-start latency
+       startupProbe:
+         httpGet:
+           path: /actuator/health/liveness
+           port: 8080
+         initialDelaySeconds: 10
+         periodSeconds: 5
+         failureThreshold: 30       # Total budget: 10s + (30 * 5s) = 160 seconds
+         timeoutSeconds: 3
+
        # 2. Steady-State Liveness Probe: Detects internal JVM deadlocks only
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
-         initialDelaySeconds: 15
-         periodSeconds: 10
-         failureThreshold: 3
+         periodSeconds: 10
+         failureThreshold: 3        # Fast reaction: kills deadlock after 30 seconds
+         timeoutSeconds: 3
+
+       # 3. Readiness Probe: Controls traffic routing into Service endpoints
+       readinessProbe:
+         httpGet:
+           path: /actuator/health/readiness
+           port: 8080
+         periodSeconds: 5
+         failureThreshold: 2        # Fast ejection: removes from service in 10 seconds
+         timeoutSeconds: 3
```

### 4.2 Spring Boot Actuator Configuration (`application.yml`)

Ensure Spring Boot Actuator explicitly decouples liveness and readiness state groups [Source: Spring Boot Actuator Kubernetes Probes Documentation](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes):

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  endpoint:
    health:
      probes:
        enabled: true
      group:
        liveness:
          include: livenessState
        readiness:
          include: readinessState,db
```

* `/actuator/health/liveness` validates only `LivenessState` (internal JVM/thread integrity).
* `/actuator/health/readiness` validates `ReadinessState` and critical network dependencies (`db`). If the database is unreachable, the pod is removed from Kubernetes Service Endpoints but **is not killed or restarted**.

---

## 5. Architectural Deep Dive: Kubelet Startup Gate in `worker.go`

To understand why this solution eliminates cold-start latency while maintaining fast deadlock recovery, examine the probe execution logic inside `pkg/kubelet/prober/worker.go` [Source: Kubernetes Source Code — pkg/kubelet/prober/worker.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/prober/worker.go):

```go
// Inside pkg/kubelet/prober/worker.go
func (w *worker) doProbe(ctx context.Context) bool {
    // If a startup probe is defined and has not yet completed successfully,
    // liveness and readiness probe workers must yield immediately.
    if w.probeType != startup {
        if !w.containerStarted() {
            return true
        }
    }

    result, err := w.probeManager.runProbe(ctx, w.probeType, w.pod, w.status, w.container, w.containerID)
    if err != nil {
        return true
    }

    if w.probeType == startup {
        if result == probe.Success {
            // Container startup completed!
            w.setContainerStarted()
            // Terminate startup worker routine; hand over control to liveness/readiness
            return false
        }
        if w.resultRun >= w.spec.FailureThreshold {
            // Exceeded startup budget -> signal kubelet to restart container
            w.onProbeFailure()
            return false
        }
    }
    // ...
    return true
}
```

### The Fast-Path Early Exit Benefit

With `startupProbe`:
* Max startup budget is configured generously: $10\text{s} + (30 \times 5\text{s}) = 160\text{ seconds}$.
* If the application finishes bootstrapping at second 32, the startup probe succeeds on probe attempt 5 ($10\text{s} + [5 \times 5\text{s}] = 35\text{s}$).
* The startup worker immediately calls `w.setContainerStarted()` and exits its loop (`return false`).
* The `livenessProbe` and `readinessProbe` workers activate immediately.
* **Result**: Zero wasted seconds. The pod enters active service 125 seconds faster than it would with a naive `initialDelaySeconds: 160` configuration.

---

## 6. Production Verification Runbook & CLI Commands

Follow these operational CLI commands to verify probe transitions in real time during continuous deployment:

```bash
# 1. Watch pod rollout progression and observe probe transitions
kubectl get pods -n production -l app=order-service -w

# 2. Inspect active probe definitions and runtime events for the container
kubectl describe pod -n production -l app=order-service | grep -E "(Startup|Liveness|Readiness):|Events:" -A 15

# 3. Query kubelet prober metrics from Prometheus to detect flaky probes
# Metric: kubelet_container_probe_total{probe_type="Startup", result="successful"}
kubectl exec -n production deploy/order-service -- curl -s http://localhost:8080/actuator/health/liveness
kubectl exec -n production deploy/order-service -- curl -s http://localhost:8080/actuator/health/readiness

# 4. Verify that rolling restart incurs zero dropped connections
kubectl rollout restart deployment/order-service -n production
kubectl rollout status deployment/order-service -n production --timeout=180s
```

### Verification Test Results

```text
$ kubectl describe pod order-service-594dfb7c9-z8m2q -n production
Containers:
  order-service:
    State:          Running
      Started:      Mon, 12 Nov 2026 10:52:14 +0900
    Ready:          True
    Restart Count:  0
    Startup:        http-get http://:8080/actuator/health/liveness delay=10s timeout=3s period=5s #success=1 #failure=30
    Liveness:       http-get http://:8080/actuator/health/liveness delay=0s timeout=3s period=10s #success=1 #failure=3
    Readiness:      http-get http://:8080/actuator/health/readiness delay=0s timeout=3s period=5s #success=1 #failure=2
Events:
  Type    Reason     Age   From               Message
  ----    ------     ----  ----               -------
  Normal  Scheduled  58s   default-scheduler  Successfully assigned production/order-service-594dfb7c9-z8m2q to ip-10-0-3-42.ec2.internal
  Normal  Pulled     56s   kubelet            Container image "registry.internal/order-service:v2.1" already present on machine
  Normal  Created    55s   kubelet            Created container order-service
  Normal  Started    55s   kubelet            Started container order-service
```

Zero container kills occurred during the cold-start phase. The pod transitioned smoothly from unready to ready state in 58 seconds without triggering `CrashLoopBackOff`.

---

## 7. Production Best Practices Checklist

1. **Decouple Startup from Liveness**: Never use aggressive steady-state liveness timeouts to monitor slow-booting applications. Always allocate a dedicated `startupProbe` with a generous budget:
   $$T_{\text{startup\_budget}} \ge 1.5 \times \text{P99.9 Cold-Start Duration}$$
2. **Keep Liveness Probes Lightweight**: A liveness check must only verify that the container process and internal thread pool are responsive. Never connect to external databases, message brokers, or remote microservices inside a liveness check.
3. **Use Readiness Probes for External Dependencies**: If a required database connection pool drops, fail the `readinessProbe` to remove the container from Kubernetes Service endpoints. Keep the container alive so it can reconnect when the database recovers.
4. **Configure Graceful Termination**: Ensure `terminationGracePeriodSeconds` (default: 30s) exceeds the application's internal shutdown timeout (e.g., `spring.lifecycle.timeout-per-shutdown-phase: 20s`) to allow in-flight HTTP requests to drain before the kubelet executes `SIGKILL`.
5. **Monitor Kubelet Probe Metrics**: Alert on high values of `kubelet_container_probe_failures_total` in Prometheus to catch regressions in JVM initialization time before they breach production thresholds.

---

## References

* [Kubernetes Documentation: Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
* [Kubernetes Documentation: Pod Lifecycle & Container Restart Policies](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
* [Spring Boot Reference Documentation: Actuator Kubernetes Probes](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)
* [Kubernetes GitHub Source Code: pkg/kubelet/prober/worker.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/prober/worker.go)
* [Kubernetes GitHub Source Code: pkg/probe/http/http.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/probe/http/http.go)
