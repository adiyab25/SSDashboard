# syntax=docker/dockerfile:1
# The `app` image: the NestJS api, plus the `migrate` entry point (and later the worker).
# Build from the repo root:
#   docker build -f deploy/Dockerfile.app --build-arg APP_VERSION=1.0.0 -t ghcr.io/<owner>/ssdashboard-app:1.0.0 .

ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-alpine AS base
# Keep these in step with `packageManager` and the turbo catalog entry.
ARG PNPM_VERSION=12.16.1
ARG TURBO_VERSION=2.11.10
RUN npm install -g pnpm@${PNPM_VERSION} turbo@${TURBO_VERSION}
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

# Keep only the api and the workspace packages it depends on.
FROM base AS prune
COPY . .
RUN turbo prune @ssdashboard/api --docker

FROM base AS build
# Manifests and lockfile first, so dependency installs stay cached until they change.
COPY --from=prune /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN turbo run build --filter=@ssdashboard/api
# A self contained copy with production dependencies only (includes packages/db migrations).
RUN pnpm deploy --filter=@ssdashboard/api --prod /out

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_VERSION=0.0.0-dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# `migrate` runs this same image with: node dist/migrate.js
CMD ["node", "dist/main.js"]
