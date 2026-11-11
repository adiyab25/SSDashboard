# Catalog screens

The SKU list at `/skus` (columns, the "Name, SKU or barcode" search, season and group filters) and the SKU detail page at `/skus/[id]` (with a read only style block that links to its style), with dialogs to create and edit a SKU. The style, season, and product group screens sit in the [styles](styles/README.md), [seasons](seasons/README.md), and [product-groups](product-groups/README.md) folders.

## Owns

- List page: [skus-page.tsx](skus-page.tsx) (the access gate), [skus-view.tsx](skus-view.tsx)
- Detail page: [sku-detail-page.tsx](sku-detail-page.tsx) (the access gate), [sku-detail-view.tsx](sku-detail-view.tsx)
- List parts: [sku-filter-bar.tsx](sku-filter-bar.tsx), [sku-filter-select.tsx](sku-filter-select.tsx), [sku-name-cell.tsx](sku-name-cell.tsx)
- Detail part: [sku-style-block.tsx](sku-style-block.tsx) (style linked to `/styles/[id]`, season, group, options, barcodes; read only)
- Shared by the catalog screens: [catalog-api.ts](catalog-api.ts) (style, season, group, and barcode calls and query keys), [catalog-error.ts](catalog-error.ts), [use-grouping-choices.ts](use-grouping-choices.ts) (the active seasons and groups for pickers and filters), and the seasons and product groups list and dialog [grouping-list-view.tsx](grouping-list-view.tsx), [grouping-dialog.tsx](grouping-dialog.tsx), [grouping-errors.ts](grouping-errors.ts)
- Dialogs: [new-sku-dialog.tsx](new-sku-dialog.tsx), [sku-edit-dialog.tsx](sku-edit-dialog.tsx)
- Routes: `src/app/(backoffice)/skus/page.tsx` and `src/app/(backoffice)/skus/[id]/page.tsx`

## Decisions in code

- The season and group filters offer the active rows of `GET /api/seasons` and `GET /api/product-groups` (`useGroupingChoices`), loaded only once the person may read the catalog; an archived season or group leaves the filters (spec 0012, AC-6).
- After every catalog write a screen refreshes with `refetchAfterWrite` (`src/api/refetch-after-write.ts`), not a plain invalidation.

## Never touches

- Stock numbers computed in the browser. Stock comes from the api.
- Staff only data from the partner or portal screens.
- Hard coded text or physical side CSS classes (`left`, `ml-`). Use `t()` and logical classes.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/catalog
pnpm --filter @ssdashboard/web test:e2e -- e2e/master-data.spec.ts
pnpm --filter @ssdashboard/web test:e2e -- e2e/no-access.spec.ts
```

## Governing spec

- [0012 Catalog: styles and variants](../../../../docs/specs/0012-catalog-styles-variants/index.md)
- [0006 Core stock loop](../../../../docs/specs/0006-core-stock-loop/index.md)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)
- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
