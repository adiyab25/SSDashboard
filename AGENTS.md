# SSDashboard

Warehouse and ERP system for multi channel ecommerce, one shared core deployed per client. Scope: [docs/scope/index.md](docs/scope/index.md).

## Stack

- **Language / Runtime**: TypeScript (strict) on Node 26 (`.nvmrc`), ESM everywhere
- **Framework**: modular monolith, NestJS api + worker + migrate (`apps/api`), Next.js App Router back office (`apps/web`)
- **Key dependencies**: PostgreSQL 18 + Drizzle ORM (`packages/db`), Zod contracts + OpenAPI (`packages/contracts`), Better Auth, pg-boss, shadcn/ui on Tailwind v4, TanStack Table
- **Package manager**: pnpm workspaces (shared versions in the `catalog:` of `pnpm-workspace.yaml`) + Turborepo
- **Deploy**: two images (`app`, `web`) + Postgres + Caddy as one Docker Compose stack per client (`deploy/`). Full decision: [spec 0001](docs/specs/0001-stack-architecture/index.md)

## Build approach

Tracer Bullet: prove one real thread through every layer first, then thicken one segment at a time, always end to end.

## Commands

```bash
pnpm install                                  # Install
docker compose -f deploy/compose.dev.yaml up -d   # Local Postgres on port 5433 (copy .env.example to .env)
pnpm db:migrate                               # Apply migrations (as the owner, MIGRATION_DATABASE_URL)
pnpm dev                                      # api on 3001, web on 3000
pnpm build && pnpm typecheck                  # Build, type check
pnpm test                                     # Unit tests (Vitest)
pnpm test:e2e                                 # Database backed e2e + Playwright (needs Postgres)
pnpm db:generate                              # New SQL migration from the Drizzle schema
```

## Specs

Stored in `docs/specs/`. Format: `docs/specs/NNNN-title/index.md` (plus `rationale.md`, `verify.md`).

## Rules

- **Domain driven modules.** Each business area (catalog, inventory, purchasing, sales, production, costing, platform) is one bounded NestJS module owning its tables, services, and controllers. Modules talk only through exported services or past tense domain events (`StockMoved`, `OrderPlaced`), never by reading another module's tables. Use the business's words in code; immutable value objects (`Money`, `Quantity`) validate on construction.
- **The stock ledger is append only.** Every stock change goes through the inventory ledger service, the single writer of movements. Never update or delete a movement; correct with a new one. Every movement, order line, and receipt carries cost and price.
- **Two database roles.** The api and worker connect as `ssdashboard_app` (`DATABASE_URL`), which can only insert and read the ledger history; only `migrate` connects as the owner (`MIGRATION_DATABASE_URL`). Never give an app service the owner password; Compose passes each service an explicit env list. Full rules: [spec 0002](docs/specs/0002-core-data-model/index.md).
- **Folder by feature.** Colocate a feature's module, schema, contract, and screens; no global `services/` or `controllers/` folders.
- **Strict types.** No `any` (use `unknown` and narrow), exhaustive `switch` on unions; keep `strict` and `noUncheckedIndexedAccess` on.
- **One schema per shape.** Request and response shapes are Zod schemas in `packages/contracts`; the api validates with them and the web calls the generated client. Never hand write a duplicate type.
- **No business logic in Next.js server code.** Server components render only the shell and session check; business data loads in client components through relative `/api` paths. No `NEXT_PUBLIC_*` per client settings; they come from `GET /api/config`.
- **Config is env only, validated at startup** (`apps/api/src/config/env.ts`). Nothing per client is baked into an image; client differences live in settings, module toggles, custom fields, or `extensions/<client>`, never core edits.
- **Migrations only move forward**, run only by the `migrate` entry point, apply from any supported version, and follow expand and contract (no destructive change in one release). Data moves happen in SQL migrations.
- **Errors**: throw NestJS HTTP exceptions with a stable error code at the api edge; domain code throws typed domain errors, never returns error strings. **Named exports only**, except where Next.js requires a default export (`page`, `layout`, and similar files).
- **UI**: English and Arabic from day one, so no hard coded strings and logical CSS properties only (`ms-`/`me-`, `start`/`end`, never `left`/`right`); WCAG 2.2 AA with keyboard and focus support.
- **Design system**: build all UI to [`packages/ui/DESIGN.md`](packages/ui/DESIGN.md) (color roles, type, density, focus, and the table, form, and feedback rules); token values live in `packages/ui/src/styles/globals.css`, not `packages/config`. Use role tokens only (`bg-muted`, `text-foreground`, never `bg-zinc-200` or raw colors), Radix `asChild` for custom triggers, and shadcn components from `@ssdashboard/ui` before custom markup. Every page renders inside the app shell with exactly one `<h1>`.

