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
  const map = await client.getMap<string, string>(MAP_NAME);
  const raw = await map.get(id);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function setCachedMessage(id: string, value: unknown): Promise<void> {
  if (!client) return;
  const map = await client.getMap<string, string>(MAP_NAME);
  await map.set(id, JSON.stringify(value));
}

export async function evictCachedMessage(id: string): Promise<void> {
  if (!client) return;
  const map = await client.getMap<string, string>(MAP_NAME);
  await map.delete(id);
}

export async function shutdownCache(): Promise<void> {
  await client?.shutdown();
  client = undefined;
}
