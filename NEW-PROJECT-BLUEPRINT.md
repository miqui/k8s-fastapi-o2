# New Project Blueprint: Swapping the Application Stack (FastAPI REST example)

> **Audience: an AI coding agent.** This is a brief for starting a new project from this
> repository's platform. Only the **application layer** gets replaced. The platform layers
> (kind cluster, Kustomize manifests, Argo CD, Kyverno, Postgres, Hazelcast, and the
> observability stack) stay as they are. Your job is to build a new service that satisfies
> the **contracts** in section 2 so those layers keep working without redesign.
>
> The worked example swaps **Node.js + Apollo GraphQL + Prisma** for
> **Python + FastAPI (REST) + SQLAlchemy/Alembic**. The same contracts apply to any other
> stack (Go, Java, .NET, and so on).

---

## 0. Rules for the agent

1. **Don't redesign the platform.** Leave the cluster topology, the Argo CD flow, the Kyverno
   rules, the observability pipeline, and the deployment scripts alone. The only platform files
   you may edit are the ones in section 6, and only in the ways described there.
2. **The contracts in section 2 are hard requirements.** If a contract conflicts with a
   framework default, the contract wins. Override the framework default.
3. **Keep the domain behavior** described in section 4: validation limits, optimistic
   locking, pagination bounds, error codes, cache-aside, and idempotent seeding. Only the
   transport changes, from GraphQL to REST.
4. **"Done" means the checks in section 8 pass.** Code that compiles isn't enough.
5. Use the existing code as the reference for behavior. Port the behavior, not the code:
   `src/index.ts`, `src/resolvers.ts`, `src/validation.ts`, `src/errors.ts`, `src/cache.ts`,
   `src/telemetry.ts`, `src/tracing.ts`, `prisma/schema.prisma`.

---

## 1. What stays and what changes

| Layer | Status | Notes |
|---|---|---|
| kind cluster (`k8s/kind-config.yaml`) | **Keep** | 1 control plane + 6 workers. Node labels: `workload=api` (x3), `db`, `cache`, `observability`, `openobserve`. Host ports 80 and 443 go to ingress-nginx. |
| Bootstrap scripts (`deploy-kind.sh`, `teardown-kind.sh`) | **Keep** | Run with `op run --env-file=.env -- ./deploy-kind.sh`. Only edit them if you rename things (section 6). |
| Argo CD (`k8s/argocd/`) | **Keep** | Auto-syncs `k8s/` from `main`. Image Updater picks new image tags. |
| Kyverno (`k8s/policies/`, `check-policies.sh`) | **Keep** | Enforced in `default`. The new workload must comply. |
| Postgres 16 (`k8s/postgres-*.yaml`) | **Keep** | One StatefulSet with one database per service. |
| Hazelcast 5.5 (`k8s/hazelcast-*.yaml`) | **Keep** | Single member, cluster name `message-service-cache`. |
| Observability (`k8s/observability/`) | **Keep** | OTel Collector, Prometheus, Grafana, OpenObserve, log collector. **Exception:** the Grafana dashboard JSON needs new metric names (section 6). |
| App code (`src/`, `prisma/`, `package.json`, `tsconfig.json`) | **Replace** | Replace with the FastAPI project in section 3. |
| `Dockerfile` | **Replace** | Python multi-stage build, same runtime contract. |
| `.github/workflows/*-ci.yml` | **Adapt** | Swap the Node steps for Python steps. Keep the tag format and the push targets. |
| `test-api.sh`, `k6-*.js` | **Rewrite** | Same scenarios and thresholds, REST calls instead of GraphQL. |
| `GRAPHQL-API-DESIGN.md` | **Replace** | Write an `API-DESIGN.md` for the REST surface. |

---

## 2. Application contracts (hard requirements)

