# Season screens

The Seasons page at `/seasons`: list (active, archived, or all), create, edit with the stale check, archive, unarchive, and delete, for people holding `catalog.manage`.

## Owns

- [seasons-page.tsx](seasons-page.tsx): the `catalog.manage` gate, then the shared list
- Route: `src/app/(backoffice)/seasons/page.tsx`
- The list and the dialog are shared with product groups, one folder up: [grouping-list-view.tsx](../grouping-list-view.tsx), [grouping-dialog.tsx](../grouping-dialog.tsx), [grouping-errors.ts](../grouping-errors.ts)

## Never touches

- Styles or cost records that hold a season. Archive and delete are the api's call (`IN_USE`, `SEASON_PROTECTED`).
- Hard coded text or physical side CSS classes. Use `t()`, `useFormat()`, and logical classes.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/catalog/seasons
```

## Governing spec

- [0012 Catalog: styles and variants](../../../../../docs/specs/0012-catalog-styles-variants/index.md), AC-6, AC-16, AC-18

## Decisions

None yet. In code: the page needs `catalog.manage`, like `/locations`; a person with only `stock.view` gets the no access state (the navigation shows it to `catalog.manage` only, AC-18). The seeded `CORE` row shows "Built in" and a sentence saying why it has no Archive or Delete button, and its code is read only in the edit dialog.
