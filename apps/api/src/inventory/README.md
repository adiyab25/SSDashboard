# Inventory and the stock ledger

Stock locations, stock levels, stock receipts, SKU lifecycle, and the ledger service. The ledger service is the only writer of stock in the system: every stock change is a posting through `LedgerService`, and a mistake is fixed by a reversal, never an edit.

Agent rules, locking and costing gotchas: [AGENTS.md](AGENTS.md).

## Owns

- The ledger service and its rules: [ledger/ledger.service.ts](ledger/ledger.service.ts), [ledger/costing.ts](ledger/costing.ts), [ledger/locks.ts](ledger/locks.ts), [ledger/ledger.errors.ts](ledger/ledger.errors.ts)
- Nightly reconciliation of balances against movements: [ledger/reconciliation.service.ts](ledger/reconciliation.service.ts), [ledger/reconcile.job.ts](ledger/reconcile.job.ts)
- Locations and bins, routes under `/api/locations`: [locations/locations.controller.ts](locations/locations.controller.ts)
- Stock levels and movement history, routes `/api/stock`, `/api/skus/:id/stock`, `/api/skus/:id/movements`: [stock/stock.controller.ts](stock/stock.controller.ts)
- Stock receipts, routes under `/api/stock-receipts`: [receipts/receipts.controller.ts](receipts/receipts.controller.ts)
- SKU usage, code change, archive and unarchive: [sku-lifecycle/sku-lifecycle.controller.ts](sku-lifecycle/sku-lifecycle.controller.ts)
- The ledger tables: `movement_groups`, `stock_movements`, `movement_serials`, `stock_levels`, `reservations`, `serials`, `lots`, defined in [packages/db](../../../../packages/db/src/schema/inventory.ts)
- Locations and receipts tables: [locations](../../../../packages/db/src/schema/locations.ts), [stock-receipts](../../../../packages/db/src/schema/stock-receipts.ts)

## Never touches

- Updating or deleting a stock movement. Correct with `reverse`.
- Other modules' tables.
- Ledger tables from any other folder. Other modules import `LedgerService` and `ReconciliationService` from [inventory.module.ts](inventory.module.ts). [module-boundary.spec.ts](module-boundary.spec.ts) and a lint rule enforce this.
- The service schemas `PostingInput` in controllers. Routes validate with `PostingRequest` or `ReverseRequest` from `@ssdashboard/contracts` ([controller-contracts.spec.ts](controller-contracts.spec.ts)).

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/inventory
pnpm build && pnpm --filter @ssdashboard/api test:e2e
pnpm --filter @ssdashboard/api test:e2e -- test/ledger.e2e-spec.ts
```

End to end specs in `apps/api/test`: `ledger`, `ledger-tracking`, `locations`, `stock-receipts`, `numbering-reconcile`, `scale` (all `*.e2e-spec.ts`). `scale` seeds 100,000 SKUs and adds about 1m45s. They need Postgres.

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0006 Core stock loop](../../../../docs/specs/0006-core-stock-loop/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
