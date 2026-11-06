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
