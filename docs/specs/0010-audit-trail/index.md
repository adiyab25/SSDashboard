# 0010. Audit trail: one append only log of who did what, when, and why, written in the same transaction as the change

**Date**: 2026-11-05
**Status**: Built 2026-11-07 (milestones 1 to 4)
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
  > Amended 2026-11-07 (security review AS2, milestone 2 task 9): masking is also record type aware. `AUDIT_RECORD_TYPES` in `packages/contracts/src/audit/audit-record-types.ts` lists, per record type, the bare keys that are personal in its diffs although the shared list leaves them alone elsewhere (a customer's `name`, `email`, and merge `reason`; an outbound command's `payload` and `failure_reason`), because a changed fields diff carries no marker key. They are stored as `"[REDACTED]"` and listed in `personal_fields`. A phone shaped object key is refused (`AuditPersonalDataRefused`), a whole number of 10 to 15 digits is masked as phone shaped (AS4), and JSON looking text under a personal key is masked whole, like any other value of that key; JSON looking text under any other key is walked beside the redactor's own result at its own path (so the path rules such as `customer.name` and the phone number rule reach inside it) and stored as the walked value written back as JSON, never as the input text; its path is listed only when something inside was masked (AS9, corrected 2026-11-07 by security reviews AS14 and AS21). A wholly uuid string is an id and is never masked (AS22).
  > Amended 2026-11-07 (security review milestone 2, AS16 to AS18): each record type in `AUDIT_RECORD_TYPES` also gives its label shape. A SKU, location, or stock receipt label must match that record's own code contract (`SKU_CODE_PATTERN`, `LOCATION_CODE_PATTERN`, `STOCK_RECEIPT_NUMBER_PATTERN`) and is then trusted as it is, so a SKU coded `01012345678` is never refused or masked as a phone, and a top level `code` in its diff that matches the contract is stored as written. A customer takes no label; the other types keep `AUDIT_RECORD_LABEL_PATTERN` with the phone refusal. Undo argument keys must be codes, the undo check uses the record type's personal keys, and a customer's `external_id` is personal (`externalid`).
- **AC-5** (reason): each action in the registry (AC-10) says whether a reason is `required` or `optional`. A missing or blank reason on a required action throws the typed domain error `AuditReasonRequired`, which the api edge answers as 422 `REASON_REQUIRED`, and the change rolls back. A reason is trimmed, at most 500 characters, and phone shaped text in it is masked with `maskPhones`. The set of required reasons is in "Actions that require a reason" below.
  > Amended 2026-11-07 (security review AS13, gate ruling): each record type says how its reason is kept (`AUDIT_RECORD_TYPES`, `reason: 'code' | 'text'`). `customer`, `order`, `exchange`, and `outbound_command` take a reason code only (`ReasonCode`, the shape of spec 0002 S4), and only one the action lists in its registry entry's `reasonCodes` (security review AS23: the registry test requires that list for such an action, and refuses a code with a phone in it); a typed note or an unlisted code throws `AuditReasonInvalid`, answered 422 `REASON_INVALID`, and the change rolls back. Every other record type keeps free text, trimmed, with phones and emails masked (`maskPhones`, `maskEmails`). A typed explanation for a customer facing action, if a later feature needs one, lives in the owning module's own note row, which can be edited and erased under Law 151, never in the audit entry.
