# Verify: orders and their state machines · spec 0013 · written 2026-11-07, updated the same day for the domain reviews

_Steps derived from spec 0013 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Each milestone of the Build plan ticks the steps it makes runnable. The test file names are the ones the Build plan creates._

## UI / manual

- [ ] As support, open `/orders/new`, pick channel WhatsApp, add two variants found by an Arabic name typed without hamza, a phone typed in Arabic digits, an address, 50.00 shipping, payment cash on delivery, and save → a toast names `MAIN` and `SO-<year>-000001`; the order opens with two lines, state New and Unpaid, outcome Open, COD expected and due equal to the total → AC-1, AC-3, AC-5
- [ ] Press save twice quickly on a new form → one order, not two → AC-1
- [ ] As support, open `/orders/new` in gifted mode → not offered; as a manager create a gifted order with reason Influencer → the price shows with an equal discount, total 0.00, cash Nothing to collect, a Gift flag in the list → AC-2
- [ ] Open `/orders` → newest first, the store code beside every number, two chips at most plus the outcome once final, flags under the number; filter by store, then fulfillment state, then cash state, then the hold, then a day range; clear each → AC-3, AC-4
- [ ] Search `1001` with two stores holding `#1001` → two rows, each with its store; search a customer's second phone → her order; the browser's address bar never holds the phone → AC-3, AC-4
- [ ] Load more until the end → no repeated or missing row, an end message → AC-4
- [ ] On an order, edit: change the M line to L and fix the address in one save → the old line shows Cancelled (edit removal), the new line is last, totals updated; a manager sees one "Order edited" entry in the history panel saying the address changed, without the address → AC-9, AC-11, AC-5
- [ ] Open the same order in two tabs, edit in the first, then save in the second → "changed by someone else, reload", nothing overwritten → AC-9
- [ ] Try to remove the only open line → refused with "cancel the order instead" → AC-9
- [ ] On an order of a Shopify store with write back unavailable → Edit is replaced by "Edit this order in Shopify" → AC-10
- [ ] Confirm a new order → Confirmed with your name and time in the timeline; as warehouse, Pack it → Packed; Back to confirmed → Confirmed → AC-7
- [ ] With a waiting write back command on an order (fixture) → the list shows "Edit not synced, hold" and the hold filter finds it; Pack is refused with the hold message → AC-7, AC-12
- [ ] Cancel an order as a duplicate without choosing the original → refused; with it → Cancelled, lines still listed as open, totals unchanged, cash Nothing to collect, the original linked → AC-7
- [ ] An order whose carrier delivery exists (pickup requested) → Edit is not offered and a direct edit answers "locked"; Cancel is still offered, cancelling works, the order shows Cancelled with cash Nothing to collect, and a "terminate the delivery in Bosta" attention is raised (fixture listener) → AC-8
- [ ] A fixture carrier fact "terminated before pickup" on a confirmed order → Cancelled, stock released, no terminate attention; after the parcel is shipped, Cancel is not offered → AC-8, AC-15
- [ ] Cancel an order of a Shopify store while write back is unavailable → "cancel this order in Shopify", nothing changed → AC-7
- [ ] Cancel a packed order → the warehouse gets "unpack the cancelled order" (fixture listener) → AC-7
- [ ] Edit a fully prepaid order down to a cheaper size → "the customer has paid more than the new total", nothing changed → AC-9
- [ ] On `/orders/new`, reopen a cancelled order by choosing it as "reopened from" → the new order shows the link and the original's campaign; both pages show the link → AC-23
- [x] An order line the warehouse cannot cover → "short" on the line and a Short flag in the list, the order still saved; Pack answers "a line is short" → AC-13, AC-7 _(QA 2026-11-12, milestone 4: driven in English and Arabic on the real app, and `e2e/orders.spec.ts` "marks a short line on the page and the list" desktop and mobile; `docs/reviews/verify-orders-stock-holds.md`)_
- [ ] Receive the missing piece (a receipt) → the order's line is no longer short without anyone touching the order; Pack works → AC-13
- [x] Before a location first goes online, with open orders imported, the online gate shows "open orders are held" failing with a count; Hold open orders here → the count goes to 0 → AC-26 _(QA 2026-11-12: driven in English and Arabic on the real app, 182 lines then 0)_
- [ ] As a person without `cost.view` → no unit cost on any line; with it → unit cost after shipping → AC-5, AC-19
- [ ] As a media buyer or partner → no Orders entry, a direct visit shows the no access state and loads no order → AC-19
- [ ] Switch to Arabic on every orders screen → right to left, Arabic labels, Western digits, codes left to right inside `LtrText`; Tab through the list, page, form, and dialogs → visible focus, Escape closes dialogs, focus returns to the trigger; one `<h1>` per page → AC-20

## Commands

