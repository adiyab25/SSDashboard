# Verify: Data model · spec 0002 · updated 2026-11-05 · original verified 2026-11-03 (PASS) · amendment 2026-11-05 not yet verified
_Steps derived from spec 0002 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

This feature has no screens or HTTP endpoints, so every step runs against PostgreSQL: the dev database from `deploy/compose.dev.yaml`, migrated with `pnpm db:migrate`. The database suites build their own scratch databases.

> Amended 2026-11-05: the checked steps below are the record of the original verification on migrations `0000` to `0008`, which the amendment replaces with one baseline. Lines the amendment makes false carry a note; the new checks are in `## Amendment 2026-11-05 checks` at the end.

## Commands
- [x] `pnpm db:migrate` → prints `Migrations applied.`; the dev database has the 20 core tables, the `pgboss` schema owned by `ssdashboard_app`, and the seeded settings, `pc` unit, `TRANSIT` and `SCRAP` locations → AC-2, AC-3, AC-13
  > Amended 2026-11-05: the baseline holds many more tables (see the ownership map in the tenancy child), and the `pgboss` schema is owned by the role named in `ssd.app_role`.
- [x] `pnpm --filter @ssdashboard/db test:e2e` → all pass (append only triggers and grants, composite keys, archive rules) → AC-2, AC-13
- [x] `pnpm build && pnpm --filter @ssdashboard/api test:e2e` → all pass, including `ledger`, `ledger-tracking`, `numbering-reconcile`, and `scale` → AC-1 to AC-14
- [x] `pnpm test` → all pass, including `costing.spec.ts`, `money.spec.ts`, and `module-boundary.spec.ts` → AC-2, AC-12
  > Amended 2026-11-05: `apps/api/src/inventory/module-boundary.spec.ts` is replaced by `apps/api/src/module-boundary.spec.ts` (A5).
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
  > Amended 2026-11-05: replaced by the 50,000 SKU suite (AC-36).

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

## Amendment 2026-11-05 checks
_Not yet verified. Derived from AC-15 to AC-36 (as revised by the fix pass of 2026-11-05) and the Value sourcing tables of the five child specs. Run against a dev database recreated from the baseline (drop the volume, then `pnpm bootstrap`)._

### Commands
- [ ] `pnpm db:migrate` on an empty database → `Migrations applied.` from the three baseline files (`0000_baseline_extensions.sql`, `0001_baseline_tables.sql`, `0002_baseline_rules.sql`); regenerating with `pnpm db:generate` changes only `0001`; a second run applies nothing; `SELECT * FROM install` → one row whose `id` equals `current_setting('ssd.tenant_id')`; `SHOW ssd.app_role` in a new session → `ssdashboard_app` → AC-16
- [ ] Rerun `migrate` with a different `TENANT_ID` → fails with `TenantMismatch`, nothing changed → AC-16
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → all pass, including `tenant.e2e-spec.ts`, `operating-day.e2e-spec.ts`, and an append only case per table in A4 → AC-15, AC-17, AC-33
- [ ] `pnpm test` → all pass, including the phone, transition, outcome, line split, credit arithmetic, settlement state, ownership map, module boundary, owner type boundary, cost lookup, and redaction tests → AC-19 to AC-22, AC-24, AC-25, AC-27, AC-29, AC-30, AC-32, AC-34
- [ ] `pnpm build && pnpm --filter @ssdashboard/api test:e2e` → all pass, including `location-owner-types.e2e-spec.ts` and the amended ledger suites → AC-29, AC-31
- [ ] `pnpm test:e2e` → every pre existing api and Playwright test passes unchanged on the baseline → AC-16
- [ ] `pnpm build && pnpm --filter @ssdashboard/api test:e2e -- test/scale.e2e-spec.ts` → every p95 under its budget (the audit entry budgets of spec 0010 included); record the measured values below → AC-36
- [ ] `pnpm test:e2e` does not run `test/scale.e2e-spec.ts`; the CI `scale` job runs it nightly and on a pull request labelled `scale` → AC-36
- [ ] `pnpm lint` → passes; a planted `schema.orders` import in another module's folder fails the boundary test; a planted `=== 'consignment_partner'` outside the policy file fails the owner type boundary test → AC-29, AC-34