- **AC-6** (one business action): entries written for one business action share one `correlation_id` (the caller passes the value it got from `AuditService.newCorrelationId()`, or an incoming job id). A merge writes one entry per customer record with the same id. The screen filters by it and shows "N entries in this action".
  > 2026-11-07 (milestone 2 task 8): the shared rule is built: `AuditService.newCorrelationId(actor?)` returns a system job's own pg-boss job id and a new id for anyone else, and one `recordMany` call refuses entries with different ids (`AuditCorrelationMismatch`), because one call is one business action.
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
  > Amended 2026-11-07 (milestone 4 task 16, security review AS5): the undone entry's code is `<action>_undone` (for example `sku.archived_undone`), so it satisfies `audit_action_format`; it is written on the undone entry's own record (same record type and id, which the table's `audit_entries_undo_matches` trigger requires), and the undo answers 200 with it as an `AuditEntryView`. 409 `UNDO_NOT_POSSIBLE` carries the owner's code in `undoCode` (the body's `code` stays `UNDO_NOT_POSSIBLE`). A typed reason is required (owner question 3); on a record type that keeps reason codes it must be one of the action's `undoReasonCodes` (422 `REASON_INVALID`).
  > Amended 2026-11-07 (milestone 4 reviews M4R1 to M4R4, M4R17, security review AS31 to AS33): the reason policy is checked before the owner's handler runs, and the handler gets only the checked reason (the listed code, or the text with phones and emails masked). `undoCode` is passed on only when it is one of the `undoRefusalCodes` the undoable action lists in the registry (required on every undoable action); any other refusal answers a plain 409 `UNDO_NOT_POSSIBLE` without `undoCode`, and the message is always a fixed text, never the owner's. The entry id is matched in any letter case, and a second undone entry the unique index refuses answers 409 `ALREADY_UNDONE`. The undone entry is written by a writer only the undo service reaches (not the exported `AuditService`), and a module may register a handler only for a code its own undoable actions name. The start check that every undoable code has a handler runs only in the api (`AuditUndoModule`, imported by the app root alone), never in the worker. If the read after commit fails, the undo answers from the row it wrote.
- **AC-15** (export): `GET /api/audit/entries/export` streams the current filter as CSV (UTF 8 with a byte order mark so Arabic opens right in Excel), in keyset batches of 1,000, at most 200,000 rows a file (413 `EXPORT_TOO_LARGE` asks for a narrower range) and only with a day range of at most 366 days. It needs `audit.export` (the manager hat by default). Each export writes its own entry (`audit.exported`, the filter in `after`). The file carries no personal data because the table holds none.
  > Amended 2026-11-07 (security review AS28): the export is `POST /api/audit/entries/export`, not a GET. It writes `audit.exported` under the caller's name, and a GET runs on any cross site link or redirect (the `SameSite=Lax` cookie rides a top level navigation), so an outsider could plant "this manager exported" entries; a POST passes the session guard's Origin check (403 `FORBIDDEN_ORIGIN`). The filter stays in the query string, the reason in the `x-audit-reason` header, and there is no body. A GET to that path meets the entry detail and answers 404 `ENTRY_NOT_FOUND`, writing nothing.
- **AC-16** (personal data and retention): no code path deletes or rewrites an entry. Entries are kept for the life of the install; there is no age limit because they hold no personal data (**Assumed**, owner question 4). The module README states this and the one allowed way to remove old rows if a lawyer ever requires it: the owner role, in a reviewed migration, never the app.
  > Amended 2026-11-07 (security review AS13): the "no personal data" basis for keeping entries for the life of the install now holds for the reason too: customer facing record types store only reason codes, and free text reasons on the other types have phones and emails masked. A name typed into a free text reason of a non customer record (a SKU, a location, a receipt) is not found by shape; it is the staff member's own wording about stock, and the screens ask for a reason about the record, not a person.
- **AC-17** (scale): with 5,000,000 entries seeded (about four times three years of volume at 120 orders a day), a page of 50 entries answers under 150 ms at p95 for each filter alone (person, record, action, day range, correlation) and for the unfiltered list, and one `record` call costs under 10 ms at p95 (budgets **Assumed**, set from the first measured run like the spec 0007 budgets). The check runs in `apps/api/test/scale.e2e-spec.ts`.
  > Amended 2026-11-05: `apps/api/test/scale.e2e-spec.ts` runs only in the separate CI `scale` job (nightly and on a `scale` label), never in the default e2e job ([spec 0002](../0002-core-data-model/index.md) build plan milestone 5).
  > Measured 2026-11-07 (task 18, first passing run, dev PostgreSQL 18 on the developer machine, CPU shared with a Playwright run): 5,000,000 entries over 1,096 operating days (36 people, 14 actions, 1,666,667 correlation groups, 703,049 records, 2744 MB with indexes), seeded in 120 s. p95 over 60 timed runs after 20 warm up runs, each through the real `AuditQueryService.list` (the page, the undone lookup, and the staff names) or `AuditService.record`, the worst read of each row:
  >
  > | Row | Budget (ms) | p95 (ms) |
  > |---|---|---|
  > | Page, unfiltered (first page and keyset pages) | 150 | 4.2 |
  > | Page by person | 150 | 2.3 |
  > | Page by record (type and id) | 150 | 2.3 |
  > | Page by record type alone (review AR12, every seeded type) | 150 | 3.4 |
  > | Page by action (most common, rarest, every action) | 150 | 2.3 |
  > | Page by day range (1, 7, and 31 days at random, and the oldest day) | 150 | 41.4 |
  > | Page by correlation | 150 | 1.8 |
  > | `record`, one entry | 10 | 1.0 |
  >
  > The budgets stand. Two fixes came out of the first runs. The list, the record history, and the export batches sorted by their own `to_char(...) AS recorded_at` output column instead of the table column (a bare `ORDER BY` name resolves to the output column first), so no index served the order and the unfiltered page was a full scan and sort; every reader now orders by `audit_entries.recorded_at DESC, audit_entries.id DESC`, guarded by a unit test on the issued SQL. And the day range page read the newest first index with only a filter on `operating_day` (about 800 ms for a day three years back). The btree fallback of the Data model section was measured and did not help (912, 845, and 776 ms p95 for 1, 7, and 31 days); a superset `recorded_at` bound beside the day filter did (`filtersOf`, midnight UTC two days before `dayFrom` to three days after `dayTo`), so the BRIN index stays.
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

> Amended 2026-11-07 (task 18): the scale test measured that fallback and it did not help: the planner served the day range from the newest first index with only a filter on `operating_day`, with the BRIN index and with the btree alike, and walked most of the table for an old day (about 800 to 900 ms p95). What holds the budget is a bound on `recorded_at` that the readers add beside each day condition (`filtersOf` in `apps/api/src/audit/audit-query.service.ts`): from midnight UTC two days before `dayFrom` to midnight UTC three days after `dayTo`. It is a superset of every operating day in the range for any time zone (UTC offsets -12 to +14 hours) and cutoff hour (0 to 23), so the `operating_day` conditions still decide the match. The BRIN index stays; no index changed.

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
> Amended 2026-11-07 (security review AS29): now true of every public reader, not only `forRecord`. Each takes the viewer: `list(query, viewer)`, `get(id, viewer)`, `view(id, viewer)`, and `forRecord(viewer, type, id, cursor, limit)` refuse a viewer without `audit.read`, and the export's `exportBound`, `exportSize`, and `exportBatches` one without `audit.export` (`AuditReadForbidden`, 403 `FORBIDDEN`); each leaves out cost fields for a viewer without `cost.view` itself, so another module that calls one for a support agent gets 403, never the trail or its costs. The cost match covers any spelling of a `COST_FIELD_KEYS` name (case, `_`, `-`, and spaces ignored) and JSON text stored as a string in a diff (AS30, review M4R8).

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
| `customer.merge_suggested_applied` | `customer` | o | yes | yes | feature 14 (amended 2026-11-07 by spec 0014, see the note below the table: feature 14 no longer registers it) |
| `policy.changed` (a `location_owner_policies` or similar policy row) | `policy` (the owner type's stable uuid; the label is the owner type code) | R | no | no | feature 4 follow up, settings screen (feature 9, spec 0009 milestone 5) |
| `cost_rule.recorded` (a per order cost rule recorded, spec 0009 AC-23) | `order_cost_rule` (`order_cost_rules.id`; the label is the rule's kind) | R | no | no | feature 9 (spec 0009 milestone 5) |
| `cost_rule.recorded_in_locked_period` (a per order cost rule from a day on or before the inventory lock date, recorded with the override, spec 0009 AC-23, D14) | `order_cost_rule` (`order_cost_rules.id`; the label is the rule's kind) | R | no | no | feature 9 (spec 0009 milestone 5) |
| `setting.changed` | `setting` | o; R when the registry entry says `reason: required` (the time zone and the cutoff hour among them; cost rules have their own `cost_rule.*` codes) | no | no | feature 9 |
| `hat.granted`, `hat.revoked` | `user` | o; R for `hat.revoked` of the manager hat | no | no | feature 8 |
| `license.added` (a verified license recorded for the first time, from the file or an upload) | `license` (`licenses.id`; the label is the vendor's license id) | o | no (actor the uploader, or `system_job` for the file) | no | feature 9 (spec 0009 milestone 2) |
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
| `audit.exported`, `<action>_undone` (amended 2026-11-07, AS5: on the undone entry's own record type) | `audit_entry`; the undone entry's record type for `_undone` | R for undone | no | no | this feature |
| `location.created`, `location.stock_confirmed` (amended 2026-11-07 by spec 0011, designed, not built) | `location` | o | no | no | feature 11 (spec 0011) |
| `location.online_moved`, `location.online_stopped` (amended 2026-11-07 by spec 0011) | `location` | R | no | no | feature 11 (spec 0011) |
| `partner.created` (amended 2026-11-07 by spec 0011; new record type `partner`, label the partner code) | `partner` | o | no | no | feature 11 (spec 0011) |
| `stock.adjustment_requested` (amended 2026-11-07 by spec 0011; new record type `stock_adjustment_request`, no label) | `stock_adjustment_request` | R | no | no | feature 11 (spec 0011) |
| `stock_discrepancy.rebuilt` (amended 2026-11-07 by spec 0011; new record type `stock_discrepancy`, no label) | `stock_discrepancy` | o | no | no | feature 11 (spec 0011) |
| `stock_discrepancy.dismissed` (amended 2026-11-07 by spec 0011) | `stock_discrepancy` | R | no | no | feature 11 (spec 0011) |
| `style.edited`, `style.code_changed`, `style.variant_added` (amended 2026-11-07 by spec 0012, designed, not built; new record type `style`, label the style code; one `style.edited` per style on a bulk assign) | `style` | o | no | no | feature 12 (spec 0012) |
| `sku.barcode_added`, `sku.barcode_removed` (amended 2026-11-07 by spec 0012) | `sku` | o | no | no | feature 12 (spec 0012) |
| `cost_record.recorded` (amended 2026-11-07 by spec 0012; the record id is the style) | `style` | o; R when backdated | no | no | feature 12 (spec 0012) |
| `season.created`, `season.edited`, `season.archived`, `season.unarchived`, `season.deleted` (amended 2026-11-07 by spec 0012; new record type `season`) | `season` | o | no | no | feature 12 (spec 0012) |
| `product_group.created`, `product_group.edited`, `product_group.archived`, `product_group.unarchived`, `product_group.deleted` (amended 2026-11-07 by spec 0012; new record type `product_group`) | `product_group` | o | no | no | feature 12 (spec 0012) |
| `style.channel_created`, `style.channel_updated`, `sku.channel_created`, `sku.channel_linked`, `sku.channel_updated` (amended 2026-11-07 by spec 0012; written by the channel sync with the caller's actor) | `style` or `sku` | not applicable (system) | yes | no (Shopify would write it back on the next sync) | feature 12 (spec 0012) |
| `order.created_manually`, `order.payment_method_rederived` (amended 2026-11-07 by spec 0013, designed, not built; the second has actor `system_job`) | `order` | o | no (spec 0013: none automatic) | no | feature 16 (spec 0013) |
| `order.collection_recorded_manually` (amended 2026-11-07 by spec 0013) | `order` | R | no | no | feature 16 (spec 0013) |
| `customer.merge_suggestion_dismissed`, `customer.phone_added`, `customer.flagged` (amended 2026-11-07 by spec 0014, designed, not built) | `customer` | o | no | no | feature 14 (spec 0014) |
| `customer.unflagged` (amended 2026-11-07 by spec 0014) | `customer` | R | no | no | feature 14 (spec 0014) |
| `connection.created`, `connection.edited`, `connection.backfill_started`, `inbound_event.retried` (amended 2026-11-07 by spec 0015, designed, not built; new record types `connection`, label the store code, and `inbound_event`, label the Shopify order name. Built 2026-11-08 by spec 0015 task 6: `connection.created` and the record type `connection` (reason text, label the store code), proof `apps/api/test/shopify-connect.e2e-spec.ts`; the other codes and `inbound_event` land with their tasks) | `connection`; `inbound_event` for `inbound_event.retried` | o | no | no | feature 13 (spec 0015) |
| `connection.paused`, `connection.resumed`, `connection.credentials_replaced`, `connection.archived`, `connection.stock_push_confirmed` (amended 2026-11-07 by spec 0015; entries never hold credentials) | `connection` | R | no | no | feature 13 (spec 0015) |
| `outbound_command.retried`, `outbound_command.resolved` (amended 2026-11-07 by spec 0015) | the command's linked record type (**Assumed**: spec 0015 names no record type for these two) | reason code | no | no | feature 13 (spec 0015) |
| `stock_difference.acknowledged` (amended 2026-11-07 by spec 0015; new record type `connection_stock_level`, label the SKU code) | `connection_stock_level` | reason code | no | no | feature 13 (spec 0015) |

> Amended 2026-11-07 by specs 0011 to 0015 (designed, not built; each owning feature's build registers its codes and labels in `packages/contracts/src/audit/` and `packages/i18n`). Codes the rows above already listed before this note keep their rows and gain their detail from the owning spec: `stock.adjusted_manually` (spec 0011, R, record type `stock_movement_group`, no label), `order.edited` and `order.partial_delivery_split` (spec 0013, optional, reasons kept as codes), `customer.merged` and `customer.unmerged` (spec 0014; the merge undo handler is `customers.merge_undo`). Spec 0011 writes no entry for showroom moves (the transfer row and its movements are their own history). Spec 0013 does not register `order.cancelled_override`: its design has no move that skips the transition table, so the first feature that adds one registers it, and state moves themselves are not audited. Spec 0015 requires a reason on `connection.paused`, `connection.resumed`, `connection.credentials_replaced`, `connection.archived`, and `connection.stock_push_confirmed` (its audit list and API table agree since 2026-11-07).

> Amended 2026-11-07 by spec 0014 (owner decision Q-14.4, designed, not built): the `customer.merge_suggested_applied` row above, and its "feature 14" owner, no longer hold. Feature 14 does not register `customer.merge_suggested_applied`, because a suggested merge is applied by a person, never automatically, and writes `customer.merged` (reason code `suggestion`). The row stays only as history; the first feature that applies a merge automatically registers the code. The "applying a suggested merge" example in "What an automatic action is" below is not true of feature 14 for the same reason.

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

> Amended 2026-11-07 (milestone 4 task 16, as built): the handler's context is `{ entry: AuditUndoTarget; actor; reason }`, where `AuditUndoTarget` holds the entry's id, action, correlation id, record, `before`, `after`, and `undo` (`action` and `args`), because the handler needs the undo arguments the entry view never shows. The transaction is `READ COMMITTED`, so the second of two parallel undos, released by the advisory lock, sees the first's entry and answers `ALREADY_UNDONE`. `NotUndoable` also covers an entry whose action the registry no longer marks undoable, or whose `undo_action` is not the registry's `undoHandler`. A handler must answer the entry's own record (`AuditUndoRecordMismatch` otherwise, a programming error). The registry check runs in the api, not in a unit test of contracts: `AuditUndoRegistry.onApplicationBootstrap` stops the process when an `undoHandler` has no registered handler (`AuditUndoHandlerMissing`), so every process that loads the audit module (today the api and the worker, through inventory) must load each module that owns an undoable code.

> Amended 2026-11-07 (review M4R1, M4R4, security review AS33): the paragraph above no longer holds for the start check. The worker loads the audit module (through inventory) but serves no undo, so the check moved off `AuditUndoRegistry` into `AuditUndoStartCheck`, provided by the leaf `AuditUndoModule` (the undo route, `AuditUndoService`, and the undone entry writer), which only the api's `AppModule` imports; only the api must load each module that owns an undoable code, and `apps/api/src/audit/audit-routes.spec.ts` fails if the worker graph ever gains the check. The undone entry is written by `AuditUndoneWriter`, which no module exports (it replaces `AuditService.recordUndone`; `apps/api/src/module-boundary.spec.ts` keeps it to the undo). `AuditUndoRegistry.register(code, handler, owner)` refuses a code no undoable action of `owner` names (`AuditUndoHandlerForeign`).

### State

None for an entry (immutable). Derived "undone" is `EXISTS (undoes_entry_id = id)`, read for the visible page in one extra query on `undoes_entry_id = ANY(:ids)`.

### API surface

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/audit/entries` | GET | `actorUserId?`, `recordType?`, `recordId?`, `action?`, `dayFrom?`, `dayTo?`, `correlationId?`, `cursor?`, `limit?` (1 to 200, default 50) | `items[]` (entry view with `actorName`, `undone`, `canUndo`), `nextCursor` or null | staff, `audit.read` | 400 `INVALID_FILTER`, 400 `INVALID_CURSOR`, 403 |
| `/api/audit/entries/:id` | GET | id | one entry view with the field diff | staff, `audit.read` | 404 `ENTRY_NOT_FOUND`, 403 |
| `/api/audit/records/:type/:id/entries` | GET | `cursor?`, `limit?` (1 to 200, default 50) | `items[]` (entry view), `nextCursor` or null, newest first | staff, `audit.read` | 400 `INVALID_FILTER` (a bad type, id, or query), 400 `INVALID_CURSOR`, 403 |
| `/api/audit/entries/:id/undo` | POST | `reason` (1 to 500, `AuditUndoRequest`) | 200, the new `<action>_undone` entry (`AuditEntryView`) | staff, `audit.undo` | 404 `ENTRY_NOT_FOUND`, 409 `ALREADY_UNDONE`, 409 `UNDO_NOT_POSSIBLE` (with `undoCode`), 409 `NOT_UNDOABLE`, 422 `REASON_REQUIRED`, 422 `REASON_TOO_LONG`, 422 `REASON_INVALID` (code form record types), 400 `INVALID_INPUT` (any other body) |
| `/api/audit/entries/export` | POST (amended 2026-11-07, security review AS28: was GET) | the list filters in the query string, no body, but `dayFrom` and `dayTo` required, at most 366 days counted with both ends (`auditExportDayCount`); an optional reason in the `x-audit-reason` header, percent encoded (amended 2026-11-07, review M3R3: never the query string) | `text/csv` stream | staff, `audit.export` | 400 `INVALID_FILTER`, 400 `INVALID_REASON`, 413 `EXPORT_TOO_LARGE`, 403 |

> Amended 2026-11-06 (review AR7): `AuditService.record` throws `AuditReasonTooLong` for a reason over 500 characters after trimming, answered 422 `REASON_TOO_LONG` by `auditHttpError`. A route whose contract already caps its reason (the receipt void, 400 `INVALID_INPUT`) never reaches it.

> Amended 2026-11-07 (milestone 3, api side): the record history endpoint above is new: it reads `AuditQueryService.forRecord(viewer, type, id, cursor, limit)`, which refuses a viewer without `audit.read` itself, so another module that reaches it carries a viewer (review AR3). The detail answers `AuditEntryDetail`: the entry view plus `changes`, one row per top level field of `before` and `after` with both sides and `personal` (masked). The export decides its size with a `LIMIT 200001` count before anything streams, reads the newest entry key inside the filter and counts only entries at or below it, records `audit.exported` (record type `audit_entry`, the export's own id, the filter and the row count in `after`, an optional reason from the `x-audit-reason` header) in its own committed transaction before the first byte, so an export is on record even when the download is cut off and a failure to record stops it; it then streams only the entries at or below that key, at most the counted number, so the file holds exactly `after.rows` rows and never its own entry (amended 2026-11-07, review M3R2); a reader that goes away stops the stream and logs one line with no values (M3R1); it streams `AUDIT_EXPORT_COLUMNS` (`recorded_at` in the install time zone, `operating_day`, `actor_kind`, `actor` (name or reference), `actor_hat`, `action`, `action_label` (English), `record_type`, `record_id`, `record_label`, `reason`, `before`, `after`, `personal_fields`, `correlation_id`, `entry_id`) in keyset batches of 1,000, every cell quoted and a leading `=`, `+`, `-`, `@` defused. Until hats land each route carries one `@Roles('admin')`, so the switch to `@Permission('audit.read' | 'audit.export')` is one decorator per route.

> Amended 2026-11-07 (milestones 2 and 3 merged with spec 0008): the switch is made. The list, the detail, and the record history carry `@Permission('audit.read')`, the export `@Permission('audit.export')`; each has a row in spec 0008's route mapping and a fixture in `apps/api/test/access-sweep.e2e-spec.ts`. Cost fields reach only a reader with `cost.view` on every route that answers a diff: the list (`serializeAuditPage`), the detail and its `changes` (`serializeAuditDetail`), the record history (inside `forRecord`), and the export's `before` and `after` cells (`AuditExportPlan.showCost`), all in `apps/api/src/audit/audit-cost-fields.ts`.

> Amended 2026-11-07 (review M3R6): the export route lives in `AuditExportModule`, a leaf module that imports `AuditModule` and the platform module (for the time zone it passes to the stream); `AuditModule` never imports the platform module, because spec 0009 makes the platform module import audit. The app root lists the leaf first, so `/export` is routed before `/:id` (`apps/api/src/audit/audit-routes.spec.ts`).

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
8. [x] All six actor kinds with constructor helpers, `recordMany`, `newCorrelationId`, and the shared correlation rule; tests for each actor shape and the table refusing wrong ones, satisfies **AC-3**, **AC-6**
  > 2026-11-06: `recordMany` and `newCorrelationId` were built in the milestone 1 fix pass (review AR2); this task keeps the six actor constructor helpers, the shared correlation rule, and their tests.
  > 2026-11-07: built. `personActor`, `partnerUserActor`, `systemJobActor`, `carrierActor`, `importActor`, and `portalCustomerActor` in `packages/contracts/src/audit/audit-actor.ts` validate the shape with `AuditActor` and throw before the table check; the correlation rule is under AC-6. Tests: `packages/contracts/test/audit.spec.ts` (each helper, each wrong shape), `apps/api/src/audit/audit.service.spec.ts` (job id, mixed ids refused), `apps/api/test/audit.e2e-spec.ts` (the table refusing wrong shapes). The session carries no hat yet (`CurrentStaff` is the staff role only), so a person actor's `hat` is still the role, `admin`; it becomes the hat code when spec 0008 puts the hat on the session.
  > 2026-11-07 (merged with spec 0008): it now is. Every person actor names the hat that holds the route's permission (`Access.actingHat`): `stock.correct` for a receipt void, `catalog.manage` for the SKU and location actions, `audit.export` for an export, `people.manage` for identity's codes.
9. [x] Personal data guard: masking with `personal_fields`, refusal in `undo_args` and `record_label`, phone masking in `reason`; the sentinel test over every column, satisfies **AC-4**, **AC-16**
  > 2026-11-06, from the security review of milestone 1 (must land before any customer facing action is wired): AS2 record type aware masking, because a changed fields diff has no marker keys, so a bare `name`, `email`, `reason`, or `payload` is not masked today (extend the sentinel test with them); AS3 an allowlist shape and a length limit for `record_label`, and `undo_args` holding only ids, codes, and numbers; AS4 phone shaped object keys and phone length numbers masked or refused; AS9 no false `personal_fields` entry from a JSON looking string that `redact` re parses.
  > 2026-11-07: built and closing AS2, AS3, AS4, AS9. AS2 under AC-4. AS3: a `record_label` must match `AUDIT_RECORD_LABEL_PATTERN` (a code or number, at most 64 characters, no space) and the table check `audit_record_label_length` holds 1 to 64 (in the regenerated `0001`); `undo_args` holds only uuids, codes, and numbers that are not phone length. Tests: `apps/api/src/audit/audit.service.spec.ts` (personal data guard) and the sentinel case over every column in `apps/api/test/audit.e2e-spec.ts`.
10. [x] The rest of the registry for today's code: SKU archive, unarchive, code change; location edit, archive, unarchive; staff user create, disable, enable, password reset; each wired in its transaction with its reason policy, satisfies **AC-5**, **AC-11**
  > 2026-11-06: the staff user part is built by identity (`staff_user.created`, `.disabled`, `.enabled`, `.password_reset`, plus `hat.granted` and `hat.revoked`), on spec 0008's branch; partner logins reuse `staff_user.*` with record type `user`.
  > 2026-11-07: SKU archive, unarchive, and code change (`apps/api/src/inventory/sku-lifecycle/`) and location edit, archive, and unarchive (`apps/api/src/inventory/locations/`) record inside their own `ledgerTransaction`, only when the record really changed, with the optional reason policy; proof `apps/api/test/audit-inventory.e2e-spec.ts`. Record type labels moved to contracts beside the registry (`AUDIT_RECORD_TYPES`, review AW2); the web reads them from there.
  > 2026-11-07 (milestones 2 and 3 merged with spec 0008): identity's six codes are in `AUDIT_ACTIONS` with proof `apps/api/test/identity-audit.e2e-spec.ts`, and `user` is a row of `AUDIT_RECORD_TYPES` (free text reason, no label, `name` and `email` personal keys), so the screen labels it from contracts like every other type.
11. [x] Registry unit test (fields, both labels, proof file contains the code, undoable has a handler), unknown code refused, module boundary test with `audit_entries` named only inside `audit`, and the extension test, satisfies **AC-9**, **AC-10**, **AC-19**
  > 2026-11-07: `registryFaults` in `packages/contracts/test/audit.spec.ts` checks every field, both labels, a known record type, the proof file naming the code, and that an undoable code names its `undoHandler` (no code is undoable yet; planted entries prove each check fails). The extension case (a scratch registry row and one `record` call, no schema change) and the sentinel case are in `apps/api/test/audit.e2e-spec.ts`; the planted import of the audit table outside `audit` is in `apps/api/src/module-boundary.spec.ts`.

**Done when:**
- `pnpm --filter @ssdashboard/api test` passes, including `src/audit/audit-registry.spec.ts` and `src/module-boundary.spec.ts` (the planted import of the audit schema in another module fails it).
  > 2026-11-06 (review AR10): the registry test is `packages/contracts/test/audit.spec.ts` (`pnpm --filter @ssdashboard/contracts test`); it already checks fields, both labels, and the proof file; task 11 adds the undoable handler check.
- `pnpm --filter @ssdashboard/api test:e2e -- test/audit.e2e-spec.ts` passes: the sentinel phone and address appear in no column, a reason with a phone is stored masked, one correlation id on a two record action, the operating day case with cutoff 2.
- `pnpm --filter @ssdashboard/db test:e2e` passes (table ownership and append only suites included).

**Milestone 3: The manager screen and the export**
12. [x] Full filters (person picker from the identity staff list, record type and id, action select from the registry, day range, correlation id), "load more", the entry detail with the field diff and "hidden, personal data" for masked fields, and a "same action" link, satisfies **AC-12**, **AC-18**
  > 2026-11-07: built. Api: `GET /api/audit/entries/:id` (`AuditEntryDetail`, `changes` with `personal`). Web: `apps/web/src/audit/audit-filter-bar.tsx` and `audit-filter.ts` (every filter, kept in the URL), `audit-pager.tsx` (load more), `audit-entry-dialog.tsx` (the field diff, "hidden, personal data", the same action link), `audit-export-control.tsx`. Tests: `apps/web/e2e/audit.spec.ts` "each filter alone and combined, with the filter in the URL", "the detail shows the field diff, the same action link, and the record history", "a personal field is shown as hidden, never its marker", "Load more works by keyboard alone and keeps focus"; `apps/api/test/audit.e2e-spec.ts` (detail, paging with arrivals).
13. [x] `RecordHistoryPanel` in `apps/web/src/audit/` (the reusable block other record screens embed, reading `forRecord`), satisfies **AC-12**, **AC-13**
  > 2026-11-07: built. Api: `AuditQueryService.forRecord(viewer, ...)` and `GET /api/audit/records/:type/:id/entries` (`AuditRecordRef`, `AuditRecordHistoryQuery`). Web: `apps/web/src/audit/record-history-panel.tsx`, shown in the entry detail. Tests: `apps/web/e2e/audit.spec.ts` "the detail shows the field diff, the same action link, and the record history", "the filtered list, the detail, and the history are axe clean"; `apps/api/test/audit.e2e-spec.ts` (history, bad record, 403).
14. [x] CSV export: streaming in keyset batches, byte order mark, 366 day and 200,000 row limits, `audit.exported` entry, `audit.export` permission, satisfies **AC-15**
  > 2026-11-07: built (`AuditExportService`, `GET /api/audit/entries/export`, `AuditExportQuery`, `AUDIT_EXPORT_COLUMNS`); see the dated note under the API surface. Tests: `apps/api/test/audit.e2e-spec.ts` (byte order mark, header and rows, `audit.exported`, 400, 413, 403) and `apps/api/src/audit/audit-reading.spec.ts` (cells, file name). A download button on the screen, if wanted, is frontend-dev's.
15. [x] Accessibility, keyboard, and both language checks on every new screen, satisfies **AC-18**

**Done when:**
- `pnpm --filter @ssdashboard/api test:e2e -- test/audit.e2e-spec.ts` passes the paging case (120 entries, 50 per page, new entries arriving, no gap and no duplicate), the permission cases, and the export cases (byte order mark, 400, 413, `audit.exported`).
- `pnpm --filter @ssdashboard/web test:e2e -- e2e/audit.spec.ts --project=desktop` passes: each filter alone and combined, load more, the diff, axe clean in both languages, keyboard only.
- `pnpm lint` passes (logical CSS check, no hard coded strings).

**Milestone 4: Undo and scale**
16. [x] `AuditUndoRegistry` and `AuditUndoService` (advisory lock on the entry, handler call, the `.undone` entry, the unique index), `POST /api/audit/entries/:id/undo` with `audit.undo`, the undo dialog with the reason on the screen and the detail, satisfies **AC-14**, **AC-18**
  > 2026-11-06 (security review AS5): the undo code must satisfy `audit_action_format`, so it is `<noun>.<verb>_undone` (for example `stock_receipt.voided_undone`), not `<action>.undone`. An undo integrity trigger lands with this task: an insert with `undoes_entry_id` must name a target of the same record, with an undoable action, and carry a reason, so no insert can block a real undo by claiming its target first.
  > 2026-11-07: web part built (`b619a26`): the `/audit` entry detail shows Undo only when the entry's `canUndo` is true; it opens one confirm dialog (`apps/web/src/audit/audit-undo-dialog.tsx`) holding the typed reason (1 to 500, required) or, for an action with `undoReasonCodes`, a select of those codes, so the undo stays one step (owner question 3). Each api refusal shows from its stable code (`UNDO_NOT_POSSIBLE` with the owner's `undoCode`); on success the list, detail, and history refresh, the original shows "Undone", and focus moves to the undone notice. Undone entries show the shared label with the undone action named under it. Tests: `audit-undo-dialog.spec.tsx` (the registry mocked, since nothing is undoable yet) and `apps/web/e2e/audit.spec.ts` (the api stubbed with `page.route`, keyboard only, axe clean in English and Arabic).
  > 2026-11-07: api part built. Registry: undone codes are derived, never listed: each undoable code `X` brings `X_undone` (`auditActionsWithUndone`, `undoneActionOf`, `auditUndoneParentOf` in `packages/contracts/src/audit/audit-actions.ts`), owned by `audit`, on `X`'s record type, reason `required`, final, labelled with the one shared key `audit.actions.actionUndone` (the screen names the undone action beside it, from the code without its suffix), and proven by `X`'s own proof file, which must therefore name `X_undone`. An undoable action on a record type that keeps reason codes lists `undoReasonCodes`, copied to its undone code's `reasonCodes`. `registryFaults` (`packages/contracts/test/audit.spec.ts`) runs over the registry with the derived codes, refuses a listed code ending in `_undone`, and refuses `undoReasonCodes` on a final action; `auditActionOf` knows the derived codes; `AUDIT_ACTION_CODES` (the filter picker) lists only the registered ones. `record` refuses an undone code and `recordUndone` (called only by `AuditUndoService`) refuses any other. Database: `audit_entries_undo_matches` in `0002_baseline_rules.sql` (BEFORE INSERT, when `undoes_entry_id` is set or the code ends in `_undone`): the row needs a reason and a target of the same tenant, record type, and record id with an `undo_action`, and its code must be the target's action plus `_undone`; an `_undone` code without a target is refused. Api: `AuditUndoRegistry` (`register`, `missingHandlers`, the start check), `AuditUndoService`, `AuditUndoController` (`POST /api/audit/entries/:id/undo`, class `@Audience('staff')` and `@Permission('audit.undo')`), `canUndo` on every entry view (list, detail, history: the registry marks it undoable and it names its handler, not undone, the viewer holds `audit.undo`). Spec 0008's route mapping and the route sweep have the route.
17. [x] Undo tests with a fixture handler (once, twice, handler refusal, two parallel calls) and the boundary test proving the audit module imports no owning module, satisfies **AC-9**, **AC-14**
  > 2026-11-07: built. `apps/api/test/audit.e2e-spec.ts` "audit undo api (spec 0010, milestone 4)": a scratch undoable SKU code and a fixture handler over its own table; one undo (the undone entry, the owner's change reversed, `canUndo` before and after), a second call 409 `ALREADY_UNDONE`, a refusing handler 409 `UNDO_NOT_POSSIBLE` with its `undoCode` and its own write rolled back, two parallel calls giving one 200 and one 409 and one undone entry, 422 `REASON_REQUIRED` and `REASON_TOO_LONG`, 400 for another body, 403 without `audit.undo`, 401 without a session, 409 `NOT_UNDOABLE`, 404. `packages/db/test/audit-append-only.e2e-spec.ts` (the AS5 trigger: another record, record type, or code, no reason, a final target, an undone target, no target). `apps/api/src/audit/audit-undo.spec.ts` (the start check with a planted gap, duplicate handlers, the body answers, the edge mapping, the service's refusals) and `audit.service.spec.ts` (`recordUndone`). `apps/api/src/module-boundary.spec.ts` "audit imports no owning module": a file under `apps/api/src/audit/` may import only its own folder, `database`, `config`, `platform`, and identity's staff directory, with a planted case.
  > 2026-11-07 (review nits carried from milestone 3): M3R11, `AuditExportQuery` extends the one `AuditEntryFilter` (with `auditFilterRules`) the list extends, instead of copying its fields. M3R12, each `changes` row of the detail carries `kind` (`added`, `removed`, `changed`), so a stored `null` (`changed` with a null side) is told apart from a side that does not hold the field (`added` or `removed`, its value sent as null).
18. [x] Scale check in `apps/api/test/scale.e2e-spec.ts`: seed 5,000,000 entries, then p95 per filter and for `record`; if the BRIN day filter misses, switch to the btree named above, satisfies **AC-17**
  > Amended 2026-11-05: this check runs in the same separate CI `scale` job as the spec 0002 scale suite, never in the default e2e job.
  > 2026-11-06 (review AR12): add a `recordType` only filter (no `recordId`) to the measured cases; the record index leads with type then id, so that filter sorts every entry of the type. If it misses the budget, require `recordId` or add a (`record_type`, `recorded_at` desc, `id` desc) index.
  > 2026-11-07: built and passing; the measured values are in AC-17. `apps/api/test/scale-audit-seed.ts` loads the 5,000,000 entries in bulk SQL as the owner (time ordered instants and ids over three years, with the three stamp triggers off around the load and back on after, the day filled by `ssd_operating_day`, the function the trigger calls, and the five non unique indexes rebuilt from their own definitions). The suite explains the exact SQL `AuditQueryService` issues and times `list` and `record` as the app role. The record type alone filter (AR12) passed for every seeded type (3.4 ms p95) through the newest first index, so neither the index nor a required `recordId` was added; see the follow up below for the case it does not cover. No index changed; the BRIN fallback was replaced by the day bound (Data model, amended 2026-11-07).
19. [x] Module README final (Owns, Never touches, How to test, Governing spec, Decisions, Retention and who may read), `docs/specs/0010-audit-trail/verify.md` ticked, satisfies **AC-16**
  > 2026-11-07: the module README is final: its Retention and who may read section states AC-16 and the three permissions (`audit.read`, `audit.export`, `audit.undo`, manager hat by default), and each statement was checked against the code (`AuditUndoModule`, `AuditUndoRegistry.register(code, handler, owner)`, `AuditUndoneWriter`, `AuditUndoStartCheck` in the api only, the export as a POST, the readers' own permission checks and cost strip). `verify.md` is ticked only where `docs/reviews/verify-audit-trail.md` or a named passing test proves the line; the lines still open are named in that file. The `pnpm lint:repo` gate of this task was not run by the docs writer (no shell in that lane); the lead runs it before merge.

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
- [x] Spec 0009 (settings): add `setting.changed` and the list of sensitive setting keys that need a reason. (2026-11-07: spec 0009 *Audit actions* names it; each registry entry's `reason` rule is the list; built in spec 0009 milestone 1.)
- [ ] Align names: `order_events.actor_type` uses `system`, this spec uses `system_job`; the order and credit specs map one to the other, or the orders build renames. Tell the orders build.
- [ ] Features 14, 34, 45, orders, tasks, credit, settlement, channels: each build task names AC-11 and AC-19 and adds its registry entries and proof tests.
- [ ] Scope `docs/scope/foundations.md` feature 10: link this spec and add the milestones as sub tasks (the scope owner, after approval). Not done here.
- [ ] A tamper evident hash chain and partitioning are revisit items (50,000,000 rows, or a client who asks for proof against a database administrator).
- [ ] Record type alone filter (review AR12, found by task 18 on 2026-11-07): it passes at scale because every seeded record type is spread over the whole three years, so the newest first index finds 50 matches quickly. A record type whose entries all sit in the past (a type no longer written, or one written rarely) would make that read walk most of the table, as the day range did before its bound. The fix is a btree on (`record_type`, `recorded_at` desc, `id` desc); add it, and a scale case with a type whose entries are all old, when such a type exists.
- [ ] Feature 26 (security review AS10): the app role can set `tenant_id` and `list` does not filter by it; harmless with one database per brand. Add a tenant check or row level security when installs share a database.
- [x] First partner session build (security review AS11): add the AC-13 test that a partner session gets 403 `WRONG_AUDIENCE` on `/api/audit/entries`.
  > 2026-11-07 (security review AS35): met by the route sweep, `apps/api/test/access-sweep.e2e-spec.ts`, which calls every audit route (the list, the detail, the record history, the export, and the undo) as the partner persona and requires 403 `WRONG_AUDIENCE`.
- [ ] Spec 0009 (settings, review M4R7): the day window of `filtersOf` (a superset `recorded_at` bound from two days before `dayFrom` to three days after `dayTo`) is proven only for an operating day cutoff of 0 to 23 hours and a time zone whose UTC offset is within minus 12 to plus 14 hours. Spec 0009's settings writer must bound `operating_day_cutoff_hour` to 0 to 23 and `timezone` to IANA names (in the contract and a table check) and name `filtersOf` in `apps/api/src/audit/audit-query.service.ts` as the dependent; otherwise day filters and exports would silently drop entries.
- [ ] Customers and orders features (security review AS13): a typed explanation of a customer facing action (a merge, an order edit, an exchange) goes in the owning module's own note row, which can be edited and erased under Law 151; the audit entry keeps only a reason code (AC-5).

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
