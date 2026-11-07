# 0011. Stock ledger and locations: one online location, an online stock read for channels, reservations for documents, and manual corrections on the built ledger

**Date**: 2026-11-07
**Status**: Proposed
**Feature**: scope feature 11, [Stock ledger & locations](../../scope/confirmation-to-cash.md) (Slice 1a, Core, GA)
**Depends on**: the built ledger of [spec 0002](../0002-core-data-model/index.md) (AC-1 to AC-13, AC-29, AC-31, AC-36) and [spec 0006](../0006-core-stock-loop/index.md) (receipts, voids, the Stock page, locations management); hats and permissions of [spec 0008](../0008-roles-as-hats/index.md); the audit writer of [spec 0010](../0010-audit-trail/index.md). Neighbours in the same wave call this spec's services and never write its tables: orders (spec 0013), the Shopify connector (spec 0015), catalog (spec 0012); they are written in parallel, so they are named here without links.

## Summary

Most of the stock ledger already exists: every stock change is an unchangeable movement with its quantity, cost, place, and source document, and a correction is always a new movement. This feature adds the few pieces the order flow needs on top of it. Exactly one warehouse is the brand's online stock location, and a new read tells Shopify and the portal how many pieces of each variant can be sold online there, so stock at a showroom partner can never be offered online. Orders get a way to hold stock for all the lines of an order at once, and to release it, in their own transaction. A manager gets two correction tools the pilot needs before full stock counts exist: a manual stock adjustment with a reason, and a screen for the mismatches the nightly check finds. The location screens learn owner types (own, consignment partner, wholesale customer) and the party behind them.

## Requirements

**User stories**:

- As the Shopify connector (spec 0015), I want one call that tells me how many pieces of each variant may be sold online, and which variants changed since my last run, so the store never offers stock we do not have or that sits at a partner.
- As the orders module (spec 0013), I want to hold stock for an order's lines in the same transaction that writes the order, as far as stock allows, and to release it when the order is cancelled or edited, so two orders never take the same piece and a short line is visible at once.
- As a manager, I want to correct stock with a reason when pieces are found, missing, or damaged, so the numbers stay true between stock counts, and every correction is traceable.
- As a manager, I want to see the mismatches the nightly check found and fix or dismiss each one, so a drifted balance never sits unnoticed.
- As a manager, I want to create a location for a consignment partner or a wholesale customer with its party, and see which one location feeds online stock, so stock at partners is counted but never sold online.

**Already built, kept as the contract** (not rebuilt here): spec 0002 AC-1 to AC-13 (the ledger: movements with quantity, unit cost, location, source type and id; append only history; reversal as the only correction; idempotent postings; the reserved stock rule; nightly reconciliation), AC-29 (owner type fixed for life, `LocationPolicyService`, the boundary test, the three way test), AC-31 (opening stock and restocks carry a cost), AC-36 (the 50,000 SKU scale suite); spec 0006 AC-1 to AC-17 (receipts, voids, the Stock page, SKU history, locations management). This feature's tests must keep every one of their suites green.

**Acceptance criteria**:

