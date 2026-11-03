# Verify: Data model · spec 0002 · updated 2026-11-03 · verified 2026-11-03 (PASS)
_Steps derived from spec 0002 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

This feature has no screens or HTTP endpoints, so every step runs against PostgreSQL: the dev database from `deploy/compose.dev.yaml`, migrated with `pnpm db:migrate`. The database suites build their own scratch databases.

## Commands
- [x] `pnpm db:migrate` → prints `Migrations applied.`; the dev database has the 20 core tables, the `pgboss` schema owned by `ssdashboard_app`, and the seeded settings, `pc` unit, `TRANSIT` and `SCRAP` locations → AC-2, AC-3, AC-13
- [x] `pnpm --filter @ssdashboard/db test:e2e` → all pass (append only triggers and grants, composite keys, archive rules) → AC-2, AC-13
- [x] `pnpm build && pnpm --filter @ssdashboard/api test:e2e` → all pass, including `ledger`, `ledger-tracking`, `numbering-reconcile`, and `scale` → AC-1 to AC-14
- [x] `pnpm test` → all pass, including `costing.spec.ts`, `money.spec.ts`, and `module-boundary.spec.ts` → AC-2, AC-12
- [x] `pnpm lint` → passes; adding `schema.stockMovements` to a file outside `apps/api/src/inventory/` fails lint → AC-2
- [x] Start the worker (`pnpm --filter @ssdashboard/api worker` after a build) → logs `Worker started.`; `SELECT name, cron, timezone FROM pgboss.schedule` shows `ledger.reconcile`, `0 2 * * *`, `Africa/Cairo` → AC-11

## Database checks (psql as the owner role)
- [x] As `ssdashboard_app` (`SET ROLE ssdashboard_app`), `UPDATE stock_movements SET quantity = 1` → fails with permission denied; as the owner it fails with "append only" → AC-2
- [x] `TRUNCATE stock_movements` as the owner → fails with "append only" → AC-2
- [x] `DELETE` a product variant that has movements → fails on a foreign key; setting `archived_at` works; deleting an unused variant works → AC-13

## Ledger behavior (each is a test in the api e2e suite; rerun by hand if a test changes)
- [x] Receive 10 at 3.3333, ship 4, ship 6 → second shipment costs −20.00, the balance holds 0 on hand and 0.00 → AC-1, AC-3, AC-12
- [x] In an `allow_negative` location: 3 on hand at 30.00, ship 5, receive 5 at 12.0000 → movement total 56.00, `cost_variance` 4.00, balance 3 / 36.00 / 12.0000 → AC-4, AC-12
- [x] Same start, receive 2 instead → balance exactly 0 and 0.00; receive 1 instead → balance −1 / −10.00 / average 10.0000 → AC-12
- [x] Ship from a never costed balance → `total_cost` 0.00, `cost_unknown` true, caller's `reason_code` kept → AC-12
- [x] Receive 5 at 10 and 5 at 20, ship 5, receive 3 at 1, reverse the 5 at 20 receipt → −48.75 with `cost_variance` −51.25, balance 3 / 29.25 → AC-2, AC-12
- [x] Reverse a group twice → `AlreadyReversed`; reverse a reversal → `CannotReverseReversal` → AC-2
- [x] 20 parallel single unit shipments against 10 on hand → exactly 10 succeed, 10 get `InsufficientStock` → AC-4
- [x] 100 parallel two line postings in opposite line orders → no deadlock error → AC-4
- [x] Post the same key twice → stock moves once and the second call returns the first result; a retry without a date matches; a changed quantity gets `IdempotencyConflict`; a replay after stock ran out and the period locked still returns the stored result → AC-5
- [x] Lock date set to yesterday (Cairo): a posting at 23:30 yesterday Cairo time → `PeriodLocked`; 00:30 today → succeeds; tomorrow → `FutureDate` → AC-6
- [x] A two line posting whose second line fails → no movement, balance, or group lands → AC-7
- [x] A lot SKU without a lot, a lot of another SKU, a serial count that does not match, a serial already in stock, a service or bundle SKU, an archived SKU, location, or bin → each rejected with its error → AC-8
- [x] Ship serials, then reverse the shipment → the same serials are back in stock at the same bin → AC-2, AC-8
- [x] 10 on hand with 8 reserved: unreserved shipment of 3 → `InsufficientStock`; shipment of 3 against the reservation → succeeds → AC-4, AC-9
- [x] Stock in a non sellable bin or location → not counted as available; reserving more than available → `InsufficientStock`; partial release of 2 from 5 leaves 3 open; fulfilling with another lot → `ReservationMismatch` → AC-9
- [x] 50 concurrent numbering transactions with 5 rolled back → 45 consecutive numbers, no gap; 23:30 UTC on 31 December gives next year's `000001`; a prefix change leaves issued numbers as they were → AC-10
- [x] Tamper with a balance as the owner, reconcile twice → one open discrepancy with expected and actual; rebuild → balance matches movements, discrepancy marked `rebuilt` with who and when → AC-11
- [x] Reconcile while 20 postings run → 0 found → AC-11
- [x] 100,000 SKUs and 1,000,000 movements: `getAvailable` for one SKU and a single line `post` both under 50 ms at p95 → AC-14

