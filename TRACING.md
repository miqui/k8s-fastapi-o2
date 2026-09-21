# Tracing — message-service & issue-service → OpenObserve

Distributed tracing for both GraphQL APIs, exported over OTLP to the OTel Collector and from there
to OpenObserve. Traces sit alongside the metrics that already flow through the same collector
(see `PROMETHEUS.md`).

```
message-service ─┐  OTLP/HTTP            OTLP/HTTP + basic auth
                 ├─► otel-collector:4318 ─────────────────────► OpenObserve (org "default")
issue-service  ──┘   /v1/traces           /api/default/v1/traces
```

## What is traced

| Layer | Instrumentation | Spans |
| :--- | :--- | :--- |
| HTTP server | `@opentelemetry/instrumentation-http` | One span per request. `/health/*` (kubelet probes) is ignored. |
| GraphQL | `@opentelemetry/instrumentation-graphql` | One span per operation (named after it), with parse / validate / execute below it. |
| Database | `@prisma/instrumentation` | `prisma:client:operation` and `prisma:engine:*` spans — the DB side of each request. |

Not traced: Hazelcast cache calls (`src/cache.ts`), and the two services never call each other, so
there is no cross-service trace — each API produces its own traces.

## Code

Both services have an identical `src/tracing.ts` (`service.name` differs):

- `src/tracing.ts` — message-service
- `issue-service/src/tracing.ts` — issue-service

Decisions worth knowing before changing them:

- **It must be the first import in `index.ts`** (after `./env`, before `node:http`, express,
  graphql and `@prisma/client`). Instrumentations patch modules when they are first required, so
  anything loaded earlier goes untraced, silently.
- **No express instrumentation.** With `/health/*` ignored at the HTTP layer, express would still
  create root spans for those requests plus a span per middleware layer. The HTTP span plus the
  GraphQL operation span carry everything useful (every request is `POST /graphql`).
- **`ignoreTrivialResolveSpans` + `mergeItems`** on the GraphQL instrumentation — without them every
  field of every list result becomes its own span.
- **Resource attributes** mirror the metrics: `service.name` and `k8s.pod.name` (from the
  `POD_NAME` Downward API env var).
- **The exporter URL is used verbatim.** `OTEL_TRACES_URL` must include `/v1/traces`; the SDK does
  not append it when a `url` is passed explicitly.
- `shutdownTracing()` runs in the SIGTERM handler so the last batch of spans is flushed.

## Configuration

`k8s/configmap.yaml`, for both `message-service-config` and `issue-service-config`:

| Variable | Value | Purpose |
| :--- | :--- | :--- |
| `OTEL_TRACES_URL` | `http://otel-collector.observability.svc.cluster.local:4318/v1/traces` | Where the SDK posts spans |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | Sample by ratio; children follow the parent's decision |
| `OTEL_TRACES_SAMPLER_ARG` | `"0.1"` | 10% of new traces |

The sampler uses the SDK's standard env vars, so no code reads them — the ratio can be changed by
editing the ConfigMap and restarting the pods. 10% is deliberate: a k6 run against a 5Gi PVC with
3-day retention (see `k8s/observability/openobserve-values.yaml`) would otherwise fill it quickly.
Set `"1.0"` temporarily when debugging, and expect to need a burst of ~50+ requests to see anything
at 0.1.

## Collector

`k8s/observability/otel-collector-configmap.yaml` gained a `traces` pipeline next to the existing
`metrics` one:

```yaml
extensions:
  basicauth/openobserve:
    client_auth:
      username: root@example.com
      password: ${env:OPENOBSERVE_PASSWORD}

exporters:
  otlphttp/openobserve:
    endpoint: http://openobserve.observability.svc.cluster.local:5080/api/default
    auth:
      authenticator: basicauth/openobserve

service:
  extensions: [basicauth/openobserve]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/openobserve]
```

- The `otlphttp` exporter appends `/v1/traces` itself, unlike the services' exporter (above).
- `OPENOBSERVE_PASSWORD` comes from `secretKeyRef` in `otel-collector-deployment.yaml`, pointing at
  the existing `openobserve-remote-write-credentials` Secret (key `password`) that Prometheus'
  `remote_write` already uses — so the password stays out of the ConfigMap, and there is one
  place to rotate it. The username is hard-coded, same as in `prometheus-configmap.yaml`.
- The Secret in the repo (`openobserve-prometheus-secret.yaml`) holds a placeholder password;
  `deploy-kind.sh` creates the real one. Don't `kubectl apply` the placeholder file over a live cluster.
