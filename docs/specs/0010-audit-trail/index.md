# 0010. Audit trail: one append only log of who did what, when, and why, written in the same transaction as the change

**Date**: 2026-11-05
**Status**: In Progress
**Depends on**: the feature 4 baseline ([spec 0002 amendment](../0002-core-data-model/index.md#amendment-2026-11-05), [tenancy child](../0002-core-data-model/0002-tenancy-platform.md): `tenant_id`, `ssd_reject_change()`, `ssd_stamp_operating_day()`, the append only list, the table ownership map). Milestone 1 starts only after that baseline migration has landed. Hats (spec 0008, written in parallel) and settings (spec 0009) are consumers of this shape, not prerequisites.

## Summary

Every edit, merge, override, confirmation, export, and automatic action writes one row into a table the application can only add to. The row says who acted (a person, a partner user, a scheduled job, a carrier, an import, or a customer using a link), when, which record, what changed (before and after), and why when a reason is required. The row is written in the same database transaction as the change, so there is never a change without its entry or an entry without its change. Managers filter the log by person, record, action, and day. Customer phones, names, and addresses are never stored in it (Law 151): the entry says that an address changed, not what it was. An automatic action can be undone in one step: the audit module finds the module that owns the action and asks it to reverse its own change; the audit module never edits another module's data.

## Requirements

**User stories**:
- As a manager, I want to see who changed an order, merged a customer, overrode a rule, or revoked a confirmation, with the reason, so that I can answer "who did this and why" without asking around.
- As a manager, I want to filter the log by person, by record, by action, and by day, so that I can follow one agent's day or one order's whole story.
- As a manager, I want to undo something the system did on its own in one step, so that a wrong automatic decision costs a minute, not an afternoon.
- As an owner, I want nobody, not even an admin through the app, to be able to edit or delete an entry, so that the log can be trusted in a dispute.
- As the brand's data controller, I want the log to hold no customer personal data, so that keeping it for years never conflicts with Law 151.

**Acceptance criteria** (the contract; each is checkable on its own):

- **AC-1** (entry shape): `audit_entries` holds one row per changed record with: `id`, `tenant_id`, `recorded_at` (the instant, `clock_timestamp()` so rows of one transaction keep their order), `operating_day` (stamped by trigger from `recorded_at`, never passed by the writer), `correlation_id`, the actor (AC-3), `action` (a code such as `stock_receipt.voided`), `record_type`, `record_id`, an optional short `record_label` (for example an order number or SKU code, supplied by the caller, never personal), `before` and `after` (JSON objects holding only the fields that changed), `personal_fields`, `reason`, and the undo fields (AC-14). Every business key rule of the tenancy child holds (`tenant_id` default and not null).
- **AC-2** (same transaction): `AuditService.record(tx, entry)` writes through the caller's transaction handle. When the change rolls back, the entry rolls back; when `record` throws, the change rolls back. A test forces a failure after `record` and finds neither the change nor the entry, and one before it and finds the same.
- **AC-3** (who can act): the actor is exactly one of six kinds, enforced by a table check so a wrong shape cannot be stored: `person` (a staff `users.id`, with the hat it acted under in `actor_hat`), `partner_user` (a partner `users.id` and the partner account id in `actor_ref`), `system_job` (the job name in `actor_ref` and the pg-boss job id in `job_id`), `carrier` (the connection code in `actor_ref`), `import` (the import run id in `actor_ref`), `portal_customer` (the customer id in `actor_ref`, acting through a signed link). `actor_user_id` is set exactly for `person` and `partner_user`, and is a foreign key to `users` (a person who acted can be disabled, never deleted).
- **AC-4** (before and after, without personal data): `before` and `after` hold only changed fields (a creation has no `before`, a removal no `after`). Fields the shared redaction list marks personal (`packages/config/src/redaction.ts`: `PERSONAL_DATA_KEYS`, `PERSONAL_DATA_PATHS`) are stored as `"[REDACTED]"` and their paths are listed in `personal_fields`, so the screen can say "address changed" without the address. A test edits an order's address and phone with sentinel values and proves the sentinel text appears in no column of `audit_entries`.
- **AC-5** (reason): each action in the registry (AC-10) says whether a reason is `required` or `optional`. A missing or blank reason on a required action throws the typed domain error `AuditReasonRequired`, which the api edge answers as 422 `REASON_REQUIRED`, and the change rolls back. A reason is trimmed, at most 500 characters, and phone shaped text in it is masked with `maskPhones`. The set of required reasons is in "Actions that require a reason" below.
- **AC-6** (one business action): entries written for one business action share one `correlation_id` (the caller passes the value it got from `AuditService.newCorrelationId()`, or an incoming job id). A merge writes one entry per customer record with the same id. The screen filters by it and shows "N entries in this action".
- **AC-7** (operating day): `operating_day` is stamped by `ssd_stamp_operating_day('recorded_at')`, so an entry at 00:30 Cairo time with a cutoff hour of 2 belongs to the previous day; the day is never recomputed when the time zone setting changes.
- **AC-8** (nothing edits or deletes): the app role has `INSERT` and `SELECT` on `audit_entries` and nothing else; `UPDATE`, `DELETE`, and `TRUNCATE` fail with permission denied. As the owner they fail with "append only" from the row trigger (`UPDATE`, `DELETE`) and the statement trigger (`TRUNCATE`). The guard test also plants a failure: it grants `UPDATE` to the app role in a scratch database and shows the trigger still rejects the change. The test fails the build if `audit_entries` is missing from the append only list.
- **AC-9** (module walls): only the `audit` module names `audit_entries`. Every other module records through the exported `AuditService`, and reads history through the exported `AuditQueryService`. The audit module reads no other module's table: record labels come from the caller, person names from the exported identity service. The boundary test of the tenancy child (A5) passes, and `audit_entries` is in `packages/db/src/table-ownership.ts` under `audit`.
- **AC-10** (registry): every action code is an entry in one registry in `packages/contracts/src/audit/audit-actions.ts` with: the code, the owning module, the record type, `reason` (`required` or `optional`), `automatic` (true when the system decides in place of a person), `undoable`, English and Arabic labels, and `proof` (the path of the test that shows the action writes its entry). `record` rejects an unknown code with `UnknownAuditAction`. A unit test fails when an entry lacks a field, a label in either language, or a proof file that exists and contains the code.
  > Amended 2026-11-06 (review AR10): the registry's label is a message key (`label`, for example `audit.actions.stockReceiptVoided`) into the English and Arabic catalogs of `packages/i18n`, never label text; the catalog parity test holds both languages. The registry test is `packages/contracts/test/audit.spec.ts`.
- **AC-11** (what is recorded): the registry and the build cover the actions named in "Actions" below. This feature wires the ones whose code exists today (void of a stock receipt, SKU archive and unarchive, location edit and archive, staff account create, disable, and enable); every later feature adds its own codes in the same change that builds the action, and its build task names this AC. Ledger rows (stock movements, credit entries, settlement lines, order events) stay their own history; an audit entry is added for voids, reversals, overrides, and every automatic action.
- **AC-12** (manager screen and api): `GET /api/audit/entries` filters by person (`actorUserId`), record (`recordType` and `recordId`), `action`, operating day range (`dayFrom`, `dayTo`, inclusive), and `correlationId`, newest first, with keyset paging (an opaque cursor over `recorded_at` and `id`, `limit` default 50, at most 200). It never uses offset paging and never counts all rows. The back office page `/audit` offers the same filters, a "load more" control, and a per entry detail with the field by field before and after.
  > Known property, 2026-11-06 (review AR14): the keyset runs on insert time (`recorded_at`), not commit time, so an entry of a long transaction that commits after a reader paged past its instant does not show on that reader's "load more"; a fresh list shows it. Accepted; paging inside one snapshot is the fix if it ever matters.
- **AC-13** (who may read): the list, the detail, the record history, and the export need the `audit.read` permission, given to the manager hat and nobody else by default (until hats land, to the existing `admin` role). Others get 403 `FORBIDDEN`. The controllers carry `@Audience('staff')`; partner and portal audiences have no audit route. Person names come from the identity service, not a join.
  > 2026-11-06: hats have landed (spec 0008): `audit.read`, `audit.undo` and `audit.export` are in the permission matrix on the manager hat only.
- **AC-14** (undo in one step): an entry of an action the registry marks `undoable` carries `undo_action` (the code of a handler registered by the owning module) and `undo_args` (ids and non personal values only; a value the redaction list marks personal is refused at write time). `POST /api/audit/entries/:id/undo` with a `reason` runs the owning module's handler inside one transaction, then writes a new entry (`<action>.undone`, `undoes_entry_id` set, a reason, never itself undoable). An entry is undone at most once (a unique index on `undoes_entry_id`): a second call answers 409 `ALREADY_UNDONE`. A handler that cannot restore (a later change got in the way) throws, and the call answers 409 `UNDO_NOT_POSSIBLE` with the handler's code, changing nothing. The audit module imports no owning module's table or service; it holds a registry of handlers that owners fill in.
- **AC-15** (export): `GET /api/audit/entries/export` streams the current filter as CSV (UTF 8 with a byte order mark so Arabic opens right in Excel), in keyset batches of 1,000, at most 200,000 rows a file (413 `EXPORT_TOO_LARGE` asks for a narrower range) and only with a day range of at most 366 days. It needs `audit.export` (the manager hat by default). Each export writes its own entry (`audit.exported`, the filter in `after`). The file carries no personal data because the table holds none.
- **AC-16** (personal data and retention): no code path deletes or rewrites an entry. Entries are kept for the life of the install; there is no age limit because they hold no personal data (**Assumed**, owner question 4). The module README states this and the one allowed way to remove old rows if a lawyer ever requires it: the owner role, in a reviewed migration, never the app.
- **AC-17** (scale): with 5,000,000 entries seeded (about four times three years of volume at 120 orders a day), a page of 50 entries answers under 150 ms at p95 for each filter alone (person, record, action, day range, correlation) and for the unfiltered list, and one `record` call costs under 10 ms at p95 (budgets **Assumed**, set from the first measured run like the spec 0007 budgets). The check runs in `apps/api/test/scale.e2e-spec.ts`.
  > Amended 2026-11-05: `apps/api/test/scale.e2e-spec.ts` runs only in the separate CI `scale` job (nightly and on a `scale` label), never in the default e2e job ([spec 0002](../0002-core-data-model/index.md) build plan milestone 5).
- **AC-18** (screens): the `/audit` page and the record history panel work in English and Arabic (no hard coded string, logical CSS only, action labels from the registry), by keyboard alone, to WCAG 2.2 AA, with one `<h1>`, a loading state, an empty state ("No entries match"), an error state with retry, and the diff readable by a screen reader (field name, then before, then after).
- **AC-19** (adding an action costs one row): a later feature adds an action by adding a registry entry, one `AuditService.record` call in its transaction, and its proof test. It needs no migration and no change to the audit module. Features 8 (hat grant and revoke) and 9 (setting changed) use exactly this.

## Decision

**Chosen option**: Option 1, an explicit `AuditService.record(tx, entry)` call inside the writer's transaction, into one append only table, with a registry of action codes and an undo handler registry that owners fill in.

Not domain events (past tense events handled in process, as spec 0002 A6 uses for projections), because an event that nobody handles writes nothing and the failure is silent; a direct call is checked by the module's own tests. The registry's `proof` test closes the other gap: an action cannot be listed without a test that shows its entry.

**Implementation skills**: `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `nestjs-best-practices` (`.claude/skills/nestjs-best-practices/`)

## Rationale

See [rationale.md](rationale.md): the context, the four options weighed (and why a log inside each module, a hash chain, and an event handler were not chosen), the personal data decision, and the references.

## Feature design

### Where it lives

`apps/api/src/audit/` (module `audit`, bundle `core`, always on) owns `audit_entries`, `AuditService`, `AuditQueryService`, `AuditUndoRegistry`, the controllers, and a README (Owns, Never touches, How to test, Governing spec, Decisions, plus a Retention section). Schema in `packages/db/src/schema/audit.ts`. Contracts in `packages/contracts/src/audit/`. Web in `apps/web/src/audit/` with the page at `/audit` under `(backoffice)`. No other module imports the audit table; they import `AuditService`.

### Data model

Table `audit_entries` (append only, tenancy child A4). Types follow PostgreSQL's guidance: `timestamptz` for instants, `text` plus `CHECK` for evolving code lists (not enums), `jsonb` for the diffs, uuid ids from `uuidv7()` so the id also orders by time.

```sql
CREATE TABLE audit_entries (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL DEFAULT current_setting('ssd.tenant_id')::uuid,
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  operating_day   date NOT NULL,                 -- BEFORE INSERT trigger ssd_stamp_operating_day('recorded_at')
  correlation_id  uuid NOT NULL,
  actor_kind      text NOT NULL,
  actor_user_id   uuid REFERENCES users (id),    -- person and partner_user only
  actor_ref       text,                          -- partner account id, job name, connection code, import run id, customer id
  job_id          uuid,                          -- pg-boss job id, system_job only
  actor_hat       text,                          -- hat that allowed the act, person only (Assumed: codes from spec 0008)
  action          text NOT NULL,                 -- registry code, 'module_noun.verb_past'
  record_type     text NOT NULL,
  record_id       uuid NOT NULL,
  record_label    text,
  before          jsonb,
  after           jsonb,
  personal_fields text[] NOT NULL DEFAULT '{}',
  reason          text,
  undo_action     text,
  undo_args       jsonb,
  undoes_entry_id uuid REFERENCES audit_entries (id),
  CONSTRAINT audit_actor_kind CHECK (actor_kind IN
    ('person','partner_user','system_job','carrier','import','portal_customer')),
  CONSTRAINT audit_actor_shape CHECK (CASE actor_kind
    WHEN 'person'          THEN actor_user_id IS NOT NULL AND actor_ref IS NULL     AND job_id IS NULL
    WHEN 'partner_user'    THEN actor_user_id IS NOT NULL AND actor_ref IS NOT NULL AND job_id IS NULL AND actor_hat IS NULL
    WHEN 'system_job'      THEN actor_user_id IS NULL     AND actor_ref IS NOT NULL AND actor_hat IS NULL
    ELSE                        actor_user_id IS NULL     AND actor_ref IS NOT NULL AND job_id IS NULL AND actor_hat IS NULL
  END),
  CONSTRAINT audit_action_format CHECK (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT audit_reason_length CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT audit_json_objects CHECK
    ((before IS NULL OR jsonb_typeof(before) = 'object') AND (after IS NULL OR jsonb_typeof(after) = 'object')),
  CONSTRAINT audit_undo_pair CHECK ((undo_action IS NULL) = (undo_args IS NULL)),
  CONSTRAINT audit_undo_entry_not_undoable CHECK (undoes_entry_id IS NULL OR undo_action IS NULL)
);
```

Indexes (the only access paths: the screen's filters, the keyset order, and the correlation link; the foreign key on `actor_user_id` is covered by the person index):

| Index | Serves |
|---|---|
| btree (`recorded_at` desc, `id` desc) | the unfiltered list, keyset paging, the export |
| btree (`actor_user_id`, `recorded_at` desc, `id` desc) where `actor_user_id` is not null | "what did this person do" |
| btree (`record_type`, `record_id`, `recorded_at` desc, `id` desc) | "the whole story of this record" and the history panel |
| btree (`action`, `recorded_at` desc, `id` desc) | filter by action |
| btree (`correlation_id`) | "the rest of this action" |
| unique (`undoes_entry_id`) where not null | an entry is undone at most once |
| BRIN (`operating_day`) | day range filters; rows arrive in time order, so the index stays a few pages even at millions of rows |

The unique index on `undoes_entry_id` holds only a uuid column, so the tenancy schema test exempts it. **Partitioning is not used now**: at the 5,000,000 row test size the table is about 2 GB with its indexes and the budgets hold on plain tables; the PostgreSQL guidance in the project's `postgresql-table-design` skill starts at about 100 million rows. The revisit trigger is 50,000,000 rows or a p95 over budget, and the move would be monthly range partitions on `recorded_at` (the primary key would then include `recorded_at`, a migration of its own). If the BRIN index does not hold the day filter budget in the scale test, it is replaced by a btree on (`operating_day`, `recorded_at` desc, `id` desc), a one line change.

Grants and guards (hand written part of the migration, after the generated statements): `REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM` the app role (read from `ssd.app_role`, per the tenancy child), a `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE` statement trigger calling `ssd_reject_change()`, and the `ssd_stamp_operating_day('recorded_at')` trigger. This spec adds `audit_entries` to the stamped list of tenancy A3.

### Who acts, and how a module writes

```ts
// packages/contracts/src/audit/audit-actor.ts (Zod, one schema per shape)
type AuditActor =
  | { kind: 'person'; userId: string; hat: string }
  | { kind: 'partner_user'; userId: string; partnerAccountId: string }
  | { kind: 'system_job'; name: string; jobId: string }
  | { kind: 'carrier'; connectionCode: string }
  | { kind: 'import'; runId: string }
  | { kind: 'portal_customer'; customerId: string };

// apps/api/src/audit/audit.service.ts (exported)
interface AuditEntryInput {
  actor: AuditActor;
  action: AuditActionCode;                  // must be in the registry
  record: { type: string; id: string; label?: string };
  before?: Record<string, unknown>;         // changed fields only
  after?: Record<string, unknown>;
  reason?: string;
  correlationId: string;
  undo?: { action: string; args: Record<string, unknown> };
}
AuditService.record(tx: Transaction, entry: AuditEntryInput): Promise<void>;
AuditService.recordMany(tx: Transaction, entries: AuditEntryInput[]): Promise<void>; // one multi row insert
AuditService.newCorrelationId(): string;
```

`record` does, in this order: check the code is in the registry; check the reason policy; compute `personal_fields` and mask personal values in `before` and `after` with the shared redaction list; refuse personal data in `undo_args` and `record_label` (the redacted copy must equal the input, else `AuditPersonalDataRefused`, a programming error caught in tests); mask phones in `reason`; insert through `tx`. It never opens its own transaction, never swallows an error, and never reads another module's table. Controllers build the actor from the session (`@Audience('staff')` gives a person, `partner` a partner user); workers build `system_job` from the pg-boss job; connector code builds `carrier` and `import`; the portal controller builds `portal_customer` from the verified link.

`AuditQueryService` is the only reader: `list(filter, cursor, limit)`, `get(id)`, and `forRecord(type, id, cursor, limit)` for the history panel other screens embed. It needs the caller to hold `audit.read`.

### Actions

The registry starts with these. "Reason" is `required` (R) or `optional` (o). "Auto" is an automatic action, always undoable unless stated. "Built by" is the feature whose build task adds the code (each names AC-11); features 13, 14, 16, 23, 34, 45 are the numbers in specs 0002 and 0007.

| Code | Record type | Reason | Auto | Undo | Built by |
|---|---|---|---|---|---|
| `stock_receipt.voided` | `stock_receipt` | R | no | no (a void is final; the receipt is re entered) | this feature |
| `sku.archived`, `sku.unarchived`, `sku.code_changed` | `sku` | o | no | no | this feature |
| `location.edited`, `location.archived`, `location.unarchived` | `location` | o | no | no | this feature |
| `staff_user.created`, `staff_user.disabled`, `staff_user.enabled`, `staff_user.password_reset` | `user` | o | no | no | this feature |
| `order.edited` (address, variant, added line) | `order` | o | no | no | orders (0002 orders, edit rule) |
| `order.partial_delivery_split` | `order` | o | no | no | orders (0002 orders, split rule) |
| `order.cancelled_override`, any state override that skips the normal rule | `order` | R | no | no | orders |
| `task.assigned`, `task.rescheduled`, `task.closed`, `task.reopened` | `task` | o | no | no | tasks (0002 customers, credit, tasks) |
| `customer.merged` | `customer` | o | no (suggested merges applied by a person) | yes | feature 14 |
| `customer.unmerged` | `customer` | R | no | no | feature 14 |
| `customer.merge_suggested_applied` | `customer` | o | yes | yes | feature 14 |
| `policy.changed` (a `location_owner_policies` or similar policy row) | `policy` | R | no | no | feature 4 follow up, settings screen (feature 9) |
| `setting.changed` | `setting` | o; R when the key is sensitive (time zone, cutoff hour, cost rules) | no | no | feature 9 |
| `hat.granted`, `hat.revoked` | `user` | o; R for `hat.revoked` of the manager hat | no | no | feature 8 |
| `confirmation.confirmed` | `confirmation` | o | no | no | period close (spec 0007 section 3) |
| `confirmation.confirmed_automatic` | `confirmation` | not applicable (system) | yes | yes | spec 0007 section 3 |
| `confirmation.revoked`, `settlement.revoked` | `confirmation` or `settlement_period` | R | no | no | period close, settlement |
| `import.forced_into_confirmed_range` | `confirmation` | R (the admin's written reason, positioning 6.13) | no | no | connectors, period close |
| `mapping.edited` | `channel_code` | o | no | yes (positioning 6.12) | channels |
| `mapping.auto_mapped` | `channel_code` | not applicable (system) | yes | yes | channels |
| `exchange.auto_approved` | `exchange` | not applicable (system) | yes | yes | feature 34 |
| `exchange.requested` | `exchange` | o | no (actor `portal_customer`) | no | feature 34 |
| `export.generated` | `export_run` | o | no | no | feature 45 |
| `export.marked_imported` | `export_run` | o | no | no | feature 45 (spec 0007 section 4) |
| `export.superseded` | `export_run` | R | no | no | feature 45 |
| `credit.reversed`, `stock.adjusted_manually` | `credit_entry`, `stock_movement_group` | R | no | no | credit, inventory |
| `audit.exported`, `<action>.undone` | `audit_entry` | R for undone | no | no | this feature |

A reason is required in two situations: the action overrides a rule or reverses something (voids, reversals, revokes, unmerge, supersede, forced import, manual stock adjustment, a sensitive setting), or the system must be told why it was wrong (every undo). An automatic action has no reason (a system has none); the entry records the rule that fired in `after` (for example `{"rule":"exact_match"}`) and its evidence ids. A feature may tighten (`reasonRequired: true` on one call) but never loosen the registry.

**What an "automatic action" is.** A decision the system makes in place of a person: confirming a day, mapping a code, approving an exchange, applying a suggested merge, closing a task. A carrier status feed (a Bosta update moving an order to `delivered`) is not one: it is already in `order_events` with its actor and in the connector inbox, and a row per update would bury the log (about six a day per order). The entry for "who did it" exists there. **Assumed**, owner question 2.

### Undo

"Snapshot" means three things the entry already holds: the changed fields in `before`, the evidence in `after`, and `undo_args`. A snapshot never contains personal data; when an undo needs more than ids (for example the repointed customer ids of a merge), the owning module keeps that in its own table (`customer_merges.repointed_ids` already does) and `undo_args` points at it.

```ts
// owner side, registered at module start
AuditUndoRegistry.register('customers.merge_undo', {
  undo(tx: Transaction, ctx: { entry: AuditEntryView; actor: AuditActor; reason: string }):
    Promise<{ record: { type: string; id: string; label?: string }; before?: object; after?: object }>;
});
```

`AuditUndoService.undo(entryId, actor, reason)`: opens one transaction; takes `pg_advisory_xact_lock` keyed on the entry id; loads the entry and refuses with `AlreadyUndone` if a row has `undoes_entry_id = entryId`, with `NotUndoable` if `undo_action` is null; calls the registered handler (the owner mutates only its own tables, and may throw `UndoNotPossible(code)`); writes the `<action>.undone` entry from the handler's returned record, before, and after; commits. The audit module changes nothing outside its own table. The handler is the owner's existing service method (for merges, the undo of feature 14 with its `MergeNotLatest` rule), so there is one code path for "undo a merge" whether a person clicks it on the customer screen or on the audit screen. A handler left unregistered for an `undoable` code fails the registry unit test.

### State

None for an entry (immutable). Derived "undone" is `EXISTS (undoes_entry_id = id)`, read for the visible page in one extra query on `undoes_entry_id = ANY(:ids)`.

### API surface

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/audit/entries` | GET | `actorUserId?`, `recordType?`, `recordId?`, `action?`, `dayFrom?`, `dayTo?`, `correlationId?`, `cursor?`, `limit?` (1 to 200, default 50) | `items[]` (entry view with `actorName`, `undone`, `canUndo`), `nextCursor` or null | staff, `audit.read` | 400 `INVALID_FILTER`, 400 `INVALID_CURSOR`, 403 |
| `/api/audit/entries/:id` | GET | id | one entry view with the field diff | staff, `audit.read` | 404 `ENTRY_NOT_FOUND`, 403 |
| `/api/audit/entries/:id/undo` | POST | `reason` (1 to 500) | the new `.undone` entry | staff, `audit.undo` | 404, 409 `ALREADY_UNDONE`, 409 `UNDO_NOT_POSSIBLE` (with `code`), 409 `NOT_UNDOABLE`, 422 `REASON_REQUIRED`, 422 `REASON_TOO_LONG` |
| `/api/audit/entries/export` | GET | the list filters but `dayFrom` and `dayTo` required, range at most 366 days | `text/csv` stream | staff, `audit.export` | 400, 413 `EXPORT_TOO_LARGE`, 403 |

> Amended 2026-11-06 (review AR7): `AuditService.record` throws `AuditReasonTooLong` for a reason over 500 characters after trimming, answered 422 `REASON_TOO_LONG` by `auditHttpError`. A route whose contract already caps its reason (the receipt void, 400 `INVALID_INPUT`) never reaches it.

All shapes are Zod schemas in `packages/contracts/src/audit/`; the api validates with them and the web parses each answer with them. The person filter's picker uses the identity module's existing staff list. Errors are NestJS exceptions with these stable codes; domain code throws `AuditReasonRequired`, `UnknownAuditAction`, `AuditPersonalDataRefused`, `AlreadyUndone`, `NotUndoable`, `UndoNotPossible`, mapped at the edge.

### Value sourcing

| Action | Value produced or displayed | Source |
|---|---|---|
| any `record` | `tenant_id` | column default, `current_setting('ssd.tenant_id')` |
| any `record` | `recorded_at` | column default `clock_timestamp()` |
| any `record` | `operating_day` | trigger `ssd_stamp_operating_day('recorded_at')` (settings `timezone`, `operating_day_cutoff_hour`) |
| any `record` | `actor_*`, `actor_hat` | the session (person, partner user), the pg-boss job (system job), the connection (carrier), the import run, the verified link (portal customer); built by the caller, checked by the table |
| any `record` | `correlation_id` | `AuditService.newCorrelationId()` once per business action and passed along; a worker may use its job id |
| any `record` | `action`, reason policy, labels | the registry (`audit-actions.ts`) |
| any `record` | `record_label` | supplied by the owning module (order number, SKU code); null for customers |
| any `record` | `before`, `after` | the owning module's own diff of its row; masked by the audit module |
| any `record` | `personal_fields` | derived: paths where the redacted copy differs from the input |
| any `record` | `reason` | the person's text, trimmed and phone masked; absent for a system actor |
| an undoable action | `undo_action`, `undo_args` | the owning module, naming its registered handler |
| list and detail | `actorName` | the exported identity service (`namesByIds`), by `actor_user_id`; a system actor shows its `actor_ref` |
| list and detail | action label | the registry's English and Arabic labels, by the viewer's language (spec 0004) |
| list and detail | times shown | `recorded_at` in the install's `timezone` setting; day from `operating_day` |
| list | `undone`, `canUndo` | `undoes_entry_id` rows of the page; registry `undoable` and the viewer's `audit.undo` |
| list | cursor | the last row's `recorded_at` and `id`, base64url encoded, read back as the keyset bound |
| export | file name | `audit-<dayFrom>-<dayTo>.csv` from the filter |

### Key invariants

- An entry exists if and only if its change committed (same transaction).
- No entry changes or disappears (privileges and triggers). A correction is a new entry that points back through `undoes_entry_id`.
- No personal field value is stored in any column (a test with sentinel values proves it).
- Only the audit module touches `audit_entries`; the audit module touches no other table.
- Every `undoable` action code has a registered handler and every registry entry has a proof test.

### Security model

Read, undo, and export are three permissions (`audit.read`, `audit.undo`, `audit.export`), by default the manager hat's, and until spec 0008 lands the `admin` role's (**Assumed**; the names are proposed here for spec 0008 to adopt). Staff who are not managers see no audit data, including the history of a record they can open, because a diff can carry costs and prices that staff must not see (spec 0006 AC-11) (owner question 6). Partners and portal customers have no route. The write path has no HTTP route at all: only server code calls `record`, so a client cannot forge an entry. A superuser or the owner role can still change the table; that is the limit of any in database log, and why the app never holds the owner password (AGENTS.md, two database roles). A hash chain that would detect owner tampering is deferred (rationale, Option 3).

### Configuration required

None. Limits (200,000 export rows, 366 days, 500 character reason) are constants in the module. Permissions come with spec 0008.

### Critical test scenarios

- Happy path: void a receipt as a manager, the entry appears on `/audit` with actor, the reason, the receipt number as label, and `before` `{status:"posted"}` and `after` `{status:"voided"}`, verifies **AC-1**, **AC-5**, **AC-12**.
- Failure case: throw after `record`, and throw before it; neither leaves a change or an entry, verifies **AC-2**.
- Failure case: void without a reason gives 422 `REASON_REQUIRED` and the receipt stays posted, verifies **AC-5**.
- Failure case: an actor row with `actor_kind = 'person'` and no user, or `system_job` with a user, is refused by the table, verifies **AC-3**.
- Privacy: edit an order address and phone using sentinel values; no column of `audit_entries` contains them; `personal_fields` lists them; a reason typed as `call 01012345678` is stored as `call [phone]`; `undo_args` with a phone key is refused, verifies **AC-4**, **AC-5**, **AC-16**.
- Correlation: a merge style action writes two entries with one id; the screen filter returns both, verifies **AC-6**.
- Operating day: an entry at 00:30 Cairo time with cutoff 2 has the previous day, verifies **AC-7**.
- Append only: as the app role `UPDATE`, `DELETE`, `TRUNCATE` fail with permission denied; as the owner they fail with "append only"; a planted `GRANT UPDATE` does not let an update through, verifies **AC-8**.
- Boundary: a planted import of the audit schema in another module fails the boundary test, verifies **AC-9**.
- Registry: an unknown code is refused; an entry without an Arabic label or proof file fails the unit test, verifies **AC-10**.
- Reading: filters one by one and combined; paging 120 entries with `limit` 50 gives 50, 50, 20, no duplicates or gaps while new entries arrive; a staff user without `audit.read` gets 403; a partner session gets 403 `WRONG_AUDIENCE`, verifies **AC-12**, **AC-13**.
- Undo: with a fixture handler, undo once succeeds in one call and writes `.undone`; a second call gives 409 `ALREADY_UNDONE`; a handler that throws leaves everything unchanged and gives 409 `UNDO_NOT_POSSIBLE`; two parallel undos produce one entry, verifies **AC-14**.
- Export: a 3 day range exports the same rows the screen shows, starts with the byte order mark, writes `audit.exported`; a 400 day range gets 400; over 200,000 rows gets 413, verifies **AC-15**.
- Scale: 5,000,000 seeded entries, p95 per filter and for `record`, verifies **AC-17**.
- Accessibility and language: axe clean on `/audit` in both languages, keyboard only filter and load more, verifies **AC-18**.
- Extension: a test adds a scratch registry entry and one `record` call with no schema change, verifies **AC-19**.

## Build plan

Tracer Bullet, as the project default ([AGENTS.md](../../../AGENTS.md)). Milestone 1 is the whole scope "done when" thread, thin but real through every layer: one real action that already exists (voiding a stock receipt, spec 0006 AC-8) writes an entry in its own transaction, a manager reads it on a page, and the table refuses edits. Later milestones thicken one segment each, end to end. Depends on the feature 4 baseline migration (see the header); if it has not landed, milestone 1 waits for it.

**Milestone 1: The thin thread (void a receipt, see the entry, cannot change it)**
1. [x] Drizzle schema `packages/db/src/schema/audit.ts` and the migration after the baseline: the table, checks, the seven indexes, the revoke, the three triggers, and `audit_entries` in `table-ownership.ts` under `audit`, in the append only schema test list, and in the stamped list of the operating day test, satisfies **AC-1**, **AC-3**, **AC-7**, **AC-8**
  > Amended 2026-11-06: the tables go in the baseline, not a migration after it, because the pilot import has not run ([ADR 0003](../../adr/0003-reset-migrations-to-one-baseline.md): the baseline freezes the day the pilot brand's first import runs). `audit_entries` is in the Drizzle schema, so `packages/db/migrations/0001_baseline_tables.sql` and its `meta` snapshots are regenerated from it (the partial unique index on `undoes_entry_id` and the BRIN index are expressed in Drizzle); the revoke from the app role, the `ssd_reject_change` row and truncate triggers, and the `ssd_stamp_operating_day('recorded_at')` trigger are hand written in `0002_baseline_rules.sql`. Developers recreate their dev database once (ADR 0003).
  > Amended 2026-11-06 (security review AS1): a fourth trigger, `audit_entries_recorded_now` (BEFORE INSERT, fires before the stamp by name), sets `recorded_at := clock_timestamp()` and `id := uuidv7()`, so no writer can backdate or forward date an entry or choose its keyset position.
  > Amended 2026-11-06 (merge with the feature 4 close, security review S1 of spec 0002): `audit_entries_recorded_now` is replaced by two triggers that keep its effect, so `audit_entries` follows the one rule every append only table with `recorded_at` follows: `audit_entries_0_stamp_recorded_at` (the shared `ssd_stamp_recorded_at('statement')`, `recorded_at := clock_timestamp()`) and `audit_entries_1_stamp_id` (`id := uuidv7()`), both firing before `audit_entries_stamp_operating_day` by name. A test that plants instants disables them as the owner around the insert.
2. [x] `packages/contracts/src/audit/`: the actor union, the entry view, the filter and cursor schemas, and a registry holding the first code `stock_receipt.voided` (labels in both languages), satisfies **AC-1**, **AC-10**
3. [x] `audit` module: `AuditService.record` with the registry check, the reason policy, personal masking, and the typed errors; module README, satisfies **AC-2**, **AC-4**, **AC-5**
  > 2026-11-06 (reviews AR1, AR2, AS8): `AuditEntryInput` also has `reasonRequired?: true` (tighten only), `before`, `after`, and `undo.args` are JSON values (`JsonObject`, so a bigint fails typecheck), `record` refuses a record type other than the registry's (`AuditRecordTypeMismatch`), and `recordMany(tx, entries)` is built (one multi row insert, every entry checked first).
4. [x] Wire the receipt void (`apps/api/src/inventory/receipts/`) to call `record` inside the void's transaction with the reason, the receipt number as label, and `before` and `after` of the status, satisfies **AC-2**, **AC-11**
5. [x] `GET /api/audit/entries` with the record and day filters, keyset paging, and the manager check (`admin` until hats), `@Audience('staff')`, satisfies **AC-12**, **AC-13**
  > 2026-11-06 (review AR3): in milestone 1 the read permission is checked by the caller, the controller (`@Roles('admin')` until hats). The built reader is `AuditQueryService.list(query: AuditEntryListQuery)`, the cursor and limit inside the query. `forRecord` (milestone 3) takes the viewer and refuses without `audit.read`, because other modules call it directly.
  > 2026-11-06 (identity, spec 0008 merged with this milestone): hats landed; the audit list declares `@Permission('audit.read')` and strips cost fields from `before` and `after` without `cost.view` (`apps/api/src/audit/audit-cost-fields.ts`).
6. [x] Web: `/audit` page in `(backoffice)` showing the list with actor, time, action label, record, and reason, in English and Arabic, satisfies **AC-12**, **AC-18**
7. [x] Tests: `packages/db/test/audit-append-only.e2e-spec.ts` (the app role and owner cases and the planted grant), `apps/api/test/audit.e2e-spec.ts` (thread, rollback both ways, 422 without a reason, 403), `apps/web/e2e/audit.spec.ts` (void a receipt, then find the entry), satisfies **AC-2**, **AC-5**, **AC-8**, **AC-12**
  > 2026-11-06: the database and api suites are built and pass; the web suite comes with task 6.

**Done when:**
- `pnpm build && pnpm typecheck && pnpm lint` pass, and `pnpm format:check` passes.
- `pnpm --filter @ssdashboard/db test:e2e -- test/audit-append-only.e2e-spec.ts` passes: app role `UPDATE`, `DELETE`, `TRUNCATE` denied; owner changes rejected with "append only"; the planted grant still cannot update.
- `pnpm --filter @ssdashboard/api test:e2e -- test/audit.e2e-spec.ts` passes: the void writes one entry; a throw after `record` leaves neither; a void without a reason is 422 and changes nothing; a non manager gets 403.
- `pnpm --filter @ssdashboard/web test:e2e -- e2e/audit.spec.ts --project=desktop` passes in English and Arabic.

**Milestone 2: Everything is recorded, safely**
8. [ ] All six actor kinds with constructor helpers, `recordMany`, `newCorrelationId`, and the shared correlation rule; tests for each actor shape and the table refusing wrong ones, satisfies **AC-3**, **AC-6**
  > 2026-11-06: `recordMany` and `newCorrelationId` were built in the milestone 1 fix pass (review AR2); this task keeps the six actor constructor helpers, the shared correlation rule, and their tests.
9. [ ] Personal data guard: masking with `personal_fields`, refusal in `undo_args` and `record_label`, phone masking in `reason`; the sentinel test over every column, satisfies **AC-4**, **AC-16**
  > 2026-11-06, from the security review of milestone 1 (must land before any customer facing action is wired): AS2 record type aware masking, because a changed fields diff has no marker keys, so a bare `name`, `email`, `reason`, or `payload` is not masked today (extend the sentinel test with them); AS3 an allowlist shape and a length limit for `record_label`, and `undo_args` holding only ids, codes, and numbers; AS4 phone shaped object keys and phone length numbers masked or refused; AS9 no false `personal_fields` entry from a JSON looking string that `redact` re parses.
10. [ ] The rest of the registry for today's code: SKU archive, unarchive, code change; location edit, archive, unarchive; staff user create, disable, enable, password reset; each wired in its transaction with its reason policy, satisfies **AC-5**, **AC-11**
  > 2026-11-06: the staff user part is built by identity (`staff_user.created`, `.disabled`, `.enabled`, `.password_reset`, plus `hat.granted` and `hat.revoked`), on spec 0008's branch; partner logins reuse `staff_user.*` with record type `user`.
11. [ ] Registry unit test (fields, both labels, proof file contains the code, undoable has a handler), unknown code refused, module boundary test with `audit_entries` named only inside `audit`, and the extension test, satisfies **AC-9**, **AC-10**, **AC-19**

**Done when:**
- `pnpm --filter @ssdashboard/api test` passes, including `src/audit/audit-registry.spec.ts` and `src/module-boundary.spec.ts` (the planted import of the audit schema in another module fails it).
  > 2026-11-06 (review AR10): the registry test is `packages/contracts/test/audit.spec.ts` (`pnpm --filter @ssdashboard/contracts test`); it already checks fields, both labels, and the proof file; task 11 adds the undoable handler check.
- `pnpm --filter @ssdashboard/api test:e2e -- test/audit.e2e-spec.ts` passes: the sentinel phone and address appear in no column, a reason with a phone is stored masked, one correlation id on a two record action, the operating day case with cutoff 2.
- `pnpm --filter @ssdashboard/db test:e2e` passes (table ownership and append only suites included).

**Milestone 3: The manager screen and the export**
12. [ ] Full filters (person picker from the identity staff list, record type and id, action select from the registry, day range, correlation id), "load more", the entry detail with the field diff and "hidden, personal data" for masked fields, and a "same action" link, satisfies **AC-12**, **AC-18**
13. [ ] `RecordHistoryPanel` in `apps/web/src/audit/` (the reusable block other record screens embed, reading `forRecord`), satisfies **AC-12**, **AC-13**
14. [ ] CSV export: streaming in keyset batches, byte order mark, 366 day and 200,000 row limits, `audit.exported` entry, `audit.export` permission, satisfies **AC-15**
15. [ ] Accessibility, keyboard, and both language checks on every new screen, satisfies **AC-18**

**Done when:**
- `pnpm --filter @ssdashboard/api test:e2e -- test/audit.e2e-spec.ts` passes the paging case (120 entries, 50 per page, new entries arriving, no gap and no duplicate), the permission cases, and the export cases (byte order mark, 400, 413, `audit.exported`).
- `pnpm --filter @ssdashboard/web test:e2e -- e2e/audit.spec.ts --project=desktop` passes: each filter alone and combined, load more, the diff, axe clean in both languages, keyboard only.
- `pnpm lint` passes (logical CSS check, no hard coded strings).

**Milestone 4: Undo and scale**
16. [ ] `AuditUndoRegistry` and `AuditUndoService` (advisory lock on the entry, handler call, the `.undone` entry, the unique index), `POST /api/audit/entries/:id/undo` with `audit.undo`, the undo dialog with the reason on the screen and the detail, satisfies **AC-14**, **AC-18**
  > 2026-11-06 (security review AS5): the undo code must satisfy `audit_action_format`, so it is `<noun>.<verb>_undone` (for example `stock_receipt.voided_undone`), not `<action>.undone`. An undo integrity trigger lands with this task: an insert with `undoes_entry_id` must name a target of the same record, with an undoable action, and carry a reason, so no insert can block a real undo by claiming its target first.
17. [ ] Undo tests with a fixture handler (once, twice, handler refusal, two parallel calls) and the boundary test proving the audit module imports no owning module, satisfies **AC-9**, **AC-14**
18. [ ] Scale check in `apps/api/test/scale.e2e-spec.ts`: seed 5,000,000 entries, then p95 per filter and for `record`; if the BRIN day filter misses, switch to the btree named above, satisfies **AC-17**
  > Amended 2026-11-05: this check runs in the same separate CI `scale` job as the spec 0002 scale suite, never in the default e2e job.
  > 2026-11-06 (review AR12): add a `recordType` only filter (no `recordId`) to the measured cases; the record index leads with type then id, so that filter sorts every entry of the type. If it misses the budget, require `recordId` or add a (`record_type`, `recorded_at` desc, `id` desc) index.
19. [ ] Module README final (Owns, Never touches, How to test, Governing spec, Decisions, Retention and who may read), `docs/specs/0010-audit-trail/verify.md` ticked, satisfies **AC-16**

**Done when:**
- `pnpm --filter @ssdashboard/api test:e2e -- test/audit.e2e-spec.ts` passes the undo cases (one undo, `ALREADY_UNDONE`, `UNDO_NOT_POSSIBLE` changes nothing, parallel calls give one entry).
- `pnpm --filter @ssdashboard/api test:scale` passes the audit budgets and prints the measured p95 values to paste into this spec's AC-17.
- `pnpm lint:repo` passes (the README headings, doc links).

## Consequences

**Positive**:
- One place answers "who did this and why", the same way for staff, partners, jobs, carriers, imports, and customers.
- Atomic with the change, so the log cannot lie by omission after a rollback or by a crash between two writes.
- Holding no personal data makes a multi year log safe to keep, to export, and to show a manager.
- Adding an action is one registry row and one call, so features 8, 9, 14, 34, 45 stay small.
- One undo code path per owner, shared with the owner's own screens.

**Negative / tradeoffs**:
- Every audited writer must remember to call `record`; the registry's proof test and each feature's AC catch a missing call, but a compiler does not.
- Masked personal fields mean the log cannot show the old address; the owning record's own history must (owner question 1).
- About five btree indexes plus one BRIN on an insert only table: each `record` costs a few index writes. Measured by AC-17.
- Entries are only as strong as the database privileges: an owner or superuser can still change them (no hash chain).
- Undo depends on each owner writing a correct handler; a stale undo is refused, never forced.

**Neutral**:
- One table in the migration baseline (amended 2026-11-06, see build plan task 1), one module. No new environment setting and no new dependency.
- `order_events`, `credit_entries`, `stock_movements`, and `settlement_lines` stay their own histories; audit adds entries for voids, reversals, overrides, and automatic actions.

## Follow-up

- [x] Spec 0002 tenancy child (`docs/specs/0002-core-data-model/0002-tenancy-platform.md`, A3 stamped list): add `audit_entries` (`recorded_at`) to the list of operating day tables; A4 and A5 already list it. Owner of that file: the architect, via Igris. (2026-11-06: the A3 list already names it; nothing to add.)
- [ ] Spec 0008 (hats): adopt the permission names `audit.read`, `audit.undo`, `audit.export` for the manager hat, add `hat.granted` and `hat.revoked` to the registry, and decide whether `actor_hat` stores the hat code.
- [ ] Spec 0009 (settings): add `setting.changed` and the list of sensitive setting keys that need a reason.
- [ ] Align names: `order_events.actor_type` uses `system`, this spec uses `system_job`; the order and credit specs map one to the other, or the orders build renames. Tell the orders build.
- [ ] Features 14, 34, 45, orders, tasks, credit, settlement, channels: each build task names AC-11 and AC-19 and adds its registry entries and proof tests.
- [ ] Scope `docs/scope/foundations.md` feature 10: link this spec and add the milestones as sub tasks (the scope owner, after approval). Not done here.
- [ ] A tamper evident hash chain and partitioning are revisit items (50,000,000 rows, or a client who asks for proof against a database administrator).
- [ ] Feature 26 (security review AS10): the app role can set `tenant_id` and `list` does not filter by it; harmless with one database per brand. Add a tenant check or row level security when installs share a database.
- [ ] First partner session build (security review AS11): add the AC-13 test that a partner session gets 403 `WRONG_AUDIENCE` on `/api/audit/entries`.

## Questions for the owner

None blocks the build. Each has the default this spec uses.

1. Do managers ever need to see the old and new customer phone, name, or address inside the audit trail? **Default: no.** The trail says "address changed" and who changed it; the order's own page holds the current value. Storing them would put personal data in a log kept for years.
2. Should every carrier status update (for example Bosta moved an order to `delivered`) also write an audit entry? **Default: no.** Those already sit in the order's event history with the carrier as actor, and one entry per update would bury the log. Only decisions the system makes in place of a person are audited.
3. Must an undo of an automatic action carry a typed reason? **Default: yes**, one line in the same confirm dialog (still one step). It tells you later why the automatic choice was wrong.
4. Is there a legal or contractual limit on how long the trail is kept? **Default: none, keep for the life of the install,** because entries hold no personal data. If your lawyer sets a limit, old rows can be removed only by a reviewed migration run by the owner role, never by the app.
5. Should sign in, sign out, and failed sign in also be audit entries? **Default: no.** Spec 0005 already logs them, and the trail records account actions (create, disable, password reset, hat changes).
6. Should staff who are not managers see the history of a record they can open (for example an order's edits)? **Default: no, managers only.** A diff can show costs and prices that staff must not see.

## References

See [rationale.md](rationale.md#references).
