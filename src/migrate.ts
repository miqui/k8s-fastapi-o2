import "./env";
import { execFileSync } from "node:child_process";

// `prisma migrate deploy` is a separate CLI process, not part of the app's own
// Node process - it needs DATABASE_URL in its own environment too, so this reuses
// (rather than duplicates, e.g. in a shell one-liner) the same DB_HOST/DB_PORT/...
// -> DATABASE_URL construction in src/env.ts, then runs the CLI as a child process
// that inherits process.env, DATABASE_URL included.
execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit" });
