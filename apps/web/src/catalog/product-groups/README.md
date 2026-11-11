# Product group screens

The Product groups page at `/product-groups`: list (active, archived, or all), create, edit with the stale check, archive, unarchive, and delete, for people holding `catalog.manage`.

## Owns

- [product-groups-page.tsx](product-groups-page.tsx): the `catalog.manage` gate, then the shared list
- Route: `src/app/(backoffice)/product-groups/page.tsx`
- The list and the dialog are shared with seasons, one folder up: [grouping-list-view.tsx](../grouping-list-view.tsx), [grouping-dialog.tsx](../grouping-dialog.tsx), [grouping-errors.ts](../grouping-errors.ts)

## Never touches

- Styles or cost records that hold a group. Archive and delete are the api's call (`IN_USE`, `PRODUCT_GROUP_PROTECTED`).
- Hard coded text or physical side CSS classes. Use `t()` and logical classes.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/catalog/product-groups
```

## Governing spec

- [0012 Catalog: styles and variants](../../../../../docs/specs/0012-catalog-styles-variants/index.md), AC-7, AC-16, AC-18

## Decisions

None yet. In code: the page needs `catalog.manage`, like `/locations`; a person with only `stock.view` gets the no access state. The seeded `MAIN` row shows "Built in" and why it has no Archive or Delete button, and its code is read only in the edit dialog.
