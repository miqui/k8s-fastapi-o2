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
- **Cluster topology** (`k8s/kind-config.yaml`): 1 control-plane + 5 workers.
  - 2 workers labeled `workload=api` — the `message-service` Deployment (2 replicas) is pinned there
    via `nodeSelector`, with preferred pod anti-affinity so the two replicas spread across those nodes.
  - 1 worker labeled `workload=db` — the `postgres` StatefulSet (1 replica, with a `PersistentVolumeClaim`)
    is pinned there via `nodeSelector`.
  - 1 worker labeled `workload=observability` — the OTel Collector, Prometheus, and Grafana
    Deployments (see below) are pinned there via `nodeSelector`.
  - 1 worker labeled `workload=cache` — the `hazelcast` Deployment (see below) is pinned there
    via `nodeSelector`.
- **Lookup cache**: `MessageService.getMessageById` is `@Cacheable` (cache name `messages`), backed by
  a standalone [Hazelcast](https://github.com/hazelcast/hazelcast) member (`k8s/hazelcast-deployment.yaml`,
  `k8s/hazelcast-service.yaml`) that each `message-service` pod connects to as a **client**
  (`com.example.messageservice.config.HazelcastConfig`) rather than embedding a member per pod - that
  keeps the cache independent of app pod restarts/scaling. `updateMessage`/`deleteMessage` are
  `@CacheEvict` to keep the shared cache correct. The app falls back to a plain in-memory
  `ConcurrentMapCacheManager` under the `test` Spring profile (`src/test/java/.../config/TestCacheConfig.java`),
  since tests run with no Hazelcast server available.

  There's deliberately no client-side Near Cache here: it was tried and removed after verifying
  (in a real 2-pod deployment) that it went stale across pods after `@CacheEvict` - a pod other
  than the one that wrote an update kept serving old data indefinitely, since the client SDK's
  cross-client near-cache invalidation broadcast wasn't reliably reaching the other pod's near-cache.
  Reads go straight to the shared Hazelcast member instead, which stays correct - see
  `HazelcastConfig`'s Javadoc. Also note: Spring Boot's `cache.gets`/`cache.puts` Micrometer metrics
  read 0 for this cache regardless - they poll `getLocalMapStats()`, which isn't populated for a plain
  (non-near-cache) Hazelcast client map. The caching itself works (verified via response latency: a
  cold lookup vs. a warm one, and via direct cross-pod consistency checks after update/delete), it's
  just not visible through that particular metric.
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

Start a local PostgreSQL instance (or reuse the one deployed in kind — see below), plus a local
Hazelcast member for the cache, and point the app at both:

