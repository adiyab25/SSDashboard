# Verify: stock ledger and locations · spec 0011 · updated 2026-11-07

_Steps derived from spec 0011 acceptance criteria and its Value sourcing table, including the domain review fold of 2026-11-07. `/check verify` runs these; `/test` locks the durable ones. Nothing is ticked: the spec is Proposed. Each milestone ticks its own lines with the command output or the named passing test._

## UI / manual

- [ ] With no online location, open Stock and Locations → both show "No location feeds online stock: Shopify is not being updated" → AC-20
- [ ] As a manager, open the main warehouse's online gate before confirming its stock → the gate shows "stock not confirmed counted" and the move is not offered; confirm the stock, open it again → the counts (variants with stock, total on hand, variants pushed as 0) and each registered check show, and confirming makes it the online location with the badge → AC-19, AC-1
- [ ] Open the gate on a second warehouse → it shows the current online location and the number of reservations that stay there; confirm with a reason → the badge moves; the audit trail shows "Online location moved" → AC-19
- [ ] Stop online stock with a reason → the "not being updated" line returns → AC-19, AC-20
- [ ] Create a location, pick the consignment partner owner type, choose "New showroom partner", enter code and name → the partner and the location are created; the edit dialog shows owner type and party read only and no online action; the audit trail shows "Partner created" and "Location created" → AC-12, AC-13, AC-24
- [ ] Send 12 pieces from the online warehouse to the partner with a consignment note → `TR-<year>-000001`; the SKU history shows "Sent to partner TR-…" at both locations; the warehouse's on hand drops by 12; return 2 → "Returned from partner" → AC-25
- [ ] Try to send a piece an order holds → the form says which SKUs are held and nothing posts → AC-25
- [ ] As a manager, adjust "Damaged" −1 on a piece an order holds → it posts as "Written off"; the order's line shows short (once spec 0013 handles the event) → AC-23, AC-11
- [ ] Adjust "Found" +1 on a variant with a returned parcel waiting for restock → the line says it came back in a parcel and points to the restock by scan → AC-28
- [ ] As the warehouse hat, open Adjust stock → it offers "Ask the manager" instead of posting; send it → the audit trail shows "Adjustment requested" → AC-27
- [ ] As the warehouse hat, post a receipt → no cost field; the movement takes the style cost; a style with no cost shows "cost not set" on that line → AC-26
- [ ] As a person without `cost.view`, open any SKU history → no unit cost or value appears → AC-11
- [ ] After a planted drift and a reconciliation run, open Stock discrepancies → "History says / Balance says" and the system check line; a balance row offers Rebuild only, a reservation row offers Dismiss only and lists its holders → AC-14
- [ ] Switch to Arabic on each new page and dialog → right to left, every label translated, codes left to right, keyboard only works, focus visible → AC-16

## Commands

- [ ] `pnpm build && pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/online-stock.e2e-spec.ts` → online location rules, the gate and its stale check, partner stock never counted, waiting demand subtracted, `NoOnlineLocation`, late commit, paging → AC-1 to AC-4, AC-19, AC-20
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/ledger-reservations.e2e-spec.ts` → both shortage modes, top up, fill oldest first on a restock and on a release, carrier shipment below zero and shortening, events in the same transaction, concurrency, no deadlock, the order thread with a clean reconciliation → AC-5 to AC-7, AC-21, AC-22
- [ ] `pnpm --filter @ssdashboard/api test -- src/inventory` → `ledger-callers.spec.ts` (planted connectors import fails) and `owner-type-boundary.spec.ts` pass → AC-8, AC-12
- [ ] `pnpm --filter @ssdashboard/api test -- src/module-boundary.spec.ts` and `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/master-data.e2e-spec.ts` → no inventory `product_variants` breach; spec 0006 races unchanged → AC-18
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/stock-transfers.e2e-spec.ts` → numbering, direction by stock role, held stock refused, replay, costs in and out → AC-24, AC-25
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/stock-adjustments.e2e-spec.ts test/stock-receipts.e2e-spec.ts` → one reason, `write_off`, policy location check, cost on the operating day, removal shortening, found check, requests, receipt cost rule → AC-9 to AC-11, AC-23, AC-26 to AC-28
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/stock-discrepancies.e2e-spec.ts` → kind rules, holders, `stock.balance_drift` log, `DISCREPANCY_CLOSED` → AC-14
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/location-owner-types.e2e-spec.ts test/audit-inventory.e2e-spec.ts test/access-sweep.e2e-spec.ts` → the three way test unchanged, new audit codes recorded, every new route in the sweep → AC-12, AC-13, AC-17
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → `stock_transfers` in the append only list with its triggers and revoke; the relaxed reservation checks hold → AC-25, AC-21
- [ ] `pnpm --filter @ssdashboard/contracts test` → the audit registry test passes with the ten new codes and five record types, labels in both languages → AC-11, AC-13, AC-14, AC-19, AC-24, AC-27
- [ ] `pnpm build && pnpm --filter @ssdashboard/api test:scale` → every AC-15 budget, each plan on its named index; paste the measured p95 values here → AC-15
- [ ] `pnpm --filter @ssdashboard/web test:e2e` with the gate, partner, transfer, adjustment, receipt, and discrepancy cases in both languages, axe clean → AC-16
- [ ] `pnpm lint && pnpm typecheck && pnpm format:check` → clean → all

## Value sourcing checks

- [ ] `SELECT count(*) FROM locations WHERE sellable_online AND archived_at IS NULL` is never above 1; an owner `UPDATE` making a shop online fails on `locations_online_needs_warehouse` → AC-1
- [ ] A reservation with `quantity` 0 and `unfilled_quantity` 2 is `active`; one with both 0 is refused by the check → AC-5, AC-21
- [ ] After a restock of 1 with two waiting reservations, only the older one gained 1 and `pushable` is unchanged → AC-21
- [ ] After `postCarrierShipment` of 1 with 0 on hand in a location that does not allow negative stock, the balance is −1, the movement's group is `order_shipment` with key `order_shipment:<orderId>`, and one `StockOverdrawn` handler call ran in the same transaction → AC-22
- [ ] A found piece posted at 01:00 Cairo with cutoff 3 takes the cost record in force on the previous day → AC-10
- [ ] A transfer's group has `source_type = 'transfer_out'`, `source_id` the transfer id, two movements per line with the same `source_line_id`, and the in line's `unit_cost` equals the source balance's average before the posting → AC-25
- [ ] A receipt line sent with no cost stores `unit_cost` equal to `CostService.costFor` on the receipt's operating day → AC-26
- [ ] A dismissed discrepancy has `resolution = 'dismissed'`, kind `reservation` or `serial`, and no new movement exists → AC-14
- [ ] `changedSince` `watermark` equals the database time minus 5 minutes (to the second) → AC-4
