# Inventory screens

The stock levels page at `/stock`, stock receipts at `/stock-receipts` (list, new, detail), and locations at `/locations`.

## Owns

- Stock: [stock-page.tsx](stock-page.tsx), [stock-view.tsx](stock-view.tsx), [confirm-action-dialog.tsx](confirm-action-dialog.tsx)
- Receipts: [receipts-page.tsx](receipts-page.tsx), [receipts-view.tsx](receipts-view.tsx), [receipt-form-page.tsx](receipt-form-page.tsx), [receipt-form-view.tsx](receipt-form-view.tsx), [receipt-form-skeleton.tsx](receipt-form-skeleton.tsx), [receipt-detail-page.tsx](receipt-detail-page.tsx), [receipt-detail-view.tsx](receipt-detail-view.tsx), [void-receipt-dialog.tsx](void-receipt-dialog.tsx), [sku-picker.tsx](sku-picker.tsx)
- Locations: [locations-page.tsx](locations-page.tsx), [locations-view.tsx](locations-view.tsx), [new-location-dialog.tsx](new-location-dialog.tsx), [location-edit-dialog.tsx](location-edit-dialog.tsx)
- Calls to the api: [inventory-api.ts](inventory-api.ts)
- Routes under `src/app/(backoffice)`: `stock`, `stock-receipts`, `locations`

## Never touches

- Stock arithmetic or cost rules. The api's ledger service decides them; the screens show its answers.
- The ledger tables. The browser only calls the api.
- Hard coded text. Use `t()` and `useFormat()`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/inventory
pnpm --filter @ssdashboard/web test:e2e -- e2e/stock-loop.spec.ts
```

Other Playwright specs: `e2e/stock-page.spec.ts`, `e2e/stock-accessibility.spec.ts`, `e2e/no-access.spec.ts` (the gated pages opened without the permission).

## Governing spec

- [0006 Core stock loop](../../../../docs/specs/0006-core-stock-loop/index.md)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)
- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
