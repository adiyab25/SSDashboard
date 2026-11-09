# Catalog

Products and their SKUs (variants) for the staff back office: create a product, list and read SKUs, edit and delete a SKU.

## Owns

- Routes, all staff only: `POST /api/products`, `GET /api/skus`, `GET /api/skus/:id`, `PATCH /api/skus/:id`, `DELETE /api/skus/:id` in [catalog.controller.ts](catalog.controller.ts)
- The catalog logic: [catalog.service.ts](catalog.service.ts), wired in [catalog.module.ts](catalog.module.ts)
- SKU search (spec 0012, AC-3 and AC-4): [search/sku-list-sql.ts](search/sku-list-sql.ts). `GET /api/skus` first runs `ssd_search_normalize(q)` in SQL (the same function the stored `product_variants.search_text` uses), keeps the first 5 distinct words, then `buildSkuListSql` unions three branches, each filtered (status, `seasonId` or `none`, `productGroupId`, `styleId`, cursor), ordered by code (`COLLATE "C"`), and limited: the exact barcode (`barcodes_code_unique`), the code prefix (`product_variants_sku_c_idx`), and, when a word has 3 or more characters, every word contained in `search_text` (`product_variants_search_trgm_idx`). Rows carry the style, season, product group, and option values; `GET /api/skus/:id` adds the barcodes. `search_text` is kept by database triggers, never by this module's code
- Cost lookup: [cost.service.ts](cost.service.ts) `CostService.costFor(variantId, onDate)` returns the unit cost with its cost basis from `cost_records` (a variant override beats its style's record on the same day; the latest `recorded_at` breaks the next tie, and the greatest `id` the last one), or `not_set`, never 0. The rule is the pure [cost-selection.ts](cost-selection.ts). Cost records are append only
- Renaming a SKU also renames the style code of a one variant product whose style code was the old SKU code; a code that only another product's style holds answers `STYLE_CODE_TAKEN` (409), a code another SKU holds `SKU_TAKEN`
- A product is a style: `style_code` (the SKU code on the create path), a `product_group` (`MAIN` for a one line brand) and an optional season
- The catalog tables, defined in [packages/db](../../../../packages/db/src/schema/catalog.ts): products, options, variants, barcodes, units of measure and conversions, product groups, seasons, and cost records

- Its registry row (spec 0009, AC-6, `packages/contracts/src/modules/module-registry.ts`): `catalog`, core, no toggle. Every controller here declares `@RequiresModule('catalog')` (`src/platform/modules/requires-module.spec.ts` fails the build otherwise), so the module gate never answers `MODULE_OFF` for it while the module is core.

## Never touches

- Ledger tables (`movement_groups`, `stock_movements`, `movement_serials`, `stock_levels`, `reservations`, `serials`). Stock figures come from the inventory module.
- Other modules' tables.
- The SKU archive, unarchive and code change routes. They belong to [inventory/sku-lifecycle](../inventory/sku-lifecycle/).

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/catalog
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/master-data.e2e-spec.ts test/cost.e2e-spec.ts
```

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0006 Core stock loop](../../../../docs/specs/0006-core-stock-loop/index.md)
- [0012 Catalog, styles and variants](../../../../docs/specs/0012-catalog-styles-variants/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
