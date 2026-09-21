import "./env";
import "./tracing";
import http from "node:http";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginLandingPageLocalDefault } from "@apollo/server/plugin/landingPage/default";
import { expressMiddleware } from "@as-integrations/express5";
import cors from "cors";
import express from "express";
import { connectCache, isCacheConnected, shutdownCache } from "./cache";
import { prisma } from "./prisma";
import { resolvers } from "./resolvers";
import { typeDefs } from "./schema";
import { seedInitialMessage } from "./seed";
import { metricsPlugin, registerPrismaMetrics, shutdownTelemetry } from "./telemetry";
import { shutdownTracing } from "./tracing";

const PORT = Number(process.env.PORT ?? 8080);
const HAZELCAST_HOST = process.env.HAZELCAST_HOST ?? "localhost";
const HAZELCAST_PORT = process.env.HAZELCAST_PORT ?? "5701";

async function main(): Promise<void> {
  const app = express();
  app.use(cors());

  let ready = false;

  // Replace /actuator/health/liveness and /actuator/health/readiness - readiness only
  // flips true once both Postgres and Hazelcast are connected, mirroring the old
  // actuator probes (which the wait-for-postgres/wait-for-hazelcast init containers in
  // k8s/deployment.yaml already gate the pod's scheduling on).
  app.get("/health/liveness", (_req, res) => {
    res.status(200).json({ status: "UP" });
  });
  app.get("/health/readiness", (_req, res) => {
    res.status(ready ? 200 : 503).json({ status: ready ? "UP" : "DOWN" });
  });

  // NODE_ENV=production (set in the Dockerfile) makes Apollo Server default to a bare
  // "server is running" landing page instead of the interactive Sandbox, disables schema
  // introspection (which Sandbox needs to populate its schema view), and controls whether
  // error responses include a stacktrace - explicitly setting all three here decouples
  // them from NODE_ENV: Sandbox and introspection stay on for this disposable local dev
  // cluster (see the "GraphQL API" section in README.md) while stacktraces stay off.
  const apollo = new ApolloServer({
    typeDefs,
    resolvers,
    plugins: [metricsPlugin, ApolloServerPluginLandingPageLocalDefault({ embed: true })],
    includeStacktraceInErrorResponses: false,
    introspection: true,
  });
  await apollo.start();
  app.use("/graphql", express.json(), expressMiddleware(apollo));

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  console.log(`message-service listening on :${PORT}`);

  // Not optional, same as the old app (see HazelcastConfig.java's Javadoc): a
  // missing/unreachable Hazelcast member fails startup rather than silently running
  // without a cache - there's no profile that runs with caching disabled outside tests.
  await connectCache(HAZELCAST_HOST, HAZELCAST_PORT);
  await prisma.$connect();
  registerPrismaMetrics(prisma);
  await seedInitialMessage();

  ready = isCacheConnected();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received, shutting down`);
    ready = false;
    await apollo.stop();
    httpServer.close();
    await shutdownCache();
    await prisma.$disconnect();
    await shutdownTelemetry();
    await shutdownTracing();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
