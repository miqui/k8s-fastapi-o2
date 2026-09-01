# JVM & Garbage Collection Analysis and Container Tuning Guide

This document summarizes findings, best practices, and actionable recommendations for configuring the Java Virtual Machine (JVM) and Garbage Collection (GC) in containerized environments running on Kubernetes (specifically Java 21 + Spring Boot 4 + MyBatis on Linux/cgroups v2).

---

## 1. Executive Summary & Findings

### 1.1 Container Memory & JVM Architecture
In a Kubernetes container, total memory consumption consists of **Heap Memory** plus **Non-Heap / Native Memory**:

$$\text{Total Container RAM} = \text{Heap} + \text{Metaspace} + \text{CodeCache} + \text{Thread Stacks } (N \times \text{Xss}) + \text{Direct Buffers} + \text{GC Structures} + \text{JVM Native / C-Heap}$$

- **The OOMKilled (Exit Code 137) Risk**: If the combined memory exceeds the Kubernetes `resources.limits.memory` (e.g. `1024Mi`), the Linux cgroup OOM killer sends `SIGKILL` (`kill -9`), bypassing JVM shutdown hooks and leaving no heap dump or stack trace.
- **Default JVM Container Ergonomics**: Java 21 enables `-XX:+UseContainerSupport` by default. However, without explicit percentage flags, HotSpot defaults to `MaxRAMPercentage=25.0%`. For a 1024Mi limit, this allocates only ~256MiB to the heap, leading to frequent GC cycles under moderate load.
- **Optimal Heap Ratio**: For standard Spring Boot microservices, setting `MaxRAMPercentage` between **70.0% and 75.0%** safely leaves **25% to 30% (256MB–300MB)** for Metaspace, thread stacks, off-heap I/O, JIT compilation, and native database/network drivers.

---

## 2. Garbage Collector Comparison (Java 21 / Spring Boot)

| Feature / Metric | G1GC (Garbage-First) | Generational ZGC | Serial GC | Shenandoah GC |
| :--- | :--- | :--- | :--- | :--- |
| **Java 21 Flag** | `-XX:+UseG1GC` (Default) | `-XX:+UseZGC -XX:+ZGenerational` | `-XX:+UseSerialGC` | `-XX:+UseShenandoahGC` |
| **Target Workload** | General-purpose microservices, high throughput + bounded latency | Ultra-low latency (<1ms pause), response-time critical APIs | Single-core / constrained containers (<512MB RAM, <1 CPU) | Ultra-low pause concurrent collector |
| **Pause Time Target** | Configurable (default 200ms, tunable to 50–100ms) | Sub-millisecond (<1ms) | Stop-The-World (100ms - seconds) | Sub-millisecond / low single-digit ms |
| **Memory Overhead** | Low / Medium (~10–15% GC metadata) | Medium / High (~15–20% footprint) | Lowest footprint (<5%) | Medium |
| **CPU Overhead** | Low / Moderate | Higher concurrent background threads | Lowest (no background threads) | Moderate / High |
| **Container Fit (1GB Limit)** | **Optimal (Recommended)** | Feasible, but tighter memory budget | Good for tiny edge pods | Good alternative for low latency |

---

## 3. Key Findings & Recommended JVM Settings

### 3.1 Heap Sizing via RAM Percentages
Avoid hardcoding fixed heap values (`-Xms512m -Xmx768m`) in Docker images or deployment manifests. Instead, leverage dynamic container RAM percentages:

```bash
-XX:InitialRAMPercentage=50.0
-XX:MinRAMPercentage=50.0
-XX:MaxRAMPercentage=75.0
```

- **Why**: Allows Kubernetes resource limits in `deployment.yaml` (`512Mi`, `1024Mi`, `2048Mi`) to dictate heap allocation automatically without changing container startup arguments.
- **Initial = Min = 50%**: Avoids eager allocation of the full limit on boot while preventing frequent heap expansion pauses.

### 3.2 G1GC Tuning for Containerized Microservices
When running G1GC (default in Java 21) within `1024Mi` memory limits:

1. **Pause Time Goal**:
   ```bash
   -XX:MaxGCPauseMillis=100
   ```
   Lowers the default 200ms target to 100ms for more predictable REST API latency under load.

2. **String Deduplication**:
   ```bash
   -XX:+UseStringDeduplication
   ```
   Identifies and deduplicates duplicate `java.lang.String` instances across the heap during young/mixed GC cycles. Typically reduces heap usage by 10–20% in JSON-heavy REST APIs and MyBatis entity mappings.

3. **Memory Uncommit (Idle Pods)**:
   ```bash
   -XX:G1PeriodicGCInterval=60000
   -XX:G1PeriodicGCSysCompaction
   ```
   Periodically triggers a concurrent GC cycle when the application is idle to return unused heap memory back to the OS/cgroup, reducing the pod's resident set size (RSS).

### 3.3 Non-Heap & Thread Memory Limits
Prevent native memory leaks from growing unbounded and triggering cgroup OOM:

1. **Metaspace Cap**:
   ```bash
   -XX:MetaspaceSize=96m
   -XX:MaxMetaspaceSize=256m
   ```
2. **Thread Stack Optimization**:
   ```bash
   -Xss512k
   ```
   Reduces thread stack from default 1024k (1MB) to 512k, significantly reducing native memory footprint when handling thread pools (e.g., Tomcat request threads + HikariCP + OTel exporter threads).

### 3.4 Out-of-Memory (OOM) Handling & Diagnostics
When the JVM runs out of heap, it must terminate immediately rather than lingering in a corrupted, unresponsive state:

