---
layout: post
title: "Troubleshooting Kubernetes CrashLoopBackOff: Liveness Probe Misconfiguration & Startup Probes"
date: 2026-11-12 10:46:00 +0900
categories: [DevOps, Kubernetes]
tags: [Kubernetes, CrashLoopBackOff, LivenessProbe, StartupProbe, Cloud]
---

In modern enterprise Kubernetes clusters, newly deployed microservice pods frequently spiral into an endless restart loop, entering the dreaded `CrashLoopBackOff` state.

Inspection via `kubectl describe pod` reveals the container being repeatedly terminated by the kubelet despite no fatal application exceptions:

```text
Events:
  Type     Reason     Age                From               Message
  ----     ------     ----               ----               -------
  Normal   Scheduled  3m12s              default-scheduler  Successfully assigned default/order-service-789f4b6d4-x9q2w to node-pool-1
  Normal   Pulled     3m10s              kubelet            Container image "order-service:v2.1" already present on machine
  Normal   Created    3m9s               kubelet            Created container order-service
  Normal   Started    3m9s               kubelet            Started container order-service
  Warning  Unhealthy  2m10s (x3 over 2m40s) kubelet            Liveness probe failed: HTTP probe failed with statuscode: 503
  Normal   Killing    2m10s              kubelet            Container order-service failed liveness probe, will be restarted
  Normal   Pulled     2m                 kubelet            Container image "order-service:v2.1" already present on machine
  Warning  BackOff    45s (x4 over 1m45s) kubelet            Back-off restarting failed container
```

## Production Specs
* **Cluster Version**: Kubernetes v1.30.1
* **Container Runtime**: Containerd 1.7.18
* **Application Framework**: Spring Boot 3.3.0 (JVM cold-start time: ~45-60s)
* **Probe Config**: `initialDelaySeconds: 15`, `periodSeconds: 10`, `failureThreshold: 3`

---

## 1. Root Cause: Probe Impatience During Cold JVM Warm-Up

The kubelet kills healthy containers because the **Liveness Probe timer expires while the application is still initializing**.

In heavy microservices (Spring Boot, Java, large Node.js apps), initialization includes:
1. Classpath scanning & Spring Bean dependency injection.
2. Flyway/Liquibase database schema migration.
3. Establishing HikariCP connections and Kafka topic listeners.

With `initialDelaySeconds: 15` and `failureThreshold: 3` (period 10s), the kubelet allows exactly $15 + (10 \times 3) = 45\text{ seconds}$ before giving up.
If DB migration or pod scheduling takes 48 seconds, the kubelet executes `SIGKILL` on second 45, restarts the container, and forces the pod into an infinite `CrashLoopBackOff` loop.

---

## 2. Before vs. After Remediation

### Anti-Pattern: Artificially Inflating `initialDelaySeconds`
Increasing `initialDelaySeconds: 180` is a fragile hack: if the application deadlocks *after* 180s, detection is delayed by 3 full minutes.

### Production Solution: Introduce `startupProbe`
Kubernetes provides `startupProbe` specifically designed for slow-starting containers. When defined, **Liveness and Readiness probes are completely paused** until the `startupProbe` succeeds once.

```diff
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  template:
    spec:
      containers:
      - name: order-service
        image: order-service:v2.1
        ports:
        - containerPort: 8080
+       # 1. Startup Probe: Dedicated protection during cold-start
+       startupProbe:
+         httpGet:
+           path: /actuator/health/liveness
+           port: 8080
+         failureThreshold: 30       # 30 attempts * 5s = 150 seconds maximum startup budget
+         periodSeconds: 5
+
        # 2. Liveness Probe: Only handles runtime deadlocks AFTER startup succeeds
        livenessProbe:
          httpGet:
            path: /actuator/health/liveness
            port: 8080
-         initialDelaySeconds: 15
-         failureThreshold: 3
+         periodSeconds: 10
+         failureThreshold: 3
+
+       # 3. Readiness Probe: Controls traffic routing into Service endpoints
+       readinessProbe:
+         httpGet:
+           path: /actuator/health/readiness
+           port: 8080
+         periodSeconds: 5
+         failureThreshold: 2
```

---

## Verification & Impact
* **Rolling Updates**: Zero container restarts during production deployment.
* **Cold Starts**: Successfully absorbed 70-second startup spikes without triggering false-positive kills.

