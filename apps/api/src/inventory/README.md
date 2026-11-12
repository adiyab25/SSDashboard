# Inventory and the stock ledger

Stock locations, stock levels, stock receipts, SKU lifecycle, and the ledger service. The ledger service is the only writer of stock in the system: every stock change is a posting through `LedgerService`, and a mistake is fixed by a reversal, never an edit.

Agent rules, locking and costing gotchas: [AGENTS.md](AGENTS.md).

## Owns

- The ledger service and its rules: [ledger/ledger.service.ts](ledger/ledger.service.ts), [ledger/costing.ts](ledger/costing.ts), [ledger/locks.ts](ledger/locks.ts), [ledger/ledger.errors.ts](ledger/ledger.errors.ts), [ledger/stock-transaction.ts](ledger/stock-transaction.ts)
- Nightly reconciliation of balances against movements: [ledger/reconciliation.service.ts](ledger/reconciliation.service.ts), [ledger/reconcile.job.ts](ledger/reconcile.job.ts) (its queue `ledger.reconcile`, schedule `nightly` on `LEDGER_RECONCILE_CRON`, and handler declared through the platform `JobRegistry` with the core capability `inventory.reconcile`, spec 0009 AC-10)
- Its registry row (spec 0009, AC-6, `packages/contracts/src/modules/module-registry.ts`): `inventory`, core, no toggle, with the core capability `inventory.reconcile`. Every controller here declares `@RequiresModule('inventory')` (`src/platform/modules/requires-module.spec.ts` fails the build otherwise), so the module gate never answers `MODULE_OFF` for it while the module is core.
- Locations and bins, routes under `/api/locations`: [locations/locations.controller.ts](locations/locations.controller.ts). A location has a `kind` (`warehouse`, `shop`, `transit`, `virtual`), an owner type with a party, and `sellable_online`
- The owner type policy: [locations/location-policy.service.ts](locations/location-policy.service.ts). `LocationPolicyService.policyFor(locationId)` is the only reader of `location_owner_policies` and the only code that names an owner type; `updatePolicy` is its only writer (spec 0009 AC-24, served by [locations/owner-policies.controller.ts](locations/owner-policies.controller.ts) to holders of `settings.manage`: a reason, the `policy.changed` audit entry, the stale check, 422 `OWNER_POLICY_INCONSISTENT`, 409 `OWNER_POLICY_IN_USE` for a locked field of the brand's own row or of a type with a location that is not archived, 409 `SELLABLE_LOCATIONS_EXIST`); a location archived before a locked term of its owner type's policy changed cannot be brought back (409 `OWNER_POLICY_CHANGED_SINCE_ARCHIVE`, `assertUnchangedSinceArchive` against `locked_terms_changed_at`, which only a locked field's change stamps; a change of who refunds or of online selling never blocks it: open a new location instead); everything that differs by owner type (who refunds, when a sale counts, the tax document, online selling) is a policy attribute. Owner type and party are fixed for a location's life by the database trigger `locations_owner_fixed`
- The one online location and the gate that moves it (spec 0011 AC-1, AC-19, AC-20): [locations/online-location.service.ts](locations/online-location.service.ts) and [locations/online-location.controller.ts](locations/online-location.controller.ts) (`GET /api/locations/:id/online-gate`, `POST /api/locations/:id/confirm-stock`, `POST /api/locations/:id/make-online`, `POST /api/locations/online/stop`, all `catalog.manage`; the only writers of `sellable_online`, besides the archive that clears it; create and edit no longer take it; `location.stock_confirmed`, `location.online_moved`, `location.online_stopped` audit entries). The database holds the rule: check `locations_online_needs_warehouse` and partial unique index `locations_one_online`
- The online stock read for channels (spec 0011 AC-2 to AC-4): [online-stock/online-stock.service.ts](online-stock/online-stock.service.ts) (`onlineLocation`, `forVariants`, `list`, `changedSince`, `forCandidate`; it reads only, counts the online location only, subtracts held and waiting demand from `pushable`, and raises `NoOnlineLocation` instead of answering zeros), `GET /api/stock/online-status` ([online-stock/online-status.controller.ts](online-stock/online-status.controller.ts), `stock.view`), and the registry other modules fill with online gate checks at `onModuleInit`: [online-stock/online-stock-gate.ts](online-stock/online-stock-gate.ts) (`OnlineStockGate.register`, labels are catalog message keys)
- The stock transaction and the reservation functions (spec 0011 AC-5, AC-6, AC-21, AC-22, AC-29): [ledger/stock-transaction.ts](ledger/stock-transaction.ts) (the branded `StockTransaction`, a subtype of the api's `Transaction`; a module private `WeakSet` of the transactions the runner opened and an `AsyncLocalStorage` flag that refuses a nested ledger transaction), the functions on `LedgerService` below, and the events in [inventory.events.ts](inventory.events.ts), published with `DomainEvents.publish(tx, event)`; payloads hold ids, codes, and quantities only. Filling waiting demand and shortening reservations run under the pair lock of the write that caused them; every reservation write sets `updated_at = now()`.

  | Function | Inputs | Outputs | Errors |
  | --- | --- | --- | --- |
  | `ledger.transaction(work)` | `work: (tx: StockTransaction) => Promise<T>` | `T` | `LockTimeout`, `NestedStockTransaction` (called inside a running stock transaction, `post` and `reverse` included), and whatever `work` throws (the transaction rolls back; one deadlock retry reruns `work`) |
  | `ledger.reserveLines(tx, input)` | `sourceType` (1 to 50), `sourceId`, `shortage: 'reserve_available' \| 'refuse'`, `lines[]` (1 to 200): `sourceLineId` (distinct), `variantId`, `locationId`, `quantity` (the requested total), `lotId?` | `[{ sourceLineId, reservationId, requested, held, unfilled, short }]` in input order | `InvalidInput` (also a transaction the runner did not open), `UnknownReference`, `Archived`, `NotStockable`, `TrackingMismatch`, `InsufficientStock` (only with `refuse`; `details.lines` lists `index`, `sourceLineId`, `available`, `requested`), `DuplicateReservation`, `LockTimeout` |
  | `ledger.releaseLines(tx, input)` | `sourceType`, `sourceLineIds[]` (1 to 200) | the released `Reservation[]` (may be empty) | `InvalidInput`, `LockTimeout` |
  | `ledger.releaseSource(tx, input)` | `sourceType`, `sourceId` | the released `Reservation[]` (may be empty) | `InvalidInput`, `LockTimeout` |
  | `ledger.reservationsFor(input)` | `sourceType`, `sourceId` | one row per line (its active reservation, else its latest closed one): `{ sourceLineId, reservationId, variantId, locationId, quantity, openQuantity, unfilledQuantity, status }` | `InvalidInput` |
  | `ledger.postCarrierShipment(input)` | `orderId`, `generation?` (default 1; key `order_shipment:<orderId>`, `:<n>` from 2), `effectiveAt?`, `postedBy?`, `lines[]` (1 to 200): `sourceLineId`, `variantId`, `locationId`, `quantity`, `reservationId?` | `PostingOutcome` (each movement carries `sourceLineId`, `unitCost`, `totalCost`) | `InvalidInput`, `UnknownReference`, `IdempotencyConflict`, `LockTimeout`; never `InsufficientStock`, `Archived`, `ReservationMismatch`, or `PeriodLocked` |
  | `ledger.postingFor(idempotencyKey)` | a key of 1 to 200 characters | the stored `PostingResult` of that key, or `null` | `InvalidInput` |
  | `onlineStock.onlineLocation()` | none | `{ id, code, name }` or `null` | none |
  | `onlineStock.forVariants(variantIds)` | 1 to 1,000 uuids | `OnlineStockRow[]`: `variantId`, `onHand`, `reserved`, `unfilledDemand`, `available`, `pushable` | `NoOnlineLocation`, `InvalidInput` |
  | `onlineStock.forCandidate(locationId, variantIds?)` | an active location; optional uuids, else keyset paged | `{ locationId, rows, nextAfterVariantId }` | `UnknownReference`, `InvalidInput` |
  | `onlineStock.list(query)` | `afterVariantId?`, `limit` (1 to 1,000) | `{ onlineLocationId, rows, nextAfterVariantId }` | `NoOnlineLocation` |
  | `onlineStock.changedSince(query)` | `since`, `after?`, `limit` | `{ onlineLocationId, watermark, rows, nextAfter }` | `NoOnlineLocation`, `InvalidInput` |

  | Event or registry | Published or called when | Payload |
  | --- | --- | --- |
  | `ReservationShortened` | a carrier shipment (or later a `damaged` or `missing` removal) moves held quantity to unfilled | `reservationId`, `sourceType`, `sourceId`, `sourceLineId`, `variantId`, `locationId`, `quantity`, `cause` (`carrier_shipment`, `damaged`, `missing`), `groupId` |
  | `ReservationFilled` | an inbound posting, a reversal of an outbound, or a release fills waiting demand, oldest first | `reservationId`, `sourceType`, `sourceId`, `sourceLineId`, `quantity`, `stillUnfilled` |
  | `StockOverdrawn` | a carrier shipment leaves on hand below zero | `variantId`, `locationId`, `onHandAfter`, `groupId` |
  | `StockAdjustmentRequested` | spec 0011 AC-27 (milestone 4, not built yet) | `requestId`, `locationId`, `reasonCode`, `lines`, `requestedBy` |
  | `OnlineStockGate` | a location is evaluated for the online gate | a check returns `{ key, label, passed, count, action? }` |
  | `ReturnsAwaitingRestock` | a `found` adjustment line is checked (milestone 4, not built yet) | `pendingFor({ variantIds, locationId })` |
- Stock levels and movement history, routes `/api/stock`, `/api/skus/:id/stock`, `/api/skus/:id/movements`: [stock/stock.controller.ts](stock/stock.controller.ts)
- Stock receipts, routes under `/api/stock-receipts`: [receipts/receipts.controller.ts](receipts/receipts.controller.ts)
- SKU usage, code change, archive and unarchive: [sku-lifecycle/sku-lifecycle.controller.ts](sku-lifecycle/sku-lifecycle.controller.ts)
- The ledger source types (`opening_balance`, `stock_receipt`, `order_shipment`, `consignment_sale`, `customer_return_restock`, `transfer_out`, `transfer_in`, and the rest of spec 0002's list) and the `operating_day` the database stamps on every group and movement from `effective_at`
- The ledger tables: `movement_groups`, `stock_movements`, `movement_serials`, `stock_levels`, `reservations`, `serials`, `lots`, defined in [packages/db](../../../../packages/db/src/schema/inventory.ts)
- Locations and receipts tables: [locations](../../../../packages/db/src/schema/locations.ts), [stock-receipts](../../../../packages/db/src/schema/stock-receipts.ts)

## Never touches

- Updating or deleting a stock movement. Correct with `reverse`.
- Other modules' tables. SKU rows are locked and read only through `CatalogService.lockForShare`, `lockForUpdate`, and `serialTrackedVariantIds` (spec 0011 AC-18), so `KNOWN_BREACHES` of [../module-boundary.spec.ts](../module-boundary.spec.ts) holds no `product_variants` entry for inventory.
- Ledger tables from any other folder. Other modules import `LedgerService`, `ReconciliationService`, `LocationPolicyService`, `OnlineStockService`, and `OnlineStockGate` from [inventory.module.ts](inventory.module.ts); files under `connectors/` and `channels/` import neither `LedgerService` nor `ReconciliationService` nor anything under `ledger/` ([ledger-callers.spec.ts](ledger-callers.spec.ts), spec 0011 AC-8). [../module-boundary.spec.ts](../module-boundary.spec.ts) (every module's tables, from `TABLE_OWNERSHIP` in `packages/db`) and a lint rule enforce this.
- The service schemas `PostingInput` in controllers. Routes validate with `PostingRequest` or `ReverseRequest` from `@ssdashboard/contracts` ([controller-contracts.spec.ts](controller-contracts.spec.ts)).

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/inventory
pnpm build && pnpm --filter @ssdashboard/api test:e2e
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/ledger.e2e-spec.ts
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/owner-policies.e2e-spec.ts test/location-owner-types.e2e-spec.ts
```

`owner-type-boundary.spec.ts` fails when an owner type value is compared outside the policy service (api and web source). End to end specs in `apps/api/test`: `ledger`, `ledger-tracking`, `location-owner-types` (the three way test, and a policy edited through the endpoint), `owner-policies` (spec 0009 AC-24: the edit, its refusals, its audit entry, and the unarchive refused after a policy change), `locations`, `online-stock` (spec 0011: the online location rules, the gate, the status, the online read and its change feed), `ledger-reservations` (spec 0011 milestone 2: the stock transaction, reservations, waiting demand, carrier shipments, the order thread, concurrency, `postingFor`, and the catalog locks), `stock-receipts`, `numbering-reconcile`, `scale` (all `*.e2e-spec.ts`). `scale` is excluded from `test:e2e`; it runs through `pnpm --filter @ssdashboard/api test:scale` and the `scale` CI job. They need Postgres.

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0006 Core stock loop](../../../../docs/specs/0006-core-stock-loop/index.md)
- [0011 Stock ledger and locations](../../../../docs/specs/0011-stock-ledger-locations/index.md) (milestone 1: the online location, its gate, and the online stock read; milestone 2: the stock transaction, reservations with waiting demand, carrier shipments, `postingFor`, and the catalog row locks)

## Decisions

- The app role may read `location_owner_policies` and update only its eight policy columns plus `updated_at`, `updated_by`, and `locked_terms_changed_at` (migration 0012, spec 0009 AC-24): never insert, delete, `owner_type`, or `tenant_id`. The table's CHECKs (migration 0011) keep every row consistent whoever writes it, so even a compromised api cannot offer partner or customer stock online: online selling needs the brand's own stock with no settling partner, and the consignment row always settles with its partner (owner ruling 2026-11-08).
- `LocationPolicyService` asks the partners module's `PartnerAccounts.holdsRole` (imported through `PartnersModule`) whether a location's party holds the role its owner type needs; the party row is locked `FOR SHARE` in the inserting transaction. It never reads `parties`.

Record other non obvious decisions as ADRs in docs/adr/ and link them here.