- Changing the collector ConfigMap needs a restart: `kubectl rollout restart deploy/otel-collector -n observability`
  (a plain `apply` of the ConfigMap alone is not picked up by the running pod).

## Verification

**Collector → OpenObserve (verified live).** A synthetic OTLP span posted to the collector appeared
in OpenObserve as `tracing-smoke-test / smoke-span`, with no export errors in the collector log:

```bash
kubectl port-forward -n observability svc/otel-collector 14318:4318 &
curl -X POST localhost:14318/v1/traces -H 'Content-Type: application/json' -d '{
  "resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"tracing-smoke-test"}}]},
  "scopeSpans":[{"scope":{"name":"smoke"},"spans":[{"traceId":"5b8efff798038103d269b633813fc60c",
  "spanId":"eee19b7ec3c1b174","name":"smoke-span","kind":2,
  "startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000000050000000"}]}]}]}'
```

**Services → OpenObserve (verified live, 2026-09-21).** After the rollout (all six pods on the
`…-63b83d8` image tag, 0 restarts), 150 read-only GraphQL queries were sent to each service via
`kubectl port-forward` (`TraceCheckMessages` / `TraceCheckIssue`). Results:

- **Both services arrived:** 441 spans / 19 traces for `message-service`, 252 spans / 14 traces for
  `issue-service`.
- **Sampling matched the config:** 16 and 14 of 150 requests were sampled (~10% at
  `OTEL_TRACES_SAMPLER_ARG: "0.1"`).
- **Health probes are excluded:** 0 spans with `health` in the operation name, despite kubelet
  probing every few seconds.
- **Spans nest as intended** — HTTP → GraphQL operation → resolver → Prisma:

  ```
  - POST
    - query TraceCheckMessages
      - graphql.resolve authors
        - prisma:client:operation
          - prisma:engine:query → connection, db_query, serialize, response_json_serialization
        - graphql.resolve authors.*.id
      - graphql.resolve messages
        - prisma:client:operation …
  ```

  `mergeItems` is working (`authors.*.id` is one span, not one per author).
- **Quirk:** when a query resolves two Prisma operations concurrently (issue-service's
  `workspace` + `issue`), the `prisma:engine:*` spans can be attached under a sibling operation
  rather than the one that issued them. The span counts and durations are still right; only the
  parent link is off.

To repeat the check:

```bash
# pods should be newer than the merge
kubectl get pods -n default -l 'app in (message-service,issue-service)'

# generate traffic (10% sampling), e.g. one of the k6 scripts, then:
U=$(kubectl get secret openobserve -n observability -o jsonpath='{.data.ZO_ROOT_USER_EMAIL}' | base64 -d)
P=$(kubectl get secret openobserve -n observability -o jsonpath='{.data.ZO_ROOT_USER_PASSWORD}' | base64 -d)
kubectl port-forward -n observability svc/openobserve 15080:5080 &
END=$(python3 -c "import time;print(int(time.time()*1e6))"); START=$((END-3600000000))
curl -s -u "$U:$P" -X POST "http://localhost:15080/api/default/_search?type=traces" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":{\"sql\":\"select service_name, count(*) as n from \\\"default\\\" group by service_name\",\"start_time\":$START,\"end_time\":$END,\"from\":0,\"size\":20}}"
```

Expect rows for `message-service` and `issue-service`. Or open OpenObserve → Traces
(`openobserve.localhost`).

## Gotchas

- **Stream stats lag.** `GET /api/default/streams?type=traces` reports `doc_num: 0` for the
  `default` stream even when spans are searchable (they are still in the in-memory table). Search
  instead of trusting the stat.
- **ArgoCD `selfHeal` reverts hand edits** to `k8s/configmap.yaml` and the deployments, and the
  service images come from Docker Hub via Image Updater. To test a tracing change on the cluster it
  has to be merged, or auto-sync paused.
- **Nothing shows up?** In order: pods still on the old image; sampler ratio too low for the
  amount of traffic; `OTEL_TRACES_URL` missing `/v1/traces`; collector log for export errors
  (`kubectl logs -n observability deploy/otel-collector`).
- **Logs** are not covered here. OpenObserve currently holds only metrics and (now) traces; no pod
  log shipper is deployed.

## Dependencies added (both services)

`@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`,
`@opentelemetry/instrumentation`, `@opentelemetry/instrumentation-http`,
`@opentelemetry/instrumentation-graphql`, `@prisma/instrumentation` (pinned to the same 6.19 line as
`@prisma/client`; tracing is GA in Prisma 6, no preview feature needed).