1. **Fast Pod Termination & K8s Recovery**:
   ```bash
   -XX:+ExitOnOutOfMemoryError
   ```
   Instructs the JVM to exit immediately upon encountering an `OutOfMemoryError`. Kubernetes marks the container failed and triggers a restart according to the pod restart policy.

2. **Heap Dump Diagnostics**:
   ```bash
   -XX:+HeapDumpOnOutOfMemoryError
   -XX:HeapDumpPath=/tmp/heapdump.hprof
   ```
   Captures an HPROF memory snapshot before exit for offline root-cause analysis (e.g. memory leaks, unclosed cursors).

### 3.5 CPU CFS Quota & Thread Allocation
In Kubernetes, CPU limits (e.g. `limits.cpu: "1000m"`) are enforced via Linux CFS (Completely Fair Scheduler) quotas:
- By default, Java 21 container ergonomics reads the quota and sets `Runtime.getRuntime().availableProcessors()`.
- To avoid over-allocating parallel GC threads on multi-core host nodes with low container CPU limits:
  ```bash
  -XX:ParallelGCThreads=2
  -XX:ConcGCThreads=1
  ```

---

## 4. Container Profile Presets

### Profile A: Balanced Production (Recommended for G1GC / 1024Mi Limit)
Designed for `limits.memory: 1024Mi` and `limits.cpu: 1000m`:

```bash
JAVA_TOOL_OPTIONS="-XX:InitialRAMPercentage=50.0 \
-XX:MaxRAMPercentage=75.0 \
-XX:MinRAMPercentage=50.0 \
-XX:+UseG1GC \
-XX:MaxGCPauseMillis=100 \
-XX:+UseStringDeduplication \
-XX:MetaspaceSize=96m \
-XX:MaxMetaspaceSize=256m \
-Xss512k \
-XX:+ExitOnOutOfMemoryError \
-XX:+HeapDumpOnOutOfMemoryError \
-XX:HeapDumpPath=/tmp/heapdump.hprof \
-Djava.security.egd=file:/dev/./urandom"
```

### Profile B: Ultra-Low Latency (Generational ZGC / Java 21)
Suitable for response-time sensitive APIs with larger memory headroom (`limits.memory: 1536Mi`+):

```bash
JAVA_TOOL_OPTIONS="-XX:InitialRAMPercentage=60.0 \
-XX:MaxRAMPercentage=70.0 \
-XX:+UseZGC \
-XX:+ZGenerational \
-XX:MetaspaceSize=96m \
-XX:MaxMetaspaceSize=256m \
-Xss512k \
-XX:+ExitOnOutOfMemoryError \
-Djava.security.egd=file:/dev/./urandom"
```

### Profile C: Low-Footprint / Constrained Sandbox (`<= 512Mi`)
For lightweight microservices or edge pods with strict 512Mi limit:

```bash
JAVA_TOOL_OPTIONS="-XX:InitialRAMPercentage=50.0 \
-XX:MaxRAMPercentage=65.0 \
-XX:+UseSerialGC \
-XX:MetaspaceSize=64m \
-XX:MaxMetaspaceSize=160m \
-Xss256k \
-XX:+ExitOnOutOfMemoryError \
-Djava.security.egd=file:/dev/./urandom"
```

---

## 5. Integrating Settings into Kubernetes Deployment

The standard cloud-native pattern is to provide JVM arguments via the `JAVA_TOOL_OPTIONS` environment variable in the Kubernetes `ConfigMap` or `Deployment` manifest. The HotSpot JVM picks up `JAVA_TOOL_OPTIONS` automatically on startup without requiring Dockerfile rebuilds.

### Example in `k8s/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: message-service-config
  labels:
    app: message-service
data:
  SPRING_PROFILES_ACTIVE: "kubernetes"
  MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE: "health,info,metrics"
  DB_HOST: "postgres"
  DB_PORT: "5432"
  DB_NAME: "messagedb"
  OTEL_METRICS_URL: "http://otel-collector.observability.svc.cluster.local:4318/v1/metrics"
  JAVA_TOOL_OPTIONS: >-
    -XX:InitialRAMPercentage=50.0
    -XX:MaxRAMPercentage=75.0
    -XX:MinRAMPercentage=50.0
    -XX:+UseG1GC
    -XX:MaxGCPauseMillis=100
    -XX:+UseStringDeduplication
    -XX:MetaspaceSize=96m
    -XX:MaxMetaspaceSize=256m
    -Xss512k
    -XX:+ExitOnOutOfMemoryError
    -XX:+HeapDumpOnOutOfMemoryError
    -XX:HeapDumpPath=/tmp/heapdump.hprof
    -Djava.security.egd=file:/dev/./urandom
```

---

## 6. Observability & Verification Metrics

Monitor the impact of GC tuning in Grafana (`http://grafana.localhost/` dashboard `message-service`):

1. **JVM Heap Memory (`jvm_memory_used_bytes{area="heap"}`)**:
   - Verify steady sawtooth pattern without exponential baseline creep.
2. **GC Pause Duration (`jvm_gc_pause_milliseconds_sum` / count)**:
   - Verify young generation collection pauses stay below the target (e.g. `< 100ms`).
3. **Container Memory RSS vs Cgroup Limit (`container_memory_working_set_bytes`)**:
   - Verify total pod memory stays below 85% of `1024Mi` to avoid kernel OOM killer triggers.
4. **Active Threads (`jvm_threads_live`)**:
   - Confirm thread counts remain stable during k6 load testing runs.
