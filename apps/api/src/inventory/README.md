# Inventory and the stock ledger

Stock locations, stock levels, stock receipts, SKU lifecycle, and the ledger service. The ledger service is the only writer of stock in the system: every stock change is a posting through `LedgerService`, and a mistake is fixed by a reversal, never an edit.

Agent rules, locking and costing gotchas: [AGENTS.md](AGENTS.md).

## Owns

- The ledger service and its rules: [ledger/ledger.service.ts](ledger/ledger.service.ts), [ledger/costing.ts](ledger/costing.ts), [ledger/locks.ts](ledger/locks.ts), [ledger/ledger.errors.ts](ledger/ledger.errors.ts)
- Nightly reconciliation of balances against movements: [ledger/reconciliation.service.ts](ledger/reconciliation.service.ts), [ledger/reconcile.job.ts](ledger/reconcile.job.ts)
- Locations and bins, routes under `/api/locations`: [locations/locations.controller.ts](locations/locations.controller.ts). A location has a `kind` (`warehouse`, `shop`, `transit`, `virtual`), an owner type with a party, and `sellable_online`
- The owner type policy: [locations/location-policy.service.ts](locations/location-policy.service.ts). `LocationPolicyService.policyFor(locationId)` is the only reader of `location_owner_policies` and the only code that names an owner type; everything that differs by owner type (who refunds, when a sale counts, the tax document, online selling) is a policy attribute. Owner type and party are fixed for a location's life by the database trigger `locations_owner_fixed`
- Stock levels and movement history, routes `/api/stock`, `/api/skus/:id/stock`, `/api/skus/:id/movements`: [stock/stock.controller.ts](stock/stock.controller.ts)
- Stock receipts, routes under `/api/stock-receipts`: [receipts/receipts.controller.ts](receipts/receipts.controller.ts)
- SKU usage, code change, archive and unarchive: [sku-lifecycle/sku-lifecycle.controller.ts](sku-lifecycle/sku-lifecycle.controller.ts)
- The ledger source types (`opening_balance`, `stock_receipt`, `order_shipment`, `consignment_sale`, `customer_return_restock`, `transfer_out`, `transfer_in`, and the rest of spec 0002's list) and the `operating_day` the database stamps on every group and movement from `effective_at`
- The ledger tables: `movement_groups`, `stock_movements`, `movement_serials`, `stock_levels`, `reservations`, `serials`, `lots`, defined in [packages/db](../../../../packages/db/src/schema/inventory.ts)
- Locations and receipts tables: [locations](../../../../packages/db/src/schema/locations.ts), [stock-receipts](../../../../packages/db/src/schema/stock-receipts.ts)

## Never touches

- Updating or deleting a stock movement. Correct with `reverse`.
- Other modules' tables, with recorded exceptions listed in `KNOWN_BREACHES` of [../module-boundary.spec.ts](../module-boundary.spec.ts): `LocationPolicyService` reads `parties` (the role check for a partner or wholesale location) until the partners module has a service, and the ledger and reconciliation lock `product_variants` rows (spec 0006) until catalog offers a locking service.
- Ledger tables from any other folder. Other modules import `LedgerService`, `ReconciliationService`, and `LocationPolicyService` from [inventory.module.ts](inventory.module.ts). [../module-boundary.spec.ts](../module-boundary.spec.ts) (every module's tables, from `TABLE_OWNERSHIP` in `packages/db`) and a lint rule enforce this.
- The service schemas `PostingInput` in controllers. Routes validate with `PostingRequest` or `ReverseRequest` from `@ssdashboard/contracts` ([controller-contracts.spec.ts](controller-contracts.spec.ts)).

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/inventory
pnpm build && pnpm --filter @ssdashboard/api test:e2e
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/ledger.e2e-spec.ts
```

`owner-type-boundary.spec.ts` fails when an owner type value is compared outside the policy service (api and web source). End to end specs in `apps/api/test`: `ledger`, `ledger-tracking`, `location-owner-types` (the three way test), `locations`, `stock-receipts`, `numbering-reconcile`, `scale` (all `*.e2e-spec.ts`). `scale` is excluded from `test:e2e`; it runs through `pnpm --filter @ssdashboard/api test:scale` and the `scale` CI job. They need Postgres.

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0006 Core stock loop](../../../../docs/specs/0006-core-stock-loop/index.md)

## Decisions

- The app role has SELECT only on `location_owner_policies` (the baseline revokes the rest), so a compromised api cannot turn on online selling for partner stock. Feature 9, which owns editing the policy, grants editing back.
- `LocationPolicyService` reads `parties` directly for now; see Never touches. Remove the read when the partners module exists.

Record other non obvious decisions as ADRs in docs/adr/ and link them here.
