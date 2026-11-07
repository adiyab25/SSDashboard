# Audit trail

One append only log of who did what, when, and why, written in the same database transaction as the change, so there is never a change without its entry or an entry without its change.

## Owns

- The table `audit_entries` (schema in [packages/db/src/schema/audit.ts](../../../../packages/db/src/schema/audit.ts)); the app role may only insert and read it, triggers refuse every update, delete, and truncate, and the database stamps each entry's `id` and `recorded_at` itself, whatever the writer passes.
- `AuditService.record(tx, entry)`, `recordMany(tx, entries)`, and `newCorrelationId()`, the only writer: [audit.service.ts](audit.service.ts). It checks the action code and its record type against the registry, applies the reason policy (a call may tighten it with `reasonRequired: true`, never loosen it), masks personal values in `before` and `after` (listing their paths in `personal_fields`), refuses personal data in the record label and undo arguments, masks phones in the reason, and inserts through the caller's transaction.
- `AuditQueryService`, the only reader: [audit-query.service.ts](audit-query.service.ts).
- `GET /api/audit/entries`, staff audience, `audit.read` (spec 0008); cost fields in a diff reach only a reader with `cost.view` (`serializeAuditPage`): [audit-entries.controller.ts](audit-entries.controller.ts), [audit-cost-fields.ts](audit-cost-fields.ts).
- The typed errors and their api mapping: [audit.errors.ts](audit.errors.ts), [audit-http.ts](audit-http.ts) (`AuditReasonRequired` is 422 `REASON_REQUIRED`, `AuditReasonTooLong` 422 `REASON_TOO_LONG`).
- The masking rules over the shared redaction list: [personal-data.ts](personal-data.ts).
- The action registry and its labels live in contracts: [packages/contracts/src/audit/audit-actions.ts](../../../../packages/contracts/src/audit/audit-actions.ts).

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
