# Audit trail

One append only log of who did what, when, and why, written in the same database transaction as the change, so there is never a change without its entry or an entry without its change.

## Owns

- The table `audit_entries` (schema in [packages/db/src/schema/audit.ts](../../../../packages/db/src/schema/audit.ts)); the app role may only insert and read it, triggers refuse every update, delete, and truncate, and the database stamps each entry's `id` and `recorded_at` itself, whatever the writer passes.
- `AuditService.record(tx, entry)`, `recordMany(tx, entries)` (one business action, one correlation id), and `newCorrelationId(actor?)` (a system job's own job id, else a new one), the only writer: [audit.service.ts](audit.service.ts). It checks the action code and its record type against the registry, applies the reason policy (a call may tighten it with `reasonRequired: true`, never loosen it), masks personal values in `before` and `after` with the shared list plus the record type's own personal keys (listing their paths in `personal_fields`), refuses a phone shaped key, a label that is not a short code, and undo arguments that are not ids, codes, or numbers, masks phones in the reason, and inserts through the caller's transaction.
- `AuditQueryService`, the only reader: [audit-query.service.ts](audit-query.service.ts): `list`, `get` (one entry with its field diff), `forRecord(viewer, ...)` (refuses a viewer without the read permission itself), and the export's size check and keyset batches.
- The routes, staff audience, one `@Roles('admin')` per route until hats land: `GET /api/audit/entries` and `GET /api/audit/entries/:id` in [audit-entries.controller.ts](audit-entries.controller.ts), and `GET /api/audit/records/:type/:id/entries` in [audit-records.controller.ts](audit-records.controller.ts), all in `AuditModule`, which never imports the platform module (spec 0009 makes platform import audit).
- The CSV export, `GET /api/audit/entries/export`, in the leaf [audit-export.module.ts](audit-export.module.ts): [audit-export.controller.ts](audit-export.controller.ts) reads the time zone and the `x-audit-reason` header (percent encoded, 1 to 500 characters, 400 `INVALID_REASON`), [audit-export.service.ts](audit-export.service.ts) bounds the file by the newest key inside the filter, refuses more than 200,000 rows (413 `EXPORT_TOO_LARGE`, decided before streaming), records `audit.exported` in its own transaction before the first byte, and streams exactly the counted rows (never its own entry) in keyset batches of 1,000; a reader that goes away stops the stream and logs one line. The app root lists this module first, so `/export` is routed before `/:id` ([audit-routes.spec.ts](audit-routes.spec.ts)).
- The typed errors and their api mapping: [audit.errors.ts](audit.errors.ts), [audit-http.ts](audit-http.ts) (`AuditReasonRequired` is 422 `REASON_REQUIRED`, `AuditReasonTooLong` 422 `REASON_TOO_LONG`, `AuditReasonInvalid` 422 `REASON_INVALID`, `AuditReadForbidden` 403 `FORBIDDEN`, `AuditEntryNotFound` 404 `ENTRY_NOT_FOUND`, `AuditExportTooLarge` 413 `EXPORT_TOO_LARGE`).
- The masking rules over the shared redaction list: [personal-data.ts](personal-data.ts) (record type keys, phone shaped keys and numbers, undo argument shape).
- External ids (a Shopify customer id, a WhatsApp contact id) travel in a diff as text, never as numbers: a whole number of 10 to 15 digits is masked as phone shaped, so a numeric id would be hidden (security review AS20).
- Reasons follow the record type: customer facing types keep a reason code only, one of the action's `reasonCodes` (422 `REASON_INVALID` for a typed note or an unlisted code), every other type keeps free text with phones and emails masked (spec 0010, AC-5).
- The action registry, the record types with their labels and personal keys, and the six actor constructors live in contracts: [audit-actions.ts](../../../../packages/contracts/src/audit/audit-actions.ts), [audit-record-types.ts](../../../../packages/contracts/src/audit/audit-record-types.ts), [audit-actor.ts](../../../../packages/contracts/src/audit/audit-actor.ts).

## Never touches

- Any other module's table. Record labels and diffs come from the calling module; person names come from the staff directory by id, never from a join.
- Its own transaction: `record` writes only through the caller's `tx`, never opens one, and never swallows an error.
- A customer's phone, name, or address (Law 151): they are masked or refused before the insert.
- The owner database role. No code path updates or deletes an entry.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/audit
pnpm --filter @ssdashboard/contracts test
pnpm build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/audit.e2e-spec.ts
pnpm --filter @ssdashboard/db exec vitest run --config ./vitest.config.e2e.ts test/audit-append-only.e2e-spec.ts
```

The e2e suites need the dev Postgres (`deploy/compose.dev.yaml`); each makes its own scratch database.

## Governing spec

- [0010 Audit trail](../../../../docs/specs/0010-audit-trail/index.md)
- [0002 Core data model, tenancy child](../../../../docs/specs/0002-core-data-model/0002-tenancy-platform.md) (append only list, operating day, table ownership)

## Decisions

No ADRs yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.

- The registry (`AUDIT_ACTIONS`) stores catalog keys (`audit.actions.stockReceiptVoided`), not label text: the screen translates them in the viewer's language, and the i18n parity test keeps English and Arabic in step (spec 0010, AC-10).

## Retention

Entries are kept for the life of the install, because they hold no personal data (spec 0010, AC-16, owner question 4). If a lawyer ever requires removing old rows, the only allowed way is a reviewed migration run by the owner role, never the app.
