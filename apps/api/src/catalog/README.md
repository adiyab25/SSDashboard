# Catalog

Products and their SKUs (variants) for the staff back office: create a product, list and read SKUs, edit and delete a SKU.

## Owns

- Routes, all staff only: `POST /api/products`, `GET /api/skus`, `GET /api/skus/:id`, `PATCH /api/skus/:id`, `DELETE /api/skus/:id` in [catalog.controller.ts](catalog.controller.ts)
- The catalog logic: [catalog.service.ts](catalog.service.ts), wired in [catalog.module.ts](catalog.module.ts)
- The catalog tables, defined in [packages/db](../../../../packages/db/src/schema/catalog.ts): products, options, variants, barcodes, units of measure and conversions

## Never touches

- Ledger tables (`movement_groups`, `stock_movements`, `movement_serials`, `stock_levels`, `reservations`, `serials`). Stock figures come from the inventory module.
- Other modules' tables.
- The SKU archive, unarchive and code change routes. They belong to [inventory/sku-lifecycle](../inventory/sku-lifecycle/).

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/catalog
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api test:e2e -- test/master-data.e2e-spec.ts
```

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0006 Core stock loop](../../../../docs/specs/0006-core-stock-loop/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