```bash
docker run --rm -d --name message-postgres \
  -e POSTGRES_DB=messagedb -e POSTGRES_USER=message_app -e POSTGRES_PASSWORD=message_app \
  -p 5432:5432 postgres:16-alpine

docker run --rm -d --name message-hazelcast \
  -e HZ_CLUSTERNAME=message-service-cache \
  -p 5701:5701 hazelcast/hazelcast:5.5.0

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
Defaults connect to `localhost:5432/messagedb` with `message_app`/`message_app`. Hazelcast connection
details are `HAZELCAST_HOST`/`HAZELCAST_PORT`, defaulting to `localhost:5701`. If you skip starting a
local Hazelcast member, the app will fail to start (the client connection is required, not optional) -
that's deliberate, matching how the DB connection behaves; there's no profile that runs with the cache
disabled outside of tests.

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
  - Creates a 6-node kind cluster (1 control-plane, 2 API workers, 1 DB worker, 1 observability
    worker, 1 cache worker) if it doesn't exist yet.
  - Installs the ingress-nginx controller and waits for it to become ready.
  - Builds the `message-service:latest` image and loads it into the cluster.
  - Applies `k8s/observability/` (OTel Collector, Prometheus, Grafana - see Architecture above).
  - Applies `k8s/` via Kustomize: `Secret` + `ConfigMap`s, the `postgres` `StatefulSet`/headless
    `Service`, the `hazelcast` `Deployment`/`Service`, the `message-service` `Deployment`/`Service`
    (`ClusterIP`), and an `Ingress` routing to it.
  - Waits for PostgreSQL and Hazelcast to become ready before waiting on the API rollout (the API
    Deployment also runs `wait-for-postgres` and `wait-for-hazelcast` init containers).
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

### Adding a new kind node

Unlike the code-push flow above, node topology **cannot** be changed on a running kind cluster —
kind has no "add node" command, since each node's kubeadm role is fixed at `kind create cluster`
time via `k8s/kind-config.yaml`. Adding one means recreating the cluster.

1. **Add the new worker to `k8s/kind-config.yaml`**, matching the existing API workers' pattern:
   ```yaml
     - role: worker
       kubeadmConfigPatches:
         - |
           kind: JoinConfiguration
           nodeRegistration:
             kubeletExtraArgs:
               node-labels: "workload=api"
   ```

2. **Recreate the cluster** with the updated config:
   ```bash
   kind delete cluster --name kind-springboot-mybatis-cluster
   kind create cluster --name kind-springboot-mybatis-cluster --config k8s/kind-config.yaml
   ```
   This wipes all cluster state (PostgreSQL data, any messages created only at runtime) - it's a
   fresh cluster, rebuilt from the manifests in `k8s/`.

3. **Bump the API replica count** in `k8s/deployment.yaml` (`spec.replicas: 2` -> `3`). The
   Deployment's `nodeSelector: workload: api` already targets any node with that label; it's the
   extra replica - combined with the existing `podAntiAffinity` spread by `kubernetes.io/hostname`
   - that actually lands a pod on the new node instead of just adding another pod to an
   already-occupied one.

4. **Redeploy** - since the cluster is new, `deploy-kind.sh` detects it doesn't exist yet and
   recreates it from step 1's config, then reapplies every manifest including the new replica count:
   ```bash
   ./deploy-kind.sh
   ```

5. **Verify** the new node exists and is running the API:
   ```bash
   kubectl get nodes -L workload -o wide
   kubectl get pods -l app=message-service -o wide
   ```
   Confirm a `message-service` pod's `NODE` column shows the new worker.

### Viewing metrics in Grafana

`deploy-kind.sh` also applies `k8s/observability/` (a separate Kustomization, in its own
`observability` namespace) and waits for it to roll out. Once deployed:

- **Grafana**: `http://grafana.localhost/` — log in with `admin`/`admin` (same local-dev-only caveat
  as `k8s/secret.yaml` applies to `k8s/observability/grafana-secret.yaml`) and open one of three
  pre-provisioned dashboards, all in `k8s/observability/grafana-dashboard-json-configmap.yaml` as plain
  PromQL against real, verified metric names - if you add new panels, check the exact metric names
  Prometheus actually stores first (they differ from the raw OTLP names — see below):
  - **message-service**: app-level request rate/latency, JVM heap, GC pauses, HikariCP connections,
    CPU, thread count.
  - **kind cluster ops**: cluster-wide node/pod health - nodes ready, pod phases/restarts, per-node
    CPU/memory/disk (via node-exporter), per-namespace container CPU/memory (via cAdvisor).
  - **JVM & GC**: a `message-service`-only deep dive per JVM-GC.md's tuning goals - heap by region,
    non-heap, container memory vs. its limit, GC pause/frequency/allocation/promotion rate, thread
    states, class loading. Panels are colored against JVM-GC.md's own targets (85% memory ceiling,
    100ms max GC pause, 70-75% heap headroom) so you can see at a glance whether tuning changes are
    landing. Broken down **per pod** (`k8s_pod_name` label) rather than merged across replicas - see
    the two fixes below, both required for that to work at all.
- **Prometheus** (not exposed via Ingress; use `kubectl port-forward -n observability svc/prometheus 9090:9090`
  if you want its own UI at `http://localhost:9090`): scrapes `otel-collector.observability.svc.cluster.local:8889`
  (app metrics), plus `kube-state-metrics` and every `node-exporter` pod, and every node's kubelet
  cAdvisor endpoint via the API server proxy (see `k8s/observability/prometheus-configmap.yaml` and
  `prometheus-rbac.yaml`) for the cluster-ops dashboard.
