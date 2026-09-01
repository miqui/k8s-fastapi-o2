# Message Service (Spring Boot + MyBatis + PostgreSQL on Kubernetes)

A Spring Boot 4 REST API running on Java 21, persisting `Message` resources through
[MyBatis 3](https://mybatis.org/mybatis-3/) against a PostgreSQL database, deployed
to a local [kind](https://kind.sigs.k8s.io/) cluster.

This is a sibling of [`k8s-springboot`](../k8s-springboot), which keeps messages
in-memory. Everything else (REST API shape, validation, RFC 9457 problem details,
actuator probes) is unchanged — only the persistence layer differs.

## Architecture

- **API**: Spring Boot 4 / Java 21, `MessageController` -> `MessageService` -> `MessageMapper` (MyBatis).
- **Persistence**: MyBatis 3 mapper (`src/main/resources/mapper/MessageMapper.xml`) against PostgreSQL 16.
  Schema is created on startup from `src/main/resources/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`).
- **Cluster topology** (`k8s/kind-config.yaml`): 1 control-plane + 4 workers.
  - 2 workers labeled `workload=api` — the `message-service` Deployment (2 replicas) is pinned there
    via `nodeSelector`, with preferred pod anti-affinity so the two replicas spread across those nodes.
  - 1 worker labeled `workload=db` — the `postgres` StatefulSet (1 replica, with a `PersistentVolumeClaim`)
    is pinned there via `nodeSelector`.
  - 1 worker labeled `workload=observability` — the OTel Collector, Prometheus, and Grafana
    Deployments (see below) are pinned there via `nodeSelector`.
- **Ingress**: the control-plane node is labeled `ingress-ready=true` and maps host ports 80/443
  (see [kind's Ingress guide](https://kind.sigs.k8s.io/docs/user/ingress/)). `deploy-kind.sh` installs
  the ingress-nginx controller, and `k8s/ingress.yaml` routes all paths to `message-service`
  (a plain `ClusterIP` Service — no NodePort). The API is reachable at `http://localhost/...` with
  no port number and no `kubectl port-forward` needed.
- **Observability** (`k8s/observability/`, namespace `observability`): the app pushes Micrometer
  metrics as OTLP (`io.micrometer:micrometer-registry-otlp` + `management.otlp.metrics.export.url`,
  see `com.example.messageservice` app config) to an **OpenTelemetry Collector**
  (`otel-collector`, `otel/opentelemetry-collector-contrib`), which re-exposes them in Prometheus
  format on port 8889. **Prometheus** scrapes the collector, and **Grafana** (provisioned with that
  Prometheus datasource and a pre-built `message-service` dashboard — request rate/latency, JVM
  heap, GC pauses, HikariCP connections, CPU, thread count) is exposed via
  `k8s/observability/ingress.yaml` at `http://grafana.localhost/` (default creds `admin`/`admin`,
  see `k8s/observability/grafana-secret.yaml`). `*.localhost` resolves to `127.0.0.1` on modern
  OSes/browsers without any `/etc/hosts` change.

## Running the Application

### 1. Local run against a PostgreSQL instance

Start a local PostgreSQL instance (or reuse the one deployed in kind — see below) and point the app at it:

```bash
docker run --rm -d --name message-postgres \
  -e POSTGRES_DB=messagedb -e POSTGRES_USER=message_app -e POSTGRES_PASSWORD=message_app \
  -p 5432:5432 postgres:16-alpine

java -Xms512m -Xmx1024m \
     -XX:+UseG1GC \
     -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=./heapdump.hprof \
     -Djava.security.egd=file:/dev/./urandom \
     -jar target/message-service-0.0.1-SNAPSHOT.jar
```

*Note: If port `8080` is in use on your host, append `--server.port=8081` to bind to another port.*

Datasource connection details are configurable via environment variables (see
`src/main/resources/application.properties`): `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.
Defaults connect to `localhost:5432/messagedb` with `message_app`/`message_app`.

---

### 2. Container / Kubernetes Execution (Percentage-Based Heap Settings)

When running inside containers or Kubernetes pods with resource constraints (e.g. requests `512Mi` / limits `1024Mi`), use percentage-based flags so the JVM automatically adapts to cgroup limits while leaving overhead for native memory, Metaspace, and thread stacks:

```bash
java -XX:InitialRAMPercentage=50.0 \
     -XX:MaxRAMPercentage=75.0 \
     -XX:MinRAMPercentage=50.0 \
     -XX:+UseG1GC \
     -XX:+ExitOnOutOfMemoryError \
     -Djava.security.egd=file:/dev/./urandom \
     -jar target/message-service-0.0.1-SNAPSHOT.jar
```

---

### JVM Flags Reference

| Flag | Description |
| :--- | :--- |
| `-Xms512m / -Xmx1024m` | Allocates 512MB initial heap and limits max heap to 1GB to prevent unbounded memory growth. |
| `-XX:MaxRAMPercentage=75.0` | Dynamically sizes maximum heap to 75% of container/cgroup RAM limit, reserving 25% for native buffers and Metaspace. |
| `-XX:InitialRAMPercentage=50.0` | Sets initial heap to 50% of container memory limit. |
| `-XX:+UseG1GC` | Uses the Garbage-First collector (default in Java 21), optimized for low latency and multi-core throughput. |
| `-XX:+ExitOnOutOfMemoryError` | Immediately terminates the JVM on OutOfMemoryError, enabling container orchestrators (like Kubernetes) to restart the pod. |
| `-XX:+HeapDumpOnOutOfMemoryError` | Automatically generates a `.hprof` heap dump file upon OOM for post-mortem diagnostics. |
| `-Djava.security.egd=file:/dev/./urandom` | Uses a non-blocking entropy source to speed up Tomcat and cryptographic startup. |

---

## Building the JAR

To build the executable JAR:

```bash
./mvnw clean package
```

The output artifact is generated in `target/message-service-0.0.1-SNAPSHOT.jar`.

Tests run against an in-memory H2 database in PostgreSQL-compatibility mode (see the `test`
Spring profile / `src/test/resources`), so `./mvnw test` needs no Docker daemon or external
PostgreSQL instance. Production and the kind deployment still use real PostgreSQL — see
`src/main/resources/schema.sql` vs. the test-only `src/test/resources/schema-h2.sql`.

---

## Deployment with Kind / Kubernetes

- **Deploy to local Kind cluster**: `./deploy-kind.sh`
  - Creates a 4-node kind cluster (1 control-plane, 2 API workers, 1 DB worker) if it doesn't exist yet.
  - Installs the ingress-nginx controller and waits for it to become ready.
  - Builds the `message-service:latest` image and loads it into the cluster.
  - Applies `k8s/` via Kustomize: `Secret` + `ConfigMap`s, the `postgres` `StatefulSet`/headless `Service`,
    the `message-service` `Deployment`/`Service` (`ClusterIP`), and an `Ingress` routing to it.
  - Waits for PostgreSQL to become ready before waiting on the API rollout (the API Deployment also runs a
    `wait-for-postgres` init container using `pg_isready`).
- **Tear down cluster**: `./teardown-kind.sh`
- **Test endpoints**: `./test-api.sh`

### Pushing a Java code change to the running cluster

The kind cluster, PostgreSQL data, and ingress-nginx controller don't need to be recreated for an
application code change. `imagePullPolicy: IfNotPresent` means the Deployment won't notice a
same-tagged image has changed on its own, so after reloading the image you need to explicitly tell
it to roll out new pods:

```bash
docker build -t message-service:latest .
kind load docker-image message-service:latest --name kind-springboot-mybatis-cluster
kubectl rollout restart deployment/message-service
kubectl rollout status deployment/message-service
```

`kubectl rollout restart` recreates the pods one at a time (respecting the Deployment's rolling
update strategy), so the API stays available throughout — it just now runs the code from the image
you just rebuilt and loaded. `k8s/postgres-statefulset.yaml`, `k8s/*.yaml` in general, and the
cluster/node topology are untouched by this flow; only re-apply `kubectl apply -k k8s/` first if
you've also changed a manifest (env vars, resources, the Ingress, etc.) alongside the code.

`deploy-kind.sh` already points your current `kubectl` context at the cluster
(`kubectl config use-context kind-kind-springboot-mybatis-cluster`), so no extra kubeconfig setup is
needed for the commands above. If you want a standalone `kubeconfig.yml` for this cluster instead —
e.g. to hand to another tool, or to talk to it without touching your default `~/.kube/config` context —
generate one with:

```bash
kind get kubeconfig --name kind-springboot-mybatis-cluster > kubeconfig.yml
export KUBECONFIG=./kubeconfig.yml   # use it for the current shell
kubectl get nodes -L workload
```

`kind get kubeconfig` always regenerates the file from the cluster's current certs, so re-run it if the
cluster is ever torn down and recreated. Don't commit `kubeconfig.yml` — it embeds client certificates
that grant full cluster-admin access to this kind cluster (`.gitignore` already excludes it by name).

> The credentials in `k8s/secret.yaml` are plaintext defaults meant only for this disposable local
> kind cluster. Do not reuse them, and manage real secrets with a proper secrets manager in any
> shared or production environment.

### Viewing metrics in Grafana

`deploy-kind.sh` also applies `k8s/observability/` (a separate Kustomization, in its own
`observability` namespace) and waits for it to roll out. Once deployed:

- **Grafana**: `http://grafana.localhost/` — log in with `admin`/`admin` (same local-dev-only caveat
  as `k8s/secret.yaml` applies to `k8s/observability/grafana-secret.yaml`) and open the pre-provisioned
  **message-service** dashboard. It's provisioned from `k8s/observability/grafana-dashboard-json-configmap.yaml`
  as plain PromQL against real, verified metric names — if you add new panels, check the exact metric
  names Prometheus actually stores first (they differ from the raw OTLP names — see below).
- **Prometheus** (not exposed via Ingress; use `kubectl port-forward -n observability svc/prometheus 9090:9090`
  if you want its own UI at `http://localhost:9090`): scrapes `otel-collector.observability.svc.cluster.local:8889`,
  the OTel Collector's Prometheus exporter.
- **OTel Collector** (`k8s/observability/otel-collector-configmap.yaml`): receives OTLP metrics on
  `:4317` (gRPC) / `:4318` (HTTP) from every `message-service` pod
  (`OTEL_METRICS_URL` in `k8s/configmap.yaml` points at it) and re-exports them in Prometheus format
  on `:8889`.

Metric names go through two translations before they reach Prometheus: Micrometer's own names
(`http.server.requests`) become OTLP metric names, then the Collector's Prometheus exporter
sanitizes them into Prometheus-safe names with unit suffixes (`http_server_requests_milliseconds_count`,
`_sum`, `_bucket`, etc.). Don't guess these when adding a panel — port-forward Prometheus and check
`http://localhost:9090/api/v1/label/__name__/values`, or query `/api/v1/query?query=<metric>` directly.

Prometheus here has no `PersistentVolumeClaim` — its data is ephemeral and resets whenever its pod
restarts. That's fine for a local metrics-exploration setup; add a PVC to `prometheus-deployment.yaml`
(or switch to a `StatefulSet` like `postgres`) if you want it to survive restarts.

---

## Profiling with JProfiler

### 1. Profiling the Local Standalone JAR

#### Step 1: Start the application with the JProfiler agent
Add the `-agentpath` JVM argument pointing to your local JProfiler agent library:

**macOS:**
```bash
java -agentpath:/Applications/JProfiler.app/Contents/Resources/app/bin/macos/libjprofilerti.jnilib=port=8849,nowait \
     -Xms512m -Xmx1024m \
     -jar target/message-service-0.0.1-SNAPSHOT.jar
```

**Linux:**
```bash
java -agentpath:/opt/jprofiler/bin/linux-x64/libjprofilerti.so=port=8849,nowait \
     -Xms512m -Xmx1024m \
     -jar target/message-service-0.0.1-SNAPSHOT.jar
```

> **Tip:** Replace `nowait` with `wait` if you want the JVM to pause on startup until the JProfiler GUI connects (useful for profiling initialization and startup time).

#### Step 2: Connect from JProfiler GUI
1. Open the **JProfiler GUI**.
2. Go to **Session** > **Attach to JVM**.
3. Select **Attach to remote JVM** (or Quick Attach).
4. Enter Host: `localhost` and Port: `8849`.
5. Click **Connect** and select your profiling settings (e.g., CPU recording, Memory allocation tracking).

---

### 2. Profiling Inside Kubernetes / Container

#### Step 1: Pass agent via `JAVA_TOOL_OPTIONS`
If JProfiler agent is installed in the container image or mounted via a volume, configure `JAVA_TOOL_OPTIONS`:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-agentpath:/opt/jprofiler/bin/linux-x64/libjprofilerti.so=port=8849,nowait"
```

#### Step 2: Port-forward the profiling port
Forward port `8849` from the running pod to your local machine:

```bash
kubectl port-forward pod/<message-service-pod-name> 8849:8849
```

#### Step 3: Attach JProfiler GUI
In JProfiler GUI:
1. Choose **Session** > **Attach to JVM** > **Attach to remote JVM**.
2. Set Host: `localhost`, Port: `8849`.
3. Start recording CPU, Memory, or Threads.

---

### 3. Quick Attach (No Agent Argument Required)
If the application is already running locally with standard JVM settings on Java 21:
1. Open **JProfiler**.
2. Select **Session** > **Attach to JVM** > **Quick Attach**.
3. Select `message-service-0.0.1-SNAPSHOT.jar` from the list of running local Java processes.
4. JProfiler will dynamically load the profiling agent via JVMTI.

---

## Profiling in IntelliJ IDEA (No Plugin Required)

IntelliJ IDEA features built-in profiling (powered by async-profiler, JFR, and native memory/CPU profilers) without requiring any third-party plugins:

### 1. Run with Profiler
1. Open `MessageServiceApplication.java`.
2. Click the gutter icon next to the `main` method (or the Profiler icon in the top toolbar) and select **Run 'MessageServiceApplication' with Profiler**.
3. Choose your profiling configuration preset (e.g., **CPU and Memory Allocation**, **CPU**, or **Java Flight Recorder**).
4. Inspect real-time flame graphs, call trees, method lists, and memory allocations directly in the **Profiler** tool window (`View` > `Tool Windows` > `Profiler`).

### 2. Attach Built-in Profiler to Running Process
If the Spring Boot app or JAR is already running in your terminal:
1. Go to **Run** > **Attach Profiler to Process...** (or open the **Profiler** tool window).
2. Select the `message-service` / Java 21 process from the list.
3. Choose the profiling preset and capture snapshots.

### 3. Using External JProfiler with IntelliJ (Without Plugin)
To launch with external JProfiler from IntelliJ without installing plugins:
1. Go to **Run** > **Edit Configurations...** > `MessageServiceApplication`.
2. Under **Modify options** > **Add VM options**, add:
   ```bash
   -agentpath:/Applications/JProfiler.app/Contents/Resources/app/bin/macos/libjprofilerti.jnilib=port=8849,nowait
   ```
3. Run or Debug normally in IntelliJ, then open JProfiler and use **Attach to remote JVM** on `localhost:8849`.
