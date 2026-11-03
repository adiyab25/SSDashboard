# 0001. Adopt a TypeScript modular monolith on PostgreSQL, shipped as one container set per client

**Date**: 2026-10-31
**Status**: Accepted

## Summary

SSDashboard is built as one TypeScript codebase: a NestJS backend (the server that holds all business rules) and a Next.js back office, both on PostgreSQL. Each client gets their own copy of the same Docker containers and their own database, running in your cloud or on the client's own servers, even without internet. Clients differ only through settings, module toggles, custom fields, and optional extension packages, never through edits to the shared core. This keeps the stack small enough for 1 to 3 developers while still letting each client pin and customize their install.

## Requirements

This is a decision spec. It records the stack, not build steps. The scaffold sub task of the Stack & architecture feature (`/develop stack & architecture`) derives its steps from `## Proposed stack` and `## Architecture shape` below. Scaffold installs only the runnable skeleton the first slice needs (web, app, migrate, database, proxy). Each later feature adds its own libraries when it is built.

## Decision

**Chosen option**: Option 1: TypeScript modular monolith (NestJS + Next.js + PostgreSQL), one container set per client.

One TypeScript monorepo produces two images, `app` (the NestJS api and worker) and `web` (Next.js). They run with PostgreSQL, S3 compatible storage, and Caddy as one Docker Compose stack per client, in your cloud or on premises.

