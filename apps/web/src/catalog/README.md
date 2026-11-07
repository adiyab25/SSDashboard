# Catalog screens

The SKU list at `/skus` and the SKU detail page at `/skus/[id]`, with dialogs to create and edit a SKU.

## Owns

- List page: [skus-page.tsx](skus-page.tsx) (the access gate), [skus-view.tsx](skus-view.tsx)
- Detail page: [sku-detail-page.tsx](sku-detail-page.tsx) (the access gate), [sku-detail-view.tsx](sku-detail-view.tsx)
- Dialogs: [new-sku-dialog.tsx](new-sku-dialog.tsx), [sku-edit-dialog.tsx](sku-edit-dialog.tsx)
- Routes: `src/app/(backoffice)/skus/page.tsx` and `src/app/(backoffice)/skus/[id]/page.tsx`

## Never touches

- Stock numbers computed in the browser. Stock comes from the api.
- Staff only data from the partner or portal screens.
- Hard coded text or physical side CSS classes (`left`, `ml-`). Use `t()` and logical classes.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/catalog
pnpm --filter @ssdashboard/web test:e2e -- e2e/master-data.spec.ts
pnpm --filter @ssdashboard/web test:e2e -- e2e/no-access.spec.ts
```

## Governing spec

- [0006 Core stock loop](../../../../docs/specs/0006-core-stock-loop/index.md)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)
- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
