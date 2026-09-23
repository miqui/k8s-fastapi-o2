import type { CorsOptions } from "cors";

// Introspection and the Apollo Sandbox landing page (which needs it to load the schema) are
// on by default only outside production, i.e. `tsx watch` locally. The Dockerfile sets
// NODE_ENV=production, so a deployed pod exposes neither unless GRAPHQL_INTROSPECTION=true
// is set explicitly (k8s/configmap.yaml does, for this disposable dev cluster). An
// unrecognised value fails startup rather than silently picking a side of a security flag.
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false", got "${process.env[name]}"`);
}

export const introspectionEnabled = envFlag(
  "GRAPHQL_INTROSPECTION",
  process.env.NODE_ENV !== "production",
);

// Comma-separated exact origins allowed to call /graphql from a browser. Unset means no CORS
// headers at all (same-origin only) - curl, k6 and other non-browser clients are unaffected.
// "*" opts back in to the old allow-everything behaviour, explicitly.
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const corsOptions: CorsOptions = {
  origin: allowedOrigins.includes("*") ? "*" : allowedOrigins.length > 0 ? allowedOrigins : false,
};

export const httpConfigSummary =
  `introspection=${introspectionEnabled} ` +
  `cors=${allowedOrigins.length > 0 ? allowedOrigins.join(",") : "same-origin-only"}`;