## Tooling

Chosen here, installed by `/develop tooling` (feature 2). Tests already run on Vitest, Testing Library, and Playwright (`test-preferences.json`).
- Lint and format: ESLint flat config with typescript-eslint (shared config in `packages/config`) + Prettier, run through Turborepo `lint` and `format` tasks.
- Logical CSS check: `packages/config/scripts/check-logical-css.mjs` runs inside `lint` for `packages/ui` and `apps/web` and fails on physical side styles (`ml-`, `left-`, `text-right`, `margin-left`, and the like).
- Before commit: lint, format, and type check staged work on every commit (Husky + lint-staged).
- Testing gate: unit + integration tests with Vitest beside the source, database backed e2e and Playwright for user flows.
- CI: GitHub Actions on push and PR runs lint, typecheck, test, and the generated client freshness check. The upgrade test and image publishing come with feature 16.

## Git

- integration: on
- branch prefix: feat/
- commit: per-milestone (short imperative subject, matching the history; no conventional commit prefixes)

## Agent skills

Project wide skills here; stack specific ones are listed in each workspace doc.
- [turborepo](.claude/skills/turborepo/): `vercel/turborepo`, task pipelines, caching, package boundaries
- [pnpm](.claude/skills/pnpm/): `antfu/skills`, workspaces, catalogs, `allowBuilds`
- [multi-stage-dockerfile](.claude/skills/multi-stage-dockerfile/): `github/awesome-copilot`, the `deploy/` Dockerfiles
- [postgresql-table-design](.claude/skills/postgresql-table-design/): `wshobson/agents`, table, index, and constraint design for every module
- [agent-browser](.claude/skills/agent-browser/): drives the real app for `/check verify`
- [design-md](.claude/skills/design-md/): the `design.md` for feature 4

MCP servers: shadcn registry (recommended), Better Auth docs `https://mcp.better-auth.com/mcp` (recommended), Next.js devtools `vercel/next-devtools-mcp` (recommended), a community Postgres MCP on dev data only (recommended)

## Context files

- [apps/api/AGENTS.md](apps/api/AGENTS.md): NestJS api, worker, and migrate entry points; module, config, and extension rules
- [apps/api/src/inventory/AGENTS.md](apps/api/src/inventory/AGENTS.md): the stock ledger service, its locking, costing, and reconciliation rules
- [apps/api/src/auth/AGENTS.md](apps/api/src/auth/AGENTS.md): staff sign in, session guard, lockout, two factor, and the create-admin commands
- [apps/web/AGENTS.md](apps/web/AGENTS.md): Next.js back office (this Next.js version differs from training data, read its docs first)
- [packages/contracts/AGENTS.md](packages/contracts/AGENTS.md): Zod schemas, OpenAPI document, generated client
- [packages/db/AGENTS.md](packages/db/AGENTS.md): Drizzle schema and the only migration history
- [packages/config/AGENTS.md](packages/config/AGENTS.md): shared TypeScript (and later lint) config
- [packages/ui/AGENTS.md](packages/ui/AGENTS.md): shared design system, shadcn components, tokens, and `DESIGN.md`

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
