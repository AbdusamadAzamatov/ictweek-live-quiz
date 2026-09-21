# syntax=docker/dockerfile:1
# ICTWEEK quiz app — production image.
# Build context is the repo root:  docker build -f docker/Dockerfile .

FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
# openssl: prisma engines link against it on alpine/musl.
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app

# Warm the pnpm store from the lockfile alone (cached while deps don't change).
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Install from the warmed store; package.jsons are all pnpm needs here.
COPY package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# Build shared → server (prisma generate + tsc) → web (vite).
# A placeholder DATABASE_URL satisfies prisma.config.ts during `generate`
# (no connection is made); the real URL is injected at runtime.
COPY . .
ENV DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ictquiz
RUN pnpm build

# Produce a self-contained server deploy with production deps only
# (includes apps/server/dist with the generated Prisma client, prisma/
# migrations and prisma.config.ts; workspace deps are bundled).
# --legacy: required on pnpm >=10 for workspaces without injected deps.
RUN pnpm deploy --legacy --filter @ictquiz/server --prod /prod/server

# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production \
    MEDIA_DIR=/data/media \
    PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /prod/server /app/apps/server
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
COPY docker/entrypoint.sh /entrypoint.sh

# Only /data needs a chown (volume mount point); avoid chown -R /app —
# it would duplicate every app file into a second layer.
RUN mkdir -p /data/media && chown node:node /data/media
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["sh", "/entrypoint.sh"]
