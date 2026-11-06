# apps/api

## Overview

The NestJS backend that holds every business rule. One codebase, three entry points in the `app` image: `api` (HTTP, `src/main.ts`), `worker` (pg-boss jobs, `src/worker.ts`), and `migrate` (`src/migrate.ts`, runs migrations and exits).

## Key files

| File | Owns |
|---|---|
| `src/main.ts` | HTTP bootstrap: installs `RedactingLogger`, loads extensions |
| `src/app.setup.ts` | HTTP wiring shared by every start: trust proxy, `/api` prefix, `QueryErrorFilter`, Better Auth mounted before the body parsers |
| `src/migrate.ts` | The migrate entry point (the only place migrations run); sets the app role login from `APP_DB_PASSWORD`; `TENANT_ID` and `APP_DB_ROLE` are read here only: stored on a database's first run, then only checked on every run (a different value throws `TenantMismatch` or `AppRoleMismatch`); the app role's password is set for the stored role |
| `src/worker.ts`, `src/worker.module.ts` | The worker entry point: no HTTP, logs through `RedactingLogger`, runs pg-boss jobs (the nightly ledger reconciliation) |
| `src/database/sql.ts` | `Transaction`/`Executor` types, `pgArray` (arrays as one bound literal), PostgreSQL error code helpers |
| `src/platform/` | `SettingsService` (typed install settings, `localDate` in the install time zone), `NumberingService` (gap free document numbers), and `CostRulesService` (`ruleFor`: the per order cost rule in force on a day, read from `order_cost_rules`; `not_set` and never 0 when unset) |
| `src/platform/audience/` | `@Audience(...)` (`staff`, `partner`, `portal`, `hook`, `public`) and the deny by default `AudienceGuard`; `audience.spec.ts` fails the build for a controller without exactly one |
| `src/platform/logging/` | `RedactingLogger`: Nest's console logger with every argument passed through `redact` from `@ssdashboard/config/redaction` |
| `src/identity/` | Staff sign in (`sign-in/`) and staff administration (`staff/`), one `IdentityModule`, see [its AGENTS.md](src/identity/AGENTS.md) |
| `src/inventory/` | The stock ledger, see [its AGENTS.md](src/inventory/AGENTS.md) |
| `src/app.module.ts` | Root module, imports each business module |
| `src/config/env.ts` | Zod env schema, validated at startup |
| `src/database/database.module.ts` | Drizzle client provider |
| `src/extensions/load-extensions.ts` | Loads `extensions/<client>` packages listed in `EXTENSIONS` |

## Commands

```bash
pnpm --filter @ssdashboard/api dev        # Watch mode on port 3001
pnpm --filter @ssdashboard/api test       # Unit tests (src/**/*.spec.ts)
pnpm --filter @ssdashboard/api test:e2e   # test/*.e2e-spec.ts against Postgres (build first), except the scale suite
pnpm --filter @ssdashboard/api test:scale # only test/scale.e2e-spec.ts (build and migrate first); the `scale` CI job
pnpm --filter @ssdashboard/api worker     # Run the built worker (pg-boss jobs)
```

## Conventions

