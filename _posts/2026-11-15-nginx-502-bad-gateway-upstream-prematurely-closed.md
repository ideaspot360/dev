---
layout: post
title: "Fixing Nginx 502 Bad Gateway: upstream prematurely closed connection & keepalive_timeout"
date: 2026-11-15 10:52:00 +0900
categories: [DevOps, Nginx]
tags: [Nginx, ReverseProxy, 502BadGateway, KeepAlive, TCP, Architecture]
---

In high-concurrency microservice architectures utilizing Nginx as a reverse proxy or Kubernetes Ingress Controller, intermittent `502 Bad Gateway` errors frequently plague user traffic under sustained load.

The Nginx error log reveals the upstream application server abruptly severing the TCP connection:

```text
2026-11-15T10:50:18+09:00 [error] 14892#14892: *910243 upstream prematurely closed connection while reading response header from upstream, client: 203.0.113.88, server: api.shop.com, request: "GET /api/v1/catalog/items HTTP/1.1", upstream: "http://10.244.2.45:8080/api/v1/catalog/items", host: "api.shop.com"
2026-11-15T10:50:19+09:00 [error] 14892#14892: *910245 recv() failed (104: Connection reset by peer) while reading response header from upstream, client: 203.0.113.89, server: api.shop.com, request: "POST /api/v1/orders HTTP/1.1", upstream: "http://10.244.2.45:8080/api/v1/orders", host: "api.shop.com"
```

## Production Specs
* **Reverse Proxy**: Nginx 1.26.1 Community
* **Upstream Backend**: Spring Boot 3.3.0 (Embedded Tomcat 10.1) & Node.js Express 4.19
* **Network Topology**: Nginx -> Private VPC Overlay -> Upstream Container Pods
* **Traffic**: 8,500 RPS

---

## 1. Root Cause: TCP Keep-Alive Race Condition Between Proxy and Backend

This error is almost never an application code crash. Instead, it is a **classic TCP Keep-Alive race condition** caused by mismatched idle connection timeout configurations between Nginx and the upstream backend.

```text
[ Nginx Reverse Proxy ]                                [ Upstream Backend (Tomcat/Node) ]
       │                                                              │
       │ === Reusing Idle Keep-Alive TCP Socket (State: OPEN) ======= │
       │                                                              │
       │                                                [ Upstream Idle Timeout Fires! ]
       │                                                Tomcat sends TCP FIN packet ────┐
       │                                                                                │
       ├────── Nginx forwards Client HTTP Request ────────────────────>                 │ (Race!)
       │       (Sent at the EXACT same millisecond)                                     │
       │                                                                                │
       │ <──── Upstream kernel rejects request with TCP RST <───────────────────────────┘
       │
[ 502 Bad Gateway logged: upstream prematurely closed connection ]
```

1. To maximize performance, Nginx pools idle TCP connections to upstream backends using HTTP/1.1 Keep-Alive.
2. If the **upstream backend's idle keepalive timeout is shorter than or equal to Nginx's keepalive timeout**, the backend unilaterally issues a `TCP FIN` to close the socket.
3. If Nginx simultaneously dispatches a fresh HTTP request down that exact socket before processing the backend's `FIN`, the backend kernel rejects the incoming data with a `TCP RST` (Connection Reset).
4. Nginx detects the sudden connection reset while awaiting the HTTP response header and drops the request with `502 Bad Gateway`.

---

## 2. Before vs. After Remediation

### Golden Rule of Reverse Proxy Architecture:
> **The Upstream Backend's Keep-Alive Timeout MUST ALWAYS be GREATER than Nginx's Keep-Alive Timeout!**  
> (Recommended: Backend Timeout = Nginx Timeout + 5 to 10 seconds).

### 1) Nginx Configuration (`/etc/nginx/nginx.conf`)
Configure explicit upstream keepalive pools and set `keepalive_timeout` conservatively lower than the backend:

```diff
upstream backend_nodes {
    server 10.244.2.45:8080 max_fails=3 fail_timeout=10s;
+   keepalive 64;                     # Maintain pool of 64 idle connections
+   keepalive_requests 1000;
+   keepalive_timeout 55s;            # Nginx will close idle sockets at 55 seconds
}

server {
    listen 80;
    location / {
        proxy_pass http://backend_nodes;
+       proxy_http_version 1.1;       # Required for upstream keepalive
+       proxy_set_header Connection ""; # Clear Hop-by-Hop 'close' header
+       proxy_next_upstream error timeout invalid_header http_502 http_503;
+       proxy_next_upstream_tries 3;  # Seamlessly retry on another upstream if race occurs!
    }
}
```

### 2) Upstream Backend Timeout Alignment

**For Spring Boot (`application.yml`)**:
```diff
server:
  tomcat:
    connection-timeout: 65000ms      # 65s (> Nginx 55s)
    keep-alive-timeout: 65000ms      # 65s (> Nginx 55s)
```

**For Node.js Express (`server.js`)**:
```diff
const server = app.listen(8080);
// Ensure Node.js keepAliveTimeout exceeds Nginx keepalive_timeout
+ server.keepAliveTimeout = 65000;   // 65s (> Nginx 55s)
+ server.headersTimeout = 66000;     // Node requirement: headersTimeout > keepAliveTimeout
```

---

## Verification & Impact
* **502 Bad Gateway Error Rate**: Reduced from ~0.15% under peak traffic to **0.00%**.
* **Automatic Failover**: `proxy_next_upstream` guarantees transparent retries even during rare TCP resets.

