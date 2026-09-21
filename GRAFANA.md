# Grafana Changes — OpenObserve Observability Rollout

## `$service` variable on the API dashboards (`graphql-api`, `api-red`)

message-service and issue-service push identically named metrics (`graphql_requests_total`,
`prisma_pool_*`, `nodejs_*`, ...) through the same OTel Collector, distinguished only by the
`service_name` label. These two dashboards used to sum both APIs together, and `api-red`'s
container panels were hardcoded to `container="message-service"`, so it mixed scopes.

Both now have a multi-select **Service** dropdown (`message-service`, `issue-service`, default All):

- GraphQL / Prisma / Node.js series filter on `service_name=~"$service"`.
- cAdvisor / kube-state series filter on `container=~"$service"` or `pod=~"$service-.*"` — this
  works because each container is named after its service (`message-service`, `issue-service`).
- Per-service legends (`{{service_name}} / {{root_field}}`), and the Prisma-pool, CPU and
  event-loop panels are aggregated (`sum` / `max`) instead of emitting one unlabelled series per pod.
- **Ready Pods** replaces **Service Up** on `graphql-api`: the old query was
  `up{job="otel-collector"}`, which only says the collector is scraped, not that the API is alive.
- **Error Ratio** and the overall errors line use `... or vector(0)` so they read 0, not "No data".

`graphql_errors_total` is only created on the first error (the OTel counter emits nothing before its
first `.add()`), so the per-root-field error panels stay empty on a healthy system rather than
reading 0; the ratio and total panels use `or vector(0)` and the by-code panels say "No errors".

Not changed: `graphql-api` uses `[1m]` rate windows and `api-red` uses `[5m]`, as before.

## Schema-based metrics: `GraphQL Operations` and `GraphQL Errors` dashboards

Two new dashboards (`graphql-operations`, `graphql-errors`, same ConfigMap), plus the existing
per-operation panels on `graphql-api` / `api-red` re-pointed from `operation` to `root_field`.

Both services' `metricsPlugin` now labels the `graphql_*` metrics with `operation_type`
(`query` / `mutation` / `unresolved`), `root_field` (the schema field, aliases resolved) and, on
`graphql_errors_total`, `error_code` (`extensions.code`). The old `operation` label (the client's
`operationName`) is gone: it was client-controlled and unbounded, and every unnamed operation - i.e.
all k6 traffic - landed in `anonymous`. Full details and caveats (multi-root-field counting, error
attribution via the error `path`, the `unresolved` bucket) are in the README's
"GraphQL Operation & Error Dashboards" section.

- **GraphQL Operations** (12 panels; Service / Operation type / Root field variables): request rate,
  mutation share, p95/p99, error ratio, active root fields; rate, query-vs-mutation, p95 and average
  latency by root field; a latency-distribution heatmap; a per-root-field summary table.
- **GraphQL Errors** (11 panels; Service / Root field / Error code variables): error ratio, errors/s,
  server errors/s (`INTERNAL_SERVER_ERROR|UNKNOWN`, should stay 0), conflicts/s; errors by code, by
  root field, ratio and conflict ratio by root field; client-input errors; `NOT_FOUND` by root field;
  a totals table.

### Rollout order (follow the ArgoCD image flow)

The label change is in the service code, so it only reaches the cluster through the normal flow:
merge -> GitHub Actions builds and pushes the images -> Argo CD Image Updater picks up the new tags ->
Argo CD rolls the Deployments. Nothing is loaded or patched by hand. The Grafana ConfigMap ships through the
`observability` Argo Application (`k8s/argocd/observability-application.yaml`) once that is registered;
before it is, apply it with `kubectl apply -f k8s/observability/grafana-dashboard-json-configmap.yaml`.
Either way, the new panels are empty (and `root_field` legends on the two older dashboards collapse) until
the new images are running and have served traffic.

### Verification performed

- Each service's real `metricsPlugin` and OTLP exporter were run against that service's real schema and
  error helpers (stub resolvers, a local OTLP receiver), asserting the exact label sets for: plain
  and named operations, multiple root fields, fragment/inline-fragment roots, aliases,
  introspection, parse and validation failures, `NOT_FOUND` / `CONFLICT` / `BAD_USER_INPUT`, and that
  errors in one root field aren't attributed to another. No `operation` attribute is emitted.
- 18 of the new expressions - the exact strings shipped in the ConfigMap - were unit-tested with
  `promtool test rules` against synthetic series with hand-computed expected values (rates,
  ratios, `histogram_quantile` interpolation, the `or vector(0)` empty-error case, zero-error rows in
  the summary table). All 62 GraphQL-dashboard expressions parse on the live Prometheus.
- All 15 GraphQL documents in the k6 scripts (now named operations) validate against the real schema.
- **Not verified visually:** Grafana itself was not driven, so panel rendering (the heatmap, the two
  table transformations, the `$root_field` / `$error_code` query variables) is untested until the
  rollout above. Live series with the new labels can't exist before then either.

## New dashboard: "OpenObserve Ops"