**Implementation skills**: `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `better-auth-best-practices`, `better-auth-security-best-practices`, `email-and-password-best-practices`, `two-factor-authentication-best-practices`, `organization-best-practices`, `create-auth` (`better-auth/skills`, `.claude/skills/<name>/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `vercel-react-best-practices` (`.claude/skills/vercel-react-best-practices/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `tailwind-4-docs` (`lombiq/tailwind-agent-skills`, `.claude/skills/tailwind-4-docs/`) · TanStack Table skills `core`, `table-features`, `table-state`, `getting-started` (`tanstack/table`, `.claude/skills/<name>/`) · `turborepo` (`vercel/turborepo`, `.claude/skills/turborepo/`) · `pnpm` (`antfu/skills`, `.claude/skills/pnpm/`) · `multi-stage-dockerfile` (`github/awesome-copilot`, `.claude/skills/multi-stage-dockerfile/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Proposed stack

| Layer | Choice | Reason |
|---|---|---|
| Architecture pattern | Modular monolith: one backend with strict modules (catalog, inventory, purchasing, sales, production, costing, platform) | Right size for 1 to 3 developers and simple to run once per client. A module can be split out later if a real bottleneck appears. |
| Language & runtime | TypeScript (strict) on the current Node.js LTS, pinned in `.nvmrc` and the root `packageManager` field (pnpm) | One language across backend, frontend, and shared contracts. Pinned versions keep CI, developer machines, and images identical. |
| Backend framework | NestJS | Its module and dependency injection system maps directly onto the modular monolith, and it is the most established structured Node framework. |
| Back office frontend | Next.js (App Router), built with `output: standalone` for Docker | Engineer's pick. The app shell renders on the server, and data screens are client components (see Data loading rule). Shares code with a future storefront. |
| Phone & handheld scanning | The same Next.js app, mobile friendly and installable (PWA, an installable web app) | Camera scanning on phones, and rugged handhelds act as a keyboard. One codebase, no app store, works on premises. |
| UI components | shadcn/ui on Tailwind CSS v4, TanStack Table for data grids | You own the component code. Tailwind logical properties (start/end instead of left/right) make Arabic right to left layout clean. Feature 4 defines the design system on top. |
| Primary database | PostgreSQL, one pinned major version per release, with the `pg_trgm` and `unaccent` extensions | Transactions and row locks keep stock correct, JSONB (structured JSON columns) holds custom fields, and full text search is built in. Identical in the cloud and on premises. |
| Data access & migrations | Drizzle ORM with drizzle-kit SQL migrations, all in `packages/db` | Typed queries close to SQL, so row locks, ledger sums, and reports stay readable. Migrations are plain SQL files you can review. |
| API style | REST, described by OpenAPI (a standard machine readable API description) | The frontend gets end to end types, and the same contract later becomes the public API and webhooks (feature 48). |
| Validation & contracts | Zod schemas in `packages/contracts`, wired into NestJS with `nestjs-zod` (validation and the OpenAPI document). The browser client is generated with `openapi-typescript` and called through `openapi-fetch` | One schema validates requests, produces the API docs, and validates forms. A tiny typed client with no heavy runtime. CI fails if the generated client is out of date. |
| Auth | Better Auth, mounted in the NestJS api at `/api/auth`, its tables in `packages/db` | Self hosted, so it works fully on premises with no per user fees. Exact flows are decided in feature 6. |
| Background jobs | pg-boss (a job queue stored in PostgreSQL) in its own `pgboss` schema, run by the worker entry point of the `app` image with its own small connection pool | No extra service per install. Jobs can be queued in the same transaction as the data change. Its own pool means jobs can never starve stock writes. |
| Search | PostgreSQL full text search (the `simple` config plus Arabic and English normalization) and `pg_trgm` (fuzzy and partial matching) | Handles 100,000+ SKUs in both languages with the right indexes. PostgreSQL has no Arabic stemmer, so text is normalized instead (details in feature 9). A search engine is added only if measurements demand it. |
| File storage | S3 compatible object storage: a cloud bucket for hosted clients, MinIO (a self hosted S3 compatible server) on premises | One code path everywhere. Files never go in the database. |
| Email | One mail interface with two adapters: SMTP (default) and a transactional email API | SMTP works with any provider or a client's own mail server. The API adapter is for cloud clients who want delivery stats. |
| Reverse proxy | Caddy | Routes `/api/*` to the api and everything else to web on one domain per client, with automatic HTTPS. |
| Packaging & hosting | Two images, `app` and `web`, plus one versioned Docker Compose file per release, run in your cloud or on the client's server | One deployment method for both hosting models, simple enough for a small team to operate. |
| Repo & build | One monorepo with pnpm workspaces and Turborepo | Shared types and schemas, one version per release, cached builds. |
| CI & registry | GitHub Actions: lint, test, the upgrade test, then build amd64 images and push them to GitHub Container Registry tagged with the release version. Each release also attaches an offline image file (`docker save`) | Every install pulls an exact version. Offline clients load the file by hand. |
| Observability | Structured JSON logs (pino) from every process, plus a Sentry compatible SDK reporting to Sentry (cloud) or a self hosted compatible server such as GlitchTip (on premises) | Errors are visible from day one in both hosting models. Dashboards and alerting come in feature 16. |
| Releases | Semantic versions. Each client pins a version. Supported: the latest minor plus the previous minor, fixed on `release/x.y` branches | Clients upgrade when they choose. Security fixes are backported to both supported lines. |

## Architecture shape

The shape every later feature builds inside. `/develop` derives the exact files at scaffold time.

**Repo layout**
- `apps/web`: Next.js back office (and later the scanning screens).
- `apps/api`: NestJS. Three entry points from the same code, all in the `app` image: `api` (HTTP), `worker` (pg-boss jobs), and `migrate` (runs migrations and exits).
- `packages/contracts`: Zod schemas, shared types, the generated OpenAPI document, and the generated client.
- `packages/db`: Drizzle schema and SQL migrations for everything, including Better Auth tables. It is the only migration history.
- `packages/config`: shared TypeScript, lint, and Tailwind config.
- `extensions/<client>`: optional per client extension packages (see Customization).
- `deploy/`: Dockerfiles, the Compose template, the Caddyfile, the env template, and the bootstrap script.

**Runtime per client install** (one Compose stack): `caddy` → `web` and `api`; `worker`; `migrate` (one off); `postgres` (pinned major, data on a named volume); `minio` on premises (cloud uses a bucket). `api`, `worker`, and `migrate` always run the same `app` image tag. Each client has its own database and storage. No data is shared between clients. Every container has a memory limit, and the worker caps how many jobs run at once.

**Module rules (backend)**
- Each business area is one NestJS module, with its own Drizzle tables, services, and controllers.
- Modules call each other only through exported services or domain events, never by reading another module's tables directly.
- Every stock change goes through the inventory module's ledger service (the single writer of stock movements), so the stock ledger stays append only and consistent (details in the data model spec, feature 3).

**Sessions & routing**
- Better Auth is mounted in NestJS at `/api/auth`. NestJS's default body parser is turned off for that route so Better Auth can read the raw request (a known requirement).
- The session cookie is host only (no domain attribute), `Secure`, `HttpOnly`, and `SameSite=Lax`.
- `baseURL` and trusted origins come from one `PUBLIC_URL` env var. NestJS trusts the proxy and reads `X-Forwarded-*` from Caddy.
- Next.js checks a session by calling `GET /api/auth/get-session` over the internal network (`API_INTERNAL_URL`) and forwarding the cookie. It never holds the auth secret or reads the database.

**Data loading rule**: server components render only the app shell (layout, navigation, session check). All business data loads in client components through the generated client, calling relative `/api` paths. No stock, pricing, or business logic lives in Next.js server code.

**Runtime config (one web image for every client)**: no per client value is baked in at build time, and `NEXT_PUBLIC_*` variables are not allowed for per client settings. The browser uses relative `/api` paths. Any other client facing setting (branding, enabled modules, languages) comes from an api `GET /api/config` endpoint. Server side values like `API_INTERNAL_URL` are runtime env vars.

**Customization model** (one shared core, never forked)
1. Settings and module toggles stored in each install's database (feature 46). A toggled off module hides its UI and rejects its API calls.
2. Custom fields on core records (products, suppliers, orders, and others) stored in JSONB columns, with definitions per client (shape decided in feature 3 and feature 46).
3. Extension packages: client specific code in `extensions/<client>`, compiled into a thin derived image (`FROM app:<version>` plus the extension). The core loads it at startup by dynamic import, listed in an `EXTENSIONS` env var, through defined hook points (events, extra endpoints, extra screens). The core never imports an extension. Extensions keep their own tables in their own schema and never migrate core tables. Scaffold ships only an empty loader. The hook contract is decided in feature 46.
4. External add ons talk to the public API and webhooks (feature 48).

**Versions, images, and client pins**
- Image tags equal the release version (`1.4.2`). A client's install records the tag and its image digest (the image's unique fingerprint). Client installs never use `latest`.
- The Compose file and env template are versioned with the release and ship with it, so a new env var always travels with the version that needs it.
- Each client's env file and pinned version live in a private per client store (a private repo or a vault), never in this monorepo.
- Offline installs: each release attaches `app` and `web` image files the client loads with `docker load`, plus the matching Compose file.

