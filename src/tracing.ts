import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { GraphQLInstrumentation } from "@opentelemetry/instrumentation-graphql";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { PrismaInstrumentation } from "@prisma/instrumentation";

// Must be the very first import in src/index.ts (before "node:http", express, graphql and
// @prisma/client): instrumentations patch modules as they are first required, so anything
// loaded earlier goes untraced.
//
// Pushes spans as OTLP to the same OTel Collector the metrics go to (OTEL_TRACES_URL, see
// k8s/configmap.yaml), which forwards them to OpenObserve. Sampling is left to the SDK's
// standard OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG env vars (set in the ConfigMap) so
// the ratio can be tuned without a rebuild.
const OTEL_TRACES_URL = process.env.OTEL_TRACES_URL ?? "http://localhost:4318/v1/traces";
const POD_NAME = process.env.POD_NAME ?? "local";

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "service.name": "message-service",
    "k8s.pod.name": POD_NAME,
  }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: OTEL_TRACES_URL }))],
});
provider.register();

registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation({
      // Kubelet probes hit these every few seconds - without this they'd dominate the
      // trace list and burn through OpenObserve's small PVC.
      ignoreIncomingRequestHook: (req) => req.url?.startsWith("/health/") ?? false,
    }),
    // Every request is POST /graphql, so the HTTP span alone says nothing - this adds
    // one span per GraphQL operation (named after it) with parse/validate/execute below.
    new GraphQLInstrumentation({ ignoreTrivialResolveSpans: true, mergeItems: true }),
    // prisma:client:operation / prisma:engine:* spans, i.e. the DB side of each request.
    new PrismaInstrumentation(),
  ],
});

export async function shutdownTracing(): Promise<void> {
  await provider.shutdown();
}
