# 0002 child: tenancy, the migration baseline, the operating day, and the model's guards

Part of the [2026-11-05 amendment of spec 0002](index.md#amendment-2026-11-05). Satisfies **AC-15**, **AC-16**, **AC-17**, **AC-33**, **AC-34**. Governing decisions: [spec 0007](../0007-stack-architecture-operations-layer/index.md) sections 7, 10, 11 and *Database roles and the append only ledgers*.

## Summary

Every table gets a `tenant_id` the database fills in by itself, so no writer can forget it. The nine migrations on main are replaced by one baseline, because no install runs them yet. One SQL function turns any instant into the brand's Cairo operating day, and triggers stamp it on every row that reports read. A fixed list of tables can only grow (the app role may insert and read, never change or delete), and a map of which module owns which table makes the module walls testable.

## Tenant id (A1)

- **Column**: every table the app owns has `tenant_id uuid not null default current_setting('ssd.tenant_id')::uuid` (a Drizzle helper `tenantId()` in `packages/db/src/schema/columns.ts`, next to `id()`). That covers the Better Auth tables too: Better Auth inserts without the column and the default fills it. Excluded: the `pgboss` and `drizzle` schemas, which belong to their tools.
- **Missing setting fails loudly**: `current_setting('ssd.tenant_id')` without `missing_ok` raises "unrecognized configuration parameter", so an insert in a session where the setting is absent fails instead of writing a null or a wrong id.
- **The `install` table** (platform module): exactly one row. `id uuid primary key` (equal to the tenant id), `client_code text not null` (the slug used in role and stack names), `name text not null`, `created_at`. A unique index on `((true))` keeps it to one row, and a check `id = current_setting('ssd.tenant_id')::uuid` ties it to the database setting. It has no `tenant_id` column of its own (its `id` is the tenant id); the schema test lists it as the one named exception.
- **Unique keys**: every unique constraint on a business key leads with `tenant_id`, primary keys made of business columns included (`settings (tenant_id, key)`, `document_counters (tenant_id, doc_type, year)`, `location_owner_policies (tenant_id, owner_type)`) (for example `(tenant_id, sku)`, `(tenant_id, store_id, order_number)`, `(tenant_id, phone_e164)`). Primary keys stay the single `uuid` column, and foreign keys point at those, so no foreign key carries a tenant column (spec 0007 section 7).
- **No row level security now**: one database holds one tenant. A shared install later adds policies on the existing column (a migration, not a rewrite).
- **Indexes**: non unique indexes do not lead with `tenant_id`; with one tenant per database it is a constant column and would only widen them. The shared install migration adds it where policies need it.
- **The schema test** (`packages/db/test/tenant.e2e-spec.ts`): reads `information_schema.columns` for every base table outside `pgboss`, `drizzle`, and `pg_catalog`/`information_schema`, and fails unless each (except `install`) has `tenant_id` of type `uuid`, `is_nullable = 'NO'`, and a default whose text is `(current_setting('ssd.tenant_id'::text))::uuid`. It also fails when a primary key, unique constraint, or unique index that contains any column not of type `uuid` (a business key such as a code, a number, a phone, or a date) does not include `tenant_id`. Keys made only of `uuid` columns are exempt, because a uuid is unique on its own (for example `movement_serials (movement_id, serial_id)`). Planted failures: a scratch table without the column, and one with a unique key missing it, both make the test fail (written as test cases, not left in the schema).

## Migration baseline and the app role name (A2)

- **One baseline.** Igris confirmed for spec 0007 open question 1 that no install runs the current migrations (no client extension, no client env; the pilot starts after slice 1a). So the feature 4 build deletes `packages/db/migrations/0000` to `0008` and their `meta` snapshots and generates one `0000_baseline.sql` from the amended Drizzle schema, with the hand written part after it (extensions, functions, triggers, grants, seeds). The pg-boss schema stays a separate step of `migrate`, as today. The reset is recorded in a new ADR, `docs/adr/0003-reset-migrations-to-one-baseline.md`, listed in `docs/adr/README.md` and linked from `packages/db/README.md`.
- **After the baseline, the old rules return**: migrations only move forward, follow expand and contract, and are never edited once shipped (`packages/db/AGENTS.md`). The baseline itself counts as shipped the moment the pilot brand's first import runs.
- **Developers recreate their database once**: the dev volume from `deploy/compose.dev.yaml` is dropped and `pnpm bootstrap` rerun. The build adds this step to the ADR and to the bootstrap README; `pnpm bootstrap` detects a database migrated by the old history (a `__drizzle_migrations` row whose hash matches no file) and stops with that instruction instead of failing halfway.
- **Extensions in the baseline**: `pg_trgm`, `unaccent` (kept), and `btree_gist` (new, for the settlement period overlap constraint; it ships in PostgreSQL's contrib set, which the official `postgres` image includes).
- **The app role name comes from a database setting.** Roles are global to a PostgreSQL server, and spec 0007 gives each client `ssd_<client>_app`. The baseline therefore grants through `DO` blocks that read `current_setting('ssd.app_role', true)`, falling back to `ssdashboard_app` when unset (dev, tests, a self host with the old name). The same name receives the default privileges and every append only `REVOKE`. Feature 26 sets per client names in the host bootstrap; this feature only makes the migration name agnostic. `APP_ROLE` in `packages/db/src/index.ts` becomes the fallback constant, and the e2e helpers keep using it.
- **What `migrate` does on a first run, in order**, inside its advisory lock: (1) if the `install` row is missing, take the tenant id from `TENANT_ID` (or generate a `uuidv7()` when it is unset, which dev and tests rely on; provisioning, feature 47, always passes one), run `ALTER DATABASE <current> SET ssd.tenant_id = '<uuid>'` and `ALTER DATABASE <current> SET ssd.app_role = '<APP_DB_ROLE>'`, and `SELECT set_config(...)` for both in its own session (an `ALTER DATABASE` setting only reaches new sessions); (2) apply the migrations; (3) insert the `install` row. On later runs it reads the tenant id from the `install` row and never from `TENANT_ID`, and refuses to start if `TENANT_ID` is set and differs (`TenantMismatch`).
- **Restores** (spec 0007, carried m1): a plain `pg_dump` leaves out `ALTER DATABASE` settings, so feature 27 restores with `--create` or reapplies both settings from the `install` row.

### Migration plan

**Strategy**: big bang, once, before any install exists (no live data to move).
**Phases**:
1. Amend the Drizzle schema files and generate the single baseline; delete the old migrations and snapshots; write the ADR.
2. Recreate dev databases (`pnpm bootstrap` after dropping the volume); CI starts from an empty Postgres service, so it needs no step.
**Rollback**: revert the commit; the old migrations come back and the dev database is recreated again.
**Risks**: a developer keeps an old dev database (the bootstrap check stops it); a seed or test helper relied on a migration file name (`packages/db/test/migrate.e2e-spec.ts` is updated in the same milestone); a later feature starts a migration before the baseline lands (feature 4 is the first wave 4 build, so nothing else migrates before it).

## The operating day (A3)

- **One function**, platform module, in the baseline: `ssd_operating_day(at timestamptz) RETURNS date`, `STABLE`, `LANGUAGE sql`: `((at AT TIME ZONE tz) - make_interval(hours => cutoff))::date`, where `tz` is setting `timezone` (default `Africa/Cairo`) and `cutoff` is setting `operating_day_cutoff_hour` (integer 0 to 23, default 0, reserved by spec 0007 section 10; feature 9 owns its screen). Both are read from the `settings` table inside the function, so changing the zone changes new rows only.
- **Stored, stamped by trigger.** Because the function reads settings it cannot be `IMMUTABLE`, so it cannot back a generated column or an expression index. Instead every table with an operating day stores `operating_day date not null` and has a `BEFORE INSERT OR UPDATE OF <source column>` trigger, `ssd_stamp_operating_day()`, which takes the source column name as its trigger argument and sets `NEW.operating_day := ssd_operating_day(NEW.<source>)`. Writers never pass the column. A stored day is never recomputed when the zone setting changes later (history is not restated).
- **Where it is stamped** (source column in brackets): `orders` (`placed_at`), `order_events` (`occurred_at`), `tasks` (`created_at`), `credit_entries` (`effective_at`), `movement_groups` and `stock_movements` (`effective_at`), `settlement_lines` (none: carrier and partner statements already give a date, stored as `occurred_on date`). Each stamped column has a btree index, alone or as the lead of a report index (see each child).
- **No code adds 24 hours.** Day ranges in reports compare `operating_day` values; instants are converted only by this function.
- **The test** (`packages/db/test/operating-day.e2e-spec.ts`): finds the actual Cairo offset changes of the current calendar year by stepping hourly through the year with `AT TIME ZONE 'Africa/Cairo'` and noting where the UTC offset changes (from the time zone data in the PostgreSQL under test, never a hard coded date), then asserts the operating day one second before, at, and one second after each change, plus local 23:59:59 and 00:00:00 on an ordinary day, and the cutoff hour at 2 moving a 01:30 order to the previous day. If the year has no change (Egypt has dropped daylight saving before), the test still passes on the ordinary day cases and prints that no change was found. Refreshing time zone data is a release step (spec 0007, carried m7; feature 26 owns the runbook).

## Append only tables (A4)

For each table below the baseline revokes `UPDATE`, `DELETE`, and `TRUNCATE` from the app role, and a row trigger (`BEFORE UPDATE OR DELETE`) plus a statement trigger (`BEFORE TRUNCATE`) call one function, `ssd_reject_change()` (the existing `ledger_reject_change` renamed, same message "append only"), as the second guard. A correction is always a new row that points at the one it corrects.

| Table | Module | Built by | Corrected by |
|---|---|---|---|
| `movement_groups`, `stock_movements`, `movement_serials` | inventory | built (spec 0002) | a reversal group |
| `stock_receipt_lines` | inventory | built (spec 0006) | voiding the receipt |
| `order_events` | orders | this feature | a later event |
| `credit_entries` | credit | this feature | a reversal entry (`reverses_entry_id`) |
| `customer_merges` | customers | this feature | an undo row (`undoes_merge_id`) |
| `settlement_statements`, `settlement_lines` | settlement | this feature | a superseding statement, an adjustment line |
| `settlement_line_matches`, `settlement_period_events` | settlement | this feature | a later match or event row |
| `cost_records` | catalog | this feature | a newer record (later `recorded_at`) |
| `order_cost_rules` | platform | this feature | a newer rule row |
| `audit_entries` | audit | feature 10 (detail there) | never corrected |
| `export_runs`, except its status columns | exports | feature 45 (detail there) | `superseded by` another run |

`stock_receipts` keeps its spec 0006 rule (no `DELETE`, status columns updated on void). `export_runs` is the one partial case: feature 45 grants `UPDATE` on its status columns only (column privileges) and its trigger rejects a change to any other column. The schema test in `packages/db/test/schema.e2e-spec.ts` gains one case per table above: as the app role an `UPDATE`, `DELETE`, and `TRUNCATE` fail with permission denied; as the owner they fail with "append only".

## Module ownership of tables (A5)

`packages/db/src/schema/` gets one file per owning module (the file name is the module name), and `packages/db/src/table-ownership.ts` exports a map from every table name to its module. A unit test (`packages/db/src/table-ownership.spec.ts`) fails when a table defined in the schema is missing from the map. A boundary test in the api (`apps/api/src/module-boundary.spec.ts`, generalizing `apps/api/src/inventory/module-boundary.spec.ts`, which it replaces) fails when a file under `apps/api/src/<module>/` names the Drizzle export or the SQL name of a table owned by another module, or when an extension names any core table. Foreign keys between modules' tables are allowed (they are constraints, not reads). Cross module data goes through an exported service or a past tense domain event.

| Module | Tables | Built by |
|---|---|---|
| platform | `install`, `settings`, `document_counters`, `custom_field_definitions`, `order_cost_rules` | this feature; module toggles and license tables: feature 9 |
| audit | `audit_entries` | feature 10 |
| identity (today `auth` and `staff`) | `users`, `sessions`, `accounts`, `verifications`, `rate_limits`, `sign_in_attempts`, `two_factors` | built (spec 0005); hats: feature 8 |
| catalog | `uoms`, `products`, `product_options`, `product_variants`, `variant_uom_conversions`, `barcodes`, `seasons`, `product_groups`, `cost_records` | this feature |
| inventory | `locations`, `bins`, `location_owner_policies`, `lots`, `serials`, `movement_groups`, `stock_movements`, `movement_serials`, `stock_levels`, `reservations`, `stock_level_discrepancies`, `stock_receipts`, `stock_receipt_lines` | this feature (amended) |
| customers | `customers`, `customer_phones`, `customer_external_ids`, `customer_merges` | this feature |
| orders | `orders`, `order_lines`, `order_events`; `shipments` | this feature; `shipments`: feature 19 |
| tasks | `tasks` | this feature |
| credit | `credit_entries`; `refunds` | this feature; `refunds`: feature 35 |
| settlement | `settlement_accounts`, `settlement_periods`, `settlement_period_events`, `settlement_statements`, `settlement_lines`, `settlement_line_matches` | this feature |
| channels | `stores`, `channels`; `channel_codes` | this feature; `channel_codes`: feature 40 |
| connectors | `connections`, `outbound_commands`; `inbound_events`, `connection_external_ids` | this feature (key columns); the rest: feature 13 |
| partners | `parties` | this feature (reshaped) |
| exchanges | `exchanges` | feature 34 |
| exports | `export_runs` | feature 45 |

The `auth` and `staff` folders keep their names until feature 8 merges them into `identity`; the map lists their tables under `identity`, and the boundary test treats `auth` and `staff` as one module until then.

## Projections and domain events (A6, decided here, built by the first feature that needs it)

A few columns are projections of another module's facts: `orders.write_back_state` (from connector commands), `orders.returned_credit_amount` and `orders.exchange_consumed_amount` (from credit entries), `orders.cash_state` amounts (from settlement matches). A module never reads another's tables to fill them. The publisher emits a past tense domain event (for example `OutboundCommandFailed`, `CreditEntryPosted`, `SettlementLineMatched`) through a platform `DomainEvents` service that calls each in process handler **with the publisher's transaction**, so the projection commits or rolls back with its source and never lags it. Work that leaves the process (a task for a person, a write back, a message) is a pg-boss job enqueued in the same transaction. Feature 16 builds `DomainEvents` when it writes the first projection; this feature builds the columns and documents the rule in the platform README.

## Value sourcing

| Action | Value | Source |
|---|---|---|
| any insert | `tenant_id` | column default, `current_setting('ssd.tenant_id')::uuid` |
| first `migrate` | tenant id | env `TENANT_ID`, else a generated `uuidv7()` |
| later `migrate` | tenant id | the `install` row; `TENANT_ID` only checked against it |
| first `migrate` | app role name | env `APP_DB_ROLE`, default `ssdashboard_app` |
| baseline grants | grantee | database setting `ssd.app_role`, fallback `ssdashboard_app` |
| any stamped insert or source update | `operating_day` | trigger: `ssd_operating_day(<source column>)` |
| `ssd_operating_day` | zone, cutoff | settings `timezone` (default `Africa/Cairo`), `operating_day_cutoff_hour` (default 0) |
| append only check | which tables | the table in A4 above |
| boundary test | table owner | `packages/db/src/table-ownership.ts` |

## Configuration

- `TENANT_ID`: read by `migrate` only on the first run (spec 0007, already proposed there). Optional in dev and tests.
- `APP_DB_ROLE`: the app role's name, read by `migrate` only, default `ssdashboard_app`. Feature 26 sets `ssd_<client>_app` per client. Added to `apps/api/src/config/env.ts` (migrate only), `.env.example`, and the `migrate` service's explicit env list in Compose.

## Critical test scenarios

- Tenant default: insert into `orders` without `tenant_id` → the install's id; in a session with the setting reset (`RESET ssd.tenant_id` after `SET`), the insert fails, verifies **AC-15**.
- Schema test: passes on the baseline; fails on a planted table without the column and on a unique key without `tenant_id`, verifies **AC-15**.
- Baseline: an empty database reaches the full model in one migration; a second `migrate` changes nothing; a `TENANT_ID` different from the install row stops `migrate` with `TenantMismatch`; every pre existing ledger, receipt, and sign in suite passes unchanged, verifies **AC-16**.
- Operating day: the transition, midnight, and cutoff cases above, verifies **AC-17**.
- Append only: the three statements per listed table, as the app role and as the owner, verifies **AC-33**.
- Ownership: a planted import of `schema.orders` inside `apps/api/src/customers/` fails the boundary test; a table missing from the map fails its unit test, verifies **AC-34**.
