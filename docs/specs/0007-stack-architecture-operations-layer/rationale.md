# 0007. Stack & architecture for the operations layer: rationale

Decision record for [index.md](index.md). `/develop` builds from the index; this file explains why.

## Context

SSDashboard was repositioned on 2026-11-05 from a warehouse ERP for one ecommerce business to the order operations and warehouse back office for Egyptian clothing brands behind Shopify, Bosta cash on delivery, consignment showroom partners, and Meta ads (final plan, `docs/positioning/2026-11-05-egypt-order-operations-layer.md`). The owner approved a rebuild and chose to re decide the stack rather than inherit spec 0001 (rebuild plan section 1).

The forces that shape the decision:

- **Team**: 1 to 3 developers plus AI agents. Every extra language, service, or deployable multiplies the work of each client install and upgrade.
- **Clients**: dozens, not hundreds. About four staff per brand, up to forty; about 120 orders a day in season (the debate's simulated brand); 10,000 SKUs designed, 50,000 tested.
- **Integrations are the product**: several Shopify stores per brand, Bosta in read only mirror or writing driver mode, Meta Conversions API, WhatsApp Cloud API, a daily report into Telegram or WhatsApp. These change on the providers' schedules and must switch off cleanly when the yearly Operations plan lapses.
- **Three audiences**: staff, a public exchange portal for customers (no accounts), and consignment partners who see only their own figures.
- **Hosting**: vendor hosted by default in an Egyptian data center, many client stacks per host, one PostgreSQL server with a database per client, backups kept in Egypt; self host with offline images; an exit package that works from the first pilot day (final plan section 5; the debate's "if you disappear" objection).
- **Money and stock correctness**: three append only ledgers and one settlement primitive (final plan 6.2); a returned to origin rate near 20 percent makes every leak visible.
- **Arabic first, phone first**, Cairo operating day.
- **Existing evidence**: main holds a working build of spec 0001's stack (specs 0002 to 0006), and a real Egyptian brand's operations console (the reference console) shows what this market's systems look like and where they break.

Not deciding means each slice invents its own connector handling, audience isolation, and tenancy, and the costliest of those (tenant id, role layout on a shared server) become retrofits.

## Options considered

### Option 1: Keep spec 0001 exactly as written

The stack, the per client Compose stack with its own PostgreSQL and Caddy, fixed role names, the generated OpenAPI client, and the old module list.

**Pros**: no design work; the code on main already matches it.
**Cons**: PostgreSQL in every stack contradicts the shared server per host; fixed role names are unsafe on a shared server (roles are global to a PostgreSQL server, and new databases grant `CONNECT` to `PUBLIC`); it has no answer for connectors, audiences, the report, the export engine, tenancy, or licensing; its 100,000 SKU target and module list belong to the old positioning; the OpenAPI client it promises was never built.

### Option 2: The 0001 stack, reshaped (chosen)

Same languages, frameworks, database, ORM, auth, and queue; a new architecture shape: connector pattern with inbox and outbox, two origins and an audience guard, shared server with per client roles, tenant id, signed license, shared catalogs, an `ops` entry point for the exit package, and enforced documentation conventions.

**Pros**: keeps a reviewed, tested build on a stack the team and its agents know; every new force gets an explicit pattern before the first slice; no new infrastructure per host beyond the shared PostgreSQL and edge proxy.
**Cons**: two app servers per client stack still cost memory on a shared host; more framework surface (NestJS plus Next.js) than a single framework app; the connector pattern adds tables and jobs before connectors ship value.

### Option 3: Next.js only, full stack

Business logic in Next.js route handlers and server code, a script based worker and a migrate container beside it, PostgreSQL directly. This is the shape the reference console runs today (Next.js 16 with self hosted Supabase PostgreSQL; production runs `migrate`, `app`, and `worker`, per its `README.md` and `docker-compose.prod.yml`).

**Pros**: one framework; one fewer image; a real Egyptian brand runs on it.
**Cons**: still three processes, so it saves less than it seems; ledgers and state machines would live in code that moves with every Next major (Next 16 renamed Middleware to Proxy, `apps/web/node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`), and `apps/web/AGENTS.md` already warns this Next version breaks assumptions; no dependency injection or module walls, so the audience and module boundaries become conventions; the worker must import domain code from the web app; the reviewed NestJS ledger and auth code is thrown away.

### Option 4: A backend as a service (Supabase)

Database, auth, storage, and generated APIs from the platform, logic in row policies and edge functions.

**Pros**: fastest start for auth and storage; familiar to the brand that built the reference console.
**Cons**: the Egyptian data center and self host requirements mean self hosting it per client, and its Compose file runs 11 services (studio, api gateway, auth, rest, realtime, storage, imgproxy, meta, functions, db, supavisor) per stack; ledger locking, idempotency, and settlement logic fit poorly in row policies and short lived functions; the reference console carried security debt in exactly this setup.

### Layer alternatives (inside Option 2)

| Layer | Alternative | Why not |
|---|---|---|
| Backend language | Go, Python with Django, PHP with Laravel, C# with .NET | A second language for 1 to 3 developers; no shared Zod contracts with the web; Django needs Celery plus Redis for jobs; rewrites reviewed code with no force requiring it. |
| Backend framework | Fastify or Hono | Lower memory, but guards, modules, and injection that carry the audience and module walls would be hand built. |
| Web | Static React app served by Caddy | Saves a container per stack; loses server rendering for the public portal and COD landing page on slow phones. Revisit if measured host memory binds. |
| Job queue | BullMQ | Redis on every host, and no enqueue inside the data transaction. |
| Job queue | Graphile Worker | Viable (PostgreSQL based); pg-boss is already proven here with time zone schedules, queue policies, and transactional send. |
| Object storage | MinIO (0001's pick) | Community images stopped in October 2025 and the repository is archived; replaced by the data center's S3 service or another S3 compatible server chosen in feature 3. |
| API contracts | OpenAPI plus a generated client (0001) | Never built; shared Zod contracts already give one schema per shape; return with the public API. |
| Tenancy | Row level security on a shared database now | Multi tenant hosting is parked; a tenant id column now keeps that path a migration. |

## Rationale

**Why the stack is confirmed, not replaced.** The new forces are integrations, audiences, and hosting topology. None of them is a language or framework problem: webhook verification, idempotent jobs, rate limited outbound calls, origin isolation, and per client database roles are patterns that NestJS, PostgreSQL, and pg-boss support directly, and each is now written down. Against that, a stack change costs the reviewed ledger (append only movements, the SKU and location advisory lock, idempotency, reconciliation) and sign in hardening that took the first build five working days and two GA reviews. For 1 to 3 developers, one language with shared Zod contracts still halves the surface compared with Options 2 and 3 of spec 0001's own record.

**Why 0001 is superseded rather than amended.** The plan's section 11 proposed an addendum. On the evidence, the changes are not additions: the hosting topology (shared server, per client roles, edge proxy per host), the contracts client, the module map, the scale target, and the configuration section all change, and 0001's configuration section describes files (`deploy/compose.yaml`, migration names, `PUBLIC_URL`) that Shape B would delete and Shape A will reshape. An amendment would force every reader to merge two documents that disagree in a dozen places. A self contained 0007 that confirms the stack and replaces the shape is easier to build from.

**Why two origins.** The portal is public, takes uploads, and is the most attacked surface; staff sessions protect cost, margin, and customer data. Same deployment keeps operations simple; separate hostnames make the browser enforce the wall (a host only cookie is never sent to another host). Path based separation on one host would rely only on code.

**Why per client roles and `REVOKE CONNECT`.** PostgreSQL documents that roles are global across a server ("Database roles are global across a database cluster installation (and not per individual database)") and that `CONNECT` and `TEMPORARY` are granted to `PUBLIC` on every new database. With 0001's fixed `ssdashboard_app` name on a shared server, one client's app password would open every client's database.

**Why a tenant id although each client has its own database.** The final plan requires it, and the brand's own developer added one "so the later SaaS transition is a migration, not a rewrite" (reference brand notes 2.12). A database level setting as the column default makes it impossible to forget.

**Why the exit package is an `ops` command and not a worker job.** It needs a role that reads everything and the PostgreSQL client tools; the worker should hold neither, so a bug in a job can never exfiltrate a full dump.

**Why the build plan has two shapes.** The owner reopened whether wave 3 wipes the code and asked for both shapes with a recommendation. Shape A was recommended because the stack is confirmed and the code is on it, the domain review reached the same view from the pilot calendar, and the owner chose it on 2026-11-05 ("do what you recommend"). Shape B stays in the index as the record of what was weighed.

**Revision after the domain review (2026-11-05).** `docs/reviews/domain-stack.md` (Fable) found two blockers: order numbers unique per brand instead of per store (fixed in index section 7), and an outbound pattern with no failure path while mirror mode depends on the Shopify write back landing first (fixed in index section 1 with a sync state, `OutboundCommandFailed`, a task, and a blocking rule before packing). Its Bosta facts come from the reference repo, read again for this revision: the dashboard registered webhook with one custom header, a webhook after every state change but none on creation, the dedupe key, and the 429 incident at about 60 back to back single delivery reads (`src/app/api/webhooks/bosta/route.ts`, `src/lib/webhooks/verify.ts`, `src/lib/bosta/sync.ts` in the reference console). The hosting findings come from `docs/research/0001-egypt-hosting-options.md`: no Egyptian provider confirms S3 compatible storage, so object storage is self run on each host and backups go to a second Egyptian provider.

**Deviations from the architect skill.** This ran as a sub agent with no interview: every question the skill would ask was decided by recommendation, and the ones only the owner can answer are in `## Open questions`. The skill keeps build plans out of stack decision specs; this spec carries one because the brief and the project's documentation standard (rebuild plan section 4) require a `## Build plan` of 2 to 5 milestones per spec, and scope feature 1 includes the scaffold. The cross check by another model was not run; the domain review in wave 2b serves that role.

## Evidence

### From the existing build (main, read only)

- Versions pinned: Node 26 (`.nvmrc`), pnpm 12.16.1 (`package.json`), Next.js 16.4.3, React 19.3.0, NestJS 12.3.2, Better Auth 1.7.15, pg-boss 12.38.0, Drizzle ORM 0.45.4, Zod 4.6.7, TypeScript 6.0.3, Turborepo 2.11.10, Vitest 4.1.12, Playwright 1.64.1, i18next 26.7.1 (`pnpm-lock.yaml`).
- Reviews with no blockers: `docs/reviews/2026-11-03-feat-data-model.md` (one major: the owner password reached app containers; fixed with per service env lists), `docs/reviews/2026-11-04-feat-staff-sign-in.md` (approve with fixes).
- The OpenAPI client was never built: `packages/contracts/AGENTS.md` ("Until the OpenAPI client lands, the web calls `/api` with `fetch`"), `apps/web/src/api/client.ts`.
- No tenant column anywhere in `packages/db/src` or `apps/api/src`.
- Locations today: `location_type` enum (`warehouse`, `showroom`, `transit`, `virtual`) and `is_sellable` (`packages/db/src/schema/locations.ts`).
- Scale test: `apps/api/test/scale.e2e-spec.ts` seeds 100,000 SKUs and 1,000,000 movements in about 1m45s (`apps/api/AGENTS.md`).
- pg-boss migrates its own schema on start (`.claude/skills/pg-boss-v12/SKILL.md`); schedules accept `tz` (`.claude/skills/pg-boss-v12/reference.md`); `send` accepts a `db` option for transactional jobs (`.claude/skills/tl-pg-boss/references/advanced-patterns.md`); Better Auth rate limits can use database storage (`.claude/skills/better-auth-security-best-practices/SKILL.md`).
- Size: 381 TypeScript files; 64 commits since 2026-11-01; build tasks per spec: 0002 12, 0003 5, 0004 6, 0005 9, 0006 18.

### From the reference console (read only)

- Stack and processes: Next.js 16, self hosted Supabase PostgreSQL, `migrate`, `app`, `worker` in production (`<reference-repo>\README.md`, `docker-compose.prod.yml`).
- Export freeze verified by reading workbook cells, not bytes (`scripts/verify-erp-fixtures.mjs`).
- Portal security checklist, Bosta data shape, and the read only Bosta choice: `docs/positioning/2026-11-05-reference-brand-notes.md` sections 2 and 3.

### Landscape check (web, 2026-11-05)

- Node.js 26 "Lithium" is LTS, 26.13.0 the latest LTS release; Node 27 is in alpha.
- PostgreSQL 18 current minor 18.6, supported to November 2030.
- Shopify: webhooks signed with `X-Shopify-Hmac-SHA256` (HMAC SHA256 of the raw body, app client secret); `X-Shopify-Webhook-Id` for deduplication; 1 second connect and 5 second total timeout; 8 retries over 4 hours, then Admin API subscriptions are deleted. GraphQL Admin API uses calculated query cost, at most 1,000 points per query; bulk operations are exempt from the per query cost and rate limits.
- Meta: WhatsApp and other Graph webhooks signed with `X-Hub-Signature-256` using the app secret (secondary sources); Conversions API deduplicates on `event_name` plus `event_id` within 48 hours, and an order id is a suitable `event_id`.
- Bosta: no official webhook documentation found; an unofficial .NET SDK says webhooks are registered in the dashboard and carry a configured secret. Treated as unknown.
- Cloudflare Turnstile: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`; tokens valid 300 seconds and verifiable once.
- MinIO community edition: binaries and images stopped in October 2025, repository archived in 2026 (secondary sources); Garage and SeaweedFS are commonly named replacements.
- Supabase self hosted Compose defines 11 services.
- `eslint-plugin-jsdoc` `require-jsdoc` supports `publicOnly`, `require`, `contexts` (including `TSInterfaceDeclaration`, `TSTypeAliasDeclaration`), `enableFixer`; older issues report `publicOnly` gaps for interfaces. `eslint-plugin-tsdoc` provides `tsdoc/syntax`, which validates syntax only. `eslint-plugin-react` `no-multi-comp` allows one component per file; `eslint-plugin-unicorn` `filename-case` enforces kebab case and accepts an `ignore` list.
- BullMQ is Redis based; Graphile Worker is PostgreSQL based (secondary sources).

## References

**Project sources**
- `docs/positioning/2026-11-05-egypt-order-operations-layer.md` sections 5, 6, 7, 8, 9, 11, 12, 13, 14
- `docs/positioning/2026-11-05-rebuild-plan.md` sections 1, 2, 4
- `docs/positioning/2026-11-05-reference-brand-notes.md` sections 2, 3, 7
- `docs/positioning/2026-11-05-brand-owner-debate.md` (volume figures, exit package objection)
- `docs/reviews/domain-stack.md` (domain review of this spec) and `docs/research/0001-egypt-hosting-options.md` (Egypt hosting options)
- `docs/specs/0001-stack-architecture/` and specs 0002 to 0006
- `AGENTS.md`, `apps/api/AGENTS.md`, `apps/web/AGENTS.md`, `apps/api/src/inventory/AGENTS.md`, `packages/contracts/AGENTS.md`
- Installed skills: `pg-boss-v12`, `tl-pg-boss`, `better-auth-security-best-practices`, `nextjs-app-router-patterns`, `postgresql-table-design`

**Practices & standards**
- Modular monolith first for small teams; boring technology
- Transactional inbox and outbox for integrations; idempotent consumers; webhooks as hints, sweeps as truth
- Least privilege database roles; append only ledgers corrected by new entries
- Expand and contract migrations; forward only
- Same origin policy and host only cookies as an isolation boundary
- Egyptian Personal Data Protection Law 151 of 2020 (data in Egypt; brand as controller, vendor as processor)

**Links** (opened or returned by search during this task)
- Node.js previous releases: https://nodejs.org/en/about/previous-releases
- PostgreSQL versioning policy: https://www.postgresql.org/support/versioning/
- PostgreSQL privileges (default PUBLIC grants): https://www.postgresql.org/docs/current/ddl-priv.html
- PostgreSQL database roles (global across a cluster): https://www.postgresql.org/docs/current/database-roles.html
- Shopify HTTPS webhooks: https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- Shopify API rate limits: https://shopify.dev/docs/api/usage/rate-limits
- Meta Conversions API server event parameters: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event
- WhatsApp webhook signatures (secondary): https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices
- Bosta.Net unofficial SDK: https://www.nuget.org/packages/Bosta.Net
- Cloudflare Turnstile server side validation: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Supabase self hosted Compose file: https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml
- MinIO community edition status (secondary): https://dev.to/rosgluk/minio-ce-in-2026-retired-upstream-source-only-and-what-to-use-1k02 and https://pinggy.io/blog/minio_archived_self_hosted_s3_alternatives/
- eslint-plugin-jsdoc `require-jsdoc`: https://github.com/gajus/eslint-plugin-jsdoc/blob/main/docs/rules/require-jsdoc.md
- eslint-plugin-jsdoc issues about `publicOnly` coverage (one of them reports exported interfaces missed): https://github.com/gajus/eslint-plugin-jsdoc/issues/492, https://github.com/gajus/eslint-plugin-jsdoc/issues/713, https://github.com/gajus/eslint-plugin-jsdoc/issues/1200
- eslint-plugin-tsdoc: https://github.com/microsoft/tsdoc/tree/main/eslint-plugin
- eslint-plugin-react `no-multi-comp`: https://github.com/jsx-eslint/eslint-plugin-react/blob/master/docs/rules/no-multi-comp.md
- eslint-plugin-unicorn `filename-case`: https://github.com/sindresorhus/eslint-plugin-unicorn/blob/main/docs/rules/filename-case.md
- Graphile Worker: https://www.github.com/graphile/worker