- **OTel Collector** (`k8s/observability/otel-collector-configmap.yaml`): receives OTLP metrics on
  `:4317` (gRPC) / `:4318` (HTTP) from every `message-service` pod
  (`OTEL_METRICS_URL` in `k8s/configmap.yaml` points at it) and re-exports them in Prometheus format
  on `:8889`. Two things had to be true for per-pod JVM metrics to actually work, both already wired
  up: (1) `resource_to_telemetry_conversion.enabled: true` on the Prometheus exporter - without it,
  OTLP *resource* attributes like `k8s.pod.name` are dropped rather than becoming Prometheus labels,
  so metrics from every pod collapse into one indistinguishable series; (2) the app itself has to send
  that resource attribute in the first place (`management.opentelemetry.resource-attributes.k8s.pod.name`
  in `application.properties`, sourced from a `POD_NAME` Downward API env var in `k8s/deployment.yaml`).

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

---

## Load Testing with k6

The repository includes four parameterized [k6](https://k6.io/) scripts using `k6-utils` to benchmark
and simulate concurrent traffic against the REST API. They all follow the same conventions (same
environment variables, same VU/think-time shape), so any of the "Running the Load Tests" commands
below work with any of them - just swap the filename.

| Script | What it exercises |
| :--- | :--- |
| `k6-retrieve-messages.js` | `GET /api/messages` (read path), including a paginated `?limit=&offset=` request - see [Pagination](#pagination). |
| `k6-create-messages.js` | `POST /api/messages` (write path). |
| `k6-message-lifecycle.js` | Full CRUD per iteration: create -> get by id -> update -> delete. |
| `k6-invalid-requests.js` | Negative paths: invalid create (400), missing id (404), blank id (400) - all RFC 9457 problem-details responses. |
| `k6-transaction-isolation.js` | Concurrency/lost-update regression test for `PUT /api/messages/{id}`'s optimistic locking - see [Concurrency & Transaction Isolation](#concurrency--transaction-isolation). |

### Prerequisites

Install `k6` using Homebrew or your package manager:

```bash
brew install k6
```

### Script Configuration

Every script supports the same environment variables:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `VUS` | Number of concurrent virtual users | `10` |
| `DURATION` | Duration of the test run (e.g. `10s`, `1m`) | `10s` |
| `BASE_URL` | Target API endpoint URL | `http://localhost/api/messages` |

**Built-in Thresholds:**
- `http_req_failed`: error rate must remain below 1% (`rate<0.01`).
- `http_req_duration`: 95th percentile latency must be under 500ms (`p(95)<500`).

`k6-invalid-requests.js` is the one exception: every request in it *intentionally* gets a 4xx
response, and k6 counts any non-2xx/3xx as `http_req_failed` by default - so that metric would
always read ~100% there and isn't a useful signal. It uses `checks: ['rate>0.99']` instead, which
measures what actually matters for that script: did the API return the *correct* error (status +
problem-details body) essentially every time.

`k6-transaction-isolation.js` also deviates: a 409 Conflict from a losing optimistic-lock race is an
*expected*, correct response, not a failure, so its `PUT` calls use `http.expectedStatuses(200, 409)`
to keep those out of `http_req_failed`. See the next section for what it's actually checking.

### Running the Load Tests

#### 1. Default Run (10 VUs for 10s)
```bash
k6 run k6-retrieve-messages.js
```

#### 2. Parameterized using `-e` flags (Recommended)
```bash
k6 run -e VUS=25 -e DURATION=30s k6-create-messages.js
```

#### 3. Parameterized using shell environment variables
```bash
VUS=50 DURATION=1m k6 run k6-message-lifecycle.js
```

#### 4. Custom endpoint / remote target
```bash
k6 run -e BASE_URL=http://localhost:8080/api/messages -e VUS=20 -e DURATION=15s k6-invalid-requests.js
```

## Concurrency & Transaction Isolation

**Isolation-level review.** Nothing in this codebase sets a transaction isolation level anywhere -
not in `application.properties`, not on HikariCP, not via `@Transactional`, and there's no
`@Transactional` annotation on `MessageService` at all. MyBatis's `SqlSessionTemplate`, with no
active Spring-managed transaction, opens and commits a fresh autocommit session **per mapper
call**, so every read or write individually runs at PostgreSQL's unmodified default
(`READ COMMITTED`). Tuning that level wouldn't have mattered here, though: the real bug wasn't
*which* isolation level applied to each statement, it was that `updateMessage()` used to run its
read (`findById`) and its write (`update`) as **two entirely separate, uncoordinated
transactions** - no isolation level closes a gap between two unrelated transactions.

**The bug.** A classic lost update: two concurrent callers could both read the same row, then both
write, with the second write silently overwriting the first's change with no error to either
caller.

**The fix - optimistic locking via a `version` column.** `messages` now has a `version INTEGER`
column (see `schema.sql`'s idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, since
`spring.sql.init.mode=always` reruns it on every startup against tables that may predate it).
`GET` responses include `version`, and `PUT /api/messages/{id}` requires the caller to send back
the version it read:

```json
{ "title": "New title", "content": "New content", "version": 3 }
```

`MessageMapper.update` applies the write conditionally - `UPDATE messages SET ..., version =
version + 1 WHERE id = ? AND version = ?` - using **the version the client submitted**, not a
version the server re-reads for itself. That distinction matters: guarding against a server's own
just-read value only protects the few microseconds between that read and its own write: it can't
tell whether the *client's* value was stale, and a stale client value is exactly what happens on a
real GET-then-PUT flow. If the row has moved on since the client's read, 0 rows match and
`GlobalExceptionHandler` turns that into `409 Conflict` (`OptimisticLockingFailureException`) with
a problem-details body telling the caller to refetch and retry - instead of silently losing their
change.

**Verifying it - `k6-transaction-isolation.js`.** The script has many VUs race to increment a
counter kept in one message's `content` field: each iteration does `GET` (reads `content` and
`version`) then `PUT` (submits `content + 1` guarded by the `version` it just read). Every `200`
must correspond to a real, distinct `+1`; `409`s are expected under contention and are reported
separately (`write_conflicts`), not counted as failures. Run it and compare the two custom metrics
in the summary:

```bash
VUS=20 DURATION=15s k6 run k6-transaction-isolation.js
```

```
successful_increments..........: 213    ...
final_counter_value.............: avg=212 ...   <- best-effort read; see below
write_conflicts.................: 28723  ...
```

`successful_increments` and `final_counter_value` should be equal. `final_counter_value` is read
back through the app's own `GET` endpoint, which goes through the Hazelcast-backed `@Cacheable`
read-through cache (see `HazelcastConfig`) - immediately after a burst of writes, that cache's own
eviction can lag the true row by a count or two, so a trailing gap of 1-2 there is a read artifact
of the *cache*, not a lost update. To see the authoritative value, query Postgres directly:

```bash
kubectl exec -i postgres-0 -- psql -U message_app -d messagedb \
  -c "SELECT content, version FROM messages WHERE sender = 'k6-isolation-test';"
```

**Note:** because `PUT` now requires `version`, `k6-message-lifecycle.js`'s update step sends
`version: 0` (correct immediately after its own `create` step, since a freshly created message
always starts at version 0).

## Pagination

`GET /api/messages` used to return the entire `messages` table in one response - fine with a
handful of demo rows, but unbounded against a table that's had any real traffic (the local kind
cluster's demo table has accumulated well over a million rows from repeated k6 runs). It now
accepts two optional query parameters:

| Parameter | Description | Default | Bounds |
| :--- | :--- | :--- | :--- |
| `limit` | Max number of messages to return | `50` | `1`-`200` |
| `offset` | Number of messages to skip, ordered by `created_at, id` | `0` | `>= 0` |

```bash
curl "http://localhost/api/messages?limit=20&offset=40"
```

The response body is still a plain JSON array (existing clients that don't pass these parameters
are unaffected apart from now getting at most 50 messages instead of everything). Alongside it, an
`X-Total-Count` response header carries the *total* row count, independent of `limit`/`offset`, so
a client can compute how many pages remain (`ceil(X-Total-Count / limit)`). Out-of-range values
(`limit=0`, `limit=500`, `offset=-1`, etc.) are rejected with a `400` RFC 9457 problem-details body
via the same `HandlerMethodValidationException` path as the id-blank check on `GET
/api/messages/{id}`.

`findAll`'s `ORDER BY created_at, id LIMIT ... OFFSET ...` (see `MessageMapper.xml`) needs `id` as
a tiebreaker so paging stays stable even when two rows share the same millisecond-precision
`created_at` - without it, ties could reorder across pages and either skip or repeat a row. A
matching index, `idx_messages_created_at_id` (see `schema.sql`), keeps that sort itself from
scanning the whole table on every request; dropping it turns pagination into a full-table sort per
page, which on a million-plus-row table is the difference between double-digit-millisecond and
multi-second responses.
