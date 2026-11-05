# 0007. Keep the TypeScript modular monolith and reshape it for connectors, three audiences, and many client stacks per host

**Date**: 2026-11-05
**Status**: Accepted (owner approval at the gate on 2026-11-05; domain review re-review: approve, 0 open blockers)
**Supersedes**: [0001](../0001-stack-architecture/index.md)

## Summary

The stack stays: TypeScript, a NestJS api and worker, a Next.js web app, PostgreSQL 18, Drizzle, Better Auth, and pg-boss, all in one repository. What changes is the shape around it. Connectors to Shopify, Bosta, Meta, and WhatsApp get one fixed pattern (a durable inbox for incoming messages, outgoing calls only from background jobs, recorded test fixtures). The app serves three audiences from one deployment (staff, the public exchange portal, consignment partners) with hard walls between them. Hosting moves to many client stacks on one host in an Egyptian data center, sharing one PostgreSQL server with a database and its own login roles per client.

Spec 0001 is **superseded**, not amended: its technology choices are confirmed on the evidence, but its hosting topology, role names, module map, and scale target no longer fit, and it describes files the rebuild may change. This spec restates everything kept, so a reader needs only this one.

Wave 3 keeps the current code and amends it (Shape A), as the owner ruled on 2026-11-05 ("do what you recommend"); Shape B stays below as the record of what was weighed. This revision also closes the domain review (`docs/reviews/domain-stack.md`): its two blockers are fixed in sections 1 and 7, and every other finding is applied here or carried by name into the feature that owns it (`## Carried from the domain review`).

## Verdict on spec 0001

| Part of 0001 | Verdict | Why |
|---|---|---|
| Language, runtime, frameworks, database, ORM, auth, job queue, UI kit, monorepo tooling | **Confirmed** | Built, reviewed with no blockers, and tested on main (`docs/reviews/2026-11-03-feat-data-model.md`, `docs/reviews/2026-11-04-feat-staff-sign-in.md`); none of the new forces (connectors, three audiences, Egyptian hosting) needs another language or framework. See [rationale.md](rationale.md). |
| One Compose stack per client, PostgreSQL inside every stack, one Caddy per stack | **Replaced** | The final plan hosts many stacks per host with one PostgreSQL server and a database per client (final plan section 5). See *Hosting* below. |
| Fixed role names `ssdashboard` and `ssdashboard_app` | **Replaced** | PostgreSQL roles are global to the server, and every new database grants `CONNECT` to `PUBLIC` by default, so fixed names on a shared server would let one client's app role reach another client's database. See *Database roles*. |
| OpenAPI document plus generated client, with a CI freshness check | **Replaced** | It never landed: the web calls `/api` with `fetch` and parses with the contract schemas (`packages/contracts/AGENTS.md`, `apps/web/src/api/client.ts`). The shared Zod contracts already give one schema per shape. OpenAPI returns with the public API (parked). |
| Module list (catalog, inventory, purchasing, sales, production, costing, platform) and the 100,000 SKU target | **Replaced** | The new positioning has a different module map and a 10,000 SKU target tested at 50,000 (scope planning notes). |
| Modular monolith, module boundaries, append only stock ledger, two database roles, env only config, forward only migrations, extensions, pinned versions, offline images | **Kept**, restated below | Still right for 1 to 3 developers and dozens of clients. |

## Requirements

This is a decision spec. Its requirements are the forces the architecture must satisfy; `verify.md` checks each one. The eleven parts the brief named are R-1 to R-11.

- **R-1 Connector layer**: Shopify (several stores per brand), Bosta, Meta Conversions API, WhatsApp Cloud API, and the report channel follow one pattern: signed inbound webhooks into a durable inbox, idempotent worker processing, outbound calls only from worker jobs, rate limits respected, carrier mirror and driver modes per brand, clean switch off on license lapse, recorded fixtures only in tests.
- **R-2 Audiences**: a public exchange and return portal (phone plus order id, no accounts) and a partner surface (own given, sold, owed only) run in the same deployment as the back office, isolated by origin, route group, api audience guard, rate limits, and abuse checks.
- **R-3 Daily report**: a worker job reading the same model, with no host privileges.
- **R-4 Export engine**: templated per client, versioned immutable exports, preflight, fixture freeze test, in a core module.
- **R-5 Hybrid dev environment**: containers for the database, object storage, and a mail catcher; `pnpm dev` for the apps; CI builds the real images.
- **R-6 Hosting**: one Compose stack per client, many per host, one PostgreSQL server with a database per client, in an Egyptian data center with backups kept in Egypt; self host with offline images; the exit package as product.
- **R-7 Tenant id** on every row from the first migration.
- **R-8 Location owner type** as a setting, enforced as one code path.
- **R-9 Documentation and conventions**: TSDoc enforced by lint, a README per module and feature folder, ADRs, route groups by audience, folder by feature, naming, git, and documentation kept true (see `## Conventions`).
- **R-10 Arabic and English** from day one, right to left, message catalogs shared by every process, Cairo time, the operating day.
- **R-11 Scale**: 10,000 SKUs designed, 50,000 tested.
- **R-12 Bundles**: Warehouse and Operations as module toggles plus a signed license, one image.

## Decision

**Chosen option**: Option 2 in [rationale.md](rationale.md): the TypeScript modular monolith from 0001, reshaped (connector pattern, three audiences on two origins, shared database server per host with per client roles, tenant id, license, shared catalogs, documentation conventions).

