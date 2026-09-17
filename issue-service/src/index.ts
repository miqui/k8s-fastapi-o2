import "./env";
import http from "node:http";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginLandingPageLocalDefault } from "@apollo/server/plugin/landingPage/default";
import { expressMiddleware } from "@as-integrations/express5";
import cors from "cors";
import express from "express";
import { prisma } from "./prisma";
import { resolvers } from "./resolvers";
import { typeDefs } from "./schema";
import { seedInitialIssue } from "./seed";
import { metricsPlugin, registerPrismaMetrics, shutdownTelemetry } from "./telemetry";

const PORT = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  const app = express();
  app.use(cors());

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

  // Sandbox and introspection stay on for this disposable local dev cluster, same
  // rationale as message-service's src/index.ts.
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
  console.log(`issue-service listening on :${PORT}`);

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
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