**Upgrades and migrations**
- Migrations run only in the one off `migrate` service. Compose starts `api` and `worker` only after it completes successfully. The api never migrates on boot.
- `migrate` holds a PostgreSQL advisory lock (a database wide lock by name) while running, so two runs can never overlap. It also applies pg-boss's own schema setup.
- Migrations only move forward. There are no down migrations. Rolling back means restoring the pre upgrade backup.
- Each migration must apply cleanly from any supported version, so a client can jump several versions at once. CI proves this with an upgrade test: restore a database from the previous supported minor and migrate it to the new code.
- Each migration runs in a transaction, so a failure leaves the database unchanged. Steps that cannot run in a transaction (for example `CREATE INDEX CONCURRENTLY`) go in their own small migration that is safe to run twice.
- No destructive change ships in one release: add the new column or table, move the data, and drop the old one at least one minor version later (the expand and contract approach). Data moves always happen inside SQL migrations, never in app code or background jobs, so a client who skips versions still gets them.
- The first migration enables `pg_trgm` and `unaccent`.

**Configuration & secrets**

Each install is configured only by environment variables. The same images run for every client. The api, worker, and migrate validate their variables at startup in `apps/api/src/config/env.ts` and stop with `Invalid environment` if a required one is missing.

*Two database roles* (the reasoning and the ledger grants are in [spec 0002](../0002-core-data-model/index.md), Security model)
- **Owner** (`ssdashboard`, the Compose `postgres` user): owns the schema and runs migrations. Only `migrate` connects as it, through `MIGRATION_DATABASE_URL`. Its password is `POSTGRES_PASSWORD`. Migration `0001_core_data_model.sql` creates the application role (it skips that step if the role already exists), `0002_job_queue_schema.sql` creates the `pgboss` schema owned by that role, and every `migrate` run changes that role's password. The Compose owner is a superuser, so all three just work. On a managed database the owner is usually not a superuser, and on PostgreSQL 16 and later a role it creates does not let it act as that role. So before the first `migrate` you run, as an admin: `CREATE ROLE ssdashboard_app NOLOGIN;` then `GRANT ssdashboard_app TO <owner> WITH ADMIN OPTION, SET TRUE;`. This has not been tried on a live managed database yet (see Follow-up).
- **Application** (`ssdashboard_app`): the api and worker connect as it, through `DATABASE_URL`. It can only insert and read the stock ledger history, and reads and writes normally elsewhere. The migration `0001_core_data_model.sql` creates it with its grants and default privileges (the rules new tables inherit). Each `migrate` run then sets its login password from `APP_DB_PASSWORD`, so the password lives in `.env` and nowhere else. `env.ts` keeps `APP_DB_PASSWORD` optional: an install outside Compose that leaves it unset gets no login from `migrate` and creates one itself.

