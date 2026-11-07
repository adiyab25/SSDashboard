# Audit screens

The back office page at `/audit`: who changed what, newest first, for people with `audit.read` (the manager hat, spec 0008), with filters, an entry detail, and a CSV export (`audit.export`). Also `RecordHistoryPanel`, the block other record screens embed.

## Owns

- The page: [audit-page.tsx](audit-page.tsx) (checks `audit.read`, so the api is asked for nothing without it; the no access state, or an error with Try again when the who am I call fails) and [audit-view.tsx](audit-view.tsx) (takes `enabled`; filters read from and written to the URL query, loading, empty, error with retry, the shared no access state on a 403, the export only with `audit.export`)
- The filters: [audit-filter-bar.tsx](audit-filter-bar.tsx) (person from the staff list, read only with `people.manage`, at most 500 people and it says so when the list is cut; record type and ID, action from the registry, day range, correlation ID) and [audit-filter.ts](audit-filter.ts) (URL query to filter and back, and the rules checked before a call)
- The table (an undone original carries an "Undone" badge): [audit-entries-table.tsx](audit-entries-table.tsx), and the wording of an entry in [use-entry-text.tsx](use-entry-text.tsx) (an undone entry shows the shared label with the undone action's own label under it)
- Load more and its focus rules (stays focused while loading, then the end of list line): [audit-pager.tsx](audit-pager.tsx)
- The entry detail with the field by field diff ("none" for a side the field does not have, "empty" for a stored null, "hidden, personal data" for a masked field), the same action link (focus moves to the page heading), the history toggle, the "Undone" marker, and the Undo button (only when the entry's `canUndo` is true): [audit-entry-dialog.tsx](audit-entry-dialog.tsx)
- The undo confirm dialog: [audit-undo-dialog.tsx](audit-undo-dialog.tsx) (one step: the typed reason, 1 to 500 characters, or a select of the action's `undoReasonCodes`, sits beside the destructive button; each api error shown from its code, `UNDO_NOT_POSSIBLE` with the owner's code; on success the audit list, detail, and history queries refresh and focus moves to the "This action was undone" notice)
- The record history block: [record-history-panel.tsx](record-history-panel.tsx), props `recordType` and `recordId`; it draws an `h2`, never an `h1`, and shows its own loading, empty, error, and 403 states
- The CSV export control: [audit-export-control.tsx](audit-export-control.tsx) (a `POST`, day range required, 366 day limit counting both days, the reason sent in the `x-audit-reason` header (percent encoded) never the url, 400 and 413 shown from their codes)
- The route's loading state: [audit-page-skeleton.tsx](audit-page-skeleton.tsx) (the `h1` and a skeleton table)
- Calls to the api and query keys: [audit-api.ts](audit-api.ts) (including `undoAuditEntry`, which goes through the shared `apiRequest`; the owner's `undoCode` rides in `ApiError.body`)
- Which catalog key labels an actor kind: [audit-labels.ts](audit-labels.ts) (actions and record types come from the registries in `@ssdashboard/contracts`)
- The route: `src/app/(backoffice)/audit/page.tsx`

## Never touches

- Writing an entry. Only server code records entries; the screen only reads, and its one write is the undo request (`POST /api/audit/entries/:id/undo`), which the api turns into a new entry: the list (`GET /api/audit/entries`), one entry's detail (`GET /api/audit/entries/:id`), a record's history (`GET /api/audit/records/:type/:id/entries`), and the CSV export (`POST /api/audit/entries/export`, a POST because it writes an audit entry).
- The action registry. It lives in `@ssdashboard/contracts`; the screen only reads each label key from it.
- Hard coded text. Use `t()`.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/audit
pnpm --filter @ssdashboard/web exec playwright test e2e/audit.spec.ts --project=desktop
pnpm --filter @ssdashboard/web exec playwright test e2e/no-access.spec.ts --project=desktop
```

## Governing spec

- [0010 Audit trail](../../../../docs/specs/0010-audit-trail/index.md) (AC-12, AC-13, AC-14, AC-15, AC-18)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)

## Decisions

- Filters live in the page URL (same names as the api query) so a link reproduces the view; the filter bar keeps a draft and applies it with the button, so typing never sends a call.
- The entry detail is a dialog (like the other confirm and detail dialogs); the history panel opens inside it on request and is the same component other screens embed.
- The export is fetched and saved from a blob, so a 400 or 413 shows a message on the page instead of replacing it with JSON.
- Undo is a confirm dialog opened from the detail dialog, so there is one step: reason and button together (owner question 3). An action whose record type keeps reason codes gets a select of `undoReasonCodes`; a code shows its label from `audit.undo.reasonCodes.<code>` when the catalog has one, else the code itself, so the module that adds such an action adds the label keys in the same change.
- `useReturnFocus` and `renderWithQuery` live in `src/shared` (moved from `src/inventory`).
- The page and its body are split (`AuditPage` gates, `AuditView` draws), like the other gated pages of spec 0008: the body takes `enabled` so it asks for nothing until the person is known to hold `audit.read`.
