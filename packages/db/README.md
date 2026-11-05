# Database schema (`@ssdashboard/db`)

The Drizzle schema for every module (Better Auth tables included) and the only migration history. The api's `migrate` entry point applies the migrations; nothing else does.

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- Table definitions, one file per area, re-exported from [src/schema/index.ts](src/schema/index.ts): [auth](src/schema/auth.ts), [catalog](src/schema/catalog.ts), [inventory](src/schema/inventory.ts), [locations](src/schema/locations.ts), [parties](src/schema/parties.ts), [platform](src/schema/platform.ts), [stock-receipts](src/schema/stock-receipts.ts)
- The SQL migrations and their history: [migrations/](migrations/), the baseline of three files (`0000_baseline_extensions.sql` and `0002_baseline_rules.sql` by hand, `0001_baseline_tables.sql` generated)
- The `tenant_id` column helper that every table carries and the one row `install` table: [src/schema/columns.ts](src/schema/columns.ts), [src/schema/platform.ts](src/schema/platform.ts)
- The Drizzle client and migration runner (first run sets `ssd.tenant_id` and `ssd.app_role` on the database and writes the `install` row; `TenantMismatch` on a wrong `TENANT_ID`): [src/client.ts](src/client.ts), [src/migrate.ts](src/migrate.ts)
- Drizzle config: [drizzle.config.ts](drizzle.config.ts)

## Never touches

- A migration that has shipped. Fix forward with a new one.
- Update or delete rights on the ledger history for the app role.
- Core tables from extensions. Extensions keep their own tables in their own schema.

## How to test

```bash
pnpm --filter @ssdashboard/db test
pnpm --filter @ssdashboard/db test:e2e
pnpm db:generate
```

`test:e2e` needs Postgres from `deploy/compose.dev.yaml`. Specs: [test/client.spec.ts](test/client.spec.ts), [test/schema.e2e-spec.ts](test/schema.e2e-spec.ts), [test/migrate.e2e-spec.ts](test/migrate.e2e-spec.ts), [test/tenant.e2e-spec.ts](test/tenant.e2e-spec.ts) (the tenant column and key rules, with planted failures). `pnpm db:generate` makes a new migration from the schema (run from the repo root).

## Governing spec

- [0002 Core data model](../../docs/specs/0002-core-data-model/index.md)
- [0007 Stack and architecture for the operations layer](../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

- [ADR 0003 Reset the migrations to one baseline](../../docs/adr/0003-reset-migrations-to-one-baseline.md)

Record further non obvious decisions as ADRs in docs/adr/ and link them here.
