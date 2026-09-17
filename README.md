# Message Service (GraphQL / Apollo Server + Prisma + PostgreSQL on Kubernetes)

A GraphQL API (Node.js 22+/TypeScript, [Apollo Server](https://www.apollographql.com/docs/apollo-server/))
exposing `Message` and `Author` types, persisting through [Prisma](https://www.prisma.io/) against a
PostgreSQL database, deployed to a local [kind](https://kind.sigs.k8s.io/) cluster.

This is a GraphQL rewrite of a sibling Spring Boot + MyBatis REST API (`k8s-springboot-mybatis-o2`,
kept as the local `java-origin` git remote for reference — see [Git history](#git-history) below).
Everything below the application layer — PostgreSQL, the standalone Hazelcast cache member, the kind
cluster topology, ingress, and the full observability stack — is unchanged from that sibling project.

## Architecture

- **API**: Apollo Server (`src/schema.ts` typeDefs) -> resolvers (`src/resolvers.ts`) -> Prisma Client
  (`src/prisma.ts`), served over Express at `POST /graphql`.
- **Data model**: `Author` (id, name, email) has many `Message`s (id, title, content, `version` for
  optimistic locking, `author` relation) - see [prisma/schema.prisma](prisma/schema.prisma). Prisma
  migrations (`prisma/migrations/`) replace the old `schema.sql`; `prisma migrate deploy` runs
  idempotently on every container startup (see the Dockerfile's `ENTRYPOINT`).
- **Cluster topology** (`k8s/kind-config.yaml`): 1 control-plane + 6 workers.
  - 2 workers labeled `workload=api` — the `message-service` Deployment (3 replicas) is pinned there
    via `nodeSelector`, with preferred pod anti-affinity so replicas spread across those nodes. A
    `HorizontalPodAutoscaler` (`k8s/hpa.yaml`) keeps it between 3 and 6 replicas, scaling on CPU
    (70% average utilization) and memory (80%) against the container's `resources.requests` in
    `k8s/deployment.yaml`. It reads usage from **metrics-server**, which `deploy-kind.sh` installs
    with `--kubelet-insecure-tls` (kind's kubelet serving certs aren't signed for metrics-server's
    default verification).
  - 1 worker labeled `workload=db` — the `postgres` StatefulSet (1 replica, with a `PersistentVolumeClaim`)
    is pinned there via `nodeSelector`.
  - 1 worker labeled `workload=observability` — the OTel Collector, Prometheus, and Grafana
    Deployments (see below) are pinned there via `nodeSelector`.
  - 1 worker labeled `workload=cache` — the `hazelcast` Deployment (see below) is pinned there
    via `nodeSelector`.
  - 1 worker labeled `workload=openobserve` — the OpenObserve `StatefulSet` (see below) is pinned
    there via `nodeSelector`.
  - [Headlamp](https://headlamp.dev/) (a general-purpose Kubernetes web UI, own `headlamp`
    namespace) is pinned to the `workload=observability` node too, alongside Grafana - it's a
    lightweight single-pod dashboard with no metrics-pipeline role of its own, so it doesn't
    warrant a dedicated node.
- **Lookup cache**: `message(id)` reads through a `messages` map on a standalone
  [Hazelcast](https://github.com/hazelcast/hazelcast) member (`k8s/hazelcast-deployment.yaml`,
  `k8s/hazelcast-service.yaml`) that each `message-service` pod connects to as a **client**
  (`src/cache.ts`) rather than embedding a member per pod - that keeps the cache independent of app
  pod restarts/scaling. `updateMessage`/`deleteMessage` evict the entry to keep the shared cache
  correct.

  There's deliberately no client-side Near Cache here: it was tried (in the original Java version of
  this app) and removed after verifying, in a real multi-pod deployment, that it went stale across
  pods after an evict - a pod other than the one that wrote an update kept serving old data
  indefinitely, since the client SDK's cross-client near-cache invalidation broadcast wasn't reliably
  reaching the other pod's near-cache. Reads go straight to the shared Hazelcast member instead,
  which stays correct - see `src/cache.ts`'s comments. Connecting to Hazelcast is not optional: same
  as the DB connection, a missing/unreachable member fails startup rather than silently running
  without a cache.
- **Ingress**: the control-plane node is labeled `ingress-ready=true` and maps host ports 80/443
  (see [kind's Ingress guide](https://kind.sigs.k8s.io/docs/user/ingress/)). `deploy-kind.sh` installs
  the ingress-nginx controller, and `k8s/ingress.yaml` routes all paths to `message-service`
  (a plain `ClusterIP` Service — no NodePort). The API is reachable at `http://localhost/graphql` with
  no port number and no `kubectl port-forward` needed.
- **Observability** (`k8s/observability/`, namespace `observability`): the app pushes metrics as OTLP
  (`@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-metrics-otlp-http`, see `src/telemetry.ts`)
  to an **OpenTelemetry Collector** (`otel-collector`, `otel/opentelemetry-collector-contrib`), which
  re-exposes them in Prometheus format on port 8889. **Prometheus** scrapes the collector, and
  **Grafana** (provisioned with that Prometheus datasource and pre-built dashboards — request
  rate/latency, event-loop lag, process memory, Prisma connection-pool stats) is exposed via
  `k8s/observability/ingress.yaml` at `http://grafana.localhost/` (credentials configured via Secrets /
  1Password, see `k8s/observability/grafana-secret.yaml`). `*.localhost` resolves to `127.0.0.1` on
  modern OSes/browsers without any `/etc/hosts` change.

  **OpenObserve** (`openobserve/openobserve-standalone` Helm chart - single-node, not the HA chart;
  installed by `deploy-kind.sh`, values in `k8s/observability/openobserve-values.yaml`) is a second,
  independent observability backend, fed by Prometheus `remote_write`. It's exposed at
  `http://openobserve.localhost/` (credentials configured via Secrets / 1Password, see
  `k8s/observability/openobserve-values.yaml` and `k8s/observability/openobserve-prometheus-secret.yaml`
  - the latter is what Prometheus itself authenticates with, kept out of its ConfigMap on principle
  even though this is all disposable local-kind-only). Query its data under the `default` org, stream
  names matching the Prometheus metric names (e.g. `graphql_requests_total`,
  `container_memory_working_set_bytes`).

  **[Headlamp](https://headlamp.dev/)** (`headlamp/headlamp` Helm chart, own `headlamp` namespace -
  a general-purpose Kubernetes web UI, not part of the message-service metrics pipeline above;
  installed by `deploy-kind.sh`, values in `k8s/headlamp/headlamp-values.yaml`) gives a
  browse/inspect/edit view over every resource in the cluster (pods, deployments, logs, exec,
  node status, etc.), which is a different job than Grafana/OpenObserve's time-series metrics. It's
  exposed at `http://headlamp.localhost/`. No OIDC is configured, so the login page needs a bearer
  token; the chart's default `ClusterRoleBinding` grants its own `headlamp` ServiceAccount
  `cluster-admin`, so the simplest local token is `kubectl create token headlamp -n headlamp
  --duration=24h` (that's cluster-admin in the browser - fine for this disposable local kind
  cluster only, not a pattern to reuse anywhere shared).

  `write_relabel_configs` in `k8s/observability/prometheus-configmap.yaml` deliberately keeps only
  four scrape jobs - `otel-collector` (the message-service's own metrics), plus `node-exporter`,
  `kube-state-metrics`, and `kubernetes-nodes-cadvisor` (the same three jobs behind the "kind cluster
  ops" Grafana dashboard) - not every job Prometheus scrapes. See `PROMETHEUS.md` for why (an earlier
  attempt at forwarding everything unfiltered overflowed OpenObserve's single-node in-memory MemTable).

## Git history

The local `.git` directory was carried over from the original Spring Boot/MyBatis project on purpose,
as background reference for this rewrite - `git log` / `git show` against commits before this
migration still show the Java implementation. That remote is kept as `java-origin`; this project's own
GitHub remote (`origin`) is a separate, newly created repository.

## Running the Application

### 1. Local run against PostgreSQL + Hazelcast

Start a local PostgreSQL instance (or reuse the one deployed in kind — see below), plus a local
Hazelcast member for the cache, and point the app at both:

```bash
docker run --rm -d --name message-postgres \
  -e POSTGRES_DB=messagedb -e POSTGRES_USER=message_app -e POSTGRES_PASSWORD=message_app \
  -p 5432:5432 postgres:16-alpine

docker run --rm -d --name message-hazelcast \
  -e HZ_CLUSTERNAME=message-service-cache \
  -p 5701:5701 hazelcast/hazelcast:5.5.0

npm install
npm run prisma:migrate:deploy
npm run build
npm start
```

*Or, for iterative development with auto-reload: `npm run dev` (uses `tsx watch`, no build step).*

Datasource connection details are configurable via environment variables (see `src/env.ts`):
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`. Defaults connect to
`localhost:5432/messagedb` with `message_app`/`message_app`. Hazelcast connection details are
`HAZELCAST_HOST`/`HAZELCAST_PORT`, defaulting to `localhost:5701`. If you skip starting a local
Hazelcast member, the app will fail to start (the client connection is required, not optional) -
that's deliberate, matching how the DB connection behaves.

The GraphQL endpoint is `http://localhost:8080/graphql` (`PORT` env var to change it); Apollo Server's
own landing page there gives you an in-browser query explorer against the live schema (see
[GraphQL API](#graphql-api) below). Liveness/readiness probes are at `/health/liveness` and
`/health/readiness`.

---

### 2. Building the app

```bash
npm install
npm run build
```

Compiles `src/` to `dist/` via `tsc` (`tsconfig.json`). `npm run prisma:generate` regenerates the
Prisma Client after any `prisma/schema.prisma` change (also run automatically whenever `npm install`
runs, via Prisma's own postinstall hook).

---

## Deployment with Kind / Kubernetes

- **Deploy to local Kind cluster**: requires the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`),
  installed and signed in (`op signin`) - `deploy-kind.sh` checks both and fails fast otherwise, since
  PostgreSQL/Grafana/OpenObserve credentials all come from it and there's no valid fallback.
    ```bash
    cp .env.example .env
    # Edit .env with your op://<vault>/<item>/<field> URIs
    op run --env-file=.env -- ./deploy-kind.sh
    ```
  - Creates a 7-node kind cluster (1 control-plane, 2 API workers, 1 DB worker, 1 observability
    worker, 1 cache worker, 1 OpenObserve worker) if it doesn't exist yet.
  - Installs the ingress-nginx controller and waits for it to become ready.
  - Installs metrics-server (patched with `--kubelet-insecure-tls`) and waits for it to become ready -
    required for the `message-service` `HorizontalPodAutoscaler` to read CPU/memory usage.
  - Builds the `message-service:latest` image and loads it into the cluster.
  - Applies `k8s/observability/` (OTel Collector, Prometheus, Grafana - see Architecture above), dynamically injects observability secrets from environment, then
    installs OpenObserve via Helm (`openobserve/openobserve-standalone` - see Architecture above)
    and Headlamp via Helm (`headlamp/headlamp` - see Architecture above).
  - Applies `k8s/` via Kustomize: `Secret` + `ConfigMap`s, dynamically injects PostgreSQL database credentials from environment, the `postgres` `StatefulSet`/headless
    `Service`, the `hazelcast` `Deployment`/`Service`, the `message-service` `Deployment`/`Service`
    (`ClusterIP`)/`HorizontalPodAutoscaler`, and an `Ingress` routing to it.
  - Waits for PostgreSQL and Hazelcast to become ready before waiting on the API rollout (the API
    Deployment also runs `wait-for-postgres` and `wait-for-hazelcast` init containers).
- **Tear down cluster**: `./teardown-kind.sh`
- **Test endpoints**: `./test-api.sh`

### Pushing a code change to the running cluster

The kind cluster, PostgreSQL data, and ingress-nginx controller don't need to be recreated for an
application code change. `imagePullPolicy: IfNotPresent` means the Deployment won't notice a
same-tagged image has changed on its own, so after reloading the image you need to explicitly tell
it to roll out new pods:

```bash
docker build -t message-service:latest .
kind load docker-image message-service:latest --name kind-graphql-prisma-cluster
kubectl rollout restart deployment/message-service
kubectl rollout status deployment/message-service
```

`kubectl rollout restart` recreates the pods one at a time (respecting the Deployment's rolling
update strategy), so the API stays available throughout — it just now runs the code from the image
you just rebuilt and loaded. This also runs `prisma migrate deploy` again on every pod start (see the
Dockerfile's `ENTRYPOINT`) - idempotent, so a code-only change is a no-op there; a schema change picks
up its new migration automatically. `k8s/postgres-statefulset.yaml`, `k8s/*.yaml` in general, and the
cluster/node topology are untouched by this flow; only re-apply `kubectl apply -k k8s/` first if
you've also changed a manifest (env vars, resources, the Ingress, etc.) alongside the code.

`deploy-kind.sh` already points your current `kubectl` context at the cluster
(`kubectl config use-context kind-kind-graphql-prisma-cluster`), so no extra kubeconfig setup is
needed for the commands above. If you want a standalone `kubeconfig.yml` for this cluster instead —
e.g. to hand to another tool, or to talk to it without touching your default `~/.kube/config` context —
generate one with:

```bash
kind get kubeconfig --name kind-graphql-prisma-cluster > kubeconfig.yml
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
   kind delete cluster --name kind-graphql-prisma-cluster
   kind create cluster --name kind-graphql-prisma-cluster --config k8s/kind-config.yaml
   ```
   This wipes all cluster state (PostgreSQL data, any messages created only at runtime) - it's a
   fresh cluster, rebuilt from the manifests in `k8s/`.

3. **Bump the API replica count** in `k8s/deployment.yaml` (`spec.replicas: 3` -> `4`). The
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

- **Grafana**: `http://grafana.localhost/` — log in with credentials configured via Secrets / 1Password (see
  `k8s/observability/grafana-secret.yaml`) and open one of six
  pre-provisioned dashboards, all in `k8s/observability/grafana-dashboard-json-configmap.yaml` as plain
  PromQL against real, verified metric names - if you add new panels, check the exact metric names
  Prometheus actually stores first (they differ from the raw OTLP names — see below):
  - **API RED & Saturation**: the caller's-eye view of `message-service` - GraphQL request
    rate/latency percentiles/errors by operation, Prisma connection-pool saturation, CPU throttling,
    memory vs. limit, restarts/readiness - see [API RED & Saturation Dashboard](#api-red--saturation-dashboard) below.
  - **graphql-api**: app-level request rate/latency by operation, event-loop lag, process memory,
    Prisma connection-pool stats.
  - **kind cluster ops**: cluster-wide node/pod health - nodes ready, pod phases/restarts, per-node
    CPU/memory/disk (via node-exporter), per-namespace container CPU/memory (via cAdvisor).
  - **PostgreSQL Ops & Queries**: connections, transaction/tuple rates, buffer cache hit ratio,
    locks, checkpoints, and per-query call rate/latency - see
    [PostgreSQL Metrics (postgres_exporter)](#postgresql-metrics-postgres_exporter) below.
  - **Hazelcast Cache**: cluster size, connected clients, cache hit ratio/operation rate/latency
    for the `messages` map, member heap, GC time - see
    [Hazelcast Metrics (JMX exporter)](#hazelcast-metrics-jmx-exporter) below.
  - **OpenObserve Ops**: self-monitoring for the OpenObserve backend itself (up/down, disk usage,
    process RSS/CPU/open fds/uptime, HTTP request rate & p95/p99 latency by endpoint, ingest
    rate/bytes by stream type, in-memory MemTable size, WAL bytes) - scraped from OpenObserve's own
    `/metrics`, which is off by default (`config.ZO_PROMETHEUS_ENABLED` in
    `k8s/observability/openobserve-values.yaml` - confirmed live: with it off, `/metrics` returns
    HTTP 200 with an empty body). The MemTable Size panel is worth watching directly - that's the
    exact thing that overflowed (see the "kind cluster ops" scope note above) before OpenObserve's
    resources were bumped and remote_write was scoped down.
- **Prometheus** (not exposed via Ingress; use `kubectl port-forward -n observability svc/prometheus 9090:9090`
  if you want its own UI at `http://localhost:9090`): scrapes `otel-collector.observability.svc.cluster.local:8889`
  (app metrics), `postgres.default.svc.cluster.local:9187` (postgres_exporter) and
  `hazelcast.default.svc.cluster.local:9404` (Hazelcast's JMX exporter) cross-namespace - see below
  for both - plus `kube-state-metrics` and every `node-exporter` pod, and every node's kubelet
  cAdvisor endpoint via the API server proxy (see `k8s/observability/prometheus-configmap.yaml` and
  `prometheus-rbac.yaml`) for the cluster-ops dashboard.
- **OpenObserve**: `http://openobserve.localhost/` — log in with credentials configured via Secrets / 1Password
  (see `k8s/observability/openobserve-values.yaml`). It receives the
  message-service's own metrics plus kind cluster ops metrics (Prometheus `remote_write`s the
  `otel-collector`, `node-exporter`, `kube-state-metrics`, and `kubernetes-nodes-cadvisor` jobs into it
  — see `write_relabel_configs` in `k8s/observability/prometheus-configmap.yaml`; every other scraped
  job is deliberately dropped before it reaches OpenObserve), under org `default`, one stream per
  Prometheus metric name (e.g. `graphql_requests_total`,
  `container_memory_working_set_bytes`, `node_memory_MemAvailable_bytes`). Query it from the UI's
  Logs/Metrics explorer, or via its search API:
  ```bash
  NOW_US=$(( $(date +%s) * 1000000 )); START_US=$(( NOW_US - 3600*1000000 ))
  curl -s -u "$ZO_ROOT_USER_EMAIL:$ZO_ROOT_USER_PASSWORD" -X POST 'http://openobserve.localhost/api/default/_search?type=metrics' \
    -H 'Content-Type: application/json' \
    -d "{\"query\":{\"sql\":\"SELECT * FROM \\\"graphql_requests_total\\\" ORDER BY _timestamp DESC LIMIT 5\",\"start_time\":$START_US,\"end_time\":$NOW_US,\"size\":5}}"
  ```
  (`start_time`/`end_time` are epoch microseconds; OpenObserve rejects a query whose range doesn't
  look like one, e.g. `0`.)
- **Headlamp**: `http://headlamp.localhost/` — a general-purpose Kubernetes dashboard (not a
  metrics tool), for browsing/inspecting/editing any resource across the whole cluster: pods,
  deployments, logs, exec-into-pod, node status, etc. Log in with a bearer token:

  1. Generate a token for the chart's own `headlamp` ServiceAccount, which already has
     `cluster-admin` via its default `ClusterRoleBinding` (see `k8s/headlamp/headlamp-values.yaml`):
     ```bash
     kubectl create token headlamp -n headlamp --duration=24h
     ```
  2. Open `http://headlamp.localhost/` and paste the token into the login page's token field.
     On macOS, pipe straight to the clipboard instead of copying from a terminal selection - long
     tokens are prone to picking up a stray line break or trailing whitespace when copied by hand,
     which Headlamp will reject as an invalid token:
     ```bash
     kubectl create token headlamp -n headlamp --duration=24h | tr -d '\n' | pbcopy
     ```
  3. The token expires after `--duration` (24h above) - re-run the command and log in again once
     it does; there's no refresh flow.
- **OTel Collector** (`k8s/observability/otel-collector-configmap.yaml`): receives OTLP metrics on
  `:4317` (gRPC) / `:4318` (HTTP) from every `message-service` pod
  (`OTEL_METRICS_URL` in `k8s/configmap.yaml` points at it) and re-exports them in Prometheus format
  on `:8889`. Two things had to be true for per-pod metrics to actually work, both already wired
  up: (1) `resource_to_telemetry_conversion.enabled: true` on the Prometheus exporter - without it,
  OTLP *resource* attributes like `k8s.pod.name` are dropped rather than becoming Prometheus labels,
  so metrics from every pod collapse into one indistinguishable series; (2) the app itself has to send
  that resource attribute in the first place (`src/telemetry.ts`, sourced from a `POD_NAME` Downward
  API env var in `k8s/deployment.yaml`).

Prometheus here has no `PersistentVolumeClaim` — its data is ephemeral and resets whenever its pod
restarts. That's fine for a local metrics-exploration setup; add a PVC to `prometheus-deployment.yaml`
(or switch to a `StatefulSet` like `postgres`) if you want it to survive restarts.

### PostgreSQL Metrics (postgres_exporter)

[`postgres_exporter`](https://github.com/prometheus-community/postgres_exporter) runs as a sidecar
in the `postgres-0` pod (see `k8s/postgres-statefulset.yaml`) - it shares the pod's network
namespace, so it reaches Postgres over `localhost:5432` using the same `postgres-credentials`
Secret the app already uses. `k8s/postgres-service.yaml` exposes it on a `metrics` port (`9187`)
alongside Postgres' own `5432`, and Prometheus (running in the separate `observability` namespace)
scrapes it cross-namespace via `postgres.default.svc.cluster.local:9187`.

**Ops metrics** come from postgres_exporter's built-in collectors, enabled by default: connection
counts and per-state breakdown (`pg_stat_activity_count`), transaction/tuple rates and cache hit
ratio (`pg_stat_database_*`), lock counts by mode (`pg_locks_count`), and checkpoint/buffer activity
(`pg_stat_bgwriter_*`) - note the `stat_` infix; there is no bare `pg_bgwriter_*` metric.

**Query metrics** need the `pg_stat_statements` extension, which isn't in Postgres by default:

1. The `postgres` container's startup args add `shared_preload_libraries=pg_stat_statements` (must
   happen at server start, not via SQL) and `pg_stat_statements.track=all` (also count statements
   run inside functions).
2. `CREATE EXTENSION IF NOT EXISTS pg_stat_statements` is declared via Prisma's
   `postgresqlExtensions` preview feature (see `prisma/schema.prisma`'s `datasource` block) and
   applied by the initial migration - it attaches to that already-preloaded library on first deploy.
3. The exporter's `--collector.stat_statements` flag (plus `--collector.stat_statements.include_query`
   for a `queryid` -> SQL-text mapping) exposes per-`queryid` call count, total time, and rows via
   `pg_stat_statements_calls_total` / `_seconds_total` / `_rows_total` - the numeric metrics are
   labeled by `queryid`/`user`/`datname` only (not the SQL text itself, to keep cardinality sane);
   `pg_stat_statements_query_id` is the separate `queryid` -> `query` lookup table, capped at the
   top 20 statements and 1024 characters each by the exporter's own defaults.

If you change the postgres container's startup args or the `postgres-exporter` sidecar, the
StatefulSet needs `kubectl apply -k k8s/` (it's part of the main Kustomization, not
`k8s/observability/`); a Prisma migration change needs the app image rebuilt and redeployed (see
"Pushing a code change to the running cluster" above) since `prisma migrate deploy` runs from the
image's own `prisma/migrations/` directory. Prometheus config changes need a `kubectl rollout
restart deployment/prometheus -n observability` too - it has no `--web.enable-lifecycle` reload
endpoint wired up, so it only reads `prometheus.yml` at startup.

### Hazelcast Metrics (JMX exporter)

Hazelcast's own [Management Center has a built-in Prometheus exporter](https://docs.hazelcast.com/management-center/5.11/integrate/prometheus-monitoring)
(`hazelcast.mc.prometheusExporter.enabled`), but it turned out to be an **Enterprise-licensed
feature** - confirmed live by deploying Management Center and getting `402 LICENSE_REQUIRED` from
its `/metrics` endpoint, not just by reading the docs. Rather than requiring a paid license for a
local dev cluster, `k8s/hazelcast-deployment.yaml` instead attaches
[`jmx_prometheus_javaagent`](https://github.com/prometheus/jmx_exporter) directly to the Hazelcast
member's own JVM - a free, open-source, in-process javaagent (no separate Hazelcast license, no
remote JMX/RMI port needed) that reads the member's JMX MBeans and re-exposes them as Prometheus
text format on its own port. This is entirely on the Hazelcast server side and unaffected by the
app's own language - the standalone `hazelcast/hazelcast:5.5.0` image still runs its own JVM
regardless of what language the client (`message-service`) is written in.

- An `initContainer` (`curlimages/curl`) downloads the agent jar into a volume shared with the
  `hazelcast` container on every pod start, rather than baking it into a custom Hazelcast image.
- The `hazelcast` container's `JAVA_OPTS` sets `-Dhazelcast.metrics.jmx.enabled=true` (registers
  Hazelcast's cluster/map/operation stats as `com.hazelcast:*` JMX MBeans - off by default) and
  `-javaagent:...=9404:/etc/jmx-exporter/config.yaml` (port `9404` is the agent's own listener,
  unrelated to Hazelcast's member port `5701`). The agent's config
  (`k8s/hazelcast-jmx-exporter-configmap.yaml`) just whitelists `com.hazelcast:*` and uses the
  exporter's default attribute-derived naming rather than hand-written per-metric rules.
- `k8s/hazelcast-service.yaml` exposes port `9404` alongside `5701`, and Prometheus scrapes it
  cross-namespace via `hazelcast.default.svc.cluster.local:9404`.

**Verified metric names** (checked live via port-forward before writing dashboard panels - the
exporter's default naming isn't documented anywhere, and Hazelcast's own MBean layout isn't
guaranteed stable across versions): `com_hazelcast_metrics_<attribute>`, labeled by `prefix` (the
metric's category - `cluster`, `map`, `memory`, `gc`, `tcp.connection`, `client.endpoint`, etc.) and
`tag0` for per-instance metrics (e.g. a map name). Per-map metrics come back with `tag0` set to the
*literal string* `"name=messages"` **including the embedded quote characters** (an artifact of how
Hazelcast quotes JMX ObjectName tags, which the exporter just passes through) - matching that
exactly requires escaping those quotes twice over (once for PromQL, once for JSON), so every panel
here uses a `tag0=~".*name=messages.*"` regex substring match instead, which sidesteps the
escaping entirely. Key metrics used: `com_hazelcast_metrics_size{prefix="cluster"}` (member count),
`com_hazelcast_metrics_count{prefix="client.endpoint"}` (connected clients - matches
`message-service`'s pod count, since each pod is a Hazelcast client), `hits`/`getcount`/`putcount`/
`removecount`/`totalgetlatency`/`totalputlatency`/`ownedentrycount`/`ownedentrymemorycost`/
`evictioncount`/`expirationcount` (all `prefix="map"`, per-map via `tag0`), and
`usedheap`/`committedheap`/`maxheap` (`prefix="memory"`).

### API RED & Saturation Dashboard

`api-red.json`'s panels follow the standard [RED method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)
(**R**ate, **E**rrors, **D**uration) plus enough saturation signal to explain *why* rate/errors/
duration are moving, scoped to `message-service` and its direct dependencies:

- **Rate**: `graphql_requests_total` overall and broken down by GraphQL `operation` name (the
  `operationName` sent with the request - see the `metricsPlugin` in `src/telemetry.ts`).
- **Duration**: p50/p90/p95/p99 latency (overall and per-operation) from
  `graphql_request_duration_ms`.
- **Errors**: overall error ratio (gauge, thresholds at 1%/5%) and error rate by operation, both from
  `graphql_errors_total` - a request counts as an error whenever its GraphQL response includes a
  non-empty `errors[]` array, regardless of extensions.code.
- **Saturation**: Prisma connection-pool utilization (busy/idle/open) and average query/pool-wait
  duration (`prisma_pool_connections_*` / `prisma_client_queries_*`, sampled from
  `prisma.$metrics.json()` - see `registerPrismaMetrics` in `src/telemetry.ts`), CPU throttling
  ratio, container memory vs. its limit, and pod restarts/readiness.

Unlike the old REST version of this dashboard, there's no `uri!~"/actuator.*"` filter needed: the
`graphql_*` metrics are only ever recorded for real GraphQL operations against `/graphql` (see the
Apollo plugin in `src/telemetry.ts`) - the `/health/liveness` and `/health/readiness` probe routes
never touch that instrumentation at all, so there's no probe traffic to exclude in the first place.

**Deliberately not implemented, so not claimed as covered by this dashboard**: 429/timeout/retry
rates (the app has no rate limiting or explicit downstream timeouts to measure), business-outcome
errors beyond a resolver throwing (out of scope per this dashboard's own design goal), deployment
markers, and trace exemplars (no distributed tracing is wired up in this stack - only metrics).
Downstream dependency RED for Postgres and Hazelcast already exist as their own dashboards (linked
above) rather than being duplicated here.

---

## Load Testing with k6

The repository includes four parameterized [k6](https://k6.io/) scripts using `k6-utils` to benchmark
and simulate concurrent GraphQL traffic against the API. They all follow the same conventions (same
environment variables, same VU/think-time shape), so any of the "Running the Load Tests" commands
below work with any of them - just swap the filename.

| Script | What it exercises |
| :--- | :--- |
| `k6-retrieve-messages.js` | The `messages` query (read path), including a paginated `limit`/`offset` request - see [Pagination](#pagination). |
| `k6-create-messages.js` | The `createMessage` mutation (write path); creates one shared `Author` in `setup()`. |
| `k6-message-lifecycle.js` | Full CRUD per iteration: `createMessage` -> `message` -> `updateMessage` -> `deleteMessage`. |
| `k6-invalid-requests.js` | Negative paths: invalid create (`BAD_USER_INPUT`), missing id (`NOT_FOUND`), a missing required GraphQL variable (request-level validation error, HTTP 400) - see [GraphQL API](#graphql-api). |
| `k6-transaction-isolation.js` | Concurrency/lost-update regression test for `updateMessage`'s optimistic locking - see [Concurrency & Transaction Isolation](#concurrency--transaction-isolation). |

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
| `BASE_URL` | Target GraphQL endpoint URL | `http://localhost/graphql` |

**Built-in Thresholds:**
- `http_req_failed`: error rate must remain below 1% (`rate<0.01`).
- `http_req_duration`: 95th percentile latency must be under 500ms (`p(95)<500`).

`k6-invalid-requests.js` is the one exception: every request in it *intentionally* triggers a
GraphQL-level error, and a resolver-thrown error (`BAD_USER_INPUT`, `NOT_FOUND`) still answers HTTP
200 (only the missing-variable case, a request-level validation error, answers 400 - see [GraphQL
API](#graphql-api)) - so `http_req_failed` isn't a meaningful signal there. It uses
`checks: ['rate>0.99']` instead, which measures what actually matters for that script: did the API
return the *correct* error shape essentially every time.

`k6-transaction-isolation.js` also deviates: a `CONFLICT` GraphQL error from a losing optimistic-lock
race is an *expected*, correct response (still HTTP 200), not a failure - see the next section for
what it's actually checking.

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
k6 run -e BASE_URL=http://localhost:8080/graphql -e VUS=20 -e DURATION=15s k6-invalid-requests.js
```

## Concurrency & Transaction Isolation

**Isolation-level review.** Nothing in this codebase sets a transaction isolation level anywhere -
Prisma opens a fresh connection per query against PostgreSQL's unmodified default
(`READ COMMITTED`). Tuning that level wouldn't have mattered here, though: the real risk isn't
*which* isolation level applies to each statement, it's that a naive `updateMessage` could run its
read and its write as two entirely separate, uncoordinated operations - no isolation level closes a
gap between two unrelated round trips.

**The bug this guards against.** A classic lost update: two concurrent callers could both read the
same row, then both write, with the second write silently overwriting the first's change with no
error to either caller.

**The fix - optimistic locking via a `version` column.** `Message` has a `version Int @default(0)`
field (see `prisma/schema.prisma`). Queries include `version`, and the `updateMessage` mutation
requires the caller to send back the version it read:

```graphql
mutation {
  updateMessage(id: "…", input: { content: "New content", version: 3 }) {
    id
    version
  }
}
```

`updateMessage` (see `src/resolvers.ts`) applies the write conditionally - Prisma's `updateMany({
where: { id, version }, data: { version: { increment: 1 }, ... } })`, which compiles to `UPDATE
messages SET ..., version = version + 1 WHERE id = $1 AND version = $2` - using **the version the
client submitted**, not a version the server re-reads for itself. That distinction matters: guarding
against a server's own just-read value only protects the few milliseconds between that read and its
own write; it can't tell whether the *client's* value was stale, and a stale client value is exactly
what happens on a real read-then-update flow. If the row has moved on since the client's read, 0 rows
match and the resolver throws a `CONFLICT` GraphQL error telling the caller to refetch and retry -
instead of silently losing their change.

**Verifying it - `k6-transaction-isolation.js`.** The script has many VUs race to increment a
counter kept in one message's `content` field: each iteration reads (`content` and `version`) then
calls `updateMessage` (submits `content + 1` guarded by the `version` it just read). Every success
must correspond to a real, distinct `+1`; `CONFLICT` errors are expected under contention and are
reported separately (`write_conflicts`), not counted as failures. Run it and compare the two custom
metrics in the summary:

```bash
VUS=20 DURATION=15s k6 run k6-transaction-isolation.js
```

```
successful_increments..........: 213    ...
final_counter_value.............: avg=212 ...   <- best-effort read; see below
write_conflicts.................: 28723  ...
```

`successful_increments` and `final_counter_value` should be equal. `final_counter_value` is read
back through the app's own `message` query, which goes through the Hazelcast-backed read-through
cache (see `src/cache.ts`) - immediately after a burst of writes, that cache's own eviction can lag
the true row by a count or two, so a trailing gap of 1-2 there is a read artifact of the *cache*, not
a lost update. To see the authoritative value, query Postgres directly:

```bash
kubectl exec -i postgres-0 -- psql -U message_app -d messagedb \
  -c "SELECT content, version FROM messages WHERE title = 'k6-transaction-isolation counter';"
```

**Note:** because `updateMessage` now requires `version`, `k6-message-lifecycle.js`'s update step
sends `version: 0` (correct immediately after its own `createMessage` step, since a freshly created
message always starts at version 0).

## Pagination

The `messages` query returns a `MessagePage { items, totalCount }` rather than the whole table in one
response - unbounded against a table that's had any real traffic. It accepts two optional arguments:

| Argument | Description | Default | Bounds |
| :--- | :--- | :--- | :--- |
| `limit` | Max number of messages to return | `50` | `1`-`200` |
| `offset` | Number of messages to skip, ordered by `createdAt, id` | `0` | `>= 0` |

```graphql
query {
  messages(limit: 20, offset: 40) {
    totalCount
    items { id title content version author { name } }
  }
}
```

`totalCount` carries the *total* row count, independent of `limit`/`offset`, so a client can compute
how many pages remain (`ceil(totalCount / limit)`). Out-of-range values (`limit: 0`, `limit: 500`,
`offset: -1`, etc.) are rejected with a `BAD_USER_INPUT` GraphQL error via the same
`clampPagination`/`throwIfInvalid` path used by every other resolver-level validation (see
`src/resolvers.ts`).

The resolver's `orderBy: [{ createdAt: "asc" }, { id: "asc" }]` needs `id` as a tiebreaker so paging
stays stable even when two rows share the same millisecond-precision `createdAt` - without it, ties
could reorder across pages and either skip or repeat a row. A matching index, `@@index([createdAt,
id])` (see `prisma/schema.prisma`), keeps that sort itself from scanning the whole table on every
request; dropping it turns pagination into a full-table sort per page, which on a large table is the
difference between double-digit-millisecond and multi-second responses.

Unlike the old REST API, there's no separate "unknown query parameter" check to write:
GraphQL's schema is typed, so a client that sends a field or argument the schema doesn't declare gets
a request-level validation error (HTTP 400) automatically, before any resolver runs - see
[GraphQL API](#graphql-api) below.

## GraphQL API

The schema (`src/schema.ts`) is served at `POST /graphql`; Apollo Server's own landing page at that
same URL in a browser gives you Apollo Sandbox, an in-browser query explorer against the live schema
(introspection is left on - this is a disposable local dev API, not a public one). There's no
separate spec file to keep in sync by hand, unlike the old REST API's generated OpenAPI document -
the schema *is* the contract, and it's enforced by the GraphQL executor itself.

**Two different kinds of errors, two different HTTP statuses.** This is a deliberate, spec-mandated
behavior change from the old REST API's uniform RFC 9457 problem-details responses:

- A **request error** - the query fails GraphQL parsing/validation before any resolver runs (bad
  syntax, a missing required variable, an unknown field) - answers **HTTP 400**, no `data` in the
  body.
- An **execution error** - a resolver throws (`NOT_FOUND`, `BAD_USER_INPUT`, `CONFLICT`, see
  `src/errors.ts`) - still answers **HTTP 200**, with the error in the response body's `errors[]`
  array (`extensions.code` carries the machine-readable reason) and `data` set to `null` for the
  failed field. This is normal for GraphQL: a single request can partially succeed (some fields
  resolve, others error), so a single HTTP status can't represent the whole response the way it did
  for one-endpoint-one-outcome REST calls.

See [`k6-invalid-requests.js`](k6-invalid-requests.js) for both cases exercised directly.
