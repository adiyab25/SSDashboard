# SSDashboard

The order operations and warehouse back office for Egyptian clothing brands behind Shopify, Bosta cash on delivery, and consignment showroom partners; one shared core deployed per brand, sold as a Warehouse and an Operations bundle. Scope: [docs/scope/index.md](docs/scope/index.md). The wave 3 scaffold ([spec 0007](docs/specs/0007-stack-architecture-operations-layer/index.md) Shape A: keep and amend) is in; why the product changed: [rebuild plan](docs/positioning/2026-11-05-rebuild-plan.md).

## Stack

- **Language / Runtime**: TypeScript (strict) on Node 26 (`.nvmrc`), ESM everywhere
- **Framework**: modular monolith, NestJS api + worker + migrate (`apps/api`), Next.js App Router web app split by audience (`apps/web`)
- **Key dependencies**: PostgreSQL 18 + Drizzle ORM (`packages/db`), Zod contracts (`packages/contracts`), Better Auth, pg-boss, shadcn/ui on Tailwind v4, TanStack Table
- **Package manager**: pnpm workspaces (shared versions in the `catalog:` of `pnpm-workspace.yaml`) + Turborepo
- **Deploy**: two images (`app`, `web`) + Postgres + Caddy as one Docker Compose stack per client (`deploy/compose.yaml`) today. Full decision: [spec 0007](docs/specs/0007-stack-architecture-operations-layer/index.md) (supersedes 0001); the shared host Postgres, edge Caddy, and per client role names arrive with features 4 and 26.

## Build approach

Tracer Bullet: prove one real thread through every layer first, then thicken one segment at a time, always end to end.

## Commands

```bash
pnpm install && pnpm bootstrap               # .env from .env.example, Postgres 18 (5433), Garage S3 (3900), Mailpit (1025, UI 8025), migrations; safe to rerun
pnpm db:migrate                               # Apply migrations (as the owner, MIGRATION_DATABASE_URL)
pnpm dev                                      # api on 3001, web on 3000
pnpm build && pnpm typecheck                  # Build, type check
pnpm lint                                     # ESLint per workspace + the repo checks (pnpm lint:repo runs those alone)
pnpm format:check                             # Prettier
pnpm test                                     # Unit tests (Vitest)
pnpm check:timezone                           # Release step: tz data of Node and PostgreSQL, then the Cairo daylight saving test (needs Postgres)
pnpm test:e2e                                 # Database backed e2e + Playwright (needs Postgres); excludes the api scale suite
pnpm --filter @ssdashboard/api test:scale     # The api scale suite alone (needs Postgres, tens of minutes)
pnpm db:generate                              # New SQL migration from the Drizzle schema
```

## Specs

Stored in `docs/specs/`. Format: `docs/specs/NNNN-title/index.md` (plus `rationale.md`, `verify.md`). Decisions inside one module are ADRs in `docs/adr/NNNN-title.md` (copy `0000-template.md`, list it in `docs/adr/README.md`, link it from the module README).

## Rules