- **AC-1** (one online location): A location may have `sellable_online` true only when its `kind` is `warehouse`, `is_sellable` is true, it is not archived, and its owner type's policy has `can_sell_online`; at most one such location exists per brand (owner decision Q-11.2, recommended). Turning it on for a second location answers 409 `ONLINE_LOCATION_EXISTS` (also when two requests race: the database refuses the second); for a shop 422 `ONLINE_NEEDS_WAREHOUSE`; for a partner or wholesale location 422 `NOT_SELLABLE_ONLINE`. The database holds the rule by a check and a partial unique index, so no writer can break it. Archiving the online location turns `sellable_online` off in the same update.
- **AC-2** (online stock read): `OnlineStockService.forVariants(variantIds)` returns, for each asked variant, `onHand`, `reserved`, `available`, and `pushable` at the online location, where `available` is on hand in sellable places minus active reservations (the meaning of spec 0002 AC-9) and `pushable` is `available` floored at 0; a variant with no balance there returns zeros. Stock at any other location (a partner, a wholesale customer, a shop, a second warehouse, transit, scrap) never adds to any of these numbers. With no online location every read raises `NoOnlineLocation` and never answers zeros.
- **AC-3** (full online list): `OnlineStockService.list({ afterVariantId, limit })` pages every variant with a balance at the online location by variant id, up to 1,000 a page, with the same fields as AC-2; a variant absent from every page has `pushable` 0.
- **AC-4** (changes since a run): `OnlineStockService.changedSince({ since, after, limit })` returns each variant whose balance or reservation at the online location changed after `since`, with its current AC-2 numbers, its `changedAt`, the `onlineLocationId`, and a `watermark` (the database time minus 5 minutes). A caller that pages through all rows with `after` and then stores the first page's `watermark` as its next `since` sees every change at least once, including a change whose transaction committed late; seeing a variant twice is allowed. When `onlineLocationId` differs from the one the caller stored, the caller resyncs with AC-3.
- **AC-5** (hold stock for document lines, in the caller's transaction): `LedgerService.transaction(work)` opens a stock transaction (the ledger's own: READ COMMITTED, the 5 second lock cap per wait, one deadlock retry that reruns `work`) in which the caller writes its own rows and calls `reserveLines(tx, { sourceType, sourceId, shortage, lines })` for 1 to 200 lines, each with its `sourceLineId`, SKU, location, and requested quantity. With `shortage: 'reserve_available'` each line is reserved as far as stock allows (lines on the same SKU, location, and lot share what is available, in input order) and the call never fails for a shortage; with `shortage: 'refuse'` every line is fully reserved or the call raises `InsufficientStock` listing each short line's index, available, and requested quantity, and writes nothing. Each line answers `reservationId` (null when nothing could be held), `requested`, `reserved`, and `short`. A line that already holds an active reservation on the same SKU, location, and lot is topped up toward `requested` and never lowered, so calling again after stock arrives fills a short line and a repeat that changes nothing writes nothing; an active reservation on another SKU or location for the same line raises `DuplicateReservation`. Every reservation function refuses a transaction not opened by `LedgerService.transaction` (a type the module brands).
- **AC-6** (release and read): `releaseLines(tx, { sourceType, sourceLineIds })` and `releaseSource(tx, { sourceType, sourceId })` release the active reservations of those lines or of the whole document and return them (none gives an empty list); `reservationsFor({ sourceType, sourceId })` reads each line's reservation (`quantity`, `openQuantity`, `status`). A shipment that names a reservation (`post` with `reservationId`, spec 0002) fulfils it as today; a line reserved short posts its reserved part with its `reservationId` and the rest as a second line of the same `sourceLineId` without one, which the reserved stock rule then checks.
- **AC-7** (the order thread holds together): in one stock transaction write a fixture order row and reserve two lines, one short; after a receipt, call `reserveLines` again and the short line fills; ship one line through an `order_shipment` posting that names its reservation, and release the other with `releaseSource`: on hand, reserved, available, and `pushable` are right after each step, `changedSince` reports the variant after each step, a forced deadlock reruns the whole transaction once with one order row and one set of reservations as the result, and a reconciliation run records no discrepancy.
- **AC-8** (channels never write stock, review m2): no file under `apps/api/src/connectors/` or `apps/api/src/channels/` imports `LedgerService`, `ReconciliationService`, or anything under `apps/api/src/inventory/ledger/`; a static test fails such an import. Inbound channel stock figures can therefore only ever be compared with the ledger, never posted.
- **AC-9** (manual adjustment): a person holding `stock.correct` posts a stock adjustment (owner decision Q-11.1, recommended) through `POST /api/stock-adjustments` with an `Idempotency-Key` UUID: one active warehouse or shop location, 1 to 200 lines (each a different SKU, a non zero whole quantity up to 1,000,000 either way, and a reason code), and a written reason of 1 to 500 characters. One ledger posting of source type `adjustment`, dated now, carries every line with its reason code, and the audit entry `stock.adjusted_manually` (reason required) is written in the same transaction. The same key and body answers 200 with the same result to the person who posted it and moves stock once; any other body or person answers 409 `IDEMPOTENCY_CONFLICT`. A line that would take stock below zero or below reserved answers 409 `INSUFFICIENT_STOCK` naming the SKUs, and nothing is posted.
- **AC-10** (cost of a found piece): an adjustment line that adds stock takes the balance's average unit cost when that balance exists and its average is above 0, else the style cost from `CostService.costFor(variant, today's operating day)`; with neither, the whole adjustment answers 422 `INVALID_LINES` with `COST_NOT_SET` on that line and posts nothing (owner decision Q-11.5, recommended). A line that removes stock is costed by the ledger's outbound rule. Nobody types a cost.
- **AC-11** (adjustments are visible): a SKU's movement history shows an adjustment row as "Adjustment" with its reason code in the reader's language and who posted it; the audit trail shows the entry with the written reason; unit cost and value are shown only with `cost.view` (spec 0008 AC-6), replays included.
- **AC-12** (locations with an owner type): a person holding `catalog.manage` creates a location choosing an owner type and, when that owner type needs one, a party holding the matching role, both from lists the api returns (`GET /api/locations/owner-types`, `GET /api/locations/party-options`); the web never names an owner type value (the owner type boundary test of spec 0002 still passes). The edit dialog shows owner type and party read only, and offers the online switch only where AC-1 allows it, with each refusal shown on the field. The Locations list shows each location's owner type, its party, and an "Online stock" badge on the online location. Creating a party stays with feature 41 (owner decision Q-11.4, recommended); with no party of the needed role the dialog says so.
- **AC-13** (location creation is audited): creating a location writes `location.created` (reason optional) with the code as label and `after` holding code, kind, owner type, party id, and `sellableOnline`, in the creating transaction; `location.edited` and `location.archived` keep recording a change of `sellable_online` in `before` and `after`.
- **AC-14** (mismatches a manager can act on): a person holding `stock.correct` lists the reconciliation's discrepancies (open by default, resolved on request, newest first, 50 a page) with SKU, location, kind, expected, actual, and when found; rebuilds a `balance` one (reason optional, audit `stock_discrepancy.rebuilt`); and dismisses any open one with a written reason (audit `stock_discrepancy.dismissed`) (owner decision Q-11.3, recommended). Rebuilding a closed one answers 409 `DISCREPANCY_CLOSED`, a reservation or serial one 422 `NOT_REBUILDABLE`, a lock wait past the cap 503 `BUSY`. When the SKU or location is archived the rebuild dialog warns that stock may reappear there (spec 0006 accepted edge). Value fields of expected and actual are shown only with `cost.view`.
- **AC-15** (fast at 50,000 SKUs): with the spec 0002 scale load plus one online location holding 50,000 balances and 5,000 active reservations, on the dev PostgreSQL at the 95th percentile: `forVariants` for 250 variants under 50 ms; a `list` page of 1,000 under 150 ms; `changedSince` over a 10 minute window with 1,000 changed variants, one page of 1,000, under 150 ms; the Stock page's first page filtered by one location under 150 ms; `reserveLines` of 10 lines under 100 ms. Each read's plan is asserted to use the index this spec names. The budgets are **Assumed** and reset from the first measured run.
- **AC-16** (screens): the location dialogs, the adjustment form, and the discrepancies page work in English and Arabic (right to left) with no hard coded text, codes in `LtrText`, quantities and dates through `useFormat()`, exactly one `<h1>` per page, loading, empty, and error states, and full keyboard use (WCAG 2.2 AA, `packages/ui/DESIGN.md`). A page opened without its permission shows the no access state.
- **AC-17** (routes and permissions): every new route declares `@Audience('staff')` and the one permission in the API surface table below, and has a `FIXTURES` entry in `apps/api/test/access-sweep.e2e-spec.ts`; the sweep passes. No new permission or hat is added.
- **AC-18** (inventory reads no catalog table): the ledger and the reconciliation lock SKU rows only through `CatalogService.lockForShare` and `lockForUpdate` (taken here from spec 0012's follow up), so `KNOWN_BREACHES` in `apps/api/src/module-boundary.spec.ts` holds no `product_variants` entry for inventory, and the archive, rebuild, and code change races of spec 0006 behave exactly as before.

## Decision

**Chosen option**: Option 1: thin additions on the built ledger. A read service for online stock with a time window change feed, batch reservations in the caller's stock transaction, one online location held by the database, and two manager correction tools (adjustment, discrepancies), with no new table.

The ledger's posting, costing, locking, and reconciliation rules do not change. New behaviour lives in `apps/api/src/inventory/` only: `OnlineStockService` (new folder `online-stock/`), `transaction`, `reserveLines`, `releaseLines`, `releaseSource`, and `reservationsFor` in `LedgerService`, `dismiss` in `ReconciliationService`, new folders `adjustments/` and `discrepancies/`, and the locations service and controller. One schema change adds `reservations.updated_at`, two indexes, one check, and one partial unique index.

**Owner decisions** (made here as recommended, each changeable; see `## Questions for the owner`): Q-11.1 manual adjustments ship in this feature, manager only; Q-11.2 exactly one online location per brand; Q-11.3 the discrepancy screen ships in this feature; Q-11.4 partner and wholesale locations get their screen now, their parties come with feature 41; Q-11.5 a found piece is costed at the balance average, then the style cost, else refused.

**Implementation skills**: `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `tanstack-query` (`.claude/skills/tanstack-query/`) · `react-hook-form-zod` (`.claude/skills/react-hook-form-zod/`) · `shadcn` (`.claude/skills/shadcn/`) · `playwright-best-practices` (`.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### What is already built, and what this feature adds

