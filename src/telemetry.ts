import { monitorEventLoopDelay } from "node:perf_hooks";
import { performance } from "node:perf_hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { ApolloServerPlugin } from "@apollo/server";
import { Kind } from "graphql";
import type { DocumentNode, OperationDefinitionNode, SelectionSetNode } from "graphql";
import type { PrismaClient } from "@prisma/client";

// Pushes metrics as OTLP to the same OTel Collector the old Micrometer/OTLP registry
// used (OTEL_METRICS_URL, unchanged in k8s/configmap.yaml), tagged with the same
// k8s.pod.name resource attribute (POD_NAME, unchanged Downward API env in
// k8s/deployment.yaml) so per-pod dashboards keep working exactly as before.
const OTEL_METRICS_URL = process.env.OTEL_METRICS_URL ?? "http://localhost:4318/v1/metrics";
const POD_NAME = process.env.POD_NAME ?? "local";

const resource = resourceFromAttributes({
  "service.name": "message-service",
  "k8s.pod.name": POD_NAME,
});

const exporter = new OTLPMetricExporter({ url: OTEL_METRICS_URL });

const meterProvider = new MeterProvider({
  resource,
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 15000 })],
});

const meter = meterProvider.getMeter("message-service");

// No `unit` option on "_ms"-suffixed instruments below: the OTel Collector's Prometheus
// exporter appends its own unit-derived suffix ("ms" -> "_milliseconds") whenever a name
// doesn't already end in that exact translated string, which double-suffixes a name that
// already spells out "_ms" (confirmed live: `graphql_request_duration_ms_milliseconds_bucket`).
// Names already carry their unit, so unit hints are intentionally left off everywhere.

// Replaces http.server.requests (Micrometer) - labeled by the schema's own operation type
// and root field (see metricsPlugin) instead of HTTP method+route, since every request here
// is POST /graphql. Deliberately NOT labeled by the client-supplied operationName: it's
// unbounded (any client can invent names), which would let callers grow the series count
// in the collector and in OpenObserve at will.
const graphqlRequestCounter = meter.createCounter("graphql_requests_total", {
  description:
    "Count of GraphQL operations executed, incremented once per root field of the operation",
});
const graphqlErrorCounter = meter.createCounter("graphql_errors_total", {
  description:
    "Count of GraphQL operations that returned errors, once per root field and distinct error code",
});
const graphqlRequestDuration = meter.createHistogram("graphql_request_duration_ms", {
  description:
    "GraphQL operation duration in milliseconds; a multi-root-field operation records its full duration once per root field",
});

// Replaces JVM thread/GC pressure signals - there's no JVM anymore, so event-loop lag
// is the equivalent "is the runtime falling behind" saturation signal for Node.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
meter
  .createObservableGauge("nodejs_eventloop_lag_p99_ms", {
    description: "Node.js event loop delay, 99th percentile, milliseconds",
  })
  .addCallback((result) => {
    result.observe(eventLoopDelay.percentile(99) / 1e6);
  });

meter
  .createObservableGauge("nodejs_process_memory_rss_bytes", { description: "Resident set size" })
  .addCallback((result) => result.observe(process.memoryUsage().rss));

meter
  .createObservableGauge("nodejs_process_memory_heap_used_bytes", { description: "V8 heap used" })
  .addCallback((result) => result.observe(process.memoryUsage().heapUsed));

let lastCpuUsage = process.cpuUsage();
let lastCpuSampleAt = process.hrtime.bigint();
meter
  .createObservableGauge("nodejs_process_cpu_usage_ratio", {
    description: "Process CPU usage as a fraction of one core since the last sample",
  })
  .addCallback((result) => {
    const usage = process.cpuUsage(lastCpuUsage);
    const now = process.hrtime.bigint();
    const elapsedNs = Number(now - lastCpuSampleAt);
    const cpuNs = (usage.user + usage.system) * 1000;
    result.observe(elapsedNs > 0 ? cpuNs / elapsedNs : 0);
    lastCpuUsage = process.cpuUsage();
    lastCpuSampleAt = now;
  });