Added as a new key (`openobserve-ops.json`) in
`k8s/observability/grafana-dashboard-json-configmap.yaml`, alongside the five pre-existing
dashboards in that same ConfigMap. No changes were needed to
`grafana-dashboard-provider-configmap.yaml` or `grafana-deployment.yaml` — the whole ConfigMap is
already mounted as a directory (`/etc/grafana/provisioning/dashboards-json`), so a new key just
shows up as a new file and Grafana's file-based dashboard provider picks it up on its own.

Self-monitoring for the OpenObserve backend itself — not the message-service or cluster-ops data
*inside* OpenObserve, but OpenObserve's own health as a running service. 14 panels, `uid: openobserve-ops`:

| Panel | Type | PromQL |
| :--- | :--- | :--- |
| OpenObserve Up | stat | `up{job="openobserve"}` |
| Disk Usage | gauge | `zo_node_disk_usage{job="openobserve"} / zo_node_disk_total{job="openobserve"} * 100` |
| Process Memory (RSS) | stat | `process_resident_memory_bytes{job="openobserve"}` |
| Open File Descriptors | stat | `process_open_fds{job="openobserve"}` |
| Uptime | stat | `time() - process_start_time_seconds{job="openobserve"}` |
| Ingest Rate (records/s) | stat | `sum(rate(zo_ingest_records{job="openobserve"}[5m]))` |
| HTTP Request Rate by Endpoint | timeseries | `sum(rate(zo_http_incoming_requests{job="openobserve"}[5m])) by (endpoint, status)` |
| HTTP Response Time p95/p99 by Endpoint | timeseries | `histogram_quantile(0.95/0.99, sum(rate(zo_http_response_time_bucket{job="openobserve"}[5m])) by (le, endpoint))` |
| Ingest Rate by Stream Type (records/s) | timeseries | `sum(rate(zo_ingest_records{job="openobserve"}[5m])) by (stream_type)` |
| Ingest Rate by Stream Type (bytes/s) | timeseries | `sum(rate(zo_ingest_bytes{job="openobserve"}[5m])) by (stream_type)` |
| In-Memory MemTable Size | timeseries | `zo_ingest_memtable_bytes{job="openobserve"}` |
| WAL Used Bytes by Stream Type | timeseries | `sum(zo_ingest_wal_used_bytes{job="openobserve"}) by (stream_type)` |
| Process CPU Usage | timeseries | `rate(process_cpu_seconds_total{job="openobserve"}[5m]) * 100` |
| Disk Usage vs Total | timeseries | `zo_node_disk_usage{job="openobserve"}` vs `zo_node_disk_total{job="openobserve"}` |

The **In-Memory MemTable Size** panel is deliberate, not incidental: `zo_ingest_memtable_bytes` is
the exact thing that overflowed (`MemoryTableOverflowError`, see `PROMETHEUS.md` step 1) before
remote_write was scoped down and OpenObserve's resources were bumped. It's the one panel worth
watching if the remote_write scope is ever widened again.

All 14 metric names/labels were read directly off OpenObserve's own `/metrics` output before
writing any panel — none were guessed. Every `process_*` metric query is deliberately scoped with
`{job="openobserve"}`: `process_cpu_seconds_total`/`process_resident_memory_bytes`/etc. are generic
Prometheus-client-library metrics, also exposed by `kube-state-metrics` and `postgres-exporter` —
without the job filter these would silently mix with the wrong process's numbers.

### Dependencies (documented in full elsewhere)

This dashboard depends on two other changes, covered in their own docs:
- `k8s/observability/config/prometheus.yml` gained an `openobserve` scrape job for
  `openobserve.observability.svc.cluster.local:5080/metrics` — see `PROMETHEUS.md` step 5.
- `k8s/observability/openobserve-values.yaml` gained `config.ZO_PROMETHEUS_ENABLED: "true"` (off by
  default — confirmed live that `/metrics` returns HTTP 200 with an empty body otherwise) — see
  `HELM.md`.

### Verification performed

- Queried all 14 panel expressions directly against Prometheus (not just Grafana) — every one
  returned real, non-empty data (e.g. disk usage ~11%, RSS ~566MB, 40 open fds, ingest rate ~967
  records/s).
- Confirmed via Grafana's `/api/dashboards/uid/openobserve-ops` that the dashboard is actually
  provisioned, with all 14 panels present (not just that the ConfigMap key exists).

## Unrelated finding: admin credentials had drifted

While verifying the dashboard via Grafana's API, `admin`/`admin` (the credentials documented in
`k8s/observability/grafana-secret.yaml` and the README) returned `401 Invalid username or
password` — confirmed via pod logs (`password-auth.invalid`) that this was a genuine credential
mismatch, not a transient issue. The Grafana pod hadn't restarted since its original deploy, so
something changed the in-database admin password outside of this session's changes.

Fixed by resetting it back to the documented value using Grafana's own supported recovery path
(safe on this disposable local dev instance):

```bash
kubectl exec -n observability deploy/grafana -- grafana-cli admin reset-admin-password admin
```

No config files were changed for this — `grafana-secret.yaml` already had the correct value; only
Grafana's own internal (sqlite) state was out of sync with it.
