# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for the issue-service Apollo Server + Prisma GraphQL API.
# Build context is this directory (issue-service/) - see deploy-kind.sh.

# Shared base for stages that run `prisma generate` or the app itself. Prisma's query
# engine binary needs openssl on Alpine (musl) - without it `generate` picks the wrong
# engine and the app fails at runtime with a cryptic "Unable to require libquery_engine".
FROM node:24-alpine AS base
RUN apk add --no-cache openssl

# Stage 1: Build stage (full deps + TypeScript compile)
FROM node:24-alpine AS builder
WORKDIR /workspace

# Only schema.prisma is needed to generate the client (types for tsc), so editing a
# migration doesn't invalidate the npm ci layer.
COPY package.json package-lock.json ./
COPY prisma/schema.prisma prisma/schema.prisma
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 2: Production dependencies only. Independent of the builder, so BuildKit runs
# both installs in parallel (matters under QEMU for the arm64 leg of the CI build).
FROM base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma/schema.prisma prisma/schema.prisma
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev && npx prisma generate

# Stage 3: Runtime stage
FROM base
WORKDIR /app

ENV NODE_ENV=production

# COPY --chown avoids a `chown -R` layer that would duplicate all of node_modules.
# Runs as the image's built-in non-root `node` user.
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node prisma/ prisma/
COPY --chown=node:node --from=builder /workspace/dist ./dist

USER node
EXPOSE 8080

# Idempotent - safe to run on every startup, same as message-service's entrypoint.
# `exec` replaces the `sh` wrapper so SIGTERM from Kubernetes reaches the app's
# graceful-shutdown handler.
ENTRYPOINT ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