### 2.1 Process and HTTP
- Listen on **`0.0.0.0:8080`**. Read the port from `PORT`, default `8080`. The container port is named `http`.
- Run **as a non-root user with UID/GID 1000**. The pod sets `runAsUser: 1000` and `runAsNonRoot: true`.
- The server process must be **PID 1**, or be started with `exec`, so that it receives `SIGTERM`.
- Stateless. The deployment runs 3–6 replicas under the HPA, and any pod can serve any request.

### 2.2 Health endpoints (the paths are fixed and referenced by the probes)
| Path | Behavior |
|---|---|
| `GET /health/liveness` | Always `200 {"status":"UP"}` while the process is running. |
| `GET /health/readiness` | `200 {"status":"UP"}` only after the DB **and** the cache are connected and the seed has run. Otherwise `503 {"status":"DOWN"}`. It goes back to `503` at the start of shutdown. |

Probe budgets from `k8s/deployment.yaml`:
- **Startup:** liveness path, 10s initial delay, 5s period, 12 failures, so about 70s in total.
- **Liveness:** 10s period, 3s timeout, 3 failures.
- **Readiness:** 5s period, 3s timeout, 2 failures.

Keep health handlers dependency-free. They must not touch the DB or the cache.

> FastAPI note: uvicorn doesn't accept connections until the lifespan startup finishes, so
> liveness fails until then. Keep startup well inside the ~70s startup-probe budget. The init
> containers already wait for Postgres and Hazelcast, so this is normally a few seconds.

### 2.3 Graceful shutdown order
On `SIGTERM`/`SIGINT`, shut down in this order:
1. Set readiness to `DOWN`.
2. Stop accepting requests and drain in-flight requests.
3. Shut down the cache client.
4. Dispose of the DB pool.
5. Flush and shut down the metrics provider, then the tracer provider.
6. Exit with code 0.

The total time must fit in `terminationGracePeriodSeconds`, which defaults to 30s.

### 2.4 Configuration (environment variables)
The ConfigMap `message-service-config` and the Secret `postgres-credentials` are injected with
`envFrom`. `POD_NAME` comes from the Downward API. **Keep these variable names** so the
manifests don't need to change:

| Var | k8s value | Default (local) |
|---|---|---|
| `DB_HOST` | `postgres` | `localhost` |
| `DB_PORT` | `5432` | `5432` |
| `DB_NAME` | `messagedb` | `messagedb` |
| `DB_USER` / `DB_PASSWORD` | from Secret `postgres-credentials` | `message_app` / `message_app` |
| `HAZELCAST_HOST` / `HAZELCAST_PORT` | `hazelcast` / `5701` | `localhost` / `5701` |
| `OTEL_METRICS_URL` | `http://otel-collector.observability.svc.cluster.local:4318/v1/metrics` | `http://localhost:4318/v1/metrics` |
| `OTEL_TRACES_URL` | `http://otel-collector.observability.svc.cluster.local:4318/v1/traces` | `http://localhost:4318/v1/traces` |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | `parentbased_traceidratio` / `0.1` | SDK defaults |
| `POD_NAME` | `metadata.name` | `local` |
| `CORS_ALLOWED_ORIGINS` | unset (same-origin only) | unset |
| `GRAPHQL_INTROSPECTION` | `"true"` | **Rename** to `API_DOCS_ENABLED` (section 6). It must be exactly `"true"` or `"false"`, and any other value must fail startup. |

Build the DB URL from the parts; there is no `DATABASE_URL` in the ConfigMap:
`postgresql+asyncpg://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}`.
URL-encode the password.

### 2.5 Database
- The database already exists. `messagedb` is created through `POSTGRES_DB`. Any additional
  database is created by `k8s/postgres-init-configmap.yaml`, which only runs on the **first**
  PVC init.
- **Migrations run at container start, before the server starts, and must be idempotent.**
- Three replicas start at the same time, so **migrations must take a Postgres advisory lock**.
  Prisma did this for you; Alembic doesn't (section 3.5).
- **Seed** one welcome message only if the `messages` table is empty. Upsert the system
  author `system@message-service.local`.