// Direct replacement for the old HikariCP pool metrics: Prisma's own connection-pool
// and query-timing stats (prisma.$metrics.json(), needs the "metrics" preview feature
// in prisma/schema.prisma), sampled once per collection tick via a batch callback
// rather than one client.$metrics.json() round trip per gauge.
export function registerPrismaMetrics(prisma: PrismaClient): void {
  const poolOpen = meter.createObservableGauge("prisma_pool_connections_open");
  const poolBusy = meter.createObservableGauge("prisma_pool_connections_busy");
  const poolIdle = meter.createObservableGauge("prisma_pool_connections_idle");
  const queryDurationAvg = meter.createObservableGauge("prisma_client_queries_duration_avg_ms");
  const queryWaitAvg = meter.createObservableGauge("prisma_client_queries_wait_avg_ms");

  meter.addBatchObservableCallback(
    async (result) => {
      const metrics = await prisma.$metrics.json();
      const gauge = (key: string): number =>
        metrics.gauges.find((entry) => entry.key === key)?.value ?? 0;
      const histogramAvg = (key: string): number => {
        const histogram = metrics.histograms.find((entry) => entry.key === key)?.value;
        if (!histogram || histogram.count === 0) return 0;
        return histogram.sum / histogram.count;
      };

      result.observe(poolOpen, gauge("prisma_pool_connections_open"));
      result.observe(poolBusy, gauge("prisma_pool_connections_busy"));
      result.observe(poolIdle, gauge("prisma_pool_connections_idle"));
      result.observe(queryDurationAvg, histogramAvg("prisma_client_queries_duration_histogram_ms"));
      result.observe(queryWaitAvg, histogramAvg("prisma_client_queries_wait_histogram_ms"));
    },
    [poolOpen, poolBusy, poolIdle, queryDurationAvg, queryWaitAvg],
  );
}

// Root fields of the operation, as response key (the alias if there is one) -> schema field
// name, looking through inline fragments and fragment spreads. Only called from
// didResolveOperation, i.e. after validation: every field name is a real schema field, so
// the root_field label's cardinality is bounded by the schema, and fragment cycles are
// already ruled out. The response key is kept so a field error (whose path starts with it)
// can be attributed to the root field that actually failed.
function rootFieldsByResponseKey(
  document: DocumentNode,
  operation: OperationDefinitionNode,
): Map<string, string> {
  const fragments = new Map<string, SelectionSetNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition.selectionSet);
    }
  }
  const fields = new Map<string, string>();
  const collect = (selectionSet: SelectionSetNode): void => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        fields.set(selection.alias?.value ?? selection.name.value, selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        collect(selection.selectionSet);
      } else {
        const fragment = fragments.get(selection.name.value);
        if (fragment) collect(fragment);
      }
    }
  };
  collect(operation.selectionSet);
  return fields;
}

// Requests that fail before an operation is resolved (parse / validation errors) have no
// operation type or root field - they're bucketed under this placeholder and told apart by
// error_code (GRAPHQL_PARSE_FAILED / GRAPHQL_VALIDATION_FAILED).
const UNRESOLVED = "unresolved";

export const metricsPlugin: ApolloServerPlugin = {
  async requestDidStart() {
    const start = performance.now();
    let operationType = UNRESOLVED;
    let fieldByResponseKey = new Map<string, string>();
    let rootFields = [UNRESOLVED];
    return {
      async didResolveOperation({ document, operation }) {
        if (!operation) return;
        operationType = operation.operation;
        fieldByResponseKey = rootFieldsByResponseKey(document, operation);
        if (fieldByResponseKey.size > 0) rootFields = [...new Set(fieldByResponseKey.values())];
      },
      async willSendResponse({ response }) {
        const durationMs = performance.now() - start;

        // Attribute each error to the root field it came from (its path starts with that
        // field's response key). An error with no such path - e.g. a validation or
        // variable-coercion failure - can't be pinned to one field, so it counts against
        // every root field of the operation. extensions.code is only ever set by this
        // service's own errors.ts helpers or by Apollo itself, so it's a small closed set.
        const errorCodesByField = new Map<string, Set<string>>();
        if (response.body.kind === "single") {
          for (const error of response.body.singleResult.errors ?? []) {
            const code = String(error.extensions?.code ?? "UNKNOWN");
            const responseKey = error.path?.[0];
            const field =
              typeof responseKey === "string" ? fieldByResponseKey.get(responseKey) : undefined;
            for (const affected of field ? [field] : rootFields) {
              const codes = errorCodesByField.get(affected) ?? new Set<string>();
              errorCodesByField.set(affected, codes.add(code));
            }
          }
        }

        for (const rootField of rootFields) {
          const attributes = { operation_type: operationType, root_field: rootField };
          graphqlRequestDuration.record(durationMs, attributes);
          graphqlRequestCounter.add(1, attributes);
          for (const errorCode of errorCodesByField.get(rootField) ?? []) {
            graphqlErrorCounter.add(1, { ...attributes, error_code: errorCode });
          }
        }
      },
    };
  },
};

export async function shutdownTelemetry(): Promise<void> {
  await meterProvider.shutdown();
}
