# Style screens

The style list at `/styles` (search, season with "No season", group, and status filters, and the bulk "Set season" and "Set group" steps) and the style page at `/styles/[id]` (facts, options, SKUs, and the edit, code, add SKU, and barcode dialogs).

## Owns

- List page: [styles-page.tsx](styles-page.tsx) (the `stock.view` gate), [styles-view.tsx](styles-view.tsx), [style-filter-bar.tsx](style-filter-bar.tsx), [style-assign-dialog.tsx](style-assign-dialog.tsx)
- Style page: [style-detail-page.tsx](style-detail-page.tsx) (the `stock.view` gate), [style-detail-view.tsx](style-detail-view.tsx), [style-detail-skeleton.tsx](style-detail-skeleton.tsx), [style-view.tsx](style-view.tsx)
- Dialogs: [style-edit-dialog.tsx](style-edit-dialog.tsx) (`catalog.edit`), [style-code-dialog.tsx](style-code-dialog.tsx) (`catalog.manage`), [add-variant-dialog.tsx](add-variant-dialog.tsx) (`catalog.edit`), [variant-barcodes-dialog.tsx](variant-barcodes-dialog.tsx) (`catalog.edit`)
- Routes under `src/app/(backoffice)`: `styles/page.tsx`, `styles/[id]/page.tsx`
- The calls to the api live one folder up in [catalog-api.ts](../catalog-api.ts); the season and group choices in [use-grouping-choices.ts](../use-grouping-choices.ts).

## Never touches

- Stock or cost. Cost on the style page arrives with spec 0012 milestone 3.
- The catalog tables. The browser only calls the api, and every write refreshes the style, style list, and SKU queries with `refetchAfterWrite` (`src/api/refetch-after-write.ts`).
- Hard coded text or physical side CSS classes. Use `t()`, `useFormat()`, and logical classes.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/catalog/styles
```

The Playwright spec `e2e/styles.spec.ts` (both languages, keyboard, axe, phone width) is spec 0012 task 12.

## Governing spec

- [0012 Catalog: styles and variants](../../../../../docs/specs/0012-catalog-styles-variants/index.md), AC-8 to AC-10, AC-16, AC-18
- [0008 Roles as hats](../../../../../docs/specs/0008-roles-as-hats/index.md)

## Decisions

None yet. In code: changing a list filter clears the selection, so a bulk step never touches a style the person no longer sees. In the add SKU dialog, an option name or value typed with Arabic letters is sent as its Arabic text and anything else as English (the api matches either language). The edit dialog draws its season and group pickers only once the choices loaded, so a native select never saves its first option by accident.