*How `.env` reaches the containers*: Compose reads `.env` only to fill in values (`docker compose --env-file .env up -d`). No service loads the whole file with `env_file`. Each service gets an explicit `environment` list with only what it needs, so the owner password reaches `postgres` and `migrate` and nothing else. A bug or a compromised dependency in the api cannot find the owner secret in its own environment. Every required variable is guarded with `${NAME:?message}` at least once in the file, so Compose refuses to start when one is missing instead of starting with an empty value. The `app` image fixes `NODE_ENV=production` and `PORT=3001` (`deploy/Dockerfile.app`). Neither is set per install: Caddy and `API_INTERNAL_URL` expect port 3001, and `NODE_ENV=production` stops the api from loading a stray `.env` file inside the container.

*What each service receives* (`deploy/compose.yaml`)

| Service | Variables | Owner password? |
|---|---|---|
| `postgres` | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | yes |
| `migrate` | the shared app list, plus `MIGRATION_DATABASE_URL` (built from `POSTGRES_PASSWORD`) and `APP_DB_PASSWORD` | yes |
| `api` | the shared app list, plus `PUBLIC_URL` and `BETTER_AUTH_SECRET` (both read from feature 6, sign in) | no |
| `worker` | the shared app list, plus `LEDGER_RECONCILE_CRON` | no |
| `web` | `API_INTERNAL_URL` only (today only the dev server reads it; production reads it from feature 6, for the session check). It never sees a database URL or the auth secret | no |
| `caddy` | `SITE_ADDRESS` only | no |

The shared app list (the `x-app-env` block, given to `migrate`, `api`, and `worker`) is `DATABASE_URL` (the application role, built from `APP_DB_PASSWORD`), `APP_VERSION` (from `SSD_VERSION`), and `EXTENSIONS`. `CLIENT_ID`, `SSD_VERSION`, and `SSD_REGISTRY` are used by Compose itself (the project name and the image tags) and reach no container as their own variables.

