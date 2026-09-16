import { monitorEventLoopDelay } from "node:perf_hooks";
import { performance } from "node:perf_hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { ApolloServerPlugin } from "@apollo/server";
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

// Replaces http.server.requests (Micrometer) - labeled by GraphQL operation name
// instead of HTTP method+route, since every request here is POST /graphql.
const graphqlRequestCounter = meter.createCounter("graphql_requests_total", {
  description: "Count of GraphQL operations executed",
});
const graphqlErrorCounter = meter.createCounter("graphql_errors_total", {
  description: "Count of GraphQL operations that returned at least one error",
});
const graphqlRequestDuration = meter.createHistogram("graphql_request_duration_ms", {
  description: "GraphQL operation duration in milliseconds",
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

export const metricsPlugin: ApolloServerPlugin = {
  async requestDidStart({ request }) {
    const start = performance.now();
    const operation = request.operationName ?? "anonymous";
    return {
      async willSendResponse({ response }) {
        const durationMs = performance.now() - start;
        graphqlRequestDuration.record(durationMs, { operation });
        graphqlRequestCounter.add(1, { operation });
        const hasErrors =
          response.body.kind === "single" && Boolean(response.body.singleResult.errors?.length);
        if (hasErrors) {
          graphqlErrorCounter.add(1, { operation });
        }
      },
    };
  },
};

export async function shutdownTelemetry(): Promise<void> {
  await meterProvider.shutdown();
}