| Scope "done when" | Built today | Added here |
|---|---|---|
| Every stock change is a new movement with quantity, unit cost, location, and source document | `LedgerService.post` and `reverse` (spec 0002 AC-3), receipts (spec 0006) | Adjustments post through the same service (AC-9); channels can never post (AC-8) |
| A correction is a new movement, never an edit | append only tables, revokes, triggers (spec 0002 AC-2); receipt void (spec 0006 AC-8) | Manual adjustment (AC-9, AC-10); discrepancy rebuild and dismiss (AC-14) |
| Partner stock is never offered online | owner type policy `can_sell_online` false for partners, `NotSellableOnline` (spec 0002 AC-29) | One online location held by the database (AC-1); the online read counts only that location (AC-2 to AC-4) |
| On hand per variant and location reads fast at 50,000 SKUs | `getAvailable` for one SKU under 50 ms (spec 0002 AC-36) | Batch online read, change feed, Stock page by location, `reserveLines` budgets (AC-15) |
| Locations carry an owner type and a sellable online flag | columns, trigger, policy table, api create with owner type and party (spec 0002 A13) | The screens for owner type and party, owner type and party lists from the api, `location.created` audit (AC-12, AC-13) |
| Bins stay flat | `bins` table, unused | Nothing: no bin screen, no posting names a bin |

Transfers between locations stay with features 38 and 55, counts with feature 54, partner handovers with feature 41, restocks of returned pieces with feature 21 (they post through the existing `post`).

### Where it lives

- `apps/api/src/inventory/online-stock/`: `OnlineStockService` (exported by `InventoryModule`), its error `OnlineStockError` (`NoOnlineLocation`), no controller (only other modules call it).
- `apps/api/src/inventory/ledger/`: `transaction` (exported runner over `ledgerTransaction`, handing out a branded `StockTransaction`), `reserveLines`, `releaseLines`, `releaseSource`, `reservationsFor`, and `updated_at` on every reservation write in `ledger.service.ts`; `dismiss` in `reconciliation.service.ts`.
- `apps/api/src/inventory/adjustments/`: `AdjustmentsController`, `AdjustmentsService` (calls `LedgerService.post` with `within` for the audit entry, `CostService.costFor` from catalog for found pieces).
- `apps/api/src/inventory/discrepancies/`: `DiscrepanciesController`, `DiscrepanciesService` (reads `stock_level_discrepancies`, calls `ReconciliationService.rebuildLevel` and `dismiss`, names SKUs through `CatalogService.getSkus`).
- `apps/api/src/inventory/locations/`: online rules in `LocationsService`, the two list routes in `LocationsController`, `LocationPolicyService.describeOwnerTypes()`.
- `apps/api/src/partners/`: `PartnerAccounts.listHolding(role)` and `namesByIds(ids)` (id, code, name of parties, not archived), so inventory never reads `parties`.
- `apps/api/src/catalog/`: `CatalogService.lockForShare` and `lockForUpdate` on variant rows, taken here from spec 0012's follow up (AC-18), so inventory never reads `product_variants`.
- `packages/contracts/src/`: `online-stock.ts` (row and cursor shapes), `stock-adjustments.ts`, `stock-discrepancies.ts`, the location list shapes in `locations.ts`, `ReserveLinesInput`, `ReleaseLinesInput`, `ReleaseSourceInput`, and `ReservationsForInput` in `inventory.ts`; audit codes and record types in `audit/`.
- `apps/web/src/inventory/`: the location dialogs and list, `adjustment-form-page.tsx` (route `/stock-adjustments/new`), `discrepancies-page.tsx` (route `/stock-discrepancies`), nav items with `needs`.

### Data model

No new table. Changes to tables the inventory module owns (`packages/db/src/schema/locations.ts`, `inventory.ts`):

| Table | Change | Why |
|---|---|---|
| `locations` | check `locations_online_needs_warehouse`: `NOT sellable_online OR (kind = 'warehouse' AND is_sellable)` | AC-1: only a sellable warehouse feeds online stock (scope: "only the warehouse sells online") |
| `locations` | partial unique index `locations_one_online` on (`tenant_id`) `WHERE sellable_online AND archived_at IS NULL` | AC-1: at most one online location; a racing second update fails on the index (23505), mapped to 409 `ONLINE_LOCATION_EXISTS` |
| `reservations` | `updated_at timestamptz not null default now()`; every reservation write sets it to `now()` (insert, partial release, release, fulfilment inside `post`) | AC-4: a reservation change moves `available`, and the feed must see it |
| `reservations` | index `reservations_location_updated_idx` (`location_id`, `updated_at`) | AC-4 and AC-15: the feed's reservation branch |
| `stock_levels` | index `stock_levels_location_updated_idx` (`location_id`, `updated_at`) | AC-4 and AC-15: the feed's balance branch and the Stock page filtered by one location |

The owner type policy is still answered only by `LocationPolicyService`; the check above names `kind`, never an owner type. `stock_level_discrepancies` already holds `resolved_at`, `resolved_by`, and `resolution` (`rebuilt`, `dismissed`); the written reason of a dismissal lives in its audit entry, never on the row. Every writer of `stock_levels` already sets `updated_at = now()` (the posting upsert); the build confirms `rebuildLevel` does too and adds it if not.

