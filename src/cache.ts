import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { Client } from "hazelcast-client";

/**
 * The app connects as a Hazelcast *client* to the standalone Hazelcast member deployed
 * on its own node (see k8s/hazelcast-deployment.yaml), rather than embedding a member in
 * each pod - keeps the cache tier independent of app pod restarts/scaling. Unisocket mode
 * (smartRouting: false) matches the old Java client config: there's a single member behind
 * a plain ClusterIP Service, so smart routing (talking to every member directly) isn't
 * useful here.
 *
 * Deliberately no Near Cache, for the same reason documented in the old
 * HazelcastConfig.java: a client-side Near Cache on this map went stale across pods after
 * an evict() - the invalidation broadcast wasn't reliably reaching every other client's
 * near-cache. Reads go straight to the shared Hazelcast member instead, which stays correct.
 *
 * Values are cached as JSON strings (GraphQL response shape - id/title/content/author/
 * createdAt/version - see serializeMessage in resolvers.ts), keyed by message id.
 */
const CACHE_NAME = "message-service-cache";
const MAP_NAME = "messages";

let client: Client | undefined;

// Uses the global tracer provider registered in src/tracing.ts - a no-op until that runs.
const tracer = trace.getTracer("message-service");

// Hazelcast has no OpenTelemetry instrumentation, so each cache call gets a manual span
// (a child of the GraphQL resolver span). Without them a cache hit shows up in a trace as a
// resolver with no Prisma spans, and the network hop to the Hazelcast member is an
// unexplained gap inside the resolver's duration.
async function traced<T>(operation: string, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(
    `hazelcast.${operation}`,
    { attributes: { "db.system": "hazelcast", "db.operation": operation, "cache.map": MAP_NAME } },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export async function connectCache(host: string, port: string): Promise<void> {
  client = await Client.newHazelcastClient({
    clusterName: CACHE_NAME,
    network: {
      clusterMembers: [`${host}:${port}`],
      smartRouting: false,
    },
  });
}

export function isCacheConnected(): boolean {
  return client !== undefined;
}

export async function getCachedMessage<T>(id: string): Promise<T | null> {
  if (!client) return null;
  const hz = client;
  return traced("get", async (span) => {
    const map = await hz.getMap<string, string>(MAP_NAME);
    const raw = await map.get(id);
    span.setAttribute("cache.hit", Boolean(raw));
    return raw ? (JSON.parse(raw) as T) : null;
  });
}

export async function setCachedMessage(id: string, value: unknown): Promise<void> {
  if (!client) return;
  const hz = client;
  await traced("set", async () => {
    const map = await hz.getMap<string, string>(MAP_NAME);
    await map.set(id, JSON.stringify(value));
  });
}

export async function evictCachedMessage(id: string): Promise<void> {
  if (!client) return;
  const hz = client;
  await traced("delete", async () => {
    const map = await hz.getMap<string, string>(MAP_NAME);
    await map.delete(id);
  });
}

export async function shutdownCache(): Promise<void> {
  await client?.shutdown();
  client = undefined;
}
