# Audit screens

The back office page at `/audit`: who changed what, newest first, for people with `audit.read` (the manager hat, spec 0008), with filters, an entry detail, and a CSV export (`audit.export`). Also `RecordHistoryPanel`, the block other record screens embed.

## Owns

- The page: [audit-page.tsx](audit-page.tsx) (filters read from and written to the URL query, loading, empty, error with retry, the shared no access state on a 403)
- The filters: [audit-filter-bar.tsx](audit-filter-bar.tsx) (person from the staff list, record type and ID, action from the registry, day range, correlation ID) and [audit-filter.ts](audit-filter.ts) (URL query to filter and back, and the rules checked before a call)
- The table: [audit-entries-table.tsx](audit-entries-table.tsx), and the wording of an entry in [use-entry-text.tsx](use-entry-text.tsx)
- Load more and its focus rules (stays focused while loading, then the end of list line): [audit-pager.tsx](audit-pager.tsx)
- The entry detail with the field by field diff, "hidden, personal data", the same action link, and the history toggle: [audit-entry-dialog.tsx](audit-entry-dialog.tsx)
- The record history block: [record-history-panel.tsx](record-history-panel.tsx), props `recordType` and `recordId`; it draws an `h2`, never an `h1`, and shows its own loading, empty, error, and 403 states
- The CSV export control: [audit-export-control.tsx](audit-export-control.tsx) (day range required, 366 day limit counting both days, the reason sent in the `x-audit-reason` header (percent encoded) never the url, 400 and 413 shown from their codes)
- The route's loading state: [audit-page-skeleton.tsx](audit-page-skeleton.tsx) (the `h1` and a skeleton table)
- Calls to the api and query keys: [audit-api.ts](audit-api.ts)
- Which catalog key labels an actor kind: [audit-labels.ts](audit-labels.ts) (actions and record types come from the registries in `@ssdashboard/contracts`)
- The route: `src/app/(backoffice)/audit/page.tsx`

## Never touches

- Writing an entry. Only server code records entries; the screen only reads: the list (`GET /api/audit/entries`), one entry's detail (`GET /api/audit/entries/:id`), a record's history (`GET /api/audit/records/:type/:id/entries`), and the CSV export (`GET /api/audit/entries/export`).
- The action registry. It lives in `@ssdashboard/contracts`; the screen only reads each label key from it.
- Hard coded text. Use `t()`.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/audit
pnpm --filter @ssdashboard/web exec playwright test e2e/audit.spec.ts --project=desktop
```

## Governing spec

- [0010 Audit trail](../../../../docs/specs/0010-audit-trail/index.md) (AC-12, AC-13, AC-15, AC-18)

## Decisions

- Filters live in the page URL (same names as the api query) so a link reproduces the view; the filter bar keeps a draft and applies it with the button, so typing never sends a call.
- The entry detail is a dialog (like the other confirm and detail dialogs); the history panel opens inside it on request and is the same component other screens embed.
- The export is fetched and saved from a blob, so a 400 or 413 shows a message on the page instead of replacing it with JSON.
- Undo (milestone 4) plugs into the detail dialog.