- Connection budget: Postgres allows `max_connections` = 100. Keep
  `pool_size + max_overflow` ≤ 10 per pod (6 pods × 2 services max).

### 2.6 Cache (Hazelcast)
- Client settings: cluster name **`message-service-cache`**, member `${HAZELCAST_HOST}:${HAZELCAST_PORT}`,
  and **`smart_routing=False`** (unisocket, because there is one member behind a ClusterIP Service).
- Map **`messages`**. Key: the message id. Value: a JSON string of the full message with its
  author embedded.
- **Cache-aside** for read-by-id. **Evict** after a successful update or delete. No TTL.
  **No near cache**, because it goes stale across pods.
- The cache is **mandatory**. If Hazelcast is unreachable, fail startup rather than running
  without it.

### 2.7 Metrics (OTLP/HTTP push to the collector; no `/metrics` scrape endpoint)
- Exporter: OTLP **HTTP/protobuf** to `OTEL_METRICS_URL`, every **15s**.
- Resource attributes: `service.name=<service>` and `k8s.pod.name=$POD_NAME`. The collector
  has `resource_to_telemetry_conversion` turned on, so these show up in Prometheus as the
  labels `service_name` and `k8s_pod_name`. **Don't add `service_name` as a data-point
  attribute.**
- **Don't set `unit`** on instruments whose name already ends in `_ms` or `_bytes`. The
  collector's Prometheus exporter would add another suffix, for example `_ms_milliseconds`.
- Required instruments (REST equivalents of the GraphQL ones, used by the dashboard):