### Database checks (psql)
- [ ] `INSERT INTO stores (code, name, kind) VALUES ('X', '{"en":"X"}', 'internal') RETURNING tenant_id` → the install's id; the same insert in a scratch database that has no `ssd.tenant_id` setting → fails → AC-15
- [ ] Two stores, each with order `#1001` → both insert; a second `#1001` in one store → unique violation → AC-18
- [ ] A `shopify` connection without a store → check violation; a second `shopify` connection on one store → unique violation; a `bosta` connection with and without a store → both insert → AC-18
- [ ] A `gifted` order with a line gross above 0 or a shipping charge → check violation (`total_amount = 0`); a gifted line with `unit_price` 500.00 and discount 500.00 → inserts; an `exchange_replacement` without `original_order_id` → check violation → AC-23
- [ ] An order with `fulfillment_state = 'refused'` and no `refused_reason_code` → check violation; a `gateway` connection → inserts; an order with `prepaid_amount > 0` and no `prepaid_method` → check violation → AC-18, AC-19, AC-24
- [ ] A `goodwill` credit entry funded `cod_cash`, a `refund_payout` funded `credit_only`, and a `refund_payout` without `payout_method` → each a check violation; a reversal of a `return_credit` with a negative amount → inserts → AC-24
- [ ] A settlement line inserted twice into one statement with one `external_line_ref` → unique violation; the same ref in a superseding statement → inserts; `settlement_lines` has no `period_id` column; an `accounted` match without `account_code` → check violation → AC-25
- [ ] A task with `owner_hat = 'partner'` → check violation → AC-26
- [ ] `UPDATE locations SET owner_type = 'own'` on a partner location → fails with `OwnerTypeFixed` → AC-29
- [ ] Two periods of one settlement account with overlapping dates → exclusion violation; a `carrier` account with a party → check violation → AC-25
- [ ] A task set to `done` without an outcome → check violation; two open tasks with one dedupe key → unique violation → AC-26
- [ ] `SELECT ssd_operating_day('2026-11-05 22:30:00+00')` → the Cairo local date of that instant (`2026-11-06` when the database's zone data puts Cairo at UTC+2 that day; the e2e test, not this line, owns the transition dates) → AC-17
- [ ] As the app role, `UPDATE credit_entries SET amount = 1` → permission denied; as the owner → "append only" (repeat for each A4 table) → AC-33

### Value sourcing (one per row: vary the input the value depends on)
- [ ] `tenant_id` comes from the database setting, never from the writer → Tenancy child: any insert
- [ ] `operating_day` follows its source column and the `timezone` and `operating_day_cutoff_hour` settings; changing the zone changes new rows only → Tenancy child: stamped insert
- [ ] Order `cod_expected_amount` = total − prepaid − credit applied, frozen when the carrier delivery exists → Orders child: create order
- [ ] `cod_due_amount`: a 2,450.00 order (three 800.00 pieces, 50.00 shipping) with one piece back gives 1,650.00 (full shipping kept); a full return to origin gives 0; a cancelled line leaves `lines_gross_amount` → Orders child: money on the order
- [ ] Allocation: 300.00 credit on lines of 600.00 and 350.00 with 50.00 shipping gives 180.00, 105.00, and 15.00 → Orders child: allocation
- [ ] `delivered_amount` counts `delivered` and `returned` lines, so two delivered 500 pieces with one returned and refunded give `partially_refunded` → Orders child: the derived outcome
- [ ] A return credit splits by funding: a 1,200.00 COD line with a 300.00 `credit_only` share gives 300.00 `credit_only` and 900.00 `cod_cash` → Customers child: return credit
- [ ] Payout matching: `gateway` funding only by `gateway_refund`; `cod_cash` and `instapay_or_transfer` by carrier cash or InstaPay; `credit_only` never → Customers child: refund payout
- [ ] Consumption spends `credit_only` first and is 0 for a customer who owes; a `debt_payment` never exceeds the debt → Customers child: consumption, debt payment
- [ ] A line's period is found from `occurred_on`: lines imported before the period existed join it → Settlement child: rules
- [ ] An opening stock line without a cost raises `InvalidCost`; the onboarding import's uncosted style list comes from `CostService` returning `NotSet`; an `estimate` record is returned with its basis → Catalog child: stock ledger changes
- [ ] First cash state from the amounts (`unpaid`, `prepaid`, `nothing_to_collect`) → Orders child: first state rule
- [ ] Split amounts: the worked example (gross 1,000.00 over 3 units, 1 returned → 333.33 and 666.67) → Orders child: partial delivery
- [ ] Outcome from fulfillment state, delivered amount, and refunded amount, one case per row → Orders child: the derived outcome
- [ ] Return credit share and the last unit's exact rest (999.99 over 2 → 500.00 then 499.99) → Customers child: return credit
- [ ] Consumption and balance due (500 credit, 800 order → 500 and 300); leftover (800 credit, 500 order → 300) → Customers child: exchange
- [ ] Phone normalization, one case per table row → Customers child: phone normalization
- [ ] A line's state is its latest match row; a period's status is its latest event → Settlement child: rules
- [ ] Carrier line store from the account binding, else the delivery's store → Settlement child: import
- [ ] Cost lookup by newest effective date, override on a tie, then newest recorded → Catalog child: cost lookup
- [ ] Cost rule `not_set` before the first set row, never 0 → Catalog child: per order cost rules
- [ ] Owner type answers come from the seeded policy rows → Catalog child: locations

### Scale results
_Fill in from the first measured run (AC-36); the budgets in the catalog child are Assumed until then._

### Acceptance criteria coverage (amendment)
- AC-15 … tenant schema test, psql insert check
- AC-16 … migrate commands, unchanged suites
- AC-17 … operating day test, psql check
- AC-18 … order number, connection binding checks
- AC-19, AC-20 … transition unit tests (feature 16 adds the writer tests)
- AC-21 … line split unit test
- AC-22 … outcome unit test
- AC-23 … gifted and exchange checks
- AC-24 … credit arithmetic and table checks (feature 28 adds the locked balance tests)
- AC-25 … settlement checks and state functions (features 22 and 23 add matching and close)
- AC-26 … task checks (feature 17 adds the service tests)
- AC-27 … phone tests, unique phone, redaction test
- AC-28 … merge table checks (feature 14 adds resolution and undo tests)
- AC-29 … owner type trigger, policy, boundary, three way test
- AC-30 … cost lookup test
- AC-31 … opening balance needs a cost, restock at the shipment's cost (ledger cases)
- AC-32 … cost rule tests
- AC-33 … append only cases per table
- AC-34 … ownership map and boundary tests
- AC-35 … outbound command checks and the packing refusal in `nextState`
- AC-36 … scale suite
