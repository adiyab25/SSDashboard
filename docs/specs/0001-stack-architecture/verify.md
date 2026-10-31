# Verify: Stack & architecture · spec 0001 · updated 2026-10-31
_Steps derived from spec 0001 and the feature's Done when (the spec is a decision spec, so it has no `AC-N` IDs; steps map to the Done when parts below). `/check verify` runs these; `/test` locks the durable ones._

Done when parts: **D1** the empty scaffold passes build · **D2** it boots locally · **D3** the per client install model (own install and database, Compose stack, env only config) works as specced.

## Commands
- [x] Fresh clone, Node 26, `pnpm install --frozen-lockfile` → completes with no ignored build script errors → D1
- [x] `pnpm build` → every task succeeds (contracts, db, api, web) → D1
- [x] `pnpm typecheck` → every task succeeds → D1
- [x] Copy `.env.example` to `.env`, `docker compose -f deploy/compose.dev.yaml up -d`, then `pnpm db:migrate` → prints `Migrations applied.`; `select extname from pg_extension` lists `pg_trgm` and `unaccent`; `drizzle.__drizzle_migrations` has 1 row → D2 _(2026-10-31: rerun through compose.dev with Docker. It first hit a local PostgreSQL already on host port 5432, so the dev database now publishes host port 5433 and `.env.example` matches)_
- [x] Run `pnpm db:migrate` twice at the same time → both exit 0, still 1 migration row (advisory lock) → D3
- [x] Start the api with `DATABASE_URL` unset → prints `Invalid environment` naming `DATABASE_URL`, exits 1 → D2
- [x] `pnpm dev`, then `curl localhost:3001/api/health` → `{"status":"ok","version":"0.0.0-dev","database":"up"}` → D2
- [x] Stop the dev database, `curl localhost:3001/api/health` → 200 with `"status":"degraded","database":"down"`, api keeps running → D2 _(2026-10-31: first failed, the api crashed on an unhandled pool `error` event; fixed in `packages/db/src/client.ts`. Rerun against a stand in PostgreSQL 15.8 on port 5433: degraded while down, back to `ok` after restart. Passed again against the compose.dev database)_
- [x] `docker build -f deploy/Dockerfile.app --build-arg APP_VERSION=0.1.0 -t ssdashboard-app:0.1.0 .` and the same for `deploy/Dockerfile.web` → both build; `docker run --rm ssdashboard-app:0.1.0 id -u` is not 0 → D3 _(2026-10-31: run with Docker 29.9.2)_
- [x] In `deploy/`: `./bootstrap.sh` → writes `.env` with mode 600 and 64 character secrets; running it again refuses to overwrite → D3 _(2026-10-31: run with Docker 29.9.2)_
- [x] Set `CLIENT_ID`, `SSD_VERSION=0.1.0`, `SSD_REGISTRY` (local tags), `SITE_ADDRESS=:80` in `deploy/.env`; `docker compose --env-file .env up -d` → `migrate` exits 0 before `api` starts; `postgres`, `api`, `web` report healthy → D3 _(2026-10-31: run with Docker 29.9.2)_
- [x] `curl localhost/api/health` through Caddy → `"status":"ok"`, `"version":"0.1.0"` → D3 _(2026-10-31: run with Docker 29.9.2)_

## UI / manual
- [x] With `pnpm dev` running, open `http://localhost:3000` → heading `SSDashboard`; API `ok`, Database `up`, Version shown (loaded in the browser through relative `/api`) → D2
- [x] Stop the api, reload → API shows `unreachable (…)`, the page itself still renders → D2
- [x] Through the Compose install, open `http://localhost` → the same page, served by `web` behind Caddy → D3 _(2026-10-31: run with Docker 29.9.2)_

## Acceptance-criteria coverage
- D1 (passes build) … covered by the install, build, and typecheck steps
- D2 (boots locally) … covered by migrate, env check, health ok/degraded, and the two dev UI steps
- D3 (per client install model) … covered by the concurrent migrate, docker build, bootstrap, Compose up, Caddy health, and Compose UI steps