| Name | Type | Attributes | Replaces |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route` (the **template**, e.g. `/messages/{id}`, never the raw path), `status_code` | `graphql_requests_total` (`operation_type`, `root_field`) |
| `http_errors_total` | counter | `method`, `route`, `error_code` | `graphql_errors_total` |
| `http_request_duration_ms` | histogram | `method`, `route` | `graphql_request_duration_ms` |
| `python_process_memory_rss_bytes` | gauge | — | `nodejs_process_memory_rss_bytes` |
| `python_process_cpu_usage_ratio` | gauge | — | `nodejs_process_cpu_usage_ratio` |
| `python_eventloop_lag_p99_ms` | gauge | — | `nodejs_eventloop_lag_p99_ms` |
| `db_pool_connections_open` / `_busy` / `_idle` | gauge | — | `prisma_pool_connections_*` |
| `db_client_queries_duration_avg_ms` | gauge | — | `prisma_client_queries_duration_avg_ms` |

Exclude `/health/*` from the request metrics.

### 2.8 Traces
- Exporter: OTLP **HTTP/protobuf** to `OTEL_TRACES_URL`, using a `BatchSpanProcessor`.
  Use the same resource attributes as the metrics.
- Configure the sampler from `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`. The Python
  SDK reads these natively.
- Instrument inbound HTTP, SQL, and outbound HTTP if there is any.
- **Exclude `/health/liveness` and `/health/readiness`.**
- Propagate W3C `traceparent`.

### 2.9 Logs
- Write to **stdout/stderr only**. The DaemonSet tails `/var/log/pods/default_*/*/*.log` in CRI
  format and ships to the OpenObserve stream `pod_logs`.
- Write **one JSON object per line** with at least these fields: `timestamp`, `level`,
  `message`, `logger`, `trace_id`, and `span_id`, where the trace fields are present when a
  span is active.
- Don't log secrets or full request bodies.

### 2.10 Container image
- Image repo: **`docker.io/miqui/<service>`**. Kyverno allowlists only exact repos (section 6).
- Tags: `latest` plus `<UTC yyyymmddHHMMSS>-<7-char sha>`. Image Updater matches them with
  `^[0-9]{14}-[0-9a-f]{7}$` and the `alphabetical` strategy.
- Multi-arch: `linux/amd64` and `linux/arm64`.
- The runtime needs `sh`, because the entrypoint chains the migration and the server.

---

## 3. Target stack (FastAPI example)

### 3.1 Technology mapping
| Concern | Current (Node) | New (Python) |
|---|---|---|
| Runtime | Node 24 | Python 3.13 |
| Package/deps | npm + `package-lock.json` | **uv** + `pyproject.toml` + `uv.lock` |
| HTTP framework | Express + Apollo Server 4 | **FastAPI** on **uvicorn** (1 worker per pod; scale out with the HPA) |
| API style | GraphQL `POST /graphql` | REST + OpenAPI 3.1 (`/docs`, `/openapi.json`) |
| Validation | hand-rolled `src/validation.ts` | **Pydantic v2** models + a custom error handler |
| Settings | `process.env` in `env.ts` | **pydantic-settings** |
| ORM | Prisma Client | **SQLAlchemy 2.0 async** + **asyncpg** |
| Migrations | `prisma migrate deploy` | **Alembic** (async template) |
| Cache | `hazelcast-client` (Node) | **`hazelcast-python-client`** |
| Metrics/Traces | `@opentelemetry/*` | `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`, `opentelemetry-instrumentation-fastapi`, `-sqlalchemy`, `-asyncpg` |
| Logging | `console.log` | stdlib `logging` + JSON formatter (e.g. `python-json-logger`) |
| Query guards | depth/complexity limits | Not needed. Rely on the pagination bounds, a body size limit, and Pydantic `max_length`. |
| Lint/type/test | `tsc` | **ruff**, **pyright** or **mypy --strict**, **pytest** + **httpx** `AsyncClient` |

### 3.2 Project layout
```
pyproject.toml
uv.lock
alembic.ini
Dockerfile
app/
  __init__.py
  main.py            # FastAPI app, lifespan (startup/shutdown), routers, exception handlers
  settings.py        # pydantic-settings; builds DB URL; validates API_DOCS_ENABLED strictly
  db.py              # async engine, session factory, get_session dependency
  models.py          # SQLAlchemy ORM models (authors, messages)
  schemas.py         # Pydantic request/response models (camelCase aliases)
  errors.py          # ApiError hierarchy + RFC 9457 problem+json handlers
  cache.py           # Hazelcast client wrapper (connect/get/set/evict/shutdown)
  telemetry.py       # MeterProvider + instruments + request-metrics middleware
  tracing.py         # TracerProvider + instrumentors
  logging.py         # JSON log config with trace/span ids
  seed.py            # idempotent seed
  routers/
    health.py
    messages.py
    authors.py
  services/          # business logic (optimistic locking, cache-aside) - routers stay thin
    messages.py
    authors.py
migrations/
  env.py             # async env + pg_advisory_lock
  versions/
tests/
  conftest.py
  test_messages.py
  test_authors.py
  test_health.py
```

### 3.3 Lifespan (startup and shutdown)
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(); setup_tracing(app, engine); setup_metrics(engine)
    await cache.connect(settings.hazelcast_host, settings.hazelcast_port)  # fail fast
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    await seed_initial_message()
    state.ready = True
    yield
    state.ready = False
    await cache.shutdown()
    await engine.dispose()
    shutdown_metrics(); shutdown_tracing()  # force_flush + shutdown
```
Run with `uvicorn app.main:app --host 0.0.0.0 --port 8080 --timeout-graceful-shutdown 20 --proxy-headers --forwarded-allow-ips='*'`.

### 3.4 Hazelcast from asyncio
The Python client is thread-based and returns futures. Don't block the event loop. Wrap calls
in `await asyncio.to_thread(map.get(key).result)` or use `map.blocking()` inside
`asyncio.to_thread`. Create the client once in the lifespan:
```python
hazelcast.HazelcastClient(cluster_name="message-service-cache",
                          cluster_members=[f"{host}:{port}"], smart_routing=False)
```

### 3.5 Alembic with concurrent replicas
In `migrations/env.py`, take a session-level advisory lock around `context.run_migrations()`:
`SELECT pg_advisory_lock(<fixed bigint>)` and later `pg_advisory_unlock(...)`. Without the
lock, three pods race on `alembic_version` during a rollout. Generate the first revision from
the models with autogenerate, then review it by hand. Keep the index on
`(created_at, id)`, the unique index on `email`, and the `VARCHAR` lengths.

### 3.6 Settings validation
`API_DOCS_ENABLED` must be exactly `"true"` or `"false"`, and anything else raises at startup.
When it's false, create the app with `docs_url=None, redoc_url=None, openapi_url=None`.
Parse `CORS_ALLOWED_ORIGINS` as a comma-separated list. When it's unset, don't add
`CORSMiddleware`.

---

## 4. Domain and REST API (port of the GraphQL surface)

### 4.1 Data model (same tables and columns; the DB stays snake_case)
- `authors`: `id uuid pk`, `name varchar(50) not null`, `email varchar(100) unique not null`, `created_at timestamptz default now()`.
- `messages`: `id uuid pk`, `title varchar(100) not null`, `content varchar(1000) not null`,
  `author_id uuid fk -> authors.id` (restrict delete), `created_at timestamptz default now()`,
  `version int not null default 0`, index `(created_at, id)`.

### 4.2 JSON conventions
- Bodies are **camelCase** (`authorId`, `createdAt`, `totalCount`). Use a Pydantic
  `alias_generator=to_camel` with `populate_by_name=True`.
- Timestamps are ISO-8601 UTC strings. IDs are UUID strings.
- A list response looks like `{"items": [...], "totalCount": n}`, sorted by
  `createdAt DESC, id DESC`.

### 4.3 Endpoints
| GraphQL (old) | REST (new) | Success | Errors |
|---|---|---|---|
| `messages(limit, offset)` | `GET /messages?limit=50&offset=0` | 200 page | 400 on a bad limit or offset |
| `message(id)` | `GET /messages/{id}` | 200 | 404 |
| `createMessage(input)` | `POST /messages` `{title, content, authorId}` | 201 + `Location` | 400; 404 or 409 on an unknown author |
| `updateMessage(id, input)` | `PATCH /messages/{id}` `{title?, content, version}` | 200 (version+1) | 400, 404, **409 on a version mismatch** |
| `deleteMessage(id)` | `DELETE /messages/{id}` | 204 | 404 |
| `authors` | `GET /authors` | 200 list | — |
| `author(id)` | `GET /authors/{id}` (optionally `?include=messages`) | 200 | 404 |
| `createAuthor(input)` | `POST /authors` `{name, email}` | 201 | 400, 409 on a duplicate email |
| `updateAuthor(id, input)` | `PATCH /authors/{id}` `{name?, email?}` | 200 | 400, 404, 409 |
| `deleteAuthor(id)` | `DELETE /authors/{id}` | 204 | 404, **409 if the author has messages** |

Optional: also return an `ETag: "<version>"` and accept `If-Match`. Keeping `version` in the
body is required, because the k6 isolation test depends on it.

### 4.4 Validation rules (port of `src/validation.ts`)
- **Collect all field errors** and return them together; don't stop at the first one.
- Required strings must be non-blank after trimming and within the max length:
  title ≤ 100, content ≤ 1000, name ≤ 50, email ≤ 100.
- Email must match `^[^\s@]+@[^\s@]+\.[^\s@]+$`.
- Optional fields: if present, they must pass the same checks. `null` or absent means unchanged.
- Pagination: `1 ≤ limit ≤ 200` (default 50) and `offset ≥ 0` (default 0). Out-of-range values
  return 400, and the server doesn't clamp them silently.

### 4.5 Error model (RFC 9457 `application/problem+json`)
```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Validation failed",
  "code": "BAD_USER_INPUT",
  "invalidParams": [{ "name": "title", "reason": "title must not be blank" }]
}
```
| `code` | HTTP | When |
|---|---|---|
| `BAD_USER_INPUT` | **400** | Validation failure. **Override FastAPI's default 422** `RequestValidationError` handler and map Pydantic errors to `invalidParams`. |
| `NOT_FOUND` | 404 | The resource is missing. |
| `CONFLICT` | 409 | Version mismatch, a unique constraint violation, or an FK restrict. |
| `INTERNAL_SERVER_ERROR` | 500 | Anything unhandled. Log it with the trace id, and **never return stack traces**. |

Every error increments `http_errors_total{error_code=...}`.

### 4.6 Optimistic locking (must pass `k6-transaction-isolation.js`)
Do it in a single statement:
```sql
UPDATE messages SET title = COALESCE(:title, title), content = :content, version = version + 1
WHERE id = :id AND version = :version RETURNING ...
```
If no row comes back, check whether the id exists: return `404` if it doesn't and `409` if it
does. After a successful update, **evict** the cache entry.

### 4.7 Cache-aside
`GET /messages/{id}` reads from the cache first. On a miss it loads from the DB and then
writes the cache. `PATCH` and `DELETE` evict the entry after the commit. List endpoints don't
use the cache.

---

## 5. Dockerfile template
```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.13-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY app/ app/
COPY migrations/ migrations/
COPY alembic.ini ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

FROM python:3.13-slim
RUN groupadd -g 1000 app && useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin app
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY --from=builder --chown=app:app /opt/venv /opt/venv
COPY --from=builder --chown=app:app /app /app
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8080 --timeout-graceful-shutdown 20 --proxy-headers --forwarded-allow-ips='*'"]
```
Build base images can come from any registry. Kyverno only checks the images that pods run.

---

## 6. Platform files to touch (and nothing else)

| File | Change |
|---|---|
| `k8s/configmap.yaml` | In `message-service-config`, replace `GRAPHQL_INTROSPECTION` with `API_DOCS_ENABLED: "true"`. |
| `k8s/deployment.yaml` | Normally no change. You can lower the resources: Python needs less than the Node default of 512Mi/1Gi. Keep requests and limits on every container, because Kyverno requires them. |
| `k8s/ingress.yaml` | No change if the API is served at `/`. For a service behind a prefix (like `/issues(/\|$)(.*)` with `rewrite-target: /$2`), set FastAPI `root_path="/issues"` so the OpenAPI links are correct. |
| `k8s/observability/grafana-dashboard-json-configmap.yaml` | Rename the metrics: `graphql_*` to `http_*`; label `root_field` to `route` and `operation_type` to `method`; `prisma_*` to `db_*`; `nodejs_*` to `python_*`. Update the error-code regexes: drop `GRAPHQL_*` and `QUERY_TOO_*`. |
| `.github/workflows/<service>-ci.yml` | Change the `paths:` filters to `app/**`, `migrations/**`, `pyproject.toml`, `uv.lock`, and `Dockerfile`. Use `astral-sh/setup-uv` + `uv sync` + `ruff check` + `pyright` + `pytest`. **Keep** the tag computation, the multi-arch buildx, and both tags. |
| `test-api.sh`, `k6-*.js` | Rewrite them as REST calls (section 7). |

**If the new project renames the service or the database** (for example
`message-service` → `order-service`), update **all** of the following together:

| File | What to change |
|---|---|
| Deployment, Service, HPA, Ingress | `metadata.name`, the `app:` labels and selectors, and the anti-affinity `values` |
| `k8s/configmap.yaml` | The ConfigMap name, which the Deployment references in `envFrom`. Also `DB_NAME`. |
| `k8s/kustomization.yaml` | The `images:` entry: `name`, `newName`, `newTag` |
| `k8s/argocd/image-updater.yaml` | `alias`, `imageName`, `manifestTargets.kustomize.name` |
| `k8s/policies/rules/restrict-image-repositories.yaml` | Add `docker.io/<user>/<new-service>` to the allowlist |
| `k8s/postgres-init-configmap.yaml` | Add `CREATE DATABASE <newdb>;`. **This only runs on a fresh PVC**, so recreate the cluster or create the database manually. |
| `k8s/hazelcast-deployment.yaml` + client code | The cluster name, which must match on both sides |
| `k8s/argocd/application.yaml` | `metadata.name` and `repoURL`, if it's a new repository |
| `deploy-kind.sh` / `teardown-kind.sh` | The cluster name, the Application names, and any hard-coded service names |
| `.github/policy-fixtures/violating-deployment.yaml` | Keep it violating. It's the negative test for `check-policies.sh`. |

### Kyverno checklist (enforced in `default`, applies to init containers too)
- [ ] `resources.requests.cpu/memory` **and** `resources.limits.cpu/memory` on every container
- [ ] `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `seccompProfile.type: RuntimeDefault`
- [ ] No `hostNetwork`/`hostPID`/`hostIPC`, no `privileged`, no `hostPath`, no `hostPort`
- [ ] Every image comes from an allowlisted repo
- [ ] `./check-policies.sh` passes locally before you push

---

## 7. Tests to port

| Script | Scenario to keep | Thresholds |
|---|---|---|
| `test-api.sh` | Liveness and readiness; list; create an author; create a message; create an invalid message (400 + `invalidParams`); get by id; update with v0; update with a stale version (409); delete the message (204); delete the author (204) | exits non-zero on any failure |
| `k6-create-messages.js` | setup creates an author; each iteration does `POST /messages` | `http_req_failed < 1%`, `p(95) < 500ms` |
| `k6-retrieve-messages.js` | `GET /messages?limit=50` and `?limit=5` (assert ≤ 5 items) | same |
| `k6-message-lifecycle.js` | create → get → patch → delete | same |
| `k6-transaction-isolation.js` | 20 VUs for 15s: read `{content, version}`, then `PATCH` with `content+1` and that version; count the 409s as expected conflicts; assert no lost updates | error rate < 1%, where 409 is **not** counted as a failure |
| `k6-invalid-requests.js` | Blank create → 400 + `invalidParams`; unknown id → 404; malformed request (bad UUID or bad JSON) → 400 | checks > 99%, `p(95) < 500ms` |

Mark 409 and 404 as expected in k6 with
`http.setResponseCallback(http.expectedStatuses({min:200,max:299}, 404, 409))` where it makes
sense.

Unit and integration tests (pytest) should cover:
- validation collecting multiple errors
- the problem+json shape
- a version conflict
- FK conflict on author delete
- cache evict on update and delete (use a fake cache)
- readiness returning 503 before startup completes

---

## 8. Definition of done
1. `uv run ruff check`, `uv run pyright` (or `mypy`), and `uv run pytest` are all green.
2. `docker build` succeeds, and the image runs as UID 1000 (`docker run --rm <img> id`).
3. `./check-policies.sh` passes.
4. `op run --env-file=.env -- ./deploy-kind.sh` finishes. Then check:
   - The Argo CD app is **Synced and Healthy**.
   - All replicas are `Ready`.
   - Rolling restarts with 3 replicas don't hit migration errors.
5. `./test-api.sh` passes against `http://localhost`.
6. All k6 scripts meet their thresholds.
7. In Grafana, the API dashboards show data for `http_requests_total`,
   `http_request_duration_ms_bucket`, `db_pool_*`, and `python_*`, filtered by `service_name`.
8. Traces from the service appear in OpenObserve, and health probes are **absent**.
   JSON logs with `trace_id` appear in the `pod_logs` stream.
9. `kubectl delete pod` on one replica drains cleanly: no 5xx during k6 and exit code 0 in the
   logs.

---

## 9. Reference docs in this repo (platform details, read as needed)
[README.md](README.md), [KUBECTL.md](KUBECTL.md), [ARGOCD.md](ARGOCD.md), [KYVERNO.md](KYVERNO.md),
[DB.md](DB.md), [PROMETHEUS.md](PROMETHEUS.md), [GRAFANA.md](GRAFANA.md), [TRACING.md](TRACING.md),
[LOGS.md](LOGS.md), [HELM.md](HELM.md), [trouble-shooting.md](trouble-shooting.md).