**Migration.** Before the baseline freeze (ADR 0003: the day the pilot brand's first import runs) the change is a regeneration of `0001_baseline_tables.sql` from the schema (every element above is expressible in Drizzle; nothing goes in the hand written rules file), and developers recreate their database. If the freeze has passed when this is built, it is one forward migration instead: add the column with its default, then the indexes, then the check and the unique index; the last two fail loudly on an install that already has two online locations or an online shop, which no install has before the pilot. Specs 0012 to 0015 regenerate the same file in the same wave, so whichever lands second regenerates on top of the first (Risks).

### Contract for neighbours (services other modules call)

`post` and `reverse` run their own `ledgerTransaction` (READ COMMITTED, 5 second lock cap per wait, one deadlock retry, spec 0002) with the spec 0006 `within` callback. The reservation functions instead run inside a **stock transaction** the caller opens with `LedgerService.transaction(work)`: the same runner, so the same lock cap and the same single deadlock retry, which reruns the caller's whole `work`. Inside `work` the caller writes only its own rows, keeps no state across the rerun, and calls the reservation functions with the `StockTransaction` it was handed (a branded type; a plain Drizzle transaction does not type check, and the functions also check at run time that the runner opened it, raising `InvalidInput` otherwise). Lock order inside a stock transaction: the caller's own rows, then the ledger's master `FOR SHARE`, pair locks, and reservation rows; a deadlock with a posting that takes them the other way is broken by the retry.

**What spec 0013 asks for, and where this spec answers it** (spec 0013, "Contracts with the parallel specs"; an order holds stock from creation, its Q-16.2):

1. *Reserve an order line inside the caller's transaction, answering "short" instead of throwing.* `reserveLines(tx, …)` takes the caller's transaction and never opens one; with `shortage: 'reserve_available'` it never throws for a shortage and answers `reserved` and `short` per line (AC-5). The one condition: the order's transaction is opened with `LedgerService.transaction`, which is the ledger's runner (lock cap and deadlock retry), so orders uses it as the runner of every order write that reserves or releases. The old one line `reserve` (own transaction, throws on a shortage) stays for existing callers and is not part of this contract.
2. *Release a line's reservation.* `releaseLines(tx, { sourceType, sourceLineIds })`, and `releaseSource` for a whole order (AC-6).
3. *Read the reservations for an order.* `reservationsFor({ sourceType, sourceId })` (AC-6).
4. *Post `order_shipment` with key `order_shipment:<orderId>` and return each line's unit cost.* `post` as built: `idempotencyKey: 'order_shipment:<orderId>'`, `sourceType: 'order_shipment'`, `sourceId` the order id, one line per order line with `sourceLineId` (a short line as two lines, AC-6); the result's `movements` carry `sourceLineId`, `unitCost`, and `totalCost` for each line, and a replay of the same key returns the stored result. A line posted as two movements has the unit cost `round(Σ |totalCost| / Σ |quantity|, 4)`, the ledger's own outbound display rule.

| Caller | Calls | For |
|---|---|---|
| Orders (spec 0013) | `transaction`, `reserveLines` with `shortage: 'reserve_available'`, `releaseLines`, `releaseSource`, `reservationsFor`, `post` with `sourceType: 'order_shipment'`, idempotency key `order_shipment:<orderId>`, `sourceLineId` per line, and `reservationId` on the reserved part; `OnlineStockService.onlineLocation()` | Holding stock from order creation (spec 0013 Q-16.2), filling short lines, size swaps on an edit (`releaseLines` then `reserveLines` in one stock transaction), cancellation, shipment. The `post` result carries each movement's `sourceLineId` and `unitCost`, which spec 0013 writes on its lines |
| Shopify connector (spec 0015) | `OnlineStockService.onlineLocation`, `forVariants`, `list`, `changedSince` | The stock push and its drift check. It maps variants to Shopify items itself; it never posts stock (AC-8). With `NoOnlineLocation` it pushes nothing |
| Onboarding imports (feature 15) | `post` with `sourceType: 'opening_balance'`, at most 1,000 lines a posting, each with `unitCost` from `CostService.costFor` | The stock snapshot per location, in batches with an idempotency key per batch |
| Delivery failures (feature 21), exchanges (feature 34) | `post` with `returned_to_origin_restock` or `exchange_return_restock` at the line's frozen unit cost | Restocks (spec 0002 catalog child) |
| Barcode scanning (feature 20) | the same posting calls as the flow it scans for | Scanning finds a variant (catalog) and calls the restock path; it adds no stock rule |
| Partners (feature 41) | location create with owner type and party (this spec's screen and api), `LocationPolicyService.policyFor` | Partner locations and handovers |

Functions added to `LedgerService` (exported) and `OnlineStockService` (exported):

| Function | Inputs | Outputs | Errors |
|---|---|---|---|
| `ledger.transaction(work)` | `work: (tx: StockTransaction) => Promise<T>` | `T` | `LockTimeout`, and whatever `work` throws (the transaction rolls back) |
| `ledger.reserveLines(tx, input)` | `sourceType: string` (1 to 50), `sourceId: uuid`, `shortage: 'reserve_available' \| 'refuse'`, `lines[]` (1 to 200): `sourceLineId: uuid` (distinct), `variantId`, `locationId`, `quantity: int ≥ 1` (the requested total for the line), `lotId?` | `lines: [{ sourceLineId, reservationId \| null, requested, reserved, short }]` in input order | `InvalidInput`, `UnknownReference`, `Archived`, `NotStockable`, `TrackingMismatch`, `InsufficientStock` (only with `refuse`; details `lines: [{ index, available, requested }]`), `DuplicateReservation`, `LockTimeout` |
| `ledger.releaseLines(tx, input)` | `sourceType`, `sourceLineIds[]` (1 to 200) | released `Reservation[]` (may be empty) | `InvalidInput`, `LockTimeout` |
| `ledger.releaseSource(tx, input)` | `sourceType`, `sourceId` | released `Reservation[]` (may be empty) | `InvalidInput`, `LockTimeout` |
| `ledger.reservationsFor(input)` | `sourceType`, `sourceId` | `[{ sourceLineId, reservationId, variantId, locationId, quantity, openQuantity, status }]` of every reservation of the document, newest first per line | `InvalidInput` |
| `onlineStock.onlineLocation()` | none | `{ id, code, name }` or `null` | none |
| `onlineStock.forVariants(variantIds)` | 1 to 1,000 uuids | `OnlineStockRow[]`: `variantId`, `onHand`, `reserved`, `available`, `pushable` | `NoOnlineLocation`, `InvalidInput` |
| `onlineStock.list(query)` | `afterVariantId?`, `limit` (1 to 1,000, default 500) | `{ onlineLocationId, rows: OnlineStockRow[], nextAfterVariantId }` | `NoOnlineLocation` |
| `onlineStock.changedSince(query)` | `since: timestamptz string \| null`, `after?: { changedAt, variantId }`, `limit` (1 to 1,000, default 500) | `{ onlineLocationId, watermark, rows: (OnlineStockRow & { changedAt })[], nextAfter }` | `NoOnlineLocation`, `InvalidInput` |

`ReconciliationService.dismiss(discrepancyId, resolvedBy, tx?)` is internal to inventory (used by the discrepancies service).

### API surface (HTTP)

All under `/api`, `@Audience('staff')`, behind the session, audience, and permission guards. Bodies and queries are Zod schemas in `packages/contracts`; errors go through `inventory/ledger-http.ts`.

| Endpoint | Method | Key inputs | Key outputs | Permission | Key errors |
|---|---|---|---|---|---|
| `/locations/owner-types` | GET | none | `[{ ownerType, needsParty, canSellOnline }]` in the policy table's order | `catalog.manage` | 403 |
| `/locations/party-options` | GET | `ownerType` (req, one of the values the list above returned) | `[{ id, code, name }]` of parties holding the role that owner type needs (empty for one that needs none) | `catalog.manage` | 400 `INVALID_QUERY`, 403 |
| `/locations` | POST (amended) | as today: `code`, `name`, `kind`, `ownerType?`, `partyId?`, `sellableOnline?` | `LocationDetail` plus `partyId`, `partyName` | `catalog.manage` | as today, plus 409 `ONLINE_LOCATION_EXISTS`, 422 `ONLINE_NEEDS_WAREHOUSE` |
| `/locations/:id` | PATCH (amended) | as today (`sellableOnline?` among them) | `LocationDetail` | `catalog.manage` | as today, plus 409 `ONLINE_LOCATION_EXISTS`, 422 `ONLINE_NEEDS_WAREHOUSE`, `NOT_SELLABLE_ONLINE` |
| `/locations` | GET (amended) | as today | each item adds `partyId`, `partyName`, and `online` (= `sellableOnline` of an active location) | `stock.view` | as today |
| `/stock-adjustments` | POST | header `Idempotency-Key: uuid` (req); `locationId`, `reason` (1 to 500), `lines: [{ skuId, quantity: int ≠ 0, reasonCode }]` (1 to 200) | 201 (200 on replay) `StockAdjustmentDetail`: `groupId`, `location`, `effectiveAt`, `postedBy`, `lines: [{ sku, quantity, reasonCode, unitCost?, totalCost? }]` | `stock.correct` | 400 `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_INPUT`; 409 `IDEMPOTENCY_CONFLICT`, `INSUFFICIENT_STOCK` (with `skuIds`); 422 `INVALID_LINES` (codes `UNKNOWN_SKU`, `ARCHIVED`, `NOT_STOCKABLE`, `DUPLICATE_SKU`, `COST_NOT_SET`, `REASON_SIGN_MISMATCH`), `INVALID_LOCATION`, `REASON_REQUIRED`, `PERIOD_LOCKED`; 503 `BUSY` |
| `/stock-discrepancies` | GET | `status?` (`open` default, `resolved`), `cursor?`, `limit?` (≤ 50) | `items: [{ id, kind, sku, location, archivedSku, archivedLocation, expected, actual, foundAt, resolvedAt?, resolution?, resolvedBy? }]`, `nextCursor` | `stock.correct` | 400 `INVALID_QUERY`, 403 |
| `/stock-discrepancies/:id/rebuild` | POST | `reason?` (≤ 500) | the discrepancy, resolved | `stock.correct` | 404; 409 `DISCREPANCY_CLOSED`; 422 `NOT_REBUILDABLE`; 503 `BUSY` |
| `/stock-discrepancies/:id/dismiss` | POST | `reason` (req, 1 to 500) | the discrepancy, resolved | `stock.correct` | 404; 409 `DISCREPANCY_CLOSED`; 422 `REASON_REQUIRED` |

**Adjustment reason codes** (`StockAdjustmentReason` in contracts, stored in `stock_movements.reason_code`, labels in both languages): `found` (adds), `missing` (removes), `damaged` (removes), `opening_correction` (either way), `other` (either way). A code on the wrong side answers `REASON_SIGN_MISMATCH` on that line.

**Audit codes added to the registry** (spec 0010 AC-11, each with labels in `packages/i18n` and its proof file): `location.created` (record `location`, reason optional); `stock.adjusted_manually` (new record type `stock_movement_group`, no label, reason text required); `stock_discrepancy.rebuilt` (new record type `stock_discrepancy`, no label, reason optional), `stock_discrepancy.dismissed` (same type, reason required). None is undoable: an adjustment is corrected by another adjustment, a resolution by the next reconciliation.

### Value sourcing

| Action | Value | Source |
|---|---|---|
| any online read | the online location | `SELECT id FROM locations WHERE sellable_online AND archived_at IS NULL` (at most one by `locations_one_online`); none raises `NoOnlineLocation` |
| `forVariants`, `list`, `changedSince` | `onHand`, `reserved`, `available` | `buildAvailabilitySql` (spec 0002, exported from `ledger.service.ts`) for the (variant, online location) pairs, summed over lots (clothing variants carry none); `available = onHand − reserved` |
| same | `pushable` | derived: `max(available, 0)` |
| `list` | page order and `nextAfterVariantId` | keyset on `stock_levels.variant_id` for `location_id` = the online location, served by `stock_levels_location_variant_idx`; `nextAfterVariantId` is the last row's id when the page is full, else null |
| `changedSince` | `changedAt` per variant | the greatest of `stock_levels.updated_at` and `reservations.updated_at` for that variant at the online location, over rows with `updated_at > since` (all rows when `since` is null) |
| `changedSince` | page order, `after`, `nextAfter` | keyset on (`changedAt`, `variantId`) ascending; `nextAfter` is the last row's pair when the page is full, else null |
| `changedSince` | `watermark` | the database's `now()` minus `ONLINE_FEED_LAG` (5 minutes, a constant in `online-stock/online-stock.service.ts`, not a setting); the caller stores the first page's `watermark` as its next `since` |
| `changedSince` | why the lag is safe | every ledger write stamps `now()` (its transaction's start) and commits within seconds (each lock wait is capped at 5 seconds, spec 0002); a transaction still open when a run starts therefore stamped a time after that run's `watermark` and is read on the next run. Assumed: no ledger transaction stays open 5 minutes (Risks) |
| `reserveLines` | available per line | `buildAvailabilitySql` per (variant, location) after `loadMaster` (`FOR SHARE`) and `lockPairs` on every distinct pair in ascending key order, minus what the call's earlier lines on the same SKU, location, and lot took |
| `reserveLines` | `reserved` per line | `refuse`: the requested quantity, else the whole call raises; `reserve_available`: what the line already holds (an active reservation with the same `source_type` and `source_line_id`, index `reservations_active_source_line_unique`) plus `min(requested − held, max(available, 0))`; in a location with `allow_negative` the full request |
| `reserveLines` | write | no active reservation and `reserved > 0`: insert one with `quantity = open_quantity = reserved`; an active one on the same key that grows: add the growth to `quantity` and `open_quantity`; nothing grows: no write; an active one on another SKU, location, or lot: `DuplicateReservation` |
| `reserveLines` | `short` | `reserved < requested` |
| `reserveLines`, `releaseLines`, `releaseSource`, `release`, fulfilment | `reservations.updated_at` | `now()` set by the writing statement |
| `releaseLines`, `releaseSource` | which reservations | `status = 'active'` rows with that `source_type` and those `source_line_id`s, or that `source_id`, locked `FOR UPDATE` in id order |
| `reservationsFor` | rows | `reservations` by (`source_type`, `source_id`); the build adds an index on (`source_type`, `source_id`) if the plan check at the scale load needs one |
| shipment of a short line | lines | spec 0013 posts the reserved part with `reservationId` and the remainder as a second line with the same `sourceLineId` and no reservation; the remainder passes only if unreserved stock exists (spec 0002 AC-4) |
| stock transaction | marker | in process only: the runner adds each transaction object it opens to a module private `WeakSet` and removes it when `work` ends; each reservation function checks membership and raises `InvalidInput` without it. No database setting is used |
| create or edit location | `sellable_online` allowed | `LocationPolicyService.assertCanSellOnline` / `assertCanCreate` (policy), then `kind` and `is_sellable` (check), then the one online location (unique index) |
| archive location | `sellable_online` after | `false`, set in the archive update; `location.archived` records the before and after |
| owner types list | rows | `LocationPolicyService.describeOwnerTypes()`: each policy row's `owner_type`, `can_sell_online`, and `needsParty = requiredPartyRole(ownerType) !== null` |
| party options | rows | `PartnerAccounts.listHolding(requiredPartyRole(ownerType))`, ordered by code `COLLATE "C"` |
| location list | `partyName` | `PartnerAccounts.namesByIds(partyIds)` for the page (one query per page) |
| post adjustment | location check | exists, not archived, `kind` `warehouse` or `shop`, else 422 `INVALID_LOCATION` |
| post adjustment | line checks | `CatalogService.checkStockable` and duplicates, all faults returned at once with indexes (the receipt pattern of spec 0006) |
| post adjustment | `unitCost` of an adding line | `ledger.getLevels({ variantId, locationId })`: its `avgUnitCost` when a balance exists and it is above 0; else `CostService.costFor(variantId, SettingsService.localDate(now))` when `set`; else line fault `COST_NOT_SET` |
| post adjustment | ledger `idempotencyKey`, `sourceType`, `sourceId` | `stock_adjustment:<Idempotency-Key>`, `adjustment`, the `Idempotency-Key` UUID |
| post adjustment | movement `reasonCode` | the line's `reasonCode` |
| post adjustment | `effectiveAt` | omitted (now); the ledger's lock date rule still applies (422 `PERIOD_LOCKED`) |
| post adjustment | `postedBy`, audit actor | the session user; the acting hat from `Access.actingHat` for `stock.correct` |
| post adjustment | audit entry | `AuditService.record` inside `within`: action `stock.adjusted_manually`, record (`stock_movement_group`, group id), `after` `{ locationId, lines: [{ skuId, quantity, reasonCode }] }` (no cost), `reason` the written reason |
| post adjustment | replay or conflict | the ledger's `replayed` with its request hash; a replay answers 200 only when `posted_by` equals the caller, else 409 (the spec 0006 rule) |
| SKU history | adjustment row label | `source_type = 'adjustment'` gives "Adjustment"; the movement's `reason_code` gives its label key |
| discrepancy list | SKU code and name | `CatalogService.getSkus(ids)` for the page |
| discrepancy list | archived flags | the SKU's and location's `archived` from the same reads |
| discrepancy list | page order | keyset on (`found_at desc`, `id desc`) for open ones, (`resolved_at desc`, `id desc`) for resolved; the build adds a supporting index only if the plan check needs one at the scale load |
| discrepancy list | value fields | `expected.totalValue` and `actual.totalValue` removed without `cost.view` by the response serializer |
| rebuild | corrected values | `ReconciliationService.rebuildLevel` (spec 0002), `resolvedBy` the session user |
| dismiss | resolution | `resolved_at = now()`, `resolved_by` the session user, `resolution = 'dismissed'`, under `FOR UPDATE` of the row; already resolved raises `DiscrepancyClosed` |
| any cost field | present or not | `access.has('cost.view')` (spec 0008 AC-6) |

### Key invariants

- `LedgerService` stays the only writer of `stock_levels`, `reservations`, and movements; `OnlineStockService` only reads. Both live in inventory and read only inventory tables.
- `reserveLines` follows the ledger's locking order inside the stock transaction: master rows `FOR SHARE` in id order (`loadMaster`), then `lockPairs` for every distinct SKU and location in ascending key order, then reservation rows. `releaseLines` and `releaseSource` take no pair lock (they only lower reservations), like `release`. Reservations are written only inside a stock transaction, so the lock cap and the deadlock retry always apply.
- A reservation is never lowered by `reserveLines`; only a release or a fulfilment lowers it.
- At most one active online location exists, and it is a sellable warehouse whose owner type may sell online. A change of the online location is visible to every reader at once through `onlineLocationId`.
- No module under `connectors/` or `channels/` can post, reverse, or reserve stock (AC-8).
- The online read never answers zeros for a missing online location; it raises.
- Nobody types a cost on an adjustment; a found piece never enters at 0 unless its balance average or style cost is 0.
- A dismissal changes no stock; a rebuild changes only the balance it names and never a movement.

### Security model

- Every new route is staff audience with one permission: `catalog.manage` for the location lists, `stock.correct` for adjustments and discrepancies (both manager only in the spec 0008 matrix). No new permission, no new hat.
- Cost stays behind `cost.view`: adjustment responses, SKU history, and discrepancy values strip unit cost and value per caller, replays included.
- An adjustment replay answers only the person who posted it, so a guessed key cannot read another person's adjustment.
- Party options return id, code, and name only, never contact details (`PartnerAccounts` already limits this).
- The written reasons of adjustments and dismissals go to the audit entry, which masks phones and emails (spec 0010 AC-5); movement rows carry only reason codes.
- No personal data is added. Log lines: `stock_adjustment.posted` (group id, location id, line count, user id) and `stock_discrepancy.resolved` (id, resolution, user id); never cost values, never the reason text.

### Configuration required

None. `ONLINE_FEED_LAG` is a code constant. The settings this feature reads already exist: `inventory_lock_date`, `timezone`, `operating_day_cutoff_hour` (spec 0002, in spec 0009's registry).

### Critical test scenarios

- Online location: set a warehouse online; a second warehouse online answers 409 `ONLINE_LOCATION_EXISTS`, two parallel requests give one success and one 409; a shop answers 422 `ONLINE_NEEDS_WAREHOUSE`; a partner location answers 422 `NOT_SELLABLE_ONLINE`; archiving the empty online location clears the flag and `onlineLocation()` answers null, verifies **AC-1**
- Partner stock never online: 10 pieces at the online warehouse, 30 at a partner location, 5 at a shop: `forVariants` answers on hand 10; with 3 reserved at the warehouse, available 7 and pushable 7; with 12 reserved in a location that allows negative stock, available −2 and pushable 0; with no online location every read raises `NoOnlineLocation`, verifies **AC-2**, **AC-3**
- Late commit: hold a posting open at the online location for 10 seconds after its `now()`; a `changedSince` run during it does not return it, the next run (with the stored `watermark`) does; a run with more changes than one page pages through all of them with `after`, verifies **AC-4**
- Reserve lines: two lines on one SKU of 6 and 5 with 10 available: with `refuse` the call raises listing both and writes nothing; with `reserve_available` the first holds 6 and the second 4 and is `short`; after a receipt of 3, calling again tops the second up to 5 and leaves the first unchanged; a repeat writes nothing; a `work` that throws after reserving rolls back every reservation and its own row; a plain Drizzle transaction is refused; an edit that releases line M and reserves line L in one stock transaction leaves M held when the whole transaction fails, verifies **AC-5**, **AC-6**
- Release and ship: reserve two lines, ship one with its `reservationId`, `releaseSource` the order: the second is released, the first stays fulfilled, a second `releaseSource` returns empty, `reservationsFor` shows both, reconciliation records nothing, `changedSince` lists the variant after each step; a short line ships as two lines of one `sourceLineId`, verifies **AC-6**, **AC-7**
- Concurrency: 20 parallel `reserveLines` with `refuse` of 1 unit against 10 available give exactly 10 successes, and with `reserve_available` exactly 10 lines hold 1 and 10 hold 0; two stock transactions touching the same two SKUs in opposite line orders, 100 times in parallel, finish with no deadlock error reaching the caller, verifies **AC-5**
- Channels: a planted `import { LedgerService }` in a file under `apps/api/src/connectors/` fails the static test, verifies **AC-8**
- Catalog locks: with `loadMaster` and `lockForArchive` on `CatalogService.lockForShare` and `lockForUpdate`, the spec 0006 archive race, rebuild race, and code change race tests pass unchanged, and `module-boundary.spec.ts` lists no inventory `product_variants` breach, verifies **AC-18**
- Adjustment: a manager adds 2 found pieces to a balance at average 120.0000 (posted at 120.0000) and removes 1 damaged; a found piece of a SKU never stocked takes its style cost; one with neither answers `COST_NOT_SET` and posts nothing; `found` with a negative quantity answers `REASON_SIGN_MISMATCH`; a removal past on hand answers 409; a replay by the same person answers 200 and moves stock once, by another person 409; the audit entry carries the reason; a warehouse hat gets 403, verifies **AC-9**, **AC-10**, **AC-11**, **AC-17**
- Locations screen: create a partner location from the owner type list with a party from the party list; the online switch is not offered on it; the list shows its party and the online badge on the warehouse; the owner type boundary test still passes; `location.created` is in the audit trail, verifies **AC-12**, **AC-13**
- Discrepancies: plant a balance drift as the owner; the next reconciliation lists it; rebuild fixes it and writes `stock_discrepancy.rebuilt`; a reservation discrepancy answers 422 on rebuild and dismisses with a reason; a second dismiss answers 409; an archived SKU shows the warning, verifies **AC-14**
- Scale: every AC-15 budget holds at the scale load and each plan uses its index, verifies **AC-15**
- Screens: Playwright in English and Arabic, keyboard only, axe clean for the location dialogs, the adjustment form, and the discrepancies page, verifies **AC-16**

## Build plan

Tracer Bullet, the project default ([AGENTS.md](../../../AGENTS.md)). Milestone 1 is the thinnest real thread of the scope's "partner stock is never offered online": one online location held by the database, set from the real Locations screen, read by the real `OnlineStockService`, proven against a partner location's stock. Each later milestone thickens one segment end to end. Milestones 1 and 2 come first because specs 0013 and 0015 build on them. One commit per milestone.

**Milestone 1: One online location and the online stock read, end to end**

1. Schema: the `locations` check and partial unique index, `reservations.updated_at`, the two indexes; regenerate `0001_baseline_tables.sql` (or one forward migration after the freeze); `ledger.service.ts` sets `reservations.updated_at` on every reservation write; `rebuildLevel` confirmed to set `stock_levels.updated_at`, satisfies **AC-1**, **AC-4**
2. `LocationsService` and `LocationsController`: the online rules with `ONLINE_LOCATION_EXISTS` (including the 23505 race) and `ONLINE_NEEDS_WAREHOUSE`, archive clears `sellable_online`, `online` on list items; error mapping in `ledger-http.ts`, satisfies **AC-1**
3. `OnlineStockService` (`onlineLocation`, `forVariants`, `list`, `changedSince`) with `NoOnlineLocation`, exported by `InventoryModule`; contracts in `packages/contracts/src/online-stock.ts`; `apps/api/test/online-stock.e2e-spec.ts` (partner stock, reservations, negative, late commit, paging), satisfies **AC-2**, **AC-3**, **AC-4**
4. Static test `apps/api/src/inventory/ledger-callers.spec.ts` for connectors and channels, with a planted failing case, satisfies **AC-8**
5. Web: the online switch in the location edit dialog with its field errors, the "Online stock" badge in the Locations list, both languages, satisfies **AC-1**, **AC-12**, **AC-16**

**Done when** `pnpm build && pnpm --filter @ssdashboard/api test:e2e` passes including `online-stock.e2e-spec.ts` and every existing ledger, location, and receipt suite; `pnpm --filter @ssdashboard/api test` passes including `ledger-callers.spec.ts`; and `pnpm --filter @ssdashboard/web test` passes.

**Milestone 2: Reservations for documents**

6. `ReserveLinesInput`, `ReleaseLinesInput`, and `ReleaseSourceInput` in contracts; `LedgerService.transaction` with the branded `StockTransaction`; `reserveLines` (both shortage modes, shared availability per key, top up, `DuplicateReservation`), `releaseLines`, `releaseSource`, `reservationsFor`; e2e cases in `apps/api/test/ledger-reservations.e2e-spec.ts` including the concurrency and deadlock cases, satisfies **AC-5**, **AC-6**
7. The order thread test (a fixture order row and reservations in one stock transaction, a short line filled after a receipt, ship with `reservationId` and a split short line, release, reconcile, feed after each step, the forced deadlock rerun) in the same file, satisfies **AC-7**
8. The contract table of this spec copied into `apps/api/src/inventory/README.md` (Owns) so spec 0013 and 0015 builders read it beside the code, satisfies **AC-5**, **AC-6**
9. Taken from spec 0012's follow up: `CatalogService.lockForShare(tx, variantIds)` (rows `FOR SHARE` in id order, answering `id`, `kind`, `tracking`, `archived`) and `lockForUpdate(tx, variantId)` (`FOR UPDATE`, answering `id`, `archived`, or null) in the catalog module; `loadMaster`, `lockForArchive`, and `rebuildLevel` call them instead of reading `product_variants`; both `product_variants` entries leave `KNOWN_BREACHES` in `apps/api/src/module-boundary.spec.ts` (the test fails while a stale entry remains); every archive race test of spec 0006 still passes, satisfies **AC-18**

**Done when** `pnpm build && pnpm --filter @ssdashboard/api test:e2e` passes including `ledger-reservations.e2e-spec.ts` and `master-data.e2e-spec.ts` (the archive, rebuild, and code change races), and the drift check after every ledger test stays green; `pnpm --filter @ssdashboard/api test` passes `module-boundary.spec.ts` with no inventory `product_variants` entry left.

**Milestone 3: Locations with an owner type and a party**

10. `LocationPolicyService.describeOwnerTypes()`, `PartnerAccounts.listHolding(role)` and `namesByIds(ids)` (partners module README updated), `GET /api/locations/owner-types` and `GET /api/locations/party-options`, `partyId` and `partyName` on location answers, satisfies **AC-12**
11. `location.created` in the audit registry with labels and proof, written by `LocationsService.create` in its transaction, satisfies **AC-13**
12. Web: owner type and party pickers in the new location dialog fed only by those lists, owner type and party read only in the edit dialog, the owner type and party columns, the "no party with this role yet" state; Playwright case in both languages, satisfies **AC-12**, **AC-16**
13. `FIXTURES` entries for the two routes in `access-sweep.e2e-spec.ts`, satisfies **AC-17**

**Done when** `pnpm --filter @ssdashboard/api test` passes including `owner-type-boundary.spec.ts`; `pnpm --filter @ssdashboard/api test:e2e` passes including `location-owner-types.e2e-spec.ts`, `audit-inventory.e2e-spec.ts` with the new code, and the access sweep; and the Playwright location case passes.

**Milestone 4: Manual stock adjustments**

14. Contracts (`stock-adjustments.ts`, `StockAdjustmentReason`), `AdjustmentsService` and `AdjustmentsController` (`POST /api/stock-adjustments`: idempotency, line checks, the cost rule, `post` with `within` writing the audit entry, replay only to the poster), `stock.adjusted_manually` and the `stock_movement_group` record type in the audit registry, satisfies **AC-9**, **AC-10**, **AC-11**
15. SKU history label for adjustments with the reason code, cost stripped without `cost.view`, satisfies **AC-11**
16. Web: `/stock-adjustments/new` (location, lines with the SKU picker, signed quantity, reason code, written reason, busy retry as in spec 0006) and an "Adjust stock" action on the Stock page shown with `stock.correct`; Playwright case; `FIXTURES` entry, satisfies **AC-9**, **AC-16**, **AC-17**

**Done when** `pnpm --filter @ssdashboard/api test:e2e` passes including `stock-adjustments.e2e-spec.ts` and the access sweep; `pnpm --filter @ssdashboard/contracts test` passes with the new audit code; and the Playwright adjustment case passes in both languages.

**Milestone 5: Discrepancies a manager can act on, and the scale budgets**

17. `ReconciliationService.dismiss`; `DiscrepanciesService` and `DiscrepanciesController` (list, rebuild, dismiss), `stock_discrepancy.rebuilt` and `.dismissed` and the `stock_discrepancy` record type in the audit registry; `FIXTURES` entries, satisfies **AC-14**, **AC-17**
18. Web: `/stock-discrepancies` with open and resolved tabs, rebuild and dismiss dialogs, the archived warning, a nav item needing `stock.correct`; Playwright case, satisfies **AC-14**, **AC-16**
19. `apps/api/test/scale.e2e-spec.ts`: one online location over the 50,000 balances and 5,000 active reservations in the seed, and one budget row per AC-15 read with its plan assertion; measured values recorded in `verify.md`, satisfies **AC-15**

**Done when** `pnpm --filter @ssdashboard/api test:e2e` passes including `stock-discrepancies.e2e-spec.ts`; `pnpm build && pnpm --filter @ssdashboard/api test:scale` passes with every AC-15 budget; `pnpm lint && pnpm typecheck && pnpm format:check` are clean.

## Consequences

**Positive**:

- Orders and the Shopify connector get stable, tested stock calls before they are built, so neither invents its own stock rule or reads ledger tables.
- "Partner stock is never offered online" is held by the database and by a read that counts one location, not by every caller remembering a filter.
- The change feed needs no new table, no event bus, and survives a backup restore, because it rests on timestamps the ledger already writes.
- The pilot can fix stock with a reason and see drift without running SQL.

**Negative / tradeoffs**:

- One online location means a brand that ships online orders from two warehouses cannot until an allocation rule is designed (Q-11.2).
- The feed returns each changed variant again for about 5 minutes; the connector must treat a repeated row as normal and push only when the value differs from what it last sent.
- An order that arrives when stock is already gone holds less than it asked (`short`); spec 0013 shows it, and the push already shows 0. A short line must be filled by calling `reserveLines` again; nothing fills it by itself when stock arrives.
- Reservations run inside the caller's transaction, so a slow caller holds stock pair locks longer; callers must keep their own work in a stock transaction short.
- Adjustments are manager only; a warehouse lead who finds pieces asks a manager until counts arrive (feature 54).
- The discrepancy screen adds a page and two routes for a rare event; kept because nothing else surfaces drift.
- `reservations` gains a mutable `updated_at` column on a hot table: one more value written per reservation change.

**Neutral**:

- Four audit codes and two record types join the registry, with labels in both languages.
- The baseline tables file is regenerated again; developers recreate their database once more.
- `LedgerService` grows two functions; online reads live in their own service so the ledger file does not grow further.

## Follow-up

- [ ] Spec 0013 (aligned with its Q-16.2, reserve at creation, and its AC-13, short lines never refuse an order): open order writes with `LedgerService.transaction`, call `reserveLines` with `reserve_available`, and decide when a short line is topped up (for example after a receipt or a restock of that variant, read from `changedSince`).
- [ ] Spec 0015: push `pushable`, store `watermark` per connection, resync with `list` when `onlineLocationId` changes, push nothing on `NoOnlineLocation`, and record inbound inventory levels as drift only (m2).
- [ ] Spec 0013 builds `DomainEvents` (spec 0002 A6); once it exists, the ledger may also emit `StockMoved` in transaction for in process readers. The feed of AC-4 stays the durable path for the connector.
- [ ] Feature 41: create consignment partner parties; the location screen of this spec then works with no change.
- [ ] Feature 54 (counts) and features 38 and 55 (transfers): post through `post` like adjustments; a count may replace most manual adjustments, which stay for one off fixes.
- [ ] Features 24 and 25: show the number of open discrepancies to the manager (the old alert follow up of spec 0002).
- [ ] An allocation rule for several online locations, if a brand needs it (Q-11.2).
- [ ] `/sync` after the build: `apps/api/src/inventory/AGENTS.md` (the dismiss action now exists; the online location rule; `reserveLines` locking), `apps/api/AGENTS.md` key files, and spec 0008's route mapping table gains the new routes.

## Questions for the owner

Each is decided here as recommended, so the build can start; the owner can change any of them, and the "if changed" line says what moves.

1. **Q-11.1 Manual stock adjustments in this feature?** Options: (a) yes, manager only through `stock.correct`, with a reason (recommended); (b) yes, also for the warehouse hat; (c) no, wait for full counts (feature 54, slice 4). Why: the pilot will find, lose, and damage pieces months before counts exist, and without this the only fix is SQL. If changed: (b) adds `stock.correct` or a new permission to the warehouse hat in spec 0008; (c) drops milestone 4.
2. **Q-11.2 How many online locations?** Options: (a) exactly one, a sellable warehouse (recommended); (b) several, summed for the push, with orders choosing a location by a rule; (c) any own location, shops included. Why: the scope says only the warehouse sells online, and one location makes the push, the reservation location, and the Shopify location mapping all obvious. If changed: (b) drops the unique index and needs an allocation rule in spec 0013 and a per location push in 0015.
3. **Q-11.3 The discrepancy screen in this feature?** Options: (a) yes, list, rebuild, dismiss (recommended); (b) list only; (c) later. Why: the nightly check already records drift, and at GA a drifted balance must be visible and fixable without SQL. If changed: milestone 5 shrinks or moves.
4. **Q-11.4 Partner and wholesale locations in slice 1a?** Options: (a) the location screen handles owner type and party now; parties are created by feature 41 (recommended); (b) also add a minimal partner create (code, name, role) now; (c) leave owner types off the screen until feature 41. Why: slice 1a does not need partner stock, and party records belong to the partners module that feature 41 builds. If changed: (b) adds a partners route and dialog; (c) drops tasks 10 and 12.
5. **Q-11.5 Cost of a found piece?** Options: (a) the balance's average, else the style cost, else refused (recommended); (b) always the style cost; (c) a person with `cost.view` types it. Why: the average keeps the stock value per piece unchanged, the style cost covers a never stocked SKU, and refusing beats a silent zero (final plan 6.10, "not set" never zero). If changed: only the cost line of the adjustment service and its test.
