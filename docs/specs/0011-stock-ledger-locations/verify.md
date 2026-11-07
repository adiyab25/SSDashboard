# Verify: stock ledger and locations · spec 0011 · updated 2026-11-07

_Steps derived from spec 0011 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Nothing is ticked: the spec is Proposed. Each milestone ticks its own lines with the command output or the named passing test._

## UI / manual

- [ ] As a manager, open Locations, edit the main warehouse and turn on "Online stock" → the list shows the badge on it → AC-1, AC-12
- [ ] Turn it on for a second warehouse → the field shows "another location already feeds online stock"; for a shop → "only a warehouse can feed online stock" → AC-1
- [ ] Create a location, pick the consignment partner owner type from the list and a party from the party list → it is created; its edit dialog shows owner type and party read only and offers no online switch; the audit trail shows "Location created" → AC-12, AC-13
- [ ] With no party of the needed role, pick that owner type → the dialog says no party holds this role yet, and creating is not possible → AC-12
- [ ] As a manager, open Stock, choose "Adjust stock", add 2 found pieces of a stocked SKU and remove 1 damaged one with a reason → the SKU's history shows two "Adjustment" rows with "Found" and "Damaged"; the audit trail shows the reason → AC-9, AC-11
- [ ] Add a found piece of a SKU with no balance and no style cost → the form marks that line "cost not set" and nothing posts → AC-10
- [ ] As a person without `cost.view`, open that SKU's history → no unit cost or value appears → AC-11
- [ ] As a warehouse hat, open `/stock-adjustments/new` and `/stock-discrepancies` by address → the no access state, one `<h1>` → AC-16, AC-17
- [ ] After a planted drift and a reconciliation run, open Stock discrepancies → the row shows SKU, location, expected and actual; rebuild it with no reason → it moves to Resolved; dismiss another with a reason → it moves to Resolved; the audit trail has both → AC-14
- [ ] Rebuild a discrepancy whose SKU is archived → the dialog warns that stock may reappear on an archived SKU → AC-14
- [ ] Switch to Arabic on each new page and dialog → right to left, every label translated, codes left to right, keyboard only works, focus visible → AC-16

## Commands

- [ ] `pnpm build && pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/online-stock.e2e-spec.ts` → one online location rules, partner stock never counted, negative floored, `NoOnlineLocation`, late commit seen on the next run, paging → AC-1 to AC-4
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/ledger-reservations.e2e-spec.ts` → both shortage modes, shared availability per key, top up, `DuplicateReservation`, plain transaction refused, rollback with the caller's row, release by line and by order, `reservationsFor`, concurrency, no deadlock, the order thread with a clean reconciliation → AC-5 to AC-7
- [ ] `pnpm --filter @ssdashboard/api test -- src/module-boundary.spec.ts` and `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/master-data.e2e-spec.ts` → no inventory `product_variants` breach left; the archive, rebuild, and code change races unchanged → AC-18
- [ ] `pnpm --filter @ssdashboard/api test -- src/inventory` → `ledger-callers.spec.ts` (planted connectors import fails) and `owner-type-boundary.spec.ts` pass → AC-8, AC-12
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/stock-adjustments.e2e-spec.ts` → cost rule, reason sign, insufficient stock, replay to the poster only, audit entry in the same transaction → AC-9 to AC-11
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/stock-discrepancies.e2e-spec.ts` → list, rebuild, `NOT_REBUILDABLE`, dismiss with reason, `DISCREPANCY_CLOSED` → AC-14
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/location-owner-types.e2e-spec.ts test/audit-inventory.e2e-spec.ts test/access-sweep.e2e-spec.ts` → the three way test unchanged, `location.created` recorded, every new route in the sweep → AC-12, AC-13, AC-17
- [ ] `pnpm --filter @ssdashboard/contracts test` → the audit registry test passes with the four new codes and two record types, labels in both languages → AC-11, AC-13, AC-14
- [ ] `pnpm build && pnpm --filter @ssdashboard/api test:scale` → every AC-15 budget under its limit, each plan on its named index; paste the measured p95 values here → AC-15
- [ ] `pnpm --filter @ssdashboard/web test:e2e` with the location, adjustment, and discrepancy cases in both languages, axe clean → AC-12, AC-16
- [ ] `pnpm lint && pnpm typecheck && pnpm format:check` → clean → all

## Value sourcing checks

- [ ] `SELECT count(*) FROM locations WHERE sellable_online AND archived_at IS NULL` is never above 1; an `UPDATE` as the owner that makes a second one fails on `locations_one_online` → AC-1
- [ ] `UPDATE locations SET sellable_online = true` on a shop, as the owner → fails on `locations_online_needs_warehouse` → AC-1
- [ ] After `release` of 2 from a reservation, its `updated_at` is later than before and `changedSince` returns its variant → AC-4
- [ ] `forVariants` for a variant with 3 at the online warehouse and 40 at a partner location answers `onHand` 3 → AC-2 (only the online location counts)
- [ ] An adjustment adding 1 piece to a balance with average 120.0000 posts a movement with `unit_cost` 120.0000 and `reason_code` `found`; the group's `source_type` is `adjustment` and `source_id` the `Idempotency-Key` → AC-9, AC-10
- [ ] A dismissed discrepancy has `resolution = 'dismissed'`, `resolved_by` the manager, and no new movement exists → AC-14
- [ ] `changedSince` `watermark` equals the database time minus 5 minutes (to the second) → AC-4
