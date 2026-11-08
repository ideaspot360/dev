---
layout: post
title: "Resolving Spring Boot HikariCP Connection Timeout: Pool Leak & LeakDetectionThreshold"
date: 2026-11-10 10:37:00 +0900
categories: [Backend, SpringBoot]
tags: [SpringBoot, HikariCP, ConnectionPool, Database, LeakDetection, Java]
---

During high-concurrency traffic bursts, Spring Boot enterprise services often experience database request freezes, followed by cascade failures across thread pools.

The typical stack trace reveals HikariCP failing to rent database connections:

```text
2026-11-10T10:35:12.894+09:00 ERROR 1 --- [shop-service] [nio-8080-exec-42] o.h.engine.jdbc.spi.SqlExceptionHelper   : HikariPool-1 - Connection is not available, request timed out after 30000ms.
2026-11-10T10:35:12.895+09:00 ERROR 1 --- [shop-service] [nio-8080-exec-42] c.s.o.controller.OrderController         : org.springframework.dao.CannotAcquireLockException: Could not open JPA EntityManager for transaction; nested exception is org.hibernate.exception.JDBCConnectionException: Unable to acquire JDBC Connection
    at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:217)
    at com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:162)
    at com.zaxxer.hikari.HikariDataSource.getConnection(HikariDataSource.java:128)

2026-11-10T10:35:14.102+09:00 WARN  1 --- [shop-service] [l-1 housekeeper] com.zaxxer.hikari.pool.ProxyLeakTask     : Apparent connection leak detected! Connection org.postgresql.jdbc.PgConnection@4b1f92c borrowed at:
    at com.shop.order.service.ExternalPaymentClient.callPgGateway(ExternalPaymentClient.java:54)
    at com.shop.order.service.OrderService.processPayment(OrderService.java:88)
```

## Production Specs
* **Framework**: Spring Boot 3.3.0 / OpenJDK 21
* **Connection Pool**: HikariCP 5.1.0
* **Database**: PostgreSQL 16.3
* **Max Pool Size**: 30 connections

---

## 1. Root Cause Analysis: Synchronous I/O Inside `@Transactional` Boundaries

The warning log reveals the exact smoking gun:
`Apparent connection leak detected at ExternalPaymentClient.callPgGateway()`.

When a Spring service annotates a method with `@Transactional`, HikariCP acquires a physical DB connection **before** entering the method body.

```java
@Transactional // <-- HikariCP connection acquired HERE!
public OrderResponse processPayment(OrderRequest req) {
    Order order = orderRepository.findById(req.getId()).orElseThrow();
    
    // FATAL ARCHITECTURE ANTI-PATTERN:
    // Calling slow external HTTP 3rd-party PG payment gateway (takes 2-5 seconds)
    // while holding an active DB connection from the shared pool!
    PaymentResult result = paymentGatewayClient.requestCharge(order.getAmount());
    
    order.setStatus(result.isSuccess() ? "PAID" : "FAILED");
    return new OrderResponse(order);
} // <-- Connection finally returned to pool HERE!
```

If the external payment gateway lags or takes 3 seconds, all 30 pool connections remain locked doing network I/O, completely starving the application of DB connections within milliseconds.

---

## 2. Before vs. After Remediation

### Architecture Fix: Isolate Transaction Boundaries
Never perform long-running blocking I/O (REST calls, PDF generation, email sending) inside `@Transactional`.

```diff
@Service
public class OrderService {
    @Autowired private PaymentGatewayClient paymentGatewayClient;
    @Autowired private OrderTxService orderTxService;

-   @Transactional
-   public OrderResponse processPayment(OrderRequest req) {
-       Order order = orderRepository.findById(req.getId()).orElseThrow();
-       PaymentResult res = paymentGatewayClient.requestCharge(order.getAmount());
-       order.setStatus(res.isSuccess() ? "PAID" : "FAILED");
-       return new OrderResponse(order);
-   }

+   // Correct Pattern: Narrow Transaction Scope
+   public OrderResponse processPayment(OrderRequest req) {
+       // 1. Fetch info with quick read
+       OrderDto orderInfo = orderTxService.findOrder(req.getId());
+       
+       // 2. Perform slow external HTTP call WITHOUT holding DB connection
+       PaymentResult res = paymentGatewayClient.requestCharge(orderInfo.getAmount());
+       
+       // 3. Update DB in a rapid isolated transaction
+       return orderTxService.updateOrderStatus(req.getId(), res.isSuccess());
+   }
}
```

### HikariCP Configuration Hardening
Activate `leak-detection-threshold` and align timeouts in `application.yml`:

```diff
spring:
  datasource:
    hikari:
      maximum-pool-size: 30
      minimum-idle: 10
-     connection-timeout: 30000
+     connection-timeout: 5000       # Fail fast within 5s instead of hanging for 30s
+     leak-detection-threshold: 2000 # Print warning & stack trace if query holds conn > 2s
+     max-lifetime: 1800000          # 30 mins
```

---

## Verification
Under stress testing at 1,500 RPS:
* **Connection Timeout Exceptions**: Reduced to **0**.
* **HikariCP Active Connections**: Stabilized from 100% saturation (30/30) to an average of **7/30**.