## Value sourcing (one per row: vary the input that the value depends on)
- [x] Inbound `unit_cost` is stored as given, even into a shortfall where `total_cost` differs from quantity × cost → Value sourcing: post inbound `unit_cost`
- [x] Inbound `total_cost` at or above zero on hand = round(quantity × unit cost, 2) (10 at 3.3333 → 33.33) → Value sourcing: inbound `total_cost`
- [x] Inbound into a shortfall: filling units take the shortfall value, extra units the price; partial fill takes a proportional share → Value sourcing: inbound below 0
- [x] `cost_variance` = reference cost minus `total_cost` (0 from zero or above; 4.00 in the negative stock run; −20.00 for a zero cost receipt into a 20.00 shortfall) → Value sourcing: `cost_variance`
- [x] Outbound `cost_variance` is 0 → Value sourcing: outbound `cost_variance`
- [x] Halves round away from zero on shares (0.05 × 1 / 2 → 0.03; −0.05 → −0.03) → Value sourcing: rounding
- [x] New `avg_unit_cost` after inbound = round(new value / new on hand, 4); unchanged when new on hand is 0 or below; unchanged by any outbound → Value sourcing: avg
- [x] Outbound from positive stock: emptying takes exactly the rest; beyond zero costs the kept average → Value sourcing: outbound above 0
- [x] Outbound from zero or below: kept average; average 0 → cost 0 and `cost_unknown` → Value sourcing: outbound at or below 0
- [x] Outbound `unit_cost` = round(|total| / |quantity|, 4) (−13.33 over 4 → 3.3325) → Value sourcing: outbound `unit_cost`
- [x] Reversal rows keep the original SKU, place, lot, `unit_cost`, and `source_line_id`; the group keeps the original `source_type` and `source_id` → Value sourcing: reverse lines
- [x] `effective_at` defaults to now; Cairo date compared with `inventory_lock_date`; at most 5 minutes ahead → Value sourcing: `effective_at`
- [x] `recorded_at` is the database clock and matches on the group and its movements → Value sourcing: `recorded_at`
- [x] `allow_negative` on the location decides whether stock may go below zero → Value sourcing: negative stock allowed
- [x] `posted_by` is stored from input, null when omitted → Value sourcing: posted by
- [x] Tracking rules follow `product_variants.tracking` and `kind` → Value sourcing: tracking rule
- [x] `request_hash` ignores the key, `postedBy`, a defaulted date, and line order, but not a changed quantity → Value sourcing: `request_hash`
- [x] Replay returns the stored group and movements → Value sourcing: replay result
- [x] Serial inbound creates a new serial or flips a returned one back to in stock, with place and lot from the line → Value sourcing: serial row
- [x] Available = on hand in sellable bins of sellable locations minus open reservations → Value sourcing: `getAvailable`
- [x] Numbering year from the input date in Cairo; prefix from `document_prefixes` at issue time; sequence from the counter upsert, at least 6 digits → Value sourcing: numbering
- [x] Line amounts: VAT inclusive 114.00 at 14% → net 100.00, tax 14.00; exclusive follows `prices_include_vat = false` → Value sourcing: `LineAmounts.compute`
- [x] Reconciliation reads movement sums, reservation totals, and serial counts in one REPEATABLE READ snapshot → Value sourcing: reconcile expected values
- [x] Rebuild sets on hand and value from movement sums and the average by the rebuild formula → Value sourcing: `rebuildLevel`
- [x] The job runs on `LEDGER_RECONCILE_CRON` in the `timezone` setting → Value sourcing: reconcile schedule

## Acceptance-criteria coverage
- AC-1 … happy path, negative stock runs, reversals, drift check after every ledger test
- AC-2 … database checks, db e2e, reversal steps, lint boundary
- AC-3 … happy path, source and poster step, migrate step
- AC-4 … negative stock, concurrency, reserved stock steps
- AC-5 … idempotency step
- AC-6 … lock date step, effective_at value step
- AC-7 … atomic posting step
- AC-8 … tracking steps, serial reversal step
- AC-9 … reservation and availability steps
- AC-10 … numbering step
- AC-11 … reconciliation steps, worker schedule step
- AC-12 … costing steps and value sourcing rows
- AC-13 … archive and delete checks
- AC-14 … scale step