- **Domain driven modules.** Each business area is one bounded NestJS module in `apps/api/src/<module>/` owning its tables, services, and controllers, named in the business's words. Today: `platform` (settings, numbering, `audience/`, `logging/`, `license/`, `modules/` the module registry and gate, `jobs/` the one pg-boss client per process and the job supervisor, `events/` in transaction domain events), `identity` (staff and partner sign in in `sign-in/`, audiences and hat driven sessions in `sessions/`, staff administration in `staff/`, partner logins in `partner-users/`), `audit`, `catalog`, `inventory`, `customers` (find or create a customer by phone, search, merge and undo, merge suggestions, a second phone; the profile, the timeline read through each hat's lens, the returner signal, and the flag in the leaf `CustomerProfileModule` in `profile/`, which reads orders through `OrderQueries`, spec 0014), `partners` (only `PartnerAccounts` until feature 41), `channels` (stores and channels through `ChannelsService`), `connectors` (spec 0015: the Shopify connections and connect job, the signed Shopify webhook hook, the durable inbox, and the inbox job that reads an order back, creates it through orders, applies a known order's later read backs (cancel, first fulfillment, edits, payment rederive), sends customer webhooks to `CustomersService.findOrCreate`, nets Shopify edits and makes exchange replacements (task 10), and runs the scheduled sweeps, gateway scan, backfill with go live, hourly check, freshness endpoint, and inbox purge (task 12); the outbound side is a stand-in until task 13: `ConnectorsService` reads open outbound commands and answers `writeBackAvailable`, plus the four `OutboundCommand*` events), `orders` (the only writer of orders: manual and gifted order creation, the list, the order page, edits, confirm, cancel, pack and unpack, and the write back hold so far; channel intake, stock, and the carrier and cash moves follow, spec 0013), `mail`, `health`. Planned by spec 0007's module map: `tasks`, `credit`, `settlement`, `consignment` (the partner portal, partner terms, sales ingestion, and partner settlement, toggleable, feature 41), `exchanges`, `exports`, `reporting`; planned by spec 0022: `day-close` (own records days confirmed by the sweep, and `ConfirmedDays` for reporting); purchasing and production come with slices 4 and 5. Modules talk only through exported services or past tense domain events (`StockMoved`, `OrderPlaced`), never by reading another module's tables. Immutable value objects (`Money`, `Quantity`) validate on construction.
- **The stock ledger is append only.** Every stock change goes through the inventory ledger service, the single writer of movements. Never update or delete a movement; correct with a new one. Every movement, order line, and receipt carries cost and price.
- **Two database roles.** The api and worker connect as `ssdashboard_app` (`DATABASE_URL`), which can only insert and read the ledger history; only `migrate` connects as the owner (`MIGRATION_DATABASE_URL`). Never give an app service the owner password; Compose passes each service an explicit env list. Full rules: [spec 0002](docs/specs/0002-core-data-model/index.md).
- **Audiences, deny by default.** Web route groups are exactly `(backoffice)`, `(portal)`, `(partner)`, `(auth)`. Every api controller carries exactly one `@Audience('staff' | 'partner' | 'portal' | 'hook' | 'public')` (`apps/api/src/platform/audience/`); `audience.spec.ts` fails the build otherwise. Every controller also carries exactly one class level `@RequiresModule(moduleKey)` or `@RequiresCapability(capabilityKey)` from the module registry (`packages/contracts/src/modules/`, spec 0009); `requires-module.spec.ts` fails the build otherwise, and the `ModuleGate` refuses an undeclared route with 500 `MODULE_MISSING`.
- **Folder by feature.** Colocate a feature's module, schema, contract, screens, and tests; no global `services/` or `controllers/` folders.
- **Strict types.** No `any` (use `unknown` and narrow), exhaustive `switch` on unions; keep `strict` and `noUncheckedIndexedAccess` on.
- **One schema per shape.** Request and response shapes are Zod schemas in `packages/contracts`; the api validates with them, and the web calls relative `/api` paths (`apiRequest` in `apps/web/src/api/client.ts`) and parses each answer with the contract schema. There is no OpenAPI document or generated client yet. Never hand write a duplicate type.
- **No business logic in Next.js server code.** Server components render only the shell and session check; business data loads in client components through relative `/api` paths. No `NEXT_PUBLIC_*` per client settings; they come from `GET /api/config`.
- **Config is env only, validated at startup** (`apps/api/src/config/env.ts`). Nothing per client is baked into an image; client differences live in settings, module toggles, custom fields, or `extensions/<client>`, never core edits.
- **Migrations only move forward**, run only by the `migrate` entry point, apply from any supported version, and follow expand and contract (no destructive change in one release). Data moves happen in SQL migrations.
- **Errors**: throw NestJS HTTP exceptions with a stable error code at the api edge; domain code throws typed domain errors, never returns error strings. **Named exports only**, except where Next.js requires a default export (`page`, `layout`, and similar files).
- **Ports 4900-4949 are CI only.** CI uses web 4900, api 4901, production web 4910, and Postgres 4932 (`ci.yml`), so a self-hosted runner never collides with the dev servers and databases on the same machine. Never put a port in that block in `.env.example`, `.claude/launch.json`, `package.json` scripts, `deploy/compose*.yaml`, or the Playwright defaults; `check-reserved-ci-ports.mjs` fails `lint:repo` on it.
- **Documented code.** TSDoc on every export (what it does, why, and what it must never do), enforced by lint. A `README.md` with Owns, Never touches, How to test, Governing spec, and Decisions (`docs/templates/module-readme.md`) in every api module, web feature folder, and package, enforced by `lint:repo`.
- **Names.** Kebab case files; one component per `.tsx` file, exporting the component named after the file (`exchange-request-form.tsx` exports `ExchangeRequestForm`); no vague words (`util`, `helper`, `misc`, `temp`, `mgr`, `cfg`). shadcn files in `packages/ui/src/components/` and `packages/ui/src/lib/utils.ts` are exempt ([ADR 0001](docs/adr/0001-shadcn-component-files-keep-their-vendor-shape.md)).
- **Personal data never reaches logs (Law 151).** Customer phones, names, addresses, and message bodies are redacted by the list in `packages/config/src/redaction.ts`; the api and worker log through `RedactingLogger` (`apps/api/src/platform/logging/`). Never print personal data with `console`; any error tracker runs on the host or in Egypt, never abroad.
- **Docs stay true.** A README, spec, scope, or `AGENTS.md` line your change makes false is a defect; fix it in the same change.
- **UI**: English and Arabic from day one, so no hard coded strings and logical CSS properties only (`ms-`/`me-`, `start`/`end`, never `left`/`right`); WCAG 2.2 AA with keyboard and focus support.
- **Design system**: build all UI to [`packages/ui/DESIGN.md`](packages/ui/DESIGN.md) (color roles, type, density, focus, and the table, form, and feedback rules); token values live in `packages/ui/src/styles/globals.css`, not `packages/config`. Use role tokens only (`bg-muted`, `text-foreground`, never `bg-zinc-200` or raw colors), Radix `asChild` for custom triggers, and shadcn components from `@ssdashboard/ui` before custom markup. Every page renders inside its audience's frame with exactly one `<h1>`.

## Tooling

- Lint and format: ESLint flat config (shared in `packages/config/eslint`: typescript-eslint, `jsdoc/require-jsdoc` + `tsdoc/syntax`, `unicorn/filename-case`, `react/no-multi-comp`, i18n bans) + Prettier (`.prettierrc.json`).
- Repo checks (`packages/config/scripts`, run by `pnpm lint` through the root task `//#lint:repo`): route groups, folder names, module READMEs, doc links (`docs/**`, READMEs, AGENTS.md), banned names, component export names, the TSDoc fixture, and the reserved CI ports (a port in 4900-4949 in dev facing config). The logical CSS check runs inside `lint` for `packages/ui` and `apps/web`.
- Hooks (Husky): `pre-commit` runs lint-staged (args chunked with `--max-arg-length 4000` for Windows) then `pnpm typecheck`; `commit-msg` runs `check-commit-subject.mjs`.
- Testing: Vitest and Testing Library beside the source, database backed e2e and Playwright for user flows (`test-preferences.json`).
- CI (`.github/workflows/ci.yml`): `conventions` (branch name and every commit subject, PRs only), `images` (builds `app` and `web`, not pushed), `checks` (format, lint, typecheck, unit), `e2e` (Postgres 18 service, Playwright), `scale` (Postgres 18 service, `pnpm --filter @ssdashboard/api test:scale`; on pull requests labelled `scale` or by hand, never on a schedule). Every job runs on `vars.CI_RUNS_ON` (set it to `self-hosted` for the WSL2 runner, [how to](docs/ops/self-hosted-ci-runner.md)) and falls back to `ubuntu-latest`. Publishing images comes with feature 26 (deployment).

## Knowledge graphs

Three graphify graphs of this repo, built from one extraction ([graphify-out/README.md](graphify-out/README.md)). Pick by what the question needs, and start from a concrete name: `graphify query "<question>" --seed <SymbolOrFile> --graph <path>` (also `path`, `explain`, `affected`). An unseeded question matches on its words and returns noise.

- **Product** `graphify-out/graph.json` (the default): code plus specs, ADRs, scope, reviews, and READMEs, without `.claude/`. Use for why and where questions that cross docs and code (about 1,100 edges link a spec, ADR, or review to the code it governs).
- **Code** `graphify-out/code/graph.json`: structure only (imports, calls, classes, SQL). Use for refactors, call chains, impact (`graphify affected`), and import cycles; no doc noise.
- **All** `graphify-out/all/graph.json`: product plus the vendored `.claude/` skills and agents. Use only for questions about the agent tooling itself.

A grep beats the graph for one lookup ("where is X defined"). The graphs are not committed and go stale; rebuild with the steps in that README after a merge.

## Git

- integration: on
- branch prefix: feat/ (also fix/ and docs/; CI rejects anything else, `check-branch-name.mjs`)
- commit: per-milestone (short imperative subject in business words, at most 72 characters, a body that says why when it is not obvious; no conventional prefixes, no `fixup!`, no vague subjects like `wip` or `misc`, rejected by the hook and CI)
- PRs use `.github/pull_request_template.md`; agent made commits and PRs carry the project's attribution lines (review only).

## Agent skills

Project wide skills here; stack specific ones are listed in each workspace doc.
- [turborepo](.claude/skills/turborepo/): `vercel/turborepo`, task pipelines, caching, package boundaries
- [pnpm](.claude/skills/pnpm/): `antfu/skills`, workspaces, catalogs, `allowBuilds`
- [multi-stage-dockerfile](.claude/skills/multi-stage-dockerfile/): `github/awesome-copilot`, the `deploy/` Dockerfiles
- [postgresql-table-design](.claude/skills/postgresql-table-design/): `wshobson/agents`, table, index, and constraint design for every module
- [agent-browser](.claude/skills/agent-browser/): drives the real app for `/check verify`
- [design-md](.claude/skills/design-md/): the `DESIGN.md` for feature 5

MCP servers: shadcn registry (recommended), Better Auth docs `https://mcp.better-auth.com/mcp` (recommended), Next.js devtools `vercel/next-devtools-mcp` (recommended), a community Postgres MCP on dev data only (recommended)

## Context files

Human docs come first: every module and package has a `README.md` (what it owns and never touches). The `AGENTS.md` files below carry only agent gotchas and point at those READMEs.

- [apps/api/AGENTS.md](apps/api/AGENTS.md): NestJS api, worker, and migrate entry points; module, config, audience, logging, and extension rules
- [apps/api/src/inventory/AGENTS.md](apps/api/src/inventory/AGENTS.md): the stock ledger service, its locking, costing, and reconciliation rules
- [apps/api/src/identity/AGENTS.md](apps/api/src/identity/AGENTS.md): sign in for staff and partner users, sessions and audiences, and staff administration (the identity module), the audience aware session guard, lockout, two factor, the staff cookie contract, and the create-admin commands
- [apps/web/AGENTS.md](apps/web/AGENTS.md): Next.js web app and its four audience route groups (this Next.js version differs from training data, read its docs first)
- [packages/contracts/AGENTS.md](packages/contracts/AGENTS.md): Zod schemas shared by the api and web
- [packages/i18n/AGENTS.md](packages/i18n/AGENTS.md): the English and Arabic message catalogs, `createTranslator`, and the language registry shared by the web, api, and worker
- [packages/db/AGENTS.md](packages/db/AGENTS.md): Drizzle schema and the only migration history
- [packages/config/AGENTS.md](packages/config/AGENTS.md): shared TypeScript and ESLint config, the redaction list, and the repo check scripts
- [packages/ui/AGENTS.md](packages/ui/AGENTS.md): shared design system, shadcn components, tokens, and `DESIGN.md`

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
