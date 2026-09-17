# Multi-stage Dockerfile for the issue-service Apollo Server + Prisma GraphQL API.
# Build context is this directory (issue-service/) - see deploy-kind.sh.

# Stage 1: Build stage
FROM node:24-alpine AS builder
WORKDIR /workspace

# Copy manifests first for dependency caching
COPY package.json package-lock.json ./
COPY prisma/ prisma/
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 2: Runtime stage
FROM node:24-alpine
WORKDIR /app

# Prisma's query engine binary needs openssl on Alpine (musl) - without it the engine
# fails to load at runtime with a cryptic "Unable to require libquery_engine" error.
RUN apk add --no-cache openssl

# Create a non-root group and user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json ./
COPY prisma/ prisma/
RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /workspace/dist ./dist
RUN chown -R appuser:appgroup /app

USER appuser

ENV NODE_ENV=production
EXPOSE 8080

# Idempotent - safe to run on every startup, same as message-service's entrypoint.
ENTRYPOINT ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