- One folder per business module under `src/<module>/`, holding its module, services, controllers, specs, and a `README.md` (the five headings of `docs/templates/module-readme.md`, checked by `pnpm lint:repo`) side by side.
- Inside the api and worker, log through Nest's `Logger` (routed to `RedactingLogger`); `console` appears only in command line paths (`create-admin.ts`, the startup env failure) and never with personal data. A new field that carries personal data goes into the list in `packages/config/src/redaction.ts`.
- Read config only through the injected `ENV` token, never `process.env` directly; add every new variable to `env.ts` and `.env.example`.
- Database access goes through the Drizzle client from `database.module.ts`; tables are defined in `packages/db`, not here.
- Import Drizzle helpers (`sql`, `inArray`, `SQL`) from `@ssdashboard/db`, never from `drizzle-orm`: pg-boss's `@opentelemetry/api` peer makes pnpm create a second drizzle-orm copy whose types do not match.
- Pass an array to raw SQL as one literal, `${pgArray(ids)}::uuid[]`; Drizzle expands a plain JS array into a list of parameters.
- Validate query strings with `new ZodQueryPipe(<contract schema>)` (`src/platform/zod-query.pipe.ts`); a bad query answers 400 with the stable code `INVALID_QUERY`.
- List endpoints page with a keyset cursor (the last row's sort key, base64url encoded) and compare and order with `COLLATE "C"`, so pages never skip or repeat rows (`src/inventory/locations/locations.service.ts`).

## Gotchas

- ESM with NodeNext resolution: relative imports need the `.js` suffix (`./app.module.js`).
- The api never migrates on boot. Run `pnpm db:migrate`, which builds the api first.
- Better Auth needs NestJS's body parser off for `/api/auth`, and its cookies stay host only (never a `Domain`), `Secure` on an https `PUBLIC_URL`, `HttpOnly`, `SameSite=Lax`, on `Path=<STAFF_BASE_PATH>` (else `/`); see [src/identity/AGENTS.md](src/identity/AGENTS.md).
- The core never imports an extension; extensions load by dynamic import only.
- `DATABASE_URL` is the application role, which cannot create databases. The e2e helpers create scratch databases with `MIGRATION_DATABASE_URL` (the owner) and run the ledger as the app role with `options=-c role=ssdashboard_app`.
- `test/scale.e2e-spec.ts` seeds the spec 0002 load (50,000 variants, 150,000 orders and the rest); the spec 0010 audit load joins it with feature 10 (an `it.todo` until `audit_entries` exists). It runs only through `test:scale` (`vitest.config.scale.ts`), in the `scale` CI job (nightly, `scale` label on a pull request, or by hand); `vitest.config.e2e.ts` excludes it. `pnpm --filter ... test:e2e -- <file>` does not filter in this repo (the `--` is forwarded and vitest ignores it): call `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts <file>` for one file.
- The module wall is `src/module-boundary.spec.ts`: a file in one module that names another module's table (by Drizzle export or SQL name, from `TABLE_OWNERSHIP` in `packages/db`) fails it, and so does an extension that names a core table. Its `KNOWN_BREACHES` list may only shrink.

## Agent skills

- [nestjs-best-practices](../../.claude/skills/nestjs-best-practices/): `kadajett/agent-nestjs-skills`, modules, DI, security, performance
- [drizzle-orm-patterns](../../.claude/skills/drizzle-orm-patterns/): `giuseppe-trisciuoglio/developer-kit`, queries, transactions, row locks
- [pg-boss-v12](../../.claude/skills/pg-boss-v12/): `sncollective/snc-platform`, pg-boss v12 API reference (send, work, schedule, createQueue). Written inside another project: its version notes describe that project, not ours
- [tl-pg-boss](../../.claude/skills/tl-pg-boss/): `toddlevy/tl-agent-skills`, pg-boss job patterns (cron, retries, exactly once, testing, monitoring)
- Identity work (`src/identity/`), from `better-auth/skills`: [better-auth-best-practices](../../.claude/skills/better-auth-best-practices/), [better-auth-security-best-practices](../../.claude/skills/better-auth-security-best-practices/), [email-and-password-best-practices](../../.claude/skills/email-and-password-best-practices/), [two-factor-authentication-best-practices](../../.claude/skills/two-factor-authentication-best-practices/), [organization-best-practices](../../.claude/skills/organization-best-practices/), [create-auth](../../.claude/skills/create-auth/).
## Related specs

- [0007 Stack and architecture for the operations layer](../../docs/specs/0007-stack-architecture-operations-layer/index.md) (supersedes 0001)
- [0002 Core data model](../../docs/specs/0002-core-data-model/index.md)

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
