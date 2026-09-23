import "./env";
import "./tracing";
import http from "node:http";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginLandingPageDisabled } from "@apollo/server/plugin/disabled";
import { ApolloServerPluginLandingPageLocalDefault } from "@apollo/server/plugin/landingPage/default";
import { expressMiddleware } from "@as-integrations/express5";
import cors from "cors";
import express from "express";
import { queryLimitsPlugin } from "./guards";
import { corsOptions, httpConfigSummary, introspectionEnabled } from "./http-config";
import { prisma } from "./prisma";
import { resolvers } from "./resolvers";
import { typeDefs } from "./schema";
import { seedInitialIssue } from "./seed";
import { metricsPlugin, registerPrismaMetrics, shutdownTelemetry } from "./telemetry";
import { shutdownTracing } from "./tracing";

const PORT = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  const app = express();
  app.use(cors(corsOptions));

  let ready = false;

  // Readiness flips true once Postgres is connected - the wait-for-postgres init
  // container in k8s/issue-service-deployment.yaml already gates the pod's scheduling
  // on Postgres accepting connections, mirroring message-service's health endpoints.
  // No cache dependency here (see the "Caching" decision in the design discussion) -
  // nothing in this schema has a proven hot path that needs one yet.
  app.get("/health/liveness", (_req, res) => {
    res.status(200).json({ status: "UP" });
  });
  app.get("/health/readiness", (_req, res) => {
    res.status(ready ? 200 : 503).json({ status: ready ? "UP" : "DOWN" });
  });

  // Introspection and the Sandbox landing page are one switch (GRAPHQL_INTROSPECTION, see
  // src/http-config.ts): Sandbox can't populate its schema view without introspection, so
  // there's no point serving one without the other. Stacktraces stay off regardless.
  // queryLimitsPlugin rejects over-deep / over-costly operations (GRAPHQL-API-DESIGN.md);
  // metricsPlugin goes first so it registers before the limits plugin can reject a request,
  // and maxRecursiveSelections caps fragment-expansion bombs before custom checks run.
  const apollo = new ApolloServer({
    typeDefs,
    resolvers,
    plugins: [
      metricsPlugin,
      queryLimitsPlugin,
      introspectionEnabled
        ? ApolloServerPluginLandingPageLocalDefault({ embed: true })
        : ApolloServerPluginLandingPageDisabled(),
    ],
    includeStacktraceInErrorResponses: false,
    introspection: introspectionEnabled,
    maxRecursiveSelections: true,
  });
  await apollo.start();
  app.use("/graphql", express.json(), expressMiddleware(apollo));

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  console.log(`issue-service listening on :${PORT} (${httpConfigSummary})`);

  await prisma.$connect();
  registerPrismaMetrics(prisma);
  await seedInitialIssue();

  ready = true;

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received, shutting down`);
    ready = false;
    await apollo.stop();
    httpServer.close();
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
