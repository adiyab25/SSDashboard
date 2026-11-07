# Audit screens

The back office page at `/audit`: who changed what, newest first, for people with `audit.read` (the manager hat, spec 0008).

## Owns

- The page: [audit-page.tsx](audit-page.tsx) (loading, empty, error with retry, the 403 state, Load more)
- The table: [audit-entries-table.tsx](audit-entries-table.tsx)
- Calls to the api and query keys: [audit-api.ts](audit-api.ts)
- Which catalog key labels an action, an actor kind, or a record type: [audit-labels.ts](audit-labels.ts)
- The route: `src/app/(backoffice)/audit/page.tsx`

## Never touches

- Writing an entry. Only server code records entries; the screen reads `GET /api/audit/entries`.
- The action registry. It lives in `@ssdashboard/contracts`; the screen only reads each label key from it.
- Hard coded text. Use `t()`.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/audit
pnpm --filter @ssdashboard/web exec playwright test e2e/audit.spec.ts --project=desktop
```

## Governing spec

- [0010 Audit trail](../../../../docs/specs/0010-audit-trail/index.md) (AC-12, AC-18)

## Decisions

Milestone 1 ships the list only. Filters, the entry detail with the before and after diff, and the
record history panel are milestone 3; `AuditFilter` in `audit-api.ts` and the filter in the query
key are where they plug in.
