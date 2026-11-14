# Style screens

The style list at `/styles` (search, season with "No season", group, and status filters, and the bulk "Set season" and "Set group" steps) and the style page at `/styles/[id]` (facts, options, SKUs, and the edit, code, add SKU, barcode, and record cost dialogs; for a `cost.view` holder also each SKU's cost and the cost history).

## Owns

- List page: [styles-page.tsx](styles-page.tsx) (the `stock.view` gate), [styles-view.tsx](styles-view.tsx), [style-filter-bar.tsx](style-filter-bar.tsx), [style-assign-dialog.tsx](style-assign-dialog.tsx)
- Linked styles (spec 0012, AC-15, AC-18): [style-view.tsx](style-view.tsx) labels the channel owned name, product type, brand, tags, options, variant price, and `fromChannel` barcode "From Shopify"; [style-edit-dialog.tsx](style-edit-dialog.tsx) makes the channel name and tags read only (tags are sent only when changed); [variant-barcodes-dialog.tsx](variant-barcodes-dialog.tsx) draws no Remove on the channel barcode; [add-variant-dialog.tsx](add-variant-dialog.tsx) offers only the existing option names and values; each names the field of a 409 `FIELD_OWNED_BY_CHANNEL`
- Style page: [style-detail-page.tsx](style-detail-page.tsx)(style-detail-page.tsx) (the `stock.view` gate), [style-detail-view.tsx](style-detail-view.tsx), [style-detail-skeleton.tsx](style-detail-skeleton.tsx), [style-view.tsx](style-view.tsx)
- Dialogs: [style-edit-dialog.tsx](style-edit-dialog.tsx) (`catalog.edit`), [style-code-dialog.tsx](style-code-dialog.tsx) (`catalog.manage`), [add-variant-dialog.tsx](add-variant-dialog.tsx) (`catalog.edit`), [variant-barcodes-dialog.tsx](variant-barcodes-dialog.tsx) (`catalog.edit`), [record-cost-dialog.tsx](record-cost-dialog.tsx) (`catalog.edit` plus `cost.view`)
- Cost (`cost.view` only, spec 0012 AC-12, AC-13): [variant-cost-cell.tsx](variant-cost-cell.tsx) (the cost column cell), [style-cost-history.tsx](style-cost-history.tsx) (the cost history panel, the only caller of the cost records route)
- Routes under `src/app/(backoffice)`: `styles/page.tsx`, `styles/[id]/page.tsx`
- The calls to the api live one folder up in [catalog-api.ts](../catalog-api.ts); the season and group choices in [use-grouping-choices.ts](../use-grouping-choices.ts).

## Never touches

- Stock. Cost is drawn and asked for only with `cost.view`: without it there is no column, no panel, no Record cost button, and no request to a cost route.
- The catalog tables. The browser only calls the api, and every write refreshes the style, style list, and SKU queries (a recorded cost, the style and its cost records) with `refetchAfterWrite` (`src/api/refetch-after-write.ts`).
- Hard coded text or physical side CSS classes. Use `t()`, `useFormat()`, and logical classes.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/catalog/styles
```

The Playwright spec `e2e/styles.spec.ts` (both languages, keyboard, axe, phone width) is spec 0012 task 12; the cost screens have component tests in `style-cost.spec.tsx`, and their Playwright steps are owed to QA (task 16).

## Governing spec

- [0012 Catalog: styles and variants](../../../../../docs/specs/0012-catalog-styles-variants/index.md), AC-8 to AC-10, AC-12, AC-13, AC-16, AC-18
- [0008 Roles as hats](../../../../../docs/specs/0008-roles-as-hats/index.md)

## Decisions

None yet. In code: changing a list filter clears the selection, so a bulk step never touches a style the person no longer sees. In the add SKU dialog, an option name or value typed with Arabic letters is sent as its Arabic text and anything else as English (the api matches either language). The edit dialog draws its season and group pickers only once the choices loaded, so a native select never saves its first option by accident.