- [ ] `pnpm --filter @ssdashboard/contracts test` → the exhaustive `nextState` test with the cancel row until pickup (person, `system_job`, `carrier`) and the `payment_method_rederived` cash rows, `codDue` returns 0 for `cancelled`, the order API schemas, the five audit codes with labels in both languages → AC-6, AC-7, AC-11
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → the schema test (the foreign key index rule, no `DESC NULLS LAST`), the tenant key test with `orders_store_channel_ref_unique` leading with `tenant_id` → AC-1, AC-14
- [ ] `pnpm --filter @ssdashboard/api test` → `DomainEvents` unit test (order, transaction passed, throw rolls back), `edit-plan` unit tests, the single writer test, `module-boundary.spec.ts`, `audience.spec.ts`, `permission.spec.ts` → AC-6, AC-9, AC-18, AC-19
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/orders.e2e-spec.ts` → create, idempotent `clientRef`, gifted, list, search, phone not in a URL, read services for customers → AC-1 to AC-5, AC-21
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/orders-audit.e2e-spec.ts` → the sentinel address, phone, name, and note appear in no column of `audit_entries`; `personal_fields` lists them; a failed audit write rolls the edit back → AC-11
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/orders-intake.e2e-spec.ts` → channel create replay, `OrderNumberTaken`, channel edit diff, nothing applied while a command is open, id less lines matched not duplicated, `recordChannelLineIds`, overpaid and locked snapshots not applied, prepaid never changed, channel cancel before pickup, the final state echo, after pickup, import and go live first states, `linkChannelLineVariant`, `rederivePaymentMethod`, `replacement_for` from the channel → AC-14, AC-23, AC-25
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/orders-transitions.e2e-spec.ts` → every carrier and cash row, the carrier cancel before pickup, a fact the table does not list applying nothing, the attentions, `LinesReturnedToOrigin`, automatic `nothing_to_collect`, the partial delivery worked example, collection with and without a reason, settlement moves and revokes, the shipment job writing `unit_cost` → AC-6, AC-15, AC-16, AC-17
- [x] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/orders.e2e-spec.ts` (stock cases, after milestone 4; built as `test/orders-stock.e2e-spec.ts`, with QA gaps in `test/orders-stock-gaps.e2e-spec.ts`, one case failing on a bug, see the verify report) → reserve on create, release on cancel, top up on confirm and pack, `LINE_SHORT`, `ReservationFilled` and `ReservationShortened` move `short_quantity`, the gate check and `hold-open-orders`, a forced deadlock reruns the unit once → AC-13, AC-22, AC-26
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/access-sweep.e2e-spec.ts` → a fixture for every orders route, each answering its permission → AC-19
- [ ] `pnpm --filter @ssdashboard/web test:e2e -- e2e/orders.spec.ts --project=desktop` → the create, list, page, edit, cancel, and pack thread in both languages, axe clean, keyboard only → AC-20
- [ ] `pnpm --filter @ssdashboard/api test:scale` → with 150,000 orders, the unfiltered page, each filter alone, and the search under 150 ms at p95; measured values pasted into the index → AC-4
- [ ] `pnpm lint && pnpm typecheck && pnpm format:check` → clean → all

## Value sourcing checks

- [ ] A manual order at 00:30 Cairo time with cutoff hour 2 → `operating_day` is the previous day (trigger), and the list's day filter finds it there → AC-4
- [ ] A manual order's number uses the `SO` prefix of `document_prefixes`; changing the prefix changes only later numbers → AC-1
- [ ] A line's net, tax, and gross equal `LineAmounts.compute` with the `sales_tax_rate` setting and `prices_include_vat`; `shipping_tax_amount` follows the inclusive rule → AC-1
- [ ] After any write, `outcome` equals `deriveOrderOutcome` of the row, `cod_due_amount` equals `codDue` of the row and its lines, and `replayStates` of the events equals both states → AC-6
- [ ] After `recordCarrierDelivery`, an attempted edit leaves `cod_expected_amount` and every share unchanged → AC-8
- [ ] `write_back_state` after a command is queued, fails, syncs, and is resolved equals the answer of `openCommandsFor('order', id)` each time → AC-12
- [ ] After every reserve, fill, and shorten, each open line's `short_quantity` equals its reservation's `unfilled_quantity` (spec 0011) → AC-13 _(QA 2026-11-12: not met: a confirm with no online location marks a line held in full at a candidate short, `orders-stock-gaps.e2e-spec.ts`)_
- [ ] A carrier `shipped` on an order with a short line commits, and the shipment job's `postCarrierShipment` books it with key `order_shipment:<orderId>` → AC-24
- [x] Every orders write method's first parameter is `OrderTransaction`; a call with a plain transaction fails `pnpm typecheck` (type test) → AC-22 _(QA 2026-11-12: `src/orders/order-transactions.spec.ts` and `order-transactions.adapter.spec.ts` in `pnpm test`, `pnpm typecheck` clean)_
- [ ] The customer link: a known phone links the existing customer, a new phone creates one, an unparseable phone leaves `customer_id` null with `contact_phone_raw` set → AC-1
- [ ] The `record_label` of every order audit entry is `<store code>/<order number>` → AC-3, AC-11
- [ ] No domain event payload published by the orders module carries a key in `PERSONAL_DATA_KEYS` (a unit test walks each event class) → AC-18