**Owner decisions recorded 2026-11-05** (the owner's words: "do what you recommend"):
- Wave 3 runs **Shape A**, keep and amend.
- **Support window**: vendor hosted clients all move to the latest minor in a maintenance window; self hosted clients get security fixes on the latest and the previous minor.
- **Object storage**: an S3 compatible store other than MinIO; feature 3 picks it.
- **License grace period**: 14 days after the Operations plan expires.
- **Two hostnames per brand** (staff and returns), with the DNS step in onboarding (Carried m8).
- **Cloudflare Turnstile** on the portal lookup, as the reference brand already runs it on Egyptian customers; the privacy notice (feature 30) names it.
- **Migration baseline**: reset to one baseline inside the feature 4 build, before the pilot brand's first import, provided no install runs the current migrations (a fact Igris confirms).

**Implementation skills**: `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `pg-boss-v12` (`sncollective/snc-platform`, `.claude/skills/pg-boss-v12/`) · `tl-pg-boss` (`toddlevy/tl-agent-skills`, `.claude/skills/tl-pg-boss/`) · `better-auth-best-practices`, `better-auth-security-best-practices`, `organization-best-practices` (`better-auth/skills`, `.claude/skills/<name>/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `turborepo` (`vercel/turborepo`, `.claude/skills/turborepo/`) · `pnpm` (`antfu/skills`, `.claude/skills/pnpm/`) · `multi-stage-dockerfile` (`github/awesome-copilot`, `.claude/skills/multi-stage-dockerfile/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Decisions at the gate

The owner's answers, 2026-11-05, to the nine "Questions for the owner" in `docs/reviews/domain-stack.md`. Items 5 to 9 are the **recommended default, accepted by the owner without override**.

| # | Question | Decision (owner, 2026-11-05) | Where it lands |
|---|---|---|---|
| 1 | Lapse behaviour (M5) | A read only wind down. Mirror reads and the cash sweep keep running for shipments created before the lapse until each reaches a final cash state or the setting `operations_wind_down_days` passes (default 60, matching the reference repo's 60 day fee window). New shipments, the confirmation queue, and driver mode stop. Expiry warnings at 30, 14, and 7 days in the shell and the daily report. Grace period 14 days. A renewal starts a backfill sweep over the gap. | Section 1 *Switching off on lapse*; *Bundles*; scope feature 9 |
| 2 | Pilot window | Mid March to early May 2027, between Eid al Fitr and Eid al Adha. Slice 1a must land before it, with little slack. | `## Build plan` (schedule line) |
| 3 | Bosta accounts (B1, M1) | Both setups work: carrier accounts are modelled per tenant with an optional store binding (one account for all stores, or one per store). Order numbers are unique per store. Cash matching by tracking number and business reference carries the store id. | Sections 1 and 7; scope features 4, 13, 19, 22 |
| 4 | Export template changes (M9) | A vendor change, with a promised turnaround written into the contract. Templates live in the client's extension with their fixture and freeze test. No in app editing in version one. | Section 4; scope feature 45 |
| 5 | Who marks an export imported (M9) | Recommended default, accepted by the owner without override: the operations hat, on the accountant's word, with who and when recorded on the run. An accountant hat can be added in feature 8 later. | Section 4; scope feature 45 |
| 6 | Report channel (m6) | Recommended default, accepted by the owner without override: a Telegram group first. WhatsApp group delivery is a later feature, once Meta's documentation is checked. | Section 3; scope feature 25 |
| 7 | Turnstile under Law 151 | Recommended default, accepted by the owner without override: accepted for the pilot on the real brand's precedent. A server side challenge plus rate limits is designed as the fallback, and the question goes to counsel with the Law 151 licensing check. | Section 2; scope feature 29 |
| 8 | Exit destinations | Recommended default, accepted by the owner without override: Google Drive first (proven at the real brand), then an S3 bucket the brand controls, then a local disk, as feature 27 grows. | Section 6; scope feature 27 |
| 9 | Partners serving several brands | Recommended default, accepted by the owner without override: one login per brand stack is acceptable for slice 2. A shared partner sign in is a later design question, not a slice 2 requirement. | Section 2; scope feature 41 |

## Proposed stack

Versions are the ones pinned on main today (`pnpm-lock.yaml`, `.nvmrc`, `package.json`); the scaffold keeps or bumps them, it never downgrades. Each later feature adds its own libraries when it is built.

| Layer | Choice | Reason |
|---|---|---|
| Architecture pattern | Modular monolith: one NestJS app with bounded modules, three entry points (`api`, `worker`, `migrate`) plus a fourth, `ops`, for backups and the exit package | Right size for 1 to 3 developers plus agents; one image per release keeps every process on one version. |
| Language & runtime | TypeScript 6 (strict) on Node.js 26, the current LTS line (26.13.0 on 2026-11-05) | One language across api, worker, web, and contracts; an LTS line for production. |
| Backend framework | NestJS 12 (12.3.2 resolved) | Modules and dependency injection map onto bounded modules; guards carry the audience walls; proven in this repo. |
| Web framework | Next.js 16 App Router (16.4.3), React 19.3, `output: standalone` | Server rendering helps the public portal and later the COD landing page on slow phones; business logic stays out of Next server code. |
| UI | shadcn/ui on Tailwind CSS v4 in `packages/ui`, TanStack Table, logical CSS only | Owned components, right to left by logical properties; feature 5 reshapes the visual language with the Impeccable skill. |
| Contracts | Zod 4 schemas in `packages/contracts`, imported by api (validation) and web (typed calls through one small client) | One schema per shape without code generation; OpenAPI comes back with the public API. |
| Database | PostgreSQL 18 (18.6 is the current minor), `pg_trgm` and `unaccent` | Transactions, row and advisory locks for ledgers, JSONB, full text search, and the job queue in one service. |
| Data access & migrations | Drizzle ORM (0.45.4) and drizzle-kit SQL migrations in `packages/db`, the only migration history | SQL close to the surface for ledgers and reports; reviewable migration files. |
| Auth | Better Auth (1.7.15) inside the api, database backed rate limits | Self hosted, no per user fee; staff and partner users on one auth with hats; the portal uses no accounts. |
| Background jobs | pg-boss 12 (12.38.0) in its own `pgboss` schema, worker entry point only | No extra service; jobs enqueue in the same transaction as the data change; cron schedules take a time zone. |
| Search | PostgreSQL full text search (`simple` config plus Arabic and English normalization) and `pg_trgm` | Ample for 50,000 SKUs with the right indexes (see *Scale*). |
| Object storage | A self run S3 compatible server on each host (and in the dev and self host Compose), chosen in feature 3; a provider's own S3 service is a bonus if one is ever confirmed in writing | No Egyptian provider's published pages confirm S3 compatible storage ([research 0001](../../research/0001-egypt-hosting-options.md)); MinIO's community edition stopped publishing images in October 2025 and its repository is archived. |
| Email | One mail interface, SMTP and Postmark adapters, sent through a pg-boss queue (spec 0005) | Works with any provider or a client's own server. |
| Messaging out | Telegram Bot API (the default daily report channel) and WhatsApp Cloud API (customer templates), called only from worker jobs | The owner's real interface is a chat group (reference brand notes 2.9); Telegram groups are the proven path, WhatsApp group sending has eligibility conditions still to check against Meta's own pages (Carried m6). |
| Edge proxy | Caddy: one per host when vendor hosted (routes every client's hostnames), one per stack when self hosted | Automatic HTTPS; one TLS front per host instead of one per client. |
| Packaging | Two images, `app` (api, worker, migrate, ops) and `web`; one versioned Compose file per release | One deployment path for vendor hosting and self hosting. |
| Repo & build | pnpm 12 workspaces with the `catalog:` versions, Turborepo 2 | Shared types, cached builds. |
| Tests | Vitest 4, Testing Library, Playwright 1.64, database backed e2e, recorded connector fixtures | Already the project's test stack (`test-preferences.json`). |
| CI & registry | GitHub Actions: format, lint, typecheck, unit, e2e, image build on every PR; push to GitHub Container Registry on release tags; offline image files attached to each release | Every install pulls an exact version; offline installs load files by hand. |
| Observability | pino JSON logs from every process with personal data redacted at the logger, a Sentry compatible error tracker run on the host or elsewhere in Egypt (never a tracker abroad), connector health shown in the shell and the daily report | Errors visible from day one without customer phones or addresses leaving Egypt (Law 151; see `## Conventions`). |
| Releases | Semantic versions; images tagged with the version; each install pins a version and digest; vendor hosted installs move together to the latest minor, self hosted installs are supported on the latest and previous minor; refreshing time zone data is a release step | Controlled upgrades at a support cost 1 to 3 developers can carry (owner decision above). |

## Architecture shape

### Module map and repo layout

- `apps/api/src/<module>/`: one NestJS module per business area, named in business words. Starting map (feature 4 fixes tables): `platform` (settings, toggles, license, numbering, operating day), `audit`, `identity` (staff and partner users, hats; today `auth` and `staff`), `catalog` (styles, seasons, product groups, variants, barcodes), `inventory` (stock ledger, locations and their owner type policy, reservations, transfers, counts), `customers`, `orders`, `tasks`, `credit` (customer credit ledger), `settlement` (accounts with owner type, periods, lines, period close), `channels` (stores and channel code mapping), `connectors` (inbox, outbox, one folder per provider), `exchanges` (portal, rules, execution), `partners`, `exports`, `reporting` (metric dictionary, dashboard, daily report). Purchasing and production modules come with slices 4 and 5.
- `apps/web/src/app/` route groups by audience: `(backoffice)`, `(portal)`, `(partner)`, `(auth)`; feature folders beside them in `apps/web/src/<feature>/`.
- `packages/contracts` (Zod), `packages/db` (Drizzle schema and migrations), `packages/ui` (design system), `packages/i18n` (message catalogs for every process, to be created in wave 3), `packages/config` (TypeScript, ESLint, scripts).
- `extensions/<client>/`: per client code, locales, export templates and their fixtures; the core never imports an extension.
- `deploy/`: Dockerfiles, the per client Compose template, the host level Compose (edge Caddy, PostgreSQL), the self host profile, bootstrap scripts.
- `docs/`: `scope`, `specs`, `adr`, `reviews`, `positioning`, `research`, `runbooks`, `templates` (`adr`, `research`, `templates` to be created in wave 3).
- Modules talk only through exported services or past tense domain events; a module never reads another module's tables (kept from 0001, enforced per module by a boundary test like `apps/api/src/inventory/module-boundary.spec.ts`).

### 1. Connector layer (R-1)

**Connections and stores.** One `connections` row per external account: provider, a store or account label, encrypted credentials (key from `CONNECTOR_SECRET_KEY`, never returned to the web), mode settings, status (including `restricted` with a date, for a WhatsApp number), the bundle each capability belongs to, and health. A brand with two Shopify stores has two Shopify connections, and each Shopify connection has one `stores` row (manual and landing page orders belong to an internal store of the brand). A carrier account is a connection of the tenant with an optional store binding: one Bosta account for all the brand's stores (no binding), or one account per store (bound); both setups work. Every external id is stored as (`connection_id`, external id); every order carries its `store_id` (section 7).

**Freshness, visible the same hour.** Every connection records its last successful inbound event, last successful sweep, and drift count. The back office shell shows a freshness line to the operations and manager hats (for example "Shopify Essentials: last order 3 minutes ago"), so a silent connector is seen within the sweep interval, not at the next morning's report. The architecture's guarantee: a lost webhook surfaces within one sweep interval, which each connector spec sets with a stated budget (suggested upper bound for orders: 15 minutes, decided in feature 13).

**Inbound (webhooks).**
1. `POST /api/hooks/:provider/:connectionId` reads the raw body and verifies it before parsing. Shopify: `X-Shopify-Hmac-SHA256` (base64 HMAC SHA256 of the raw body with the app's client secret). Meta and WhatsApp: `X-Hub-Signature-256` (`sha256=` HMAC of the raw body with the app secret; the `GET` subscription handshake checks the verify token). Bosta: the brand registers the webhook by hand in Bosta's business dashboard (Settings, API Integration, Set Up Your Webhook) with one custom header name and value that Bosta sends on every call (per docs.bosta.co as recorded in the reference repo, `src/lib/webhooks/verify.ts` and `src/app/api/webhooks/bosta/route.ts` in the reference console). The connection screen shows the URL, the header name, and a random per connection value to paste; the endpoint compares the header in constant time. Bosta sends a webhook after every state change, not when a delivery is created, and the body only names the delivery, so the worker always reads the delivery back. A failed check answers 401 and writes a counter, never an inbox row.
2. In one transaction it inserts an `inbound_events` row (connection, provider, dedupe key, topic, received at, payload `jsonb`, status `received`) with `ON CONFLICT DO NOTHING` on (`connection_id`, dedupe key), and enqueues a pg-boss job with the same transaction (`send` with the `db` option). Dedupe keys: Shopify `X-Shopify-Webhook-Id`; Bosta tracking number plus state plus Bosta's timestamp (the reference repo's key); Meta and WhatsApp the message or event id the payload carries (set in features 48 and 50).
3. It answers 200 at once. Shopify times a delivery out after 5 seconds, retries 8 times over 4 hours, then deletes a subscription created through the Admin API, so the endpoint never does work inline.

**Processing.** A worker job per event, idempotent three ways: the dedupe key drops repeats; the source's own version (`updated_at` or equivalent) drops stale out of order events; money and state from a carrier are read back from the carrier's single delivery endpoint before they are applied (Bosta's list endpoint carries no fees, reference brand notes section 3). The domain change and the event status (`processed`, `ignored`, `failed` with reason and attempts) commit together. Records found by a sweep enter the same inbox and job path as webhooks, so processing is identical whichever way a change arrives. Inbox rows are kept for an audit window (feature 13 sets it), then purged by a job.

**Backfill and reconciliation, for every provider.** Webhooks are hints; the sweep is the truth. Each connection has a scheduled sweep under its provider's rate policy (below):
- **Shopify**: bulk operations for the first backfill (exempt from the per query cost and rate limits), an incremental `updated_at` sweep after, and re registration of any deleted subscription.
- **Bosta**: list pages find deliveries no webhook announced (new deliveries have no webhook at all); then single delivery reads, least recently synced first, of (a) open shipments within a window and (b) delivered shipments whose cash cycle is still empty within a longer window, because Bosta announces no cash cycle by webhook and fills it days or weeks after delivery (the reference repo re polls open shipments for 45 days and fee rows within 60 days, `src/lib/bosta/sync.ts`). A webhook only moves its delivery to the front of that queue. Fees and cash cycle amounts come only from the single delivery read and are never overwritten by a list pass. Bosta webhooks are registered and removed by a person in Bosta's dashboard, so the sweep cannot re register them; it records drift instead. The settlement file import (scope feature 22) stays as the fallback path.
- Every sweep records drift in the connection's health.

**Outbound.** Only worker jobs call providers. The api writes an `outbound_commands` row (connection, kind, linked record, payload, idempotency key, sync state) and enqueues a job in the same transaction. Each connection's calls, inbound reads and outbound writes alike, run through one queue with a concurrency of one per connection and a **provider rate policy**: Shopify, a token bucket fed by the throttle status its GraphQL Admin API returns (calculated cost per query, at most 1,000 points per query); Bosta, a minimum interval between single delivery reads (the reference repo uses 1 second after Bosta answered 429 at about 60 back to back reads), a budget for time spent waiting on 429 answers, and a run budget after which the run ends partial and the next one resumes least recently synced first. Each connector spec sets its numbers. The single exception to "outbound only from jobs" is the portal's anti bot check (Cloudflare Turnstile `siteverify`), which must answer inside the request; it has a short timeout and is not a connector.

**When an outbound command fails.** Every command has a sync state the linked record shows on screen: `waiting`, `synced`, or `failed` with the provider's reason and a retry action. Transient errors retry with backoff. When retries are exhausted, or the provider rejects the command outright, the job sets `failed` and emits the past tense domain event `OutboundCommandFailed` (command, linked record, provider reason). The tasks module listens and opens a task on the linked record for the owning hat (operations by default, scope feature 17), and the shell counts failed syncs for that hat the same minute; the daily report repeats it, it is never the first place a failure shows. **Blocking rule**: an order with a confirmation edit (address, variant, added line) whose write back is `waiting` or `failed` cannot move to `packed` and cannot be handed to a carrier; the orders module asks the connectors service for open commands on the order before that transition. A person resolves it by retrying, by fixing the order in Shopify by hand and marking the command resolved (audited), or by undoing the edit.

**Echo suppression, and who owns stock.** Inbound Shopify inventory webhooks never write stock movements: the ledger is the truth and Shopify is fed from it. They record drift against the ledger for a person to resolve. Every stock quantity we push to Shopify is recorded as an outbound command with the values sent; an inbound inventory webhook that matches a command sent within a short window (same connection, item, location, quantity) is marked `echo`, which only keeps our own pushes out of the drift log.

**Order edit netting.** The Shopify adapter nets a positive and a negative line of the same order, variant, operating day (section 10), and value into one edit before it emits a domain event; nothing downstream ever sees raw edit pairs (final plan 6.14). A size change (minus one M line, plus one L line) is not a nettable pair: it is classified as an order edit removal plus an added line, never as a return.

**Carrier abstraction, Bosta first.** A `CarrierAdapter` interface written from Bosta's real shape (delivery types send, exchange, customer return pickup, return to origin; state codes; per delivery fees and cash cycles) and declared by capability: `mirror` (list, read one, parse webhook) and `driver` (create, cancel, and return pickup by type). Mode is a brand setting per shipment type, default `mirror`. In mirror mode the driver methods are not reachable: the adapter is built without them, and a fixture test fails if any write request is attempted. Core states are carrier neutral; Bosta codes map in the adapter. A delivery's store comes from the account's store binding when it has one; an unbound account shared by several stores links each delivery to its store from the delivery's business reference or Shopify store name (as the reference repo does in `src/lib/bosta/sync.ts`). Cash matching by tracking number and business reference carries that store id onto every settlement line. The second carrier generalizes the interface, not before.

**What mirror mode cannot do.** In mirror mode the app cannot set a shipment's address or contents: the carrier's Shopify app creates the delivery from the Shopify order. So an address or size fixed at confirmation reaches the courier only if the Shopify write back lands before the carrier's app creates the delivery. That is why a failed write back is a same minute task and blocks packing (above), not a report line. If a mirrored delivery already exists when the failure is found, the task tells the agent to correct it in the Bosta dashboard, and the sweep mirrors the correction back. When the Bosta Shopify app creates deliveries (on order creation or on fulfillment) and whether an address can change after pickup creation (final plan question 4) are research items before slice 1a (Follow-up).

**Meta Conversions API.** Purchase events fire on confirmation from a worker job, with the order id as `event_id`. That id is a safety net only: confirmations can come days after the order, past Meta's 48 hour deduplication window. Onboarding a brand onto the Conversions API therefore includes stopping the storefront Purchase event (or renaming it to a custom event), so the confirmation event is the only Purchase Meta sees; a checklist step owned by the media buyer hat (feature 48).

**WhatsApp sending number.** Customer messages and their history hang off the customer and the order; each message records the connection that sent it, which is never the key. A brand setting, "active sending number", points at one WhatsApp connection. Switching it (a number was restricted) re targets queued outbound commands to the new connection instead of failing them, and marks the old connection `restricted` with the date. Whether approved templates belong to the business account or to the number is unknown and is a feature 50 research item.

**Switching off on lapse: a wind down, not a cut off.** Each connector capability declares its bundle. The license service warns 30, 14, and 7 days before the Operations plan expires, in the shell for the manager hat and in the daily report's status line (owner decision at the gate, item 1). When it lapses (after the 14 day grace) or a module is toggled off, the license service emits `LicenseChanged`; the worker then stops that bundle's new work: it unschedules its cron jobs, cancels its queued jobs, removes Shopify and Meta webhook subscriptions it registered through their APIs, and stops the confirmation queue, driver mode, and new shipment mirroring. Read only capabilities keep running for shipments created before the lapse (the Bosta mirror reads and the cash cycle sweep) until each reaches a final cash state or the setting `operations_wind_down_days` passes (default 60 days), and the settlement screen stays usable for them. Bosta webhooks were registered by a person, so the runbook includes removing them; until then, and for anything else still arriving, the hooks endpoint answers 200 and records `ignored_unlicensed`, so no provider deletes a Core subscription because of errors. Core capabilities (Shopify catalog, stock, and order sync) keep running. Data stays readable. On renewal the license service starts a backfill sweep over the gap.

**Tests.** Every adapter has recorded fixtures in `apps/api/src/connectors/<provider>/fixtures/`. Tests run with an HTTP interceptor that refuses any unrecorded outbound request, so no test can reach a live service. Signature checks are tested with known good and tampered payloads.

### 2. Audiences: back office, public portal, partner surface (R-2)

| Audience | Origin | Web route group | Api prefix and guard | Identity |
|---|---|---|---|---|
| Staff (back office) | staff host, e.g. `ops.<brand domain>` | `(backoffice)`, `(auth)` | `/api/*` with `@Audience('staff')` | Better Auth session with a staff hat |
| Partner | staff host | `(partner)`, `(auth)` | `/api/partner/*` with `@Audience('partner')` | Better Auth session with the partner hat, bound to one partner account |
| Public portal | public host, e.g. `returns.<brand domain>` | `(portal)` | `/api/portal/*` with `@Audience('portal')` | no account; a sealed portal token after the phone plus order id match |
| Providers | staff host | none | `/api/hooks/*` with `@Audience('hook')` | signature per provider |
| Anyone | both | none | `/api/health`, `/api/config` with `@Audience('public')` | none |

- **Origin wall.** The portal runs on its own hostname. The staff session cookie is host only on the staff host, so the public host can never read or send it, and a script bug on a public page cannot ride a staff session. Caddy on the public host routes only `(portal)` pages, their assets, and `/api/portal/*`; everything else answers 404 there. Next.js `proxy.ts` repeats the host check, but Next's own docs say Proxy is not an authorization layer, so Caddy and the api guard are the real walls.
- **Api wall.** A global guard denies by default: every controller must declare exactly one audience, and a test fails the build on a controller without one. A partner session calling any non partner route gets 403; a staff session cannot use portal routes. Partner queries take the partner id from the session, never from the request, and an e2e test proves partner A cannot read partner B.
- **Portal abuse protection** (from the brand's own proven form, reference brand notes section 3): Turnstile on the lookup (tokens are single use and valid 5 minutes); Postgres backed rate limits per address and per phone that survive restarts; the same response shape and a minimum response time for a hit and a miss; a sealed token valid 30 minutes bound to the matched customer and orders; an idempotency key on every submit; photo uploads size capped at Caddy and the api, quarantined, then EXIF stripped by a worker job; phones masked on screen; no database ids in responses.
- **Turnstile fallback.** Turnstile is accepted for the pilot on the reference brand's precedent; a server side challenge plus the same rate limits is designed as the fallback, switchable by setting, and the Turnstile question goes to counsel with the Law 151 licensing check (owner decision at the gate, item 7).
- **Partner sign in** uses Better Auth's database backed rate limits and the lockout from spec 0005. A partner that serves several brands holds one login per brand stack in slice 2; a shared partner sign in across brands is a later design question (owner decision at the gate, item 9).

### 3. Daily report (R-3)

A pg-boss cron job in the worker, scheduled with `tz` set from the install's `timezone` setting (default `Africa/Cairo`). It reads through the `reporting` module's metric dictionary (the same service the dashboard uses), renders in the brand's language from `packages/i18n`, and sends through an outbound command to the brand's Telegram group (owner decision at the gate, item 6; WhatsApp group delivery is a later feature once Meta's own documentation is checked). The automation status line comes from the connector health table and the license expiry warnings.

**What "confirmed" means for the report.** Two classes of data:
- **Own records fed by API** (orders, confirmations, shipments, carrier states): complete for a day once that operating day has closed and a sweep after the close agrees with the inbox. The sweep is the evidence; the day confirms itself, audited and undoable, with no person needed before dawn.
- **Third party money and statements** (Bosta cash cycles or settlement file, partner sell through): reported as confirmed only after period close (scope feature 23).
- A figure that is not confirmed is printed with its provisional value and the word "provisional" in the owner's language, never as zero and never left out (the same rule as "not set" for costs). It runs as the app database role inside the worker container: no shell, no host access, no second database, no separate agent.

### 4. Export engine (R-4)

A core module, `apps/api/src/exports/`. A **template** is versioned data: format (xlsx or csv), sheets and columns, and a rules matrix (match on channel, product group, kind, and any code the client's accounting system needs, producing the output codes). Templates live in the client's extension, `extensions/<client>/exports/`, each with its fixture and freeze test. A template changes only through a reviewed vendor change to that folder, so the freeze test in CI guards every version, and the turnaround for a client's format change is promised in the contract (owner decision at the gate, item 4). There is no in app template editing in version one. When a format needs code, the extension registers a named transform through the extension hook; the core never branches on a client.

An **export run** is immutable: preflight first (blockers: unmapped lines, missing codes, unconfirmed days, each evaluated only for the template and the channels it covers, so a monthly partner never holds a daily Shopify export hostage; warnings: overlap with an earlier run), then a worker job generates the file into object storage under a write once key with its SHA 256, and an `export_runs` row records template version, period, filters, row counts, checksum, who and when. Its only later changes are `marked imported` (by a person with the operations hat on the accountant's word, who and when recorded on the run; an accountant hat may be added in feature 8 later) and `superseded by` another run. The **freeze test** keeps, per template, a fixture dataset and the expected output as a parsed cell grid (sheet names, headers, cell values and types) and compares cell by cell in CI. It compares cells, not file bytes, because workbook files embed timestamps (the brand's own verifier reads cells too: `scripts/verify-erp-fixtures.mjs` in the the reference console repository). Changing a template means changing its fixture in the same reviewed change.

### 5. Development environment (R-5)

Hybrid, as the owner chose: `deploy/compose.dev.yaml` runs PostgreSQL 18, an S3 compatible store, and a mail catcher (feature 3 picks the last two); `pnpm dev` runs api, worker, and web on the host. Local runs use the same two database roles and per client role names as production, so permission errors show up locally. CI builds the real `app` and `web` images on every PR without pushing them; fully Docker runs are for deploy rehearsals.

### 6. Hosting, backups, and the exit package (R-6)

**Vendor hosted (default).** Per host in an Egyptian data center: one host level Compose project with the edge Caddy and one PostgreSQL 18 server; per client, one Compose project (`ssd-<client>`) running `migrate`, `api`, `worker`, and `web` from the client's pinned version, joined to a shared internal network. Many client projects per host. Each client has its own database, its own bucket on the host's self run S3 compatible store, its own `.env` (kept in the private per client store), and its own hostnames.

**Peaks are shared.** Every brand on a host peaks on the same days (White Friday, Eid, the winter launch), so hosts are sized by measured peak, not idle: the scale suite's budgets become the per client peak profile, and feature 26 records idle and peak memory per client stack and writes down the maximum number of client stacks per host. One client cannot starve the others: each `ssd_<client>_app` role has a `CONNECTION LIMIT`, each client's worker has a pg-boss concurrency cap, and heavy backfills and upgrades respect a per client freeze window around the brand's declared peak dates. The recovery objective for a host failure is set in feature 26.

**Self hosted.** The same per client project plus a `selfhost` profile that adds PostgreSQL, Caddy, and the S3 compatible store on the client's machine; images loaded from the offline files attached to each release.

**Backups** are per client database and files, encrypted on the host before they leave it, and copied to a second Egyptian provider, not only a second host at the same provider ([research 0001](../../research/0001-egypt-hosting-options.md), recommendation 3), with a restore rehearsed on a schedule; feature 26 owns the tooling.

**The exit package** is a product command, not a worker job: `ops export-package` (the `ops` entry point of the `app` image) writes an encrypted database dump and the client's files to storage the client controls, on a schedule run by the host's scheduler (vendor) or Compose (self host). It connects as the client's read only backup role, which the worker never holds. The `app` image carries PostgreSQL 18 client tools for it. Because a plain `pg_dump` leaves out database level settings, the dump uses `--create` (or the restore re applies `ssd.tenant_id` from the `install` row), and every restore rehearsal inserts one row to prove the tenant default works (section 7). Destinations grow in this order: Google Drive first (proven at the reference brand), then an S3 bucket the brand controls, then a local disk (owner decision at the gate, item 8). Feature 27 picks the encryption tool and builds the destinations.

### 7. Tenant id on every row (R-7)

Every table the app owns has `tenant_id uuid not null` from the first migration, defaulting to `current_setting('ssd.tenant_id')::uuid`. `migrate` creates the client's single `install` row and runs `ALTER DATABASE <db> SET ssd.tenant_id = '<uuid>'`, so no writer (service, SQL migration, or data move) can forget it. Unique business keys include `tenant_id`, and a key that comes from a store also includes the store, the same rule as section 1's (`connection_id`, external id): order number is unique on (`tenant_id`, `store_id`, `order_number`), because two Shopify stores of one brand both start at #1001; SKU code is unique per tenant (other channels' codes map through channel code mapping); a phone is unique per tenant on the customer phone row. Every screen, export, report line, task, and message that shows an order number shows its store beside it. The portal resolves phone plus order number across all the brand's stores: one match proceeds; a match in two stores asks the customer to pick the store by its public name; no match answers like any other miss (same shape, same minimum time). Settlement matches carrier lines by tracking number and takes the store from the delivery (section 1, carrier paragraph). Foreign keys point at globally unique uuid primary keys and need no tenant column. No row level security now: one database holds one tenant. A schema test fails if any table outside the `pgboss` and `drizzle` schemas lacks the column. A shared install later becomes a migration (add row level security on the existing column), not a rewrite. Runner up: the app passes the tenant id explicitly from the `install` row; rejected because a data move in SQL could forget it.

### 8. Location owner type is a setting (R-8)

`locations` carry `owner_type` (`own`, `consignment_partner`, `wholesale_customer`), the owning party when not own, and `sellable_online` (only sellable locations feed the portal and Shopify). The behaviour that differs by owner type (when a sale is recorded, who refunds the end customer, which tax document, which settlement account owner type) lives in one policy table read by one `LocationPolicyService` in the inventory module. Orders, refunds, settlement, and tax documents ask that service; none of them compares owner types. Enforcement: a boundary test fails if `owner_type` or its values are compared anywhere outside the policy file, and one order to refund to settlement test runs three times, once per owner type, with only settings changed. If that test needs a branch, the model is wrong (final plan 6.5). Movements and settlement lines recorded under a location's owner type are never reinterpreted if it changes; feature 4 decides whether owner type is fixed for a location's life (close it and open a new one) or effective dated, and the three way test includes stock left at a location being closed.

### 9. Documentation and conventions (R-9)

Folded into `## Conventions` below, which both shapes implement.

### 10. Arabic and English, Cairo time, the operating day (R-10)

- Message catalogs move to `packages/i18n` (to be created) so the web, the api (mail), and the worker (daily report, WhatsApp templates, export labels, receipts) share one source. i18next stays (spec 0004); English stays the type source; a test fails on a missing Arabic key.
- The portal and partner pages render `lang`, `dir`, and their text on the server in the visitor's language, so a customer on a slow phone never waits behind a hidden body for a catalog. The back office may keep spec 0004's head script; the localization spec (feature 6) decides.
- Logical CSS only (the existing `check-logical-css.mjs` lint stays); codes sit in `LtrText`.
- Arabic and Western digits are both accepted at every input edge and normalized there (phones, quantities, money).
- Time: instants stored as `timestamptz`; the install `timezone` setting defaults to `Africa/Cairo`. The **operating day** is one SQL function, `ssd_operating_day(timestamptz)`, returning the local date in that zone, with a cutoff hour setting reserved (default midnight). Every `operating_day` column and report uses it; no code adds 24 hours. Egypt observes daylight saving and its rules have changed before, so refreshing time zone data in both images and in PostgreSQL is a release step, and the test asserts the operating day across the actual Cairo transition dates of the release year, not a synthetic offset.

### 11. Scale: 10,000 SKUs designed, 50,000 tested (R-11)

- **Search**: trigram (`pg_trgm`) GIN indexes on normalized SKU code and name, plus `simple` full text search on normalized Arabic and English names; normalization is a SQL function so indexes and queries agree (feature 12 sets the Arabic rules).
- **Lists**: server side filter, sort, and keyset pagination only (the pattern in `apps/api/src/inventory/locations/locations.service.ts`), 50 rows by default and 100 at most; the browser never loads a whole list, so no row virtualization is needed for tables; scan lists cap their history.
- **Indexes**: every list's sort key and filter has an index; reports aggregate in SQL over `operating_day` indexes; ledger tables keep their BRIN index on recorded time.
- **Shopify at size**: bulk operations for backfill; stock pushes batched within the query cost budget.
- **The test**: a database backed scale suite seeds 50,000 variants (about 5,000 styles), 500,000 movements, and 150,000 orders (about three years at 120 orders a day, the debate's in season figure), then asserts p95 budgets on CI: SKU search under 150 ms, any list page under 150 ms, stock on hand for one SKU under 50 ms. The budgets are **Assumed** and are set from the first measured run. The existing `apps/api/test/scale.e2e-spec.ts` (100,000 SKUs, 1,000,000 movements) is the starting point.

### Bundles, module toggles, and the license (R-12)

One image. Each module declares its bundle (`core`, `warehouse`, `operations`) and a toggle. The license is a signed file (an Ed25519 signature over client id, bundles, Operations expiry, issue date) verified with a public key built into the image, at startup and daily; no phone home, so offline installs work. Warnings go out 30, 14, and 7 days before expiry. After expiry and the 14 day grace period (owner decision) Operations modules switch off for new work: their routes answer 404 with code `MODULE_OFF`, screens hide, and connectors wind down as in *Switching off on lapse*: mirror reads and the cash sweep continue for shipments created before the lapse until a final cash state or `operations_wind_down_days` (default 60); new shipments, the confirmation queue, and driver mode stop; a renewal starts a backfill sweep over the gap. Feature 9 owns the detail. Every executing step (driver mode, auto approval, refunds, Shopify write back) is its own switch, default off.

### Database roles and the append only ledgers

- Per client roles on the shared server: `ssd_<client>_owner` (owns the schema, used only by `migrate`), `ssd_<client>_app` (api and worker), `ssd_<client>_backup` (read only, used only by `ops`). Each client database gets `REVOKE CONNECT ON DATABASE ... FROM PUBLIC` and `CONNECT` only for its own three roles. The server superuser is used only by the host bootstrap that creates a client's database and roles.
- The app role has only `INSERT` and `SELECT` on append only tables: stock movements and groups, customer credit entries, settlement lines, audit entries, and export runs except their status columns (feature 4 lists them); a trigger rejects `UPDATE`, `DELETE`, and `TRUNCATE` as a second guard (kept from spec 0002).
- Compose gives each service an explicit environment list, never the whole `.env` (kept from 0001).
- The `migrate` entry point applies Drizzle migrations and the pg-boss schema under an advisory lock; a pg-boss upgrade is treated as a migration, because pg-boss migrates its schema on start (`.claude/skills/pg-boss-v12/SKILL.md`).

### Configuration (new names, proposed)

- `STAFF_ORIGIN`, `PORTAL_ORIGIN`: the two hostnames (replace `PUBLIC_URL`).
- `CONNECTOR_SECRET_KEY`: encrypts connection credentials at rest.
- `LICENSE_FILE`: path to the signed license.
- `TURNSTILE_SECRET_KEY`: the portal's anti bot check.
- `TENANT_ID`: read by `migrate` only on the first run.
- Each added to `apps/api/src/config/env.ts` (or its Shape B successor) and to only the services that read it.

## Conventions

Both shapes implement every convention in the wave 3 scaffold. Each line names what enforces it: **lint** (ESLint in `packages/config/eslint`), **script** (a check in `packages/config/scripts`, run by `lint` or CI), **hook** (Husky), **CI**, **template**, **AGENTS.md** (written by the `/audit` rewrite after the scaffold), or **review only** (no tool can judge it; the reviewer checks it).

### Code documentation

| Convention | Enforced by |
|---|---|
| TSDoc on every exported function, class, type, interface, hook, component, and module (file level comment): what it does and why it exists | **lint**: `eslint-plugin-jsdoc` rule `jsdoc/require-jsdoc` with `publicOnly: true`, `require` turned on for `FunctionDeclaration`, `ClassDeclaration`, `ArrowFunctionExpression`, `FunctionExpression`, `MethodDefinition`, and `contexts` adding `TSInterfaceDeclaration`, `TSTypeAliasDeclaration`, `TSEnumDeclaration`, and exported `VariableDeclaration`; `enableFixer: false` so an empty comment never satisfies it. Plus `eslint-plugin-tsdoc` rule `tsdoc/syntax` for valid TSDoc. Older issues report `publicOnly` missing interfaces, so a **script** keeps a fixture file with one undocumented export of every kind and fails if lint passes it. |
| The TSDoc also says what the symbol must never do, and gives one `@example` where the signature is not obvious | **review only** (lint proves presence, not content) |
| A `README.md` per api module, per web feature folder, and per package: Owns, Never touches, How to test, Governing spec, Decisions (ADR links) | **template**: `docs/templates/module-readme.md`; **script**: fails when a module or feature folder lacks a README or one of those headings; content is **review only** |
| ADRs in `docs/adr/NNNN-title.md` for every non obvious decision inside a module, linked from the module README | **template**: `docs/adr/0000-template.md` (Context, Decision, Consequences, Status); **script**: every ADR link in a README resolves; whether a decision needed one is **review only** |
| Module `AGENTS.md` files carry only agent gotchas and point at the README | **AGENTS.md** |

### Organisation and naming

| Convention | Enforced by |
|---|---|
| Folder by feature: a feature's module, schema, contract, screens, and tests sit together; no global `services/` or `controllers/` folders | **script**: fails on those folder names; placement is **review only** |
| Web route groups by audience: `(backoffice)`, `(portal)`, `(partner)`, `(auth)` and no other top level groups | **script** on `apps/web/src/app/` |
| Every api controller declares one audience | **CI** (a unit test over all controllers) |
| Page, component, file, and module names in the scope's business words (confirmation queue, exchange request, settlement, consignment handover), no abbreviations or codenames | **lint**: `unicorn/filename-case` (kebab case, ignoring Next's `(group)` and `[param]` folders); a **script** with a small banned list (`mgr`, `cfg`, `util`, `misc`, `temp`, and the like); the vocabulary match is **review only** |
| One component per file, the file named after the component (`exchange-request-form.tsx` exports `ExchangeRequestForm`) | **lint**: `react/no-multi-comp` (from `eslint-plugin-react`); **script**: the default named export matches the file name |
| Shared UI lives only in `packages/ui`; feature folders do not export generic components | **review only**, helped by the root `AGENTS.md` design system rule (shadcn components from `@ssdashboard/ui` before custom markup) |
| Hooks are named `use…` | **review only** (`react-hooks/rules-of-hooks` checks calls, not names) |
| Server modules named after the business area they own | **review only**, listed in **AGENTS.md** |
| Named exports only, except files Next.js requires as default | **lint** (existing `no-restricted-syntax` rule in `packages/config/eslint/base.js`) |

### Git

| Convention | Enforced by |
|---|---|
| Branch names `<prefix>/<feature-slug>` in plain words: `feat/`, `fix/`, `docs/` | **CI**: the PR job fails on any other head branch name |
| One commit per milestone; short imperative subject in business terms; a body that says why when it is not obvious; no `wip`, `misc`, or `fixes` subjects; no conventional commit prefixes | **hook**: a new `.husky/commit-msg` script (no new dependency) rejects banned subjects, conventional prefixes, and subjects over 72 characters; **CI** reruns the same check on every commit in the PR, since hooks can be skipped; imperative mood, business terms, and one commit per milestone are **review only** |
| The project's attribution lines on agent made commits and PRs | **review only** (no tool can tell who wrote a commit); stated in **AGENTS.md** |
| PR titles and descriptions use the scope row's words and link the spec | **template**: `.github/pull_request_template.md` (Scope feature, Spec, What changed, Why, Docs updated, Tests); wording is **review only** |

### Personal data in logs and errors (Law 151)

| Convention | Enforced by |
|---|---|
| Customer phones, names, addresses, and message bodies never reach logs or the error tracker: the pino logger and the error tracker's event hook redact them from one shared list of field paths in `packages/config`, and phone shaped strings in free text are masked | **CI**: a unit test logs and reports a fixture order with a customer and asserts no phone pattern, name, or address survives in either output; new fields that carry personal data are **review only** |
| The error tracker runs on the host or elsewhere in Egypt, never a service abroad | **AGENTS.md** and the deploy template (feature 26); **review only** for any new outbound telemetry |

### Documentation kept true

A README, spec, scope, or `AGENTS.md` line made false by a change is a defect as severe as a failing test and is fixed in the same change. **Template**: the PR template's "Docs made true" checkbox; **script**: every relative link in `docs/**` and every README resolves; **AGENTS.md** states the rule; whether prose is still true is **review only**.

## Alternatives considered

Full write ups in [rationale.md](rationale.md).

| Alternative | Why not |
|---|---|
| Keep 0001 exactly as is | Its PostgreSQL and Caddy in every stack and fixed role names do not fit many stacks on one shared database server, and it has no connector, audience, report, export, license, or tenant pattern; every slice would invent its own. |
| Next.js only, full stack (the shape a real brand built: the reference console is Next.js 16 plus self hosted Supabase) | It still needs a separate `migrate` and `worker` (the reference console runs exactly those three), so it saves no process, while ledgers and state machines would live in Next server code that moves with each Next major (Middleware became Proxy in Next 16). |
| A different backend language (Go, Python with Django, PHP with Laravel, C# with .NET) | Two languages for 1 to 3 developers, no shared Zod contracts, Celery plus Redis for Django jobs, and a rewrite of the reviewed ledger and auth code for no gain against these forces. |
| A backend as a service such as Supabase | Egyptian data center plus self host means self hosting it per client: 11 services (studio, gateway, auth, REST, realtime, storage, image proxy, meta, functions, database, pooler) per stack; ledger rules fit poorly in row policies and edge functions; the reference console carried security debt in exactly this setup. |
| BullMQ instead of pg-boss | Needs Redis on every host and loses the enqueue in the same transaction as the data change. |
| Graphile Worker instead of pg-boss | Also PostgreSQL based and viable; switching buys nothing over a proven pg-boss with time zone schedules, queue policies, transactional send, and two installed skills. |
| Fastify or Hono instead of NestJS | Lighter, but the guards, modules, and dependency injection that carry the audience and module walls would be hand built. |
| A static React app served by Caddy instead of Next.js | Saves one container per client stack, but the public portal and COD landing page want server rendering on slow phones. Revisit only if measured memory per host binds. |

## Assessment of the existing build

Read only pass over main (identical to `feat/rebuild` apart from three docs commits): 381 TypeScript files, 64 commits since 2026-11-01, two fresh model reviews with no blockers. **Assumed**: no client install runs these migrations yet (the pilot starts after slice 1a, final plan section 9), so the migration history can be reset to one new baseline once, before the first install (Open question 1).

| Part | Verdict | Why | What the new positioning requires on top |
|---|---|---|---|
| Spec 0002, core data model (`packages/db/src/schema/*`, migrations `0000` to `0008`) | **Amend** | The ledger core is right and reviewed: append only movement groups and movements, idempotency keys with request hashes, maintained balances, the SKU and location advisory lock, moving average costing, reconciliation, gap free numbering, exact money (spec 0002 Key invariants). Its master data is warehouse ERP shaped. | Tenant id on every row (none today: no `tenant` anywhere in `packages/db/src`); location owner type and sellable online flag replacing `location_type` (`warehouse`, `showroom`, `transit`, `virtual`) and `is_sellable` (`packages/db/src/schema/locations.ts`); customers by normalized phone with many phones, channel ids, and merge, split out of `parties` (`packages/db/src/schema/parties.ts`); style, season, and product group on the catalog; store, channel, and source on orders; the fulfillment and cash state machines with partial amounts; the outcome enum and order types; the customer credit ledger; the settlement primitive with owner types; tasks; period close; channel code mapping replacing the `channel_mappings` sketch; new ledger source types (order shipment, exchange, returned to origin restock, consignment sale); per client role names; lots and serials parked but left dormant. All through the feature 4 spec. |
| Spec 0003, design system (`packages/ui`, `packages/ui/DESIGN.md`) | **Amend** | shadcn in a shared package, logical sides, axe checks in both directions, and `LtrText` are all still right. | Visual language reshaped with the Impeccable skill (feature 5); a phone first manager dashboard pattern; an in screen help pattern; shells for the portal and partner audiences; the shell's location switcher rethought for owner types. |
| Spec 0004, localization (`apps/web/src/i18n/`) | **Amend** | i18next, the format module, and the lint bans on raw text and `Intl` work. | Catalogs move to a shared `packages/i18n` for the worker (report, WhatsApp templates, exports, mail); server rendered language and direction for portal and partner pages (0004 AC-3 renders English first and hides the body); Arabic digits accepted at inputs; the operating day. |
| Spec 0005, staff sign in (`apps/api/src/auth/`, `apps/api/src/staff/`) | **Keep**, small amendments | Better Auth with lockout, optional two factor, the last admin rule, and the break glass command, reviewed with no blockers. | Roles `admin` and `staff` become hats (feature 8) including the partner and media buyer hats; partner users on the same auth behind the audience guard; two origins instead of `PUBLIC_URL`; tenant id on auth tables. Scope feature 7 shrinks to that delta. |
| Spec 0006, core stock loop (`apps/api/src/inventory/receipts/`, `apps/api/src/catalog/`, web `catalog/` and `inventory/`) | **Replace the feature, keep the code** | The old scope's feature 7 (core stock loop) was replaced by slice 1a (final plan section 10); the spec is `In Progress` and should be closed. The receipt document, SKU and location screens, and their e2e tests are reusable. | Receipts become the receiving document and the stock snapshot bootstrap (scope feature 15); SKU screens gain style, season, and product group; location screens gain owner type. |
| Inventory module (`apps/api/src/inventory/`) | **Keep** | The hardest GA code in the repo (`ledger/ledger.service.ts`, `ledger/locks.ts`, `ledger/costing.ts`, `ledger/reconciliation.service.ts`, `module-boundary.spec.ts`), with database e2e checks that balances equal movement sums after every test. | Hosts the location owner type policy service; cost at receipt comes from the style and season cost record; reservations for exchanges; transfers to partner locations; tenant id. |

**What happens to the spec files**: in Shape A, specs 0002 to 0005 get `Accepted, amended by <the foundation spec that amends them>` as each foundation spec lands, and 0006 gets `Superseded by slice 1a (scope features 11, 12, 15)`. In Shape B, all five get `Superseded by 0007 (code removed in the wave 3 wipe; kept as history)`.

## Carried from the domain review

Findings from `docs/reviews/domain-stack.md` not fully closed in this spec become named requirements of the feature that owns them. Blockers B1 and B2 are fixed here (sections 7 and 1). Applied here as well: M2, M3, M8, m1, m2, m6, m7, M10 (Conventions), and the architectural half of the others.

| Finding | Requirement carried | Owning scope feature |
|---|---|---|
| B1 | Order number unique per (tenant, store); the store shown beside every order number; the portal disambiguates across stores; Bosta deliveries linked to a store by business reference or Shopify store name | 4 (data model), 16 (orders), 29 (portal), 19 (Bosta mirror) |
| B2 | Outbound sync state on every linked record, `OutboundCommandFailed` opens a task, failed syncs counted in the shell; an order with an unsynced confirmation edit cannot be packed; research when the Bosta Shopify app creates deliveries and whether an address can change after pickup creation | 13 (Shopify), 17 (tasks), 18 (confirmation), 19 (Bosta mirror) |
| M1 | Bosta rate policy (minimum interval between single delivery reads, a 429 budget, a run budget, partial runs resumed least recently synced first) and the cash cycle sweep over delivered shipments with no cash cycle; the settlement file import as fallback | 19 (Bosta mirror), 22 (settlement) |
| M2 | Connection screen shows the Bosta webhook URL, header name, and value to paste; runbook steps to register and remove Bosta webhooks by hand | 19 (Bosta mirror), 26 (deployment runbook) |
| M3 | Sweep interval with a stated budget per connector (suggested 15 minutes for orders); the freshness line in the shell | 13 (Shopify), 19 (Bosta mirror), 24 (dashboard) |
| M4 | Own API data confirmed by the post close sweep, third party money only after period close; provisional figures labelled, never zero | 23 (period close), 25 (daily report), 24 (metric dictionary) |
| M5 | Expiry warnings at 30, 14, 7 days; read only wind down for shipments created before lapse until final cash state or a cutoff; backfill sweep on renewal | 9 (settings, toggles, bundles) |
| M6 | Size hosts by measured peak; `CONNECTION LIMIT` per app role; per client job concurrency cap; maximum stacks per host; per client freeze window; recovery objective for a host failure | 26 (deployment) |
| M7 | Onboarding checklist: stop or rename the storefront Purchase event before switching on the Conversions API | 48 (Meta attribution) |
| M8 | Active sending number setting; queued commands re targeted on a switch; template ownership (account or number) researched against Meta's pages | 50 (WhatsApp templates) |
| M9 | Templates change only by reviewed vendor change with fixture in version one; the actor and audit for "mark imported" (operations hat or an accountant hat) | 45 (export engine), 8 (roles as hats) |
| M10 | Redaction list and test in the scaffold; error tracker hosted on the host or in Egypt | 1 (this scaffold), 26 (deployment) |
| m1 | Exit package and restores use `pg_dump --create` or re apply `ssd.tenant_id`; the restore rehearsal inserts a row | 26 (backups), 27 (exit package) |
| m2 | Inbound inventory webhooks never write movements; they log drift for a person | 13 (Shopify) |
| m3 | Edit netting on the operating day; a size change is an edit removal plus an added line, never a return | 13 (Shopify), 24 (metric dictionary) |
| m4 | Owner type fixed per location or effective dated; the three way test covers a closing location | 4 (data model) |
| m5 | Preflight blockers evaluated per template and per channel it covers | 45 (export engine) |
| m6 | Telegram is the default report channel; WhatsApp group delivery researched against Meta's own documentation | 25 (daily report), 50 (WhatsApp) |
| m7 | Time zone data refresh as a release step; operating day test on the real Cairo transition dates of the release year | 6 (localization), 26 (release runbook) |
| m8 | Onboarding checklist with the exact DNS records for the brand's domain manager; path based fallback scopes the staff cookie by `Path` | 26 (deployment), 47 (provisioning) |

## Build plan

The wave 3 scaffold, in two shapes. Both use the Tracer Bullet approach (prove every layer end to end first). Each milestone is one commit. Data model changes are not here: they belong to the feature 4 spec in either shape.

**Schedule constraint (owner decision at the gate, item 2).** The pilot runs mid March to early May 2027, between Eid al Fitr and Eid al Adha. Shape A's scaffold, the foundation amendments (features 4 to 10), and all of slice 1a must land before mid March 2027, with little slack: a slip past the window moves the pilot to after Eid al Adha, about two months later. Keep the scaffold to its four milestones and move anything that is not a scaffold to its feature.

### Shape A: keep and amend

1. **Baseline and audience seams.** Rename `apps/web/src/app/(app)` to `(backoffice)`; add `(portal)` and `(partner)` route groups with their own minimal layouts; add the `@Audience` decorator and deny by default guard in the api and annotate every existing controller. **Done when** `pnpm build && pnpm typecheck && pnpm test && pnpm test:e2e` pass, and the controller audience test fails when one annotation is removed.
2. **Docs tree and templates.** Create `docs/adr/` with `0000-template.md`, `docs/research/`, `docs/templates/module-readme.md`, `.github/pull_request_template.md`; write a README for every api module, web feature folder, and package; add the README, route group, folder name, and docs link scripts. **Done when** `pnpm lint` runs those scripts and passes, and each script fails on a planted bad case.
3. **TSDoc, naming, and redaction rules.** Add `eslint-plugin-jsdoc`, `eslint-plugin-tsdoc`, `eslint-plugin-unicorn` (`filename-case` only), and `react/no-multi-comp` to `packages/config/eslint`; add the undocumented export fixture; backfill TSDoc on every existing export; add the personal data redaction list and its test to the logger. **Done when** `pnpm lint` passes on the whole repo, the fixture check fails if the rule is switched off, and the redaction test fails if the list is emptied.
4. **Git checks and CI images.** Add `.husky/commit-msg`; add CI jobs for branch name, commit subjects, and building the `app` and `web` images without pushing. **Done when** a PR from a `feat/` branch shows every job green, and a commit subject `wip` is rejected by the hook and by CI.

**Cost**: four milestones, about two sessions. Afterwards the foundation specs (features 4 to 8) are written as amendments; features 6 and 7 shrink to their deltas.

**Keep list, Shape A**: everything in the rebuild plan's keep list (git history, `docs/positioning/**`, `docs/specs/0001-stack-architecture/**`, `.claude/skills/**`, `.claude/agents/impeccable-*`, `.claude/settings*.json`, `.github/workflows/**`, `packages/config`, `.husky/`, lint and format config, `AGENTS.md` until `/audit`), **plus** `apps/**`, `packages/db`, `packages/contracts`, `packages/ui`, `extensions/**`, `deploy/**` (reshaped later by features 3 and 26), `docs/specs/0002` to `0006` (status lines updated), `docs/reviews/**`, `docs/runbooks/**`. **Removed**: nothing in wave 3. The migration baseline reset, if the owner confirms no install exists, happens inside the feature 4 build, recorded as an ADR.

### Shape B: replace

1. **Wipe and skeleton.** Remove what the keep list below removes; scaffold `apps/api` (NestJS with `api`, `worker`, `migrate`, `ops` entry points, env validation, `GET /api/health`, the audience guard), `apps/web` (Next.js with the four route groups and a health page in Arabic and English), `packages/contracts`, `packages/db` (a baseline migration: extensions, the `install` row, the tenant setting, per client roles), `packages/i18n` (empty `en` and `ar` catalogs), and `deploy/compose.dev.yaml` with PostgreSQL 18. **Done when** `pnpm build && pnpm typecheck && pnpm test` pass, `pnpm db:migrate` then `pnpm dev` answers `{"status":"ok"}` on `/api/health`, and the web health page renders right to left in Arabic.
2. **Docs tree and templates.** As Shape A milestone 2, for the new folders. **Done when** as Shape A milestone 2.
3. **TSDoc, naming, and redaction rules.** As Shape A milestone 3, with no backfill needed. **Done when** as Shape A milestone 3.
4. **Git checks and CI images.** As Shape A milestone 4. **Done when** as Shape A milestone 4.

**Cost**: four milestones, about two sessions, **then** rebuilding what Shape A keeps: the data model and ledger, design system, localization, staff sign in, and the stock screens took about 50 build tasks (0002: 12, 0003: 5, 0004: 6, 0005: 9, 0006: 18) and two GA reviews over five working days (2026-10-31 to 2026-11-04). Reusing the old specs as input, an estimated 12 to 16 milestones across features 4 to 8 before slice 1a can start, against an estimated 6 to 9 amendment milestones in Shape A. These are estimates, not measurements.

**Keep list, Shape B**: the rebuild plan's keep list as written (TypeScript is kept, so `.github/workflows/**`, `packages/config`, `.husky/`, and lint and format config stay), plus `docs/reviews/**` and `docs/specs/0002` to `0006` as history with superseded status lines. **Removed**: `apps/**`, `packages/db`, `packages/contracts`, `packages/ui` (rebuilt by feature 5), `deploy/**` (rebuilt by features 3 and 26), `extensions/**` (the loader is rebuilt), `docs/runbooks/staff-sign-in.md` (describes removed code), and root files that name removed paths (`turbo.json` env list, `.env.example`), which the skeleton rewrites.

**Owner decision (2026-11-05): Shape A, keep and amend**, as recommended. The recommendation stands as the record of why: The stack is confirmed, so the existing code is already on it; the hardest GA code (ledger concurrency, sign in hardening) is reviewed with no blockers; the new positioning's changes are mostly new tables beside it; and with no install yet, even the breaking ones (tenant id, owner types, customers out of parties) cost one baseline migration, not a migration path. Shape B's real gain, shedding the old warehouse ERP framing, is bought in Shape A by the amendment list above at a fraction of the cost. Shape B would have bought a codebase with no inherited assumptions for roughly a week of rebuild, which the pilot window cannot spare (domain review, "Shape A versus Shape B").

## Consequences

**Positive**:
- One connector pattern means each new provider is an adapter plus fixtures, not a new architecture; webhooks can never be lost to a slow handler.
- Two origins and a deny by default guard make the public portal and partners structurally unable to reach staff data.
- A shared database server with per client roles fits dozens of clients per host while keeping each client's data in its own database.
- Tenant id, owner type policy, and license are fixed before the first feature, so none of them becomes a retrofit.

**Negative / tradeoffs**:
- Two app servers (NestJS and Next.js) per client stack cost memory on a shared host; host sizing must be measured.
- Two hostnames per brand add a DNS step for every install, including self host.
- Inbox, outbox, sweeps, and echo records add tables and jobs before the first connector ships value.
- A failed write back blocks packing that order until a person resolves it: a deliberate stop that will slow a busy warehouse whenever Shopify rejects edits.
- Self running object storage on every host is one more service the vendor operates and backs up, because no Egyptian provider confirms S3.
- Pinned versions per client still mean release lines and backports; the support window is unsettled.
- A shared PostgreSQL server is a shared failure: one host outage stops every client on it until restored.
- TSDoc on every export and a README per folder add writing to every change; review must keep the content honest, since lint only proves presence.

**Neutral**:
- Spec 0001 becomes history once this is approved; this spec restates what it kept.
- The OpenAPI client leaves the plan until the public API is unparked.
- Images stay amd64 only.

## Open questions

Decided by the owner on 2026-11-05 and recorded under `## Decision` and `## Decisions at the gate`: the shape (A), the support window, object storage other than MinIO, two hostnames, Turnstile, the 14 day grace period, the migration baseline reset, and the nine domain review questions. Still open:

1. **Does any install run the current migrations?** A fact for Igris to confirm before the feature 4 build resets them to one baseline. If one does: forward migrations from `0009` instead.
2. **Which Egyptian data center** (final plan question 9). Current state, not a decision, from [research 0001](../../research/0001-egypt-hosting-options.md): Huawei Cloud's Cairo region (live May 2024, hosted by Telecom Egypt in Smart Village) is the only public cloud region found in Egypt; no Egyptian provider's published pages confirm S3 compatible storage, an API, or billing in Egyptian pounds. The research recommends Telecom Egypt or Huawei Cloud Cairo as primary, pending written answers from their sales teams; a self run S3 compatible store on each host rather than the provider's; backups encrypted and copied to a second Egyptian provider; and LightNode's Cairo VPS as the pilot fallback. Counsel must confirm the Law 151 position: executive regulations Decision 816/2025 are in force, with enforcement from about 1 November 2026, and any transfer outside Egypt needs a licence; the Turnstile question (gate item 7) goes to counsel in the same review.
3. **Which S3 compatible server** for hosts, dev, and self host. Decided: not MinIO, and self run on each host (research 0001 found no provider S3). Open for feature 3: which one; Garage and SeaweedFS are the named candidates, and Garage is AGPL, so check the license before shipping it to self host clients.

## Follow-up

- [ ] Igris: in `docs/scope/foundations.md` line 3, "once spec 0002 is approved" is now false (it is spec 0007, and the wipe is not settled); outside this task's scope.
- [ ] Igris: `docs/positioning/2026-11-05-rebuild-plan.md` section 2 and section 3 task 3 describe the wipe; the owner chose Shape A, so nothing is wiped in wave 3.
- [ ] Spec 0002 to 0006 status lines follow Shape A (see *What happens to the spec files*).
- [ ] `AGENTS.md` lines now false once this is approved: "Deploy: two images (`app`, `web`) + Postgres + Caddy as one Docker Compose stack per client" (hosting moves to a shared server), "the web calls the generated client" and "the generated client freshness check" (never built; replaced), "Full decision: spec 0001". `/audit` rewrites these after the scaffold.
- [ ] Before slice 1a, research: whether Bosta signs the webhook body beyond the custom header; its city and zone list (final plan question 5); when the Bosta Shopify app creates a delivery (order creation or fulfillment); whether an address can change after pickup creation (final plan question 4). Write the missing connector skills (Shopify Admin GraphQL, Bosta, Meta Conversions API, WhatsApp Cloud API) before wave 8, as the rebuild plan notes.
- [ ] Feature 3 picks the S3 compatible store and mail catcher; feature 26 measures idle and peak memory per client stack and sizes hosts.
- [ ] Igris: scope feature 1's third milestone label in `docs/scope/foundations.md` reads "TSDoc and naming lint rules"; it now also carries the log redaction rule (M10).
- [x] Domain review (wave 2b) of sections 1 to 6: `docs/reviews/domain-stack.md`, approve with changes; blockers B1 and B2 addressed in this revision; re-review on 2026-11-05 approves with 0 open blockers (new minors n1 to n3 and owner question q10 recorded there).

## Rationale

Reasoning, options, evidence, and references: see [rationale.md](rationale.md).
