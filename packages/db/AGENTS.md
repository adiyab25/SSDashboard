# packages/db

## Overview

The Drizzle schema for every module (Better Auth tables included) and the only migration history. The api's `migrate` entry point applies these migrations; nothing else does.

## Stack

Drizzle ORM and drizzle-kit, `pg` driver, PostgreSQL 18 with `pg_trgm`, `unaccent`, and `btree_gist` (enabled by `migrations/0000_baseline_extensions.sql`).

## Commands

```bash
pnpm db:generate                                 # From the repo root: new SQL migration from the schema
pnpm --filter @ssdashboard/db test               # Unit tests
pnpm --filter @ssdashboard/db test:e2e           # Against Postgres from deploy/compose.dev.yaml
```

## Conventions

- Tables live under `src/schema/`, one file per module, re-exported from `src/schema/index.ts`.
- Review every generated SQL migration before committing it; migrations are plain SQL and part of the release.
- Every table has `tenantId()` (`src/schema/columns.ts`), filled by the database from the `ssd.tenant_id` setting; every primary key, unique constraint, or unique index that holds a non uuid column includes `tenant_id` (`test/tenant.e2e-spec.ts` fails otherwise; lead with it, and `ON CONFLICT` targets must name `tenant_id` too). Never pass `tenant_id` from application code.
- What Drizzle cannot express (triggers, grants, roles, a partial unique index with `NULLS NOT DISTINCT`, seeds) is never written into a generated file. It goes in a `drizzle-kit generate --custom --name <x>` migration of its own, like `0002_baseline_rules.sql`; `0001_baseline_tables.sql` is generated only.
- New tables are readable and writable by the app role through default privileges. Every statement that names the app role runs in a `DO` block that reads `coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app')` and quotes it with `format('%I', ...)`. An append only table must `REVOKE UPDATE, DELETE, TRUNCATE` from it and get the `ssd_reject_change` row and truncate triggers, like the ledger history in `0002_baseline_rules.sql`.
- Every function and trigger body in the rules file names tables as `public.<table>` and the plpgsql ones set `search_path = pg_catalog, public, pg_temp`, because the app role may create temp tables that would hide an unqualified name. `ssd_operating_day` stays a plain inlinable `sql` function (qualified names, no `SET`).
- A column a trigger fills (`operating_day`, stamped by `ssd_stamp_operating_day` from `effective_at`) is `not null` without a default; writers use SQL that leaves it out, never a Drizzle insert. A `not null` column that needs a seeded row as its default (`products.product_group_id` is `MAIN`) has no column default either, because the tables file runs before the seeds: the create path and test helpers pass it.
- Composite foreign keys keep a bin in its row's location and a lot on its row's SKU; reuse `(bin_id, location_id)` and `(lot_id, variant_id)` for new tables that reference them.
- The package also re-exports Drizzle's `sql`, `inArray`, and `SQL` so the api uses this package's single drizzle-orm copy.

## Gotchas

- Never edit or delete a migration that has shipped. Fix forward with a new one.
- The append only tables (`movement_groups`, `stock_movements`, `movement_serials`, `stock_receipt_lines`, `cost_records`, `order_events`, `customer_merges`, `credit_entries`, `settlement_statements`, `settlement_lines`, `settlement_line_matches`, `settlement_period_events`, `order_cost_rules`) have their triggers and the app role revoke in `0002_baseline_rules.sql`. A correction is a new row.
- Settlement periods: `status` follows the latest `settlement_period_events` row. Insert an event and the trigger sets `status`; a write of `status` that disagrees with the latest event is refused. A period's account never changes, a closed period's dates never change (`PeriodClosed`), and no role deletes or truncates a period. A settlement account's owner never changes (`SettlementOwnerFixed`); archive it and open another.
- Match rows form one chain per line: the first row supersedes nothing, each later row supersedes the current head of its own line, and an `accounted` row is never superseded. A statement supersedes only a statement of its own account (composite key).
- Credit entries: every entry carries `request_hash`. Entries that share an `idempotency_key` share posting, customer, and hash. A reversal mirrors its original's customer, kind, funding, order, line, quantity, exchange, refund, payout method, and negated amount. The app role cannot delete tasks (`tasks` has DELETE and TRUNCATE revoked; cancel instead).
- The operating day is stamped by the `ssd_stamp_operating_day` trigger from `movement_groups.effective_at`, `stock_movements.effective_at`, `orders.placed_at`, `order_events.occurred_at`, `credit_entries.effective_at`, and `tasks.created_at`. Writers never pass `operating_day`. `orders` and `tasks` are updatable, so `orders_operating_day_follows_placed_at` and `tasks_operating_day_follows_created_at` refuse a change of the day unless `placed_at` or `created_at` changes in the same update (the guard runs before the stamp, by trigger name). The seeds are the store `MAIN` and the channel `manual` (default store `MAIN`), both in `0002_baseline_rules.sql`.
- `migrate` seeds one `not_set` row per `order_cost_rules` kind, from the operating day, after the `install` row (`seedOrderCostRules` in `src/migrate.ts`). It adds only a kind that has no row yet, so a rerun adds nothing and a rule someone set is never touched. The seed writes no value.
- A new table must be added to `src/table-ownership.ts` under its owning module, or `table-ownership.spec.ts` fails. The api's module wall (`apps/api/src/module-boundary.spec.ts`) reads the same map.
- Each migration runs in a transaction. Anything that cannot (`CREATE INDEX CONCURRENTLY`) goes in its own small migration that is safe to run twice.
- Expand and contract: add the new column, move data in SQL, drop the old one at least one minor release later.
- Extensions keep their own tables in their own schema and never migrate core tables.
- Migrations create the app role (`APP_DB_ROLE`, default `ssdashboard_app`) and a schema owned by it, so the owner (`MIGRATION_DATABASE_URL`) must be a superuser, or on a managed database hold `CREATEROLE` and membership in that role. `migrate` stores `ssd.tenant_id` and `ssd.app_role` on the database on its first run (`ALTER DATABASE ... SET`, which only reaches new sessions) and writes the `install` row; a later run with a different `TENANT_ID` throws `TenantMismatch` (a tenant left in the setting by an interrupted first run counts), a different `APP_DB_ROLE` throws `AppRoleMismatch`, and a superuser, `CREATEROLE`, `BYPASSRLS`, or owner role is refused (`UnsafeAppRole`) on every run; a rerun without them uses the stored values. The e2e suites create scratch databases with that owner URL.
- A database migrated by the pre baseline history (nine files) cannot take the baseline: drop the dev volume and rerun `pnpm bootstrap` (it checks and says so).
- `uuidv7()` (the default for every `id`) needs PostgreSQL 18.

## Agent skills

- [drizzle-orm-patterns](../../.claude/skills/drizzle-orm-patterns/): `giuseppe-trisciuoglio/developer-kit`, schema and migrations
- [postgresql-table-design](../../.claude/skills/postgresql-table-design/): `wshobson/agents`, types, indexes, constraints

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
