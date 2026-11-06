# Database schema (`@ssdashboard/db`)

The Drizzle schema for every module (Better Auth tables included) and the only migration history. The api's `migrate` entry point applies the migrations; nothing else does.

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- Table definitions, one file per area, re-exported from [src/schema/index.ts](src/schema/index.ts): [auth](src/schema/auth.ts), [catalog](src/schema/catalog.ts), [channels](src/schema/channels.ts) (`stores` and `channels`: where an order is numbered and how it arrived), [connectors](src/schema/connectors.ts) (`connections` and `outbound_commands`: the connected accounts and the write backs to them), [credit](src/schema/credit.ts) (`credit_entries`: the customer credit ledger), [customers](src/schema/customers.ts) (`customers`, `customer_phones`, `customer_external_ids`, `customer_merges`), [inventory](src/schema/inventory.ts), [locations](src/schema/locations.ts), [orders](src/schema/orders.ts) (`orders`, `order_lines`, `order_events`), [parties](src/schema/parties.ts), [platform](src/schema/platform.ts) (with `order_cost_rules`), [settlement](src/schema/settlement.ts) (accounts, periods, period events, statements, lines, match rows), [stock-receipts](src/schema/stock-receipts.ts), [tasks](src/schema/tasks.ts)
- The map of which api module owns each table (spec 0002, A5), with the tables later features build, and `schemaTables` (every Drizzle table by export and SQL name): [src/table-ownership.ts](src/table-ownership.ts)
- The seeds of the store `MAIN` and the channel `manual` (whose default store is `MAIN`), in [0002_baseline_rules.sql](migrations/0002_baseline_rules.sql); the one `not_set` order cost rule per kind, seeded by `runMigrations` after the `install` row (a rerun adds none)
- The SQL migrations and their history: [migrations/](migrations/), the baseline of three files (`0000_baseline_extensions.sql` and `0002_baseline_rules.sql` by hand, `0001_baseline_tables.sql` generated)
- The `tenant_id` column helper that every table carries and the one row `install` table: [src/schema/columns.ts](src/schema/columns.ts), [src/schema/platform.ts](src/schema/platform.ts)
- The Drizzle client and migration runner (first run sets `ssd.tenant_id` and `ssd.app_role` on the database and writes the `install` row; `TenantMismatch` on a wrong `TENANT_ID`): [src/client.ts](src/client.ts), [src/migrate.ts](src/migrate.ts)
- Drizzle config: [drizzle.config.ts](drizzle.config.ts)

## Never touches

- A migration that has shipped. Fix forward with a new one.
- Update or delete rights on the ledger history for the app role.
- Update or delete on `movement_groups`, `stock_movements`, `movement_serials`, `stock_receipt_lines`, `cost_records`, `order_events`, `customer_merges`, `credit_entries`, `settlement_statements`, `settlement_lines`, `settlement_line_matches`, `settlement_period_events`, and `order_cost_rules`. All are append only (trigger and revoke in [0002_baseline_rules.sql](migrations/0002_baseline_rules.sql)); a correction is a new row. A settlement period is never deleted (by any role), its account never changes, its status only follows its close and revoke events, and a closed period's dates never change (`PeriodClosed`). A settlement account's owner is fixed for life (`SettlementOwnerFixed`). A task is cancelled, never deleted.
- A credit reversal of another customer, line, quantity, or payout method, a payout through an unmatching method, a posting split across customers or request hashes, and a match row off its line's chain (or after `accounted`): each is refused by a check, a composite key, or a trigger in [0002_baseline_rules.sql](migrations/0002_baseline_rules.sql).
- Core tables from extensions. Extensions keep their own tables in their own schema.

## How to test

```bash
pnpm --filter @ssdashboard/db test
pnpm --filter @ssdashboard/db test:e2e
pnpm db:generate
```

`test:e2e` needs Postgres from `deploy/compose.dev.yaml`. Specs: unit [test/client.spec.ts](test/client.spec.ts) and [src/table-ownership.spec.ts](src/table-ownership.spec.ts) (every schema table has an owner); e2e [test/client.e2e-spec.ts](test/client.e2e-spec.ts), [test/migrate.e2e-spec.ts](test/migrate.e2e-spec.ts), [test/tenant.e2e-spec.ts](test/tenant.e2e-spec.ts) (the tenant column and key rules, with planted failures), [test/schema.e2e-spec.ts](test/schema.e2e-spec.ts) (the append only guards, one case per built table of A4), [test/operating-day.e2e-spec.ts](test/operating-day.e2e-spec.ts) (the Cairo operating day, stamped by trigger), [test/orders.e2e-spec.ts](test/orders.e2e-spec.ts) (stores, channels, connections, outbound commands, orders, order lines, and events), [test/customers.e2e-spec.ts](test/customers.e2e-spec.ts) (customers, phones, external ids, and merges), [test/credit.e2e-spec.ts](test/credit.e2e-spec.ts) (credit entry checks and reversals), [test/settlement.e2e-spec.ts](test/settlement.e2e-spec.ts) (accounts, the period exclusion, statements, lines, and match rows), [test/tasks.e2e-spec.ts](test/tasks.e2e-spec.ts) (owner hats, outcomes, dedupe keys), and [test/enum-parity.e2e-spec.ts](test/enum-parity.e2e-spec.ts) (each order, customer, credit, settlement, task, and cost rule database enum equals its Zod twin in `@ssdashboard/contracts`, so the two change together). `pnpm db:generate` makes a new migration from the schema (run from the repo root).

After the baseline reset in [ADR 0003](../../docs/adr/0003-reset-migrations-to-one-baseline.md), every developer recreates the dev database after each change to a baseline file until the freeze (each milestone of feature 4 is one): drop and recreate just this checkout's own database, then run `pnpm db:migrate`; or, alone on the server, `docker compose -f deploy/compose.dev.yaml down -v` then `pnpm bootstrap`. The `down -v` step removes the shared dev volume, so read the warning in the [root README](../../README.md) first. `pnpm bootstrap` stops with this instruction if it finds a database migrated by the old history.

## Governing spec

- [0002 Core data model](../../docs/specs/0002-core-data-model/index.md)
- [0002 orders child](../../docs/specs/0002-core-data-model/0002-orders.md) (stores, channels, connections, outbound commands, orders, lines, events)
- [0002 customers, credit, and tasks child](../../docs/specs/0002-core-data-model/0002-customers-credit-tasks.md) (customers, phones, external ids, merges, credit entries, tasks)
- [0002 settlement child](../../docs/specs/0002-core-data-model/0002-settlement.md) (accounts, periods, statements, lines, match rows)
- [0002 tenancy and platform child](../../docs/specs/0002-core-data-model/0002-tenancy-platform.md) (append only list A4, table ownership A5)
- [0007 Stack and architecture for the operations layer](../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

- [ADR 0003 Reset the migrations to one baseline](../../docs/adr/0003-reset-migrations-to-one-baseline.md)

Record further non obvious decisions as ADRs in docs/adr/ and link them here.