*Adding a variable*: add it to `env.ts` (or the web's runtime config), to both `.env.example` files, and to the `environment` list of only the services that read it. Never switch a service to `env_file` to save typing. Variables still to come follow the same rule: storage keys go to `api` and `worker`, mail settings to `api` and `worker`, and the Sentry DSN to every app service and `web`, each added by the feature that first needs it.

*Local development* uses the same split. The root `.env` (copied from `.env.example`) holds `DATABASE_URL` as `ssdashboard_app`, `MIGRATION_DATABASE_URL` as the owner, and `APP_DB_PASSWORD`, against the dev database from `deploy/compose.dev.yaml` on port 5433. `pnpm db:migrate` connects as the owner. The api and worker connect as the application role, so local runs hit the same permission errors production would.

*Creating the secrets*: on a new install, `deploy/bootstrap.sh` copies `deploy/.env.example` to `.env` (permissions 600, never committed, kept in the private per client store) and fills `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, and `BETTER_AUTH_SECRET` with random 64 character hex values. It refuses to overwrite an existing `.env`. An install whose `.env` predates `APP_DB_PASSWORD` adds a value by hand before upgrading: `od -An -N32 -tx1 /dev/urandom | tr -d ' \n'`. The next `migrate` sets the login, and Compose refuses to start until the value is there.

`APP_DB_PASSWORD` must be hex only (`0-9`, `a-f`), because Compose puts it into `DATABASE_URL` without encoding it, and a character like `@`, `/`, or `#` would break the URL. `migrate` checks this and stops with a clear message if the value has any other character (to build: see Follow-up).

*Rotating a secret*
- `APP_DB_PASSWORD`: edit `.env` (a new hex value) and run `docker compose --env-file .env up -d`. `migrate` runs first and sets the new login, then `api` and `worker` restart with it. Their open connections drop for a few seconds and requests in flight fail, so do this in a quiet window.
- `POSTGRES_PASSWORD`: the `postgres` image reads this value only when it first creates the data volume, so editing `.env` alone breaks `migrate`. First keep a copy of the current `.env`. Then change the role with `docker compose exec postgres psql -U ssdashboard -d ssdashboard -c '\password ssdashboard'` (it prompts for the new value, so it never lands in shell history). Then put the same value in `.env` and run `up -d`. That restarts `postgres` and runs `migrate` again, so expect a short outage. Delete the old copy only after `migrate` succeeds.
- `BETTER_AUTH_SECRET`: edit `.env` and restart `api`. This signs every user out.

## Consequences

**Positive**:
- One language and one repo for a small team. Shared Zod contracts remove a whole class of frontend and backend mismatches.
- The same two images and the same Compose file run in your cloud, on premises, and offline, so there is only one deployment path to learn and debug.
- PostgreSQL alone covers transactions, jobs, search, and custom fields, so each install has few moving parts.
- api, worker, and migrate share one image, so they can never run different versions against the same database.
- Customization through settings, fields, and extensions means every client stays on the shared core and receives fixes.

**Negative / tradeoffs**:
- Next.js plus a separate NestJS api means two servers and two builds for an app that is all behind login. A static build served by Caddy would remove the `web` container. You chose Next.js knowingly.
- Pinned versions per client mean two supported release lines, backports on `release/x.y` branches, an upgrade test in CI, and the discipline that every migration works from older versions. This is real ongoing work.
- With no down migrations, every upgrade needs a backup taken just before it (feature 16 must make that automatic).
- Extension packages are powerful but can become forks in disguise if the hook contract is loose. Feature 46 must keep it narrow.
- Docker Compose on one host has no automatic failover. A host failure means downtime until restored. This is acceptable now, but large clients may later need a high availability setup.
- PostgreSQL search and the PostgreSQL job queue share the database's load. Heavy imports and syncs need watching (feature 16).

**Neutral**:
- Accounting lives in a separate app. This stack only records costs and prices and exports them (feature 50).
- POS and the storefront are not covered here. Each gets its own surface decision when reached (features 32 and 42), building on this api.
- Images are amd64 only for now. ARM servers would need a multi architecture build later.

## Follow-up

- [ ] Project wide skill conventions not yet in root `AGENTS.md` `## Rules` (`AGENTS.md` does not exist yet): NestJS, Drizzle, PostgreSQL table design, Next.js App Router, React, shadcn, Tailwind 4, TanStack Table, Turborepo, pnpm, multi stage Dockerfiles. These apply to every file and belong at root level, captured by `/audit` after scaffold.
- [ ] Better Auth skill conventions (six skills) belong in the auth area's nested `AGENTS.md` (e.g. `apps/api/src/auth/AGENTS.md`), not root.
- [ ] MCP servers you chose to connect yourself (a user config step): shadcn registry (`npx shadcn@latest mcp init`), Better Auth docs (`https://mcp.better-auth.com/mcp`), Next.js devtools (`vercel/next-devtools-mcp`), and a community Postgres MCP (dev data only). `/audit` should list them on the `MCP servers:` line in `AGENTS.md`.
- [ ] The TanStack Table install also added framework variant skills not used here (`devtools`, `migrate-v8-to-v9`, `custom-features`, `fuzzy-ranking`). Remove them if they add noise.
- [ ] Build the `APP_DB_PASSWORD` check: `migrate` stops with a clear message when the value is not hex only. Small change in `apps/api/src/config/env.ts` (a hex rule on `APP_DB_PASSWORD`) and `deploy/.env.example` (say hex only).
- [ ] Try the managed database setup (create the app role ahead of time, then `GRANT … WITH ADMIN OPTION, SET TRUE`) on a real managed PostgreSQL 16+ before the first cloud client uses one, then remove the "not tried yet" note.
- [ ] Decisions owed to later features: translation library and locale handling (feature 5), design tokens and grid patterns (feature 4), sign in flows and session policy (feature 6), money and quantity number types and custom field storage (feature 3), Arabic text normalization details (feature 9), the extension hook contract and module toggles (feature 46), monitoring, automatic pre upgrade backups, and restore tooling (feature 16).
