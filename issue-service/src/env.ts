// Builds DATABASE_URL from discrete DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD env
// vars, same convention as message-service's src/env.ts, but defaulting to the
// "issuedb" database (see k8s/postgres-init-configmap.yaml) on the same Postgres
// instance. Must be imported before "@prisma/client" anywhere in the process, since
// PrismaClient reads it at construction time (see src/prisma.ts).
if (!process.env.DATABASE_URL) {
  const host = process.env.DB_HOST ?? "localhost";
  const port = process.env.DB_PORT ?? "5432";
  const name = process.env.DB_NAME ?? "issuedb";
  const user = process.env.DB_USER ?? "issue_app";
  const password = process.env.DB_PASSWORD ?? "issue_app";
  process.env.DATABASE_URL =
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${name}`;
}
