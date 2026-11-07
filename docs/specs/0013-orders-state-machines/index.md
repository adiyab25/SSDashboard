# 0013. Orders and their state machines: one orders module that is the only writer of orders, with named moves other features call inside their own transaction

**Date**: 2026-11-07
**Status**: Proposed
**Scope feature**: 16, Orders & their state machines (GA), in [Slice 1a: confirmation to cash](../../scope/confirmation-to-cash.md)
**Depends on**: the feature 4 baseline (built: [spec 0002 orders child](../0002-core-data-model/0002-orders.md), the `orders`, `order_lines`, and `order_events` tables, and the pure rules in `packages/contracts/src/orders/`); [spec 0008](../0008-roles-as-hats/index.md) (built: the `orders.*` and `fulfillment.work` permissions); [spec 0010](../0010-audit-trail/index.md) (built: `AuditService.record`). Written in parallel with specs 0011 (stock reservations), 0012 (variant search), 0014 (customer link), and 0015 (Shopify intake, outbound commands, stores and channels); the calls this spec makes to each are listed in [Contracts with the parallel specs](#contracts-with-the-parallel-specs), and each milestone names which one it needs.

## Summary

An order is where cash on delivery lives or dies, so exactly one place may change it: the new `orders` module in the api. Shopify, the confirmation queue, Bosta, delivery failures, and settlement never touch the order tables; they call a small set of named moves (create, edit, confirm, cancel, pack, carrier fact, partial delivery, collection, settlement) inside their own database transaction, and every move goes through the transition tables that already exist in `packages/contracts`, writes one event row, recomputes the money and the outcome, and announces itself to the rest of the app in the same transaction. Staff get an order list and an order page in Arabic and English with the store beside every order number, can create a manual or gifted order, and can edit an order (address, pieces, sizes, shipping) until the carrier delivery exists, with every edit in the audit trail. Nothing here redesigns the data model of spec 0002; it adds two columns and five indexes and fixes two small rules the domain review left to this feature.

## Requirements

**User stories**:

- As a support agent, I want to open any order and see its store, lines, both states, money, and history on one page, so that I can answer a customer on WhatsApp without opening Shopify and Bosta side by side.
- As a support agent, I want to fix the address, change a size, or add a piece before the parcel leaves, so that the courier gets the right parcel and the right amount to collect.
- As a support agent, I want to enter an order a customer placed on WhatsApp or Instagram, so that every order lives in one list.
- As a manager, I want to record a gifted order with its reason, so that influencer and giveaway parcels are tracked without ever counting as revenue or as a return.
- As a warehouse person, I want an order whose edit has not reached Shopify to say "hold" in the list and to refuse packing, so that we never ship the old size.
- As a manager, I want to see who changed an order and why, so that I can trace a wrong address or a wrong amount.
- As the developer of Shopify, Bosta, delivery failures, or settlement, I want one documented call for each move I need, so that my feature never writes an order table and never breaks the state machines.

**Acceptance criteria** (the contract; each is checkable on its own):

_Orders in and out_

- **AC-1** (manual order): a person with `orders.confirm` creates a sale order on `POST /api/orders` into an internal store (owner decision Q-16.1, recommended), on a channel of kind `manual`, `whatsapp`, or `instagram`, with at least one line of a known variant, a ship to name, phone, and address, a shipping charge, and payment `cod` (or fully prepaid by `instapay`, `bank_transfer`, or `wallet`). In one transaction the order gets the number `NumberingService.next(tx, 'SO', placedAt)` (`SO-2026-000123`), `placed_at` = now, lines priced by `LineAmounts.compute` with the `sales_tax_rate` setting and `prices_include_vat`, totals, allocation, `cod_expected_amount`, `cod_due_amount`, the first fulfillment event (`null` to `new`) and the first cash event (`null` to `firstCashState`), outcome `open`, and the customer link from the main phone. A phone that does not parse leaves `customer_id` null, keeps the text in `contact_phone_raw`, and raises the attention `phone_unparseable`. A repeat of the same `clientRef` returns the first order and writes nothing. A store of kind `shopify` answers 422 `STORE_NOT_INTERNAL`; a prepayment other than 0 or the full total answers 422 `PARTIAL_PREPAYMENT_NOT_SUPPORTED`.
- **AC-2** (gifted order): only a person with `orders.gift` creates a gifted order on `POST /api/orders/gifted`; it needs a `giftReasonCode` from the list (`influencer`, `giveaway`, `staff`, `replacement_goodwill`, `other`), every line keeps its retail `unitPrice` with an equal discount (gross 0), shipping charged is 0, payment `none`, and it starts `nothing_to_collect`. Editing a gifted order needs `orders.gift` too (403 `GIFT_NOT_ALLOWED` otherwise), and an edit that gives any line or the shipping a gross above 0 answers 422 `GIFT_MUST_STAY_FREE`. Every list row, detail page, and API answer carries `type`, so revenue and return rate readers (feature 24) can leave gifted orders out.
- **AC-3** (store beside every number, carried B1): two stores each hold an order `#1001`; a second `#1001` in one store is refused (`OrderNumberTaken`, 409 `ORDER_NUMBER_TAKEN`). Every place this feature shows or returns an order number shows the store code beside it: the list, the detail header, the search result, the event timeline, the toast after an action, and the audit `record_label` (`<store code>/<order number>`, for example `ESS/#1001`).
- **AC-4** (order list): `/orders` (permission `orders.view`) lists orders newest first with keyset pages (50 by default, 100 at most, no skipped or repeated row while new orders arrive), filters for store, channel, fulfillment state (several), cash state (several), outcome, type, write back hold, customer (every id of a merged customer, from the customer page), and an operating day range, and one search box that finds a phone (any form `EgyptianPhone` parses, matching the order's main or second ship to phone, or any phone of its customer) or else an order number in every store (`1001` finds `#1001`). Each row shows, in the design system's fixed column order, the number with its store and placed time, the ship to name, the channel, the total and the amount due, the fulfillment chip (with the outcome once it is final), and the cash chip; a hold, a gift, an exchange replacement, and a phone that needs fixing show as small flags under the number. With the spec 0002 scale load (150,000 orders), each filter alone and the unfiltered first page answer in under 150 ms at p95.
- **AC-5** (order page): `/orders/<id>` (permission `orders.view`) shows the number and store, type, channel, source, placed time in the install time zone, both state chips and the outcome, the ship to block, the linked customer's name and risk flag with a link to the customer page, the customer note, the lines (SKU code and name, quantity, unit price, discount, gross, line state, prepaid and credit shares, a "short" mark when the stock reservation could not be met, and `unitCost` only for a viewer holding `cost.view`), the money block (total, prepaid with its method, credit applied, COD expected, COD due, collected, remitted), the write back state of each open command, and the event timeline (every `order_events` row with its actor's name, reason, and time). A viewer with `audit.read` also sees the order's audit entries (`GET /api/audit/records/order/:id/entries`, spec 0010). An unknown id answers 404 `ORDER_NOT_FOUND`.

_The two state machines_

- **AC-6** (one way to move): every state change of either machine goes through `nextState` in `packages/contracts/src/orders/order-states.ts` and writes exactly one `order_events` row in the same transaction as the change of `orders.fulfillment_state` or `orders.cash_state`, with the actor, reason code, source, and `occurred_at`. A move the table refuses answers 409 `INVALID_TRANSITION` with both states and writes nothing. `orders.outcome` is written only from `deriveOrderOutcome` in the same transaction as any change to its inputs. Replaying an order's events `ORDER BY recorded_at, id` with `replayStates` equals the stored states, including two events written in one transaction.
- **AC-7** (confirm, cancel, pack): a person with `orders.confirm` confirms a `new` order (sets `confirmed_at`, `confirmed_by`), and cancels a `new`, `confirmed`, or `packed` order with a cancel reason code (`customer_cancelled`, `duplicate`, `fake`, `no_answer`, `out_of_stock`, `wrong_details`, `other`); `duplicate` needs the order it duplicates and sets `related_order_id` with `duplicate_of`. A cancel leaves every line and every total as it was, sets `cancelled_at` and `cancel_reason_code`, brings `cod_due_amount` to 0, moves cash `unpaid` to `nothing_to_collect` (actor `system_job`) in the same transaction, and releases the order's stock reservations. A person with `fulfillment.work` moves `confirmed` to `packed` and back. `packed` is refused with 409 `WRITE_BACK_OPEN` while the connectors service reports an open command on the order (carried B2), whatever `write_back_state` says.
- **AC-8** (edit lock): once `carrier_delivery_created_at` is set, or once the fulfillment state is past `packed`, every edit and every cancel answers 409 `ORDER_LOCKED` and changes nothing; `cod_expected_amount`, `prepaid_amount`, `credit_applied_amount`, and every allocation share stay as they were from that moment.

_Edits and their audit_

- **AC-9** (edits): a person with `orders.confirm` sends `POST /api/orders/:id/edits` with `expectedUpdatedAt`, an optional reason code (`customer_request`, `address_fix`, `size_change`, `out_of_stock`, `price_fix`, `other`), and one or more operations: change the ship to fields (name, phone, second phone, address, courier note, the carrier area codes), add a line, replace a line (a new variant, quantity, or price), remove a line (with `customer_cancelled`, `out_of_stock`, or `duplicate`), and change the shipping charge. All operations apply in one transaction. A line is never changed in place: a replace cancels the old line with `edit_removal` and adds a new one at the next position. Afterwards `lines_gross_amount`, `total_amount`, `shipping_tax_amount`, the allocation shares, `cod_expected_amount`, and `cod_due_amount` are recomputed with the existing contract functions; an edit in `packed` also moves the order back to `confirmed` (one event). A changed main phone relinks the customer and clears `contact_phone_raw`. Refusals: a stale `expectedUpdatedAt` answers 409 `ORDER_STALE`; an edit that would leave no open line answers 422 `ORDER_NEEDS_A_LINE` (cancel the order instead); an edit that would move `cod_expected_amount` between 0 and above 0 answers 422 `EDIT_CHANGES_PAYMENT`.
- **AC-10** (edits on a Shopify order): an order of a `shopify` store is editable in the app only while the connectors service says a write back is available for that store; otherwise every edit answers 409 `EDIT_IN_SHOPIFY` and the order page says to edit the order in Shopify, from where it syncs back (owner decision Q-16.3, recommended). An edit made in the app publishes `OrderEdited` with `origin: 'person'` in its transaction, which feature 13 turns into an outbound command in the same transaction.
- **AC-11** (audit): every edit writes exactly one `order.edited` audit entry in the edit's transaction, with the changed fields in `before` and `after`, the ship to values stored as `"[REDACTED]"` and listed in `personal_fields` (a test with sentinel values proves the address, phone, name, and courier note appear in no column of `audit_entries`), the reason code, and `record_label` `<store code>/<order number>`. A channel edit writes the same code with the `system_job` actor and `after.origin = 'channel'`. Creating a manual or gifted order writes `order.created_manually`; a partial delivery split writes `order.partial_delivery_split`; a cash collection a person enters writes `order.collection_recorded_manually` with a required reason code. A failed audit write rolls the change back.

_The write back hold (carried B2 and n1)_

- **AC-12** (hold): `orders.write_back_state` follows the open outbound commands on the order (`failed` if any failed, else `waiting` if any waits, else `none`), updated in the same transaction as the command change through the `OutboundCommand*` domain events, recomputed from `ConnectorsService.openCommandsFor('order', id, tx)` each time. The list filter "hold" finds every order with `write_back_state <> 'none'`, and the list row and the order page show "Edit not synced, hold" with the command's state and reason.

_Stock_

- **AC-13** (reservations): creating an order reserves stock for every line with a variant, adding or replacing a line reserves the new line, removing or replacing a line releases the old line's reservation, and a cancel releases them all, each in the order's transaction through the inventory module's reservation service (owner decision Q-16.2, recommended: reserve at creation). A shortage never refuses an order or an edit: the line is reserved as far as stock allows and the order page marks it "short".

_The calls other features make_

- **AC-14** (channel intake for feature 13): `OrderIntake.createFromChannel(tx, input, actor)` is idempotent on (`tenant_id`, `store_id`, `channel_order_ref`): a repeat returns `{ orderId, created: false }` and writes nothing; a different ref with a number the store already holds throws `OrderNumberTaken`. `OrderIntake.applyChannelEdit(tx, orderId, snapshot, actor)` diffs the snapshot by `channel_line_id` (missing lines cancelled with `edit_removal`, new lines added, changed quantity, variant, or price as cancel plus add) and the ship to fields, and applies it like AC-9; once the carrier delivery exists, or when the edit would change payment as AC-9 says, it applies nothing, returns `{ applied: false, why }`, and raises the attention `channel_edit_not_applied`. `OrderIntake.cancelFromChannel(tx, orderId, reasonCode, actor)` cancels as AC-7 with the `system_job` actor and a `channel.` reason code, or, after the carrier delivery exists, applies nothing and raises `channel_cancel_after_carrier_delivery`. An import (`actor_type = 'import'`, feature 15) may set the first states as found.
- **AC-15** (carrier moves for features 19 and 21): `OrderTransitions.recordCarrierDelivery(tx, orderId, { at, source })` sets `carrier_delivery_created_at` once (a repeat changes nothing) and raises `delivery_created_before_edit_synced` when a write back is open. `OrderTransitions.recordShipmentFact(tx, orderId, fact, actor)` applies `shipped`, `failed_attempt`, `delivered`, `refused` (with a `RefusedReasonCode`), `returned_to_origin`, and `lost` exactly as the transition table allows for that actor, never refuses a carrier fact the table lists, sets `carrier_delivery_created_at` on the first fact if it was unset, raises each task the table returns as an attention, moves every `open` line to `delivered`, `returned_to_origin`, or `lost` as the table says, publishes `LinesReturnedToOrigin` for lines that come back or are lost, and moves cash `unpaid` to `nothing_to_collect` when `cod_due_amount` is 0 and nothing was collected. On `shipped` it enqueues the shipment posting job in the same transaction; the job posts the `order_shipment` movement through the inventory module and writes each line's `unit_cost` from it.
- **AC-16** (partial delivery): `OrderTransitions.recordPartialDelivery(tx, orderId, { lines: [{ lineId, deliveredQuantity }], occurredAt, source }, actor)` splits each named line with `splitLine` (a line of one unit is delivered or returned whole), marks other open lines delivered unless named with 0, needs at least one delivered and one returned unit, moves fulfillment to `partially_delivered`, lowers `cod_due_amount` by the returned rows only, leaves `lines_gross_amount` and `total_amount` unchanged, writes `order.partial_delivery_split`, and publishes `LinesReturnedToOrigin` for the returned rows.
- **AC-17** (cash moves for features 19 and 22): `OrderTransitions.recordCollection(tx, orderId, { amount, occurredAt, source, reasonCode }, actor)` moves cash to `collected_by_carrier` with `cod_collected_amount` = the new total (partial amounts allowed, a later call corrects it, a person needs a reason code and writes the audit entry of AC-11); `reverseCollection` moves it back to `unpaid`. `OrderTransitions.recordSettlement(tx, orderId, change, actor)` moves `collected_by_carrier` to `remitted` (needs `depositedOn` and sets `remitted_amount`), `remitted` to `reconciled` (needs `fullySettled: true`), `prepaid` to `reconciled`, and the two revokes back (reason code required). `OrderTransitions.markExchanged(tx, orderId, { exchangeId }, actor)` moves `delivered` or `partially_delivered` to `exchanged` for feature 34.
- **AC-21** (reads for other modules): `OrderQueries.summaryOf(orderIds)` answers ids, store, number, type, both states, outcome, and amounts, never a ship to field; `OrderQueries.forCustomers(customerIds, { cursor, limit })` answers the orders of a set of customer ids newest first (number with store, placed time, both states, outcome, total, payment method, refusal reason) with a (`placed_at`, `id`) keyset, for spec 0014's timeline; `OrderQueries.countsForCustomers(customerIds, { sinceDay })` answers `{ orders, refused, returned }`: the count of orders (every type, all time when `sinceDay` is null, for spec 0014's merge compare), and, on or after that operating day and leaving gifted orders out, the orders whose fulfillment reached `refused` at the door and the orders with at least one line `returned` after delivery, for spec 0014's returner signal. None of them is a route; each reads only orders tables.

_Events, security, and quality_

- **AC-18** (domain events): the platform `DomainEvents` service (spec 0002 A6) calls every registered handler of an event with the publisher's transaction, in registration order, before the publisher commits; a handler that throws rolls the whole change back. The orders module publishes `OrderPlaced`, `OrderEdited`, `OrderStateChanged` (one per `order_events` row), `OrderAttentionRaised` (every attention kind of this spec, for feature 17 to open a task), and `LinesReturnedToOrigin`, each with ids and codes only, never a phone, name, address, or note.
- **AC-19** (security): every new route is `@Audience('staff')` with exactly one `@Permission` from the mapping in this spec, a person without it gets 403 `FORBIDDEN`, the route sweep (`apps/api/test/access-sweep.e2e-spec.ts`) has a fixture for each, `unitCost` leaves only through the cost serializer, and no log line written by the orders module carries a ship to field, the customer note, or a raw phone.
- **AC-20** (screens): the list, the order page, the new order form, and the edit and cancel dialogs render inside the back office shell with exactly one `<h1>`, in Arabic and English with right to left layout and logical CSS only, numbers and money through `useFormat()`, order numbers and SKU codes in `LtrText`, full keyboard use with visible focus, and no axe violation in either language, built to `packages/ui/DESIGN.md`.

## Decision

**Chosen option**: Option 1 in [rationale.md](rationale.md): one `orders` module is the single writer of `orders`, `order_lines`, and `order_events`; other modules move an order only by calling its named methods with their own transaction, and the orders module announces each change through an in transaction `DomainEvents` service it builds here.

Every write path takes the order row lock, checks the move with the existing pure rules, writes the row changes and the event row, recomputes money and outcome, writes the audit entry when one is owed, and publishes its domain events, all in the caller's transaction. Runner up: an event sourced order (the order row rebuilt from events), rejected because edits, splits, and money are not state events in the built model and the baseline is already shipped.

**Implementation skills**: `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `pg-boss-v12` (`sncollective/snc-platform`, `.claude/skills/pg-boss-v12/`) and `tl-pg-boss` (`toddlevy/tl-agent-skills`, `.claude/skills/tl-pg-boss/`) for the shipment posting job · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning, options, and the evidence behind each choice: [rationale.md](rationale.md).

## Feature design

### Where things live

- `apps/api/src/platform/events/domain-events.ts`: `DomainEvents` (`on(eventClass, handler, owner)` at module init, `publish(tx, event)`), exported by `PlatformModule`. A6 says the first projection builds it; this is that feature.
- `apps/api/src/orders/` (module `orders`, core, no toggle; README with the five headings):
  - `orders.module.ts`, `orders.events.ts` (the public event classes other modules import), `orders.errors.ts` (`OrderNotFound`, `OrderNumberTaken`, `OrderLocked`, `OrderStale`, `OrderNeedsALine`, `EditChangesPayment`, `EditInShopify`, `WriteBackOpen`, `GiftMustStayFree`, `PartialPrepaymentNotSupported`), `orders-http.ts` (domain error to HTTP code map).
  - `writer/order-writer.ts`: the only file that issues `INSERT`, `UPDATE` on `orders` and `order_lines` and `INSERT` on `order_events`. It locks the order (`SELECT ... FOR UPDATE`), applies a planned change, recomputes totals, allocation, `cod_expected_amount` (until the lock), `cod_due_amount`, `delivered_amount`, and `outcome`, writes event rows, and sets `updated_at`.
  - `intake/order-intake.service.ts` (`createManual`, `createFromChannel`, `applyChannelEdit`, `cancelFromChannel`).
  - `editing/order-editing.service.ts` and `editing/edit-plan.ts` (pure: operations to a planned change; also used by `applyChannelEdit`).
  - `transitions/order-transitions.service.ts` (`confirm`, `cancel`, `markPacked`, `unpack`, `recordCarrierDelivery`, `recordShipmentFact`, `recordPartialDelivery`, `recordCollection`, `reverseCollection`, `recordSettlement`, `markExchanged`).
  - `reading/order-query.service.ts`, `reading/orders.controller.ts`, `reading/order-list-sql.ts`.
  - `projections/write-back.projection.ts` (handles `OutboundCommand*`).
  - `shipment/post-shipment.job.ts` (worker; queue `orders.post_shipment`).
- `packages/contracts/src/orders/`: `order-api.ts` (request and response shapes below), `order-attention.ts` (`OrderAttentionKind`: the four `OrderTaskKind` values plus `phone_unparseable`, `channel_edit_not_applied`, `channel_cancel_after_carrier_delivery`, `delivery_created_before_edit_synced`, `shipped_with_unmapped_lines`, `shipment_not_posted`), `order-reasons.ts` (the cancel, edit, gift, and line removal code lists of the ACs). Changes to built files: `order-states.ts` (the `cancelled` row accepts `system_job` with a reason), `order-amounts.ts` (`codDue` takes an optional `fulfillmentState` and returns 0 for `cancelled`).
- `packages/contracts/src/audit/audit-actions.ts`: four new codes (Audit below).
- `apps/web/src/orders/` (feature folder with README): `order-list-page.tsx`, `order-detail-page.tsx`, `new-order-page.tsx`, `order-edit-dialog.tsx`, `cancel-order-dialog.tsx`, `order-number.tsx` (number plus store in `LtrText`), `order-line-picker.tsx`, and their specs. Routes stay thin: `apps/web/src/app/(backoffice)/orders/page.tsx`, `orders/new/page.tsx`, `orders/[orderId]/page.tsx`. One `navItems` entry, `needs: 'orders.view'`.
- `packages/i18n/src/locales/en.ts` and `ar.ts`: the `orders.*` keys, the state, outcome, reason, and attention labels.

### Data model

No new table. The tables, checks, and triggers of spec 0002 stand. One generated migration adds:

| Change | Definition | Why |
|---|---|---|
| `orders.channel_order_ref` | `text null`, check `length(channel_order_ref) <= 255` | the channel's own id of the order (a Shopify order id, or the manual form's `clientRef`): the idempotency key of intake, kept by the orders module so it never reads `connection_external_ids` |
| `orders_store_channel_ref_unique` | unique index (`tenant_id`, `store_id`, `channel_order_ref`) `WHERE channel_order_ref IS NOT NULL` | one order per channel id per store; leads with `tenant_id` (packages/db rule) |
| `orders.customer_note` | `text null`, check `length(customer_note) <= 2000` | the note the customer typed at checkout (spec 0002 follow up for feature 13 names it); personal data, already covered by `customernote` in `PERSONAL_DATA_KEYS` |
| `orders_placed_idx` | (`placed_at` desc nulls first, `id` desc nulls first) | the all stores list, newest first (the existing list index leads with `store_id`) |
| `orders_fulfillment_placed_idx` | (`fulfillment_state`, `placed_at` desc nulls first, `id` desc nulls first) | the state filter, including rare states like `lost` |
| `orders_order_number_idx` | (`order_number`) | the search box across stores (the unique key leads with `store_id`) |
| `orders_ship_to_phone_idx` | (`ship_to_phone`) `WHERE ship_to_phone IS NOT NULL` | the phone search |
| `orders_ship_to_phone_alt_idx` | (`ship_to_phone_alt`) `WHERE ship_to_phone_alt IS NOT NULL` | the phone search on the second number |

The scale suite decides whether more list indexes are needed (cash state already has the partial `orders_open_cash_idx`); an index is added only for a filter that misses its budget. `orders.updated_at` is the optimistic concurrency token (`expectedUpdatedAt`, microsecond text, the spec 0009 pattern). The `table-ownership.ts` map already lists `orders`, `order_lines`, `order_events`, and `shipments` under `orders`.

### State machines

The transition tables, the first cash state, the line split, the allocation, `codDue`, and the outcome are spec 0002's and are built. This feature applies them and changes two rules:

1. **A cancellation from the channel.** The `cancelled` row also accepts `system_job` with a reason code that matches `ReasonCode` (feature 13 maps the channel's own reason to a code starting `channel.`). It is refused once the carrier delivery exists, like a person's. The exhaustive `nextState` test gains the new pairs.
2. **A whole order cancellation** (domain review D3). Lines stay `open`, every total stays, and `codDue` returns 0 when the fulfillment state is `cancelled`, so the guard of `unpaid` to `nothing_to_collect` holds in the cancel's own transaction. Removing one piece still cancels that line (`order_lines.cancel_reason_code`). The cancelled value per agent therefore reads `total_amount` of cancelled orders, and an open line on a cancelled order holds no stock (its reservation is released).

The guards `nextState` leaves to the service (its TSDoc lists them) are enforced in `order-writer.ts`: `unpaid` to `nothing_to_collect` only with fulfillment `cancelled`, `returned_to_origin`, `refused`, or `lost`, `cod_due_amount = 0`, and `cod_collected_amount = 0`; `remitted` only with `depositedOn`; `confirmed` to `packed` asks `ConnectorsService.openCommandsFor('order', id, tx)` and passes `writeBackOpen` from that answer; `partially_delivered` only through `recordPartialDelivery`; `delivered` moves every `open` line.

Automatic follow on moves happen in the same transaction and each writes its own event: an edit in `packed` writes `packed` to `confirmed` (actor the editing person); any fulfillment move that leaves `cod_due_amount = 0` with nothing collected writes cash `unpaid` to `nothing_to_collect` (actor `system_job`, source the triggering event).

### Write paths (the contract other features call)

Every method takes the caller's `Transaction` first and an actor (`{ type: 'person', userId }`, `{ type: 'carrier', connectionId }`, `{ type: 'system_job', job, jobId }`, or `{ type: 'import', runId }`, matching `order_events.actor_type` and the spec 0010 actor). Each one locks the order row first, and never locks a second order except `cancel` with `duplicate` (both rows, ascending id). The orders module never commits or rolls back the caller's transaction. Lock order across modules: the order row, then whatever the inventory service locks.

| Method | Called by | Moves | Notes |
|---|---|---|---|
| `OrderIntake.createManual(tx, body, person)` | this feature's route | creates, `null` to `new`, `null` to first cash | AC-1, AC-2; idempotent on `clientRef` stored as `channel_order_ref` |
| `OrderIntake.createFromChannel(tx, input, actor)` | feature 13 (Shopify), 53 (landing page), 15 (import) | creates; first states `new` and first cash, or as found for `import` | AC-14; input below |
| `OrderIntake.applyChannelEdit(tx, orderId, snapshot, actor)` | feature 13 | edit; `packed` to `confirmed` when needed | AC-14; the snapshot is already netted (spec 0007 m3, feature 13) |
| `OrderIntake.cancelFromChannel(tx, orderId, reasonCode, actor)` | feature 13 | `cancelled` | AC-14 |
| `OrderEditing.edit(tx, orderId, body, person)` | this feature's route, feature 18's queue | edit | AC-9, AC-10, AC-11 |
| `OrderTransitions.confirm(tx, orderId, actor)` | this feature's route, feature 18 | `new` to `confirmed` | AC-7 |
| `OrderTransitions.cancel(tx, orderId, { reasonCode, duplicateOfOrderId? }, actor)` | this feature's route, feature 18 | `cancelled` | AC-7 |
| `OrderTransitions.markPacked` / `unpack(tx, orderId, actor)` | this feature's route, feature 33 | `confirmed` and `packed` | AC-7 |
| `OrderTransitions.recordCarrierDelivery(tx, orderId, { at, source }, actor)` | feature 19 (and 13 if it reads Shopify fulfillments) | none (sets the lock) | AC-15 |
| `OrderTransitions.recordShipmentFact(tx, orderId, { to, occurredAt, reasonCode?, source }, actor)` | features 19, 21 (a person may record `lost` with a reason) | carrier rows of the fulfillment table | AC-15 |
| `OrderTransitions.recordPartialDelivery(tx, orderId, { lines, occurredAt, source }, actor)` | features 19, 21 | `partially_delivered` | AC-16 |
| `OrderTransitions.recordCollection` / `reverseCollection` | features 19, 22 (a person from the courier's note) | cash `collected_by_carrier` and back | AC-17 |
| `OrderTransitions.recordSettlement(tx, orderId, { to, remittedAmount?, depositedOn?, fullySettled?, reasonCode?, sourceId }, actor)` | feature 22, in its matching transaction (directly, or from its own `SettlementLineMatched` handler) | `remitted`, `reconciled`, and the revokes | AC-17 |
| `OrderTransitions.markExchanged(tx, orderId, { exchangeId }, actor)` | feature 34 | `exchanged` | AC-17 |
| `OrderQueries.summaryOf(orderIds)` | features 17, 18, 19, 22, 24 | none | ids, store id, number, type, both states, outcome, amounts; never ship to fields (AC-21) |
| `OrderQueries.forCustomers(customerIds, { cursor, limit })` | spec 0014 (timeline) | none | AC-21; served by `orders_customer_idx` |
| `OrderQueries.countsForCustomers(customerIds, { sinceDay })` | spec 0014 (returner signal, merge compare) | none | AC-21 |

`ChannelOrderInput` (Zod, in `order-api.ts`, so feature 13 builds against a schema): `storeId`, `channelId`, `channelOrderRef`, `orderNumber`, `placedAt`, `type` (`sale` or `gifted`; `giftReasonCode` when gifted), `paymentMethod`, `prepaidAmount` and `prepaidMethod`, `shippingChargedAmount`, `discountCode`, `customerNote`, `channelCustomer` (spec 0014's shape: `shopify_customer` with `connectionId` and `externalId`, or null), the source fields of spec 0002, `shipTo` (name, phone text, second phone text, address, area codes when known, courier note), and `lines` (`channelLineId`, `variantId` or null when unmapped, `title`, `quantity`, `unitPrice`, `discountAmount`, `taxRate`). An `import` actor may add `firstStates` (`fulfillment`, `cash`, plus `carrierDeliveryCreatedAt`); any other actor gets `new` and `firstCashState`. `ChannelOrderSnapshot` is the same shape without the identity fields. Phones arrive as text and are parsed here with `EgyptianPhone` (the raw text goes to `contact_phone_raw` only when the main phone does not parse).

A prepayment other than 0 or the full total is refused on the manual path only (AC-1). A channel order with a partial prepayment (a deposit) is stored as it arrives and allocated by the existing gross share rule; the shipping deposit marker and the release of a prepaid share are features 18 and 21 (domain review D2), and nothing here precludes adding `prepaid_purpose` later.

### Domain events

Classes in `apps/api/src/orders/orders.events.ts`, published with `DomainEvents.publish(tx, event)` inside the write. Payloads carry ids, codes, and amounts only (Law 151).

| Event | When | Payload | Known listeners |
|---|---|---|---|
| `OrderPlaced` | an order is created | `orderId`, `storeId`, `channelId`, `type`, `placedAt`, `customerId` | 14 (timeline), 24, 48 |
| `OrderEdited` | an edit or channel edit applied | `orderId`, `storeId`, `origin` (`person` or `channel`), `addedLineIds`, `cancelledLineIds`, `changedShipToFields` (names only), `shippingChanged`, `auditEntryId` | 13 (outbound command for `origin = 'person'`), 18 |
| `OrderStateChanged` | each `order_events` row | `orderId`, `eventId`, `machine`, `from`, `to`, `actorType`, `occurredAt` | 17, 24, 48 (confirmed fires the Meta purchase job) |
| `OrderAttentionRaised` | an attention kind is raised | `orderId`, `kind` (`OrderAttentionKind`), `sourceType`, `sourceId` | 17 (opens one task per kind and order, dedupe key `order_attention:<kind>:<orderId>`) |
| `LinesReturnedToOrigin` | lines become `returned_to_origin` or `lost` | `orderId`, `lineIds`, `to` | 21 (restock by scan), 28 (`consumption_release`) |

Listened to: `OutboundCommandQueued`, `OutboundCommandSynced`, `OutboundCommandFailed`, `OutboundCommandResolved` (feature 13 names and publishes them with `linkedType` and `linkedId`); the projection ignores any whose `linkedType` is not `order`. Until feature 17 exists, `OrderAttentionRaised` has no listener and only the test observes it.

### API surface

All routes `@Audience('staff')`, under `/api/orders`, with one `@Permission` each. Bodies and queries are Zod schemas in `packages/contracts/src/orders/order-api.ts` (`ZodBodyPipe`, `ZodQueryPipe`); answers are parsed by the web with the same schemas.

| Route | Method | Key inputs | Key outputs | Permission | Key errors |
|---|---|---|---|---|---|
| `/api/orders` | GET | `OrderListQuery`: `storeId`, `channelId`, `customerId`, `fulfillment[]`, `cash[]`, `outcome`, `type`, `hold`, `dayFrom`, `dayTo`, `q`, `cursor`, `limit` (50, max 100) | `items[]` (`OrderListItem`), `nextCursor` | `orders.view` | 400 `INVALID_QUERY`, `PHONE_IN_URL` |
| `/api/orders/search` | POST | the same `OrderListQuery` in the body (used whenever `q` is a phone) | as above | `orders.view` | 400 `INVALID_QUERY` |
| `/api/orders/:id` | GET | id | `OrderDetail` (header, ship to, note, lines with variant code and name and reservation state, money, write back commands, events with actor names, `updatedAt`) | `orders.view` | 404 `ORDER_NOT_FOUND` |
| `/api/orders/options` | GET | none | internal stores, channels of kind `manual`, `whatsapp`, `instagram`, gift reason codes, `salesTaxRate`, `pricesIncludeVat` | `orders.confirm` | |
| `/api/orders` | POST | `CreateManualOrderBody`: `clientRef` (uuid), `storeId`, `channelId`, `shipTo`, `lines` (`variantId`, `quantity`, `unitPrice`, `discountAmount`), `shippingChargedAmount`, `paymentMethod`, `prepaidAmount` | `{ id, storeCode, orderNumber }` (201; 200 on a repeat) | `orders.confirm` | 422 `INVALID_BODY`, `STORE_NOT_INTERNAL`, `VARIANT_UNKNOWN`, `PARTIAL_PREPAYMENT_NOT_SUPPORTED` |
| `/api/orders/gifted` | POST | the same plus `giftReasonCode` | as above | `orders.gift` | as above, 422 `GIFT_MUST_STAY_FREE` |
| `/api/orders/:id/edits` | POST | `OrderEditBody`: `expectedUpdatedAt`, `reasonCode?`, `operations[]` | `OrderDetail` | `orders.confirm` (a gifted order also needs `orders.gift`) | 403 `GIFT_NOT_ALLOWED`, 409 `ORDER_LOCKED`, `ORDER_STALE`, `EDIT_IN_SHOPIFY`, 422 `ORDER_NEEDS_A_LINE`, `EDIT_CHANGES_PAYMENT`, `GIFT_MUST_STAY_FREE`, `REASON_INVALID`, `VARIANT_UNKNOWN` |
| `/api/orders/:id/confirm` | POST | `expectedUpdatedAt` | `OrderDetail` | `orders.confirm` | 409 `INVALID_TRANSITION`, `ORDER_STALE` |
| `/api/orders/:id/cancel` | POST | `expectedUpdatedAt`, `reasonCode`, `duplicateOfOrderId?` | `OrderDetail` | `orders.confirm` | 409 `ORDER_LOCKED`, `INVALID_TRANSITION`, `ORDER_STALE`, 422 `REASON_INVALID`, `DUPLICATE_TARGET_REQUIRED` |
| `/api/orders/:id/pack` | POST | `expectedUpdatedAt` | `OrderDetail` | `fulfillment.work` | 409 `WRITE_BACK_OPEN`, `INVALID_TRANSITION`, `ORDER_STALE` |
| `/api/orders/:id/unpack` | POST | `expectedUpdatedAt` | `OrderDetail` | `fulfillment.work` | 409 `ORDER_LOCKED`, `INVALID_TRANSITION`, `ORDER_STALE` |

Edit operations (`operations[]`, a discriminated union on `kind`): `ship_to` (any of `name`, `phone`, `phoneAlt`, `address`, `courierNote`, `area` as `{ list, governorateCode, cityCode, zoneCode }` or null), `add_line` (`variantId`, `quantity`, `unitPrice`, `discountAmount`), `replace_line` (`lineId` plus the add fields), `remove_line` (`lineId`, `cancelReasonCode`), `shipping` (`shippingChargedAmount`). Money and quantities use `moneyInput` and `quantityInput` (Arabic digits normalized). The variant picker on the form calls the catalog search route of spec 0012 (`GET /api/skus?q=`); the order page reads SKU code and name through the catalog service, never the catalog tables.

The search `q` travels in the query string of a GET like every list filter. Because a phone typed there would then sit in the access log of the proxy, the web sends a phone search as `POST /api/orders/search` with the same `OrderListQuery` in the body (permission `orders.view`), the pattern spec 0014 AC-3 uses for customer search; `GET /api/orders` refuses a `q` that parses as a phone with 400 `PHONE_IN_URL`.

The list cursor is (`placed_at`, `id`) base64url (`apps/api/src/platform/keyset-cursor.ts`), compared and ordered with `COLLATE "C"` on any text part. Search `q`, tried in this order: text that `EgyptianPhone` parses matches `ship_to_phone = p OR ship_to_phone_alt = p` (two partial indexes) `OR customer_id = ANY(idsOf(CustomersService.findByPhone(p)))` (spec 0014; skipped when it answers null), so an order placed under another number of the same customer is found too; otherwise digits or `#` digits match `order_number IN (q, '#' || q)`; anything else matches the order number exactly. The `customerId` filter is `customer_id = ANY(CustomersService.idsOf(canonicalOf(customerId)))` (spec 0014), served by `orders_customer_idx`. A phone that does not parse is never echoed in an error.

### Audit

New codes in `AUDIT_ACTIONS` (record type `order`, which keeps its reason as a code; proof `apps/api/test/orders-audit.e2e-spec.ts`; none automatic, none undoable):

| Code | Reason | Reason codes | Written by |
|---|---|---|---|
| `order.created_manually` | optional | `whatsapp_order`, `instagram_order`, `phone_order`, `gift`, `other` | `createManual` |
| `order.edited` | optional | the edit reason list of AC-9, plus `channel_edit` (channel edits only) | `edit`, `applyChannelEdit` |
| `order.partial_delivery_split` | optional | `carrier_report`, `courier_note`, `other` | `recordPartialDelivery` |
| `order.collection_recorded_manually` | required | `courier_note`, `carrier_missing_report`, `correction` | `recordCollection` and `reverseCollection` by a person |

`order.cancelled_override` (spec 0010's list) is not added: this design has no move that skips the transition table; the first feature that adds one registers it. State moves themselves are not audited (spec 0010 AC-11: `order_events` is their history). `before` and `after` use the field names of `OrderDetail` (`shipToName`, `shipToPhone`, `shipToPhoneAlt`, `shipToAddress`, `courierNote`, the area codes, `shippingChargedAmount`, `totalAmount`, `codExpectedAmount`, and `lines.added` and `lines.cancelled` as `{ lineId, variantId, quantity, grossAmount }`); the ship to names are in `PERSONAL_DATA_KEYS` already, so `AuditService.record` redacts them.

### Value sourcing

| Action | Value | Source |
|---|---|---|
| manual create | `store_id`, `channel_id` | the body; the store must be `internal` and not archived, the channel of kind `manual`, `whatsapp`, or `instagram` (`ChannelsService`, spec 0015) |
| manual create | `order_number` | `NumberingService.next(tx, 'SO', placedAt)`; prefix from the seeded `document_prefixes.SO` |
| manual create | `channel_order_ref` | the body's `clientRef`, a uuid the form makes when it opens |
| channel create | `channel_order_ref`, `order_number`, `placed_at` | `ChannelOrderInput` (feature 13 decides the Shopify field each comes from) |
| any create | `placed_at` (manual) | now (`now()` of the transaction) |
| any create | `operating_day` | trigger from `placed_at` |
| any create or edit | line `net`, `tax`, `gross` | `LineAmounts.compute` with the line's `taxRate` (channel) or the `sales_tax_rate` setting (manual), and `prices_include_vat` |
| any create or edit | `shipping_tax_amount` | the inclusive rule of spec 0002 at the `sales_tax_rate` setting |
| any create or edit | `lines_gross_amount`, `total_amount` | `linesGrossAmountOf`; `lines_gross + shipping_charged` |
| any create or edit until the lock | allocation shares, `cod_expected_amount` | `allocatePayments`, `codExpected` |
| any write | `cod_due_amount` | `codDue` with the lines, shipping shares, and `fulfillmentState` |
| any write | `delivered_amount`, `outcome` | `deliveredAmountOf`; `deriveOrderOutcome` |
| create | first cash state | `firstCashState` |
| create, phone edit | `customer_id` | `CustomersService.findOrCreate(tx, { phone, channelCustomer, name, seenAt })` (spec 0014 AC-1): `phone` the parsed main phone or null, `channelCustomer` from `ChannelOrderInput` (null on the manual path), `name` the ship to name, `seenAt` the order's `placed_at`; its `customerId` may be null (`no_phone`) |
| list search | orders of the phone's customer | `CustomersService.findByPhone(p)` then `idsOf` (spec 0014) |
| list `customerId` filter | the customer's ids | `canonicalOf(customerId)` then `idsOf` (spec 0014) |
| order page | customer name and risk flag | `CustomersService.briefs([customerId])` (spec 0014), shown only to `orders.view` holders, which every hat that reads an order has |
| create, phone edit | `ship_to_phone`, `ship_to_phone_alt`, `contact_phone_raw` | `EgyptianPhone.parse` of the text; raw text only when the main phone fails, cleared on a good fix |
| any move | allowed? | `nextState` plus the service guards above |
| any move | `order_events` row | from, to, actor, reason, `source_type` and `source_id` (the carrier event, settlement match, exchange, or job), `occurred_at` (the fact's time, else now) |
| edit | `expectedUpdatedAt` check | `orders.updated_at` |
| edit of a Shopify order | allowed? | `ConnectorsService.writeBackAvailable(storeId)` (spec 0015) |
| `packed` | `writeBackOpen` | `ConnectorsService.openCommandsFor('order', id, tx)` |
| projection | `write_back_state` | the same call, on each `OutboundCommand*` event |
| create, edit, cancel | reservation | the inventory reservation service (spec 0011), keyed by order line id |
| order page | reservation state per line ("short") | the inventory service's read for an order (spec 0011) |
| order page | SKU code and name | the catalog service (spec 0012) |
| list, page, label | store code and name, channel name | `ChannelsService` reads (spec 0015), cached per request |
| order page | actor names | `StaffDirectoryModule` (identity's public file) |
| order page | command states and reasons | `ConnectorsService.syncStateFor('order', id)` (spec 0015) |
| order page | edit history | `GET /api/audit/records/order/:id/entries` (spec 0010), only with `audit.read` |
| shipment job | `unit_cost` per line | the `order_shipment` movement the inventory service posts, per `source_line_id`, written to the line and to any split row of it whose cost is still null |
| `record_label` | `<store code>/<order number>` | `ChannelsService` store code plus `orders.order_number` |
| `sales_tax_rate` | value | settings registry (requested from feature 9; this feature registers it in its own build if feature 9's registry exists, as spec 0009 says) |

### Contracts with the parallel specs

What this spec calls; the owning spec names the real signature. If a name differs when that spec lands, the orders build adopts the owner's name and records it here.

| Owner | Call | Needed by |
|---|---|---|
| 0011 inventory | reserve one order line in the caller's transaction, never failing on a shortage (answers reserved or short); release a line's reservation; read reservation state for an order; post the `order_shipment` of an order's lines (idempotency key `order_shipment:<orderId>`) and return each line's unit cost | milestone 2 (reservations), milestone 4 (shipment) |
| 0012 catalog | search variants by name, SKU, or barcode (the form's picker); read code, name, price, and archived flag for a list of variant ids | milestone 1 |
| 0014 customers | `findOrCreate(tx, { phone, channelCustomer, name, seenAt })` answering `{ customerId \| null, outcome }`; `findByPhone(phone)` for the search box; `canonicalOf`, `idsOf` for orders by customer; `briefs(ids)` for the order page (all named in spec 0014's exported service table) | milestone 1 |
| 0014 customers (the other way) | spec 0014's timeline and returner signal read orders only through `OrderQueries.forCustomers` and `OrderQueries.countsForCustomers` (AC-21) | milestone 1 |
| 0015 channels and connectors | read stores and channels by id and the lists for the form; `openCommandsFor('order', id, tx)`; `writeBackAvailable(storeId)`; `syncStateFor('order', id)`; the `OutboundCommand*` events; turning `OrderEdited` (`origin = 'person'`) into a command | milestone 1 (stores and channels), milestone 2 (the rest) |

### Key invariants

- Only `writer/order-writer.ts` writes `orders`, `order_lines`, and `order_events` (a unit test greps the module, like the ledger's single writer rule; the module wall already keeps other modules out).
- Every state change has exactly one event row, written in the same statement batch as the column change; `replayStates` over the events equals the row.
- `outcome` equals `deriveOrderOutcome` of the row after every write; `cod_due_amount` equals `codDue` of the row and its lines after every write.
- After `carrier_delivery_created_at` is set, `cod_expected_amount`, `prepaid_amount`, `credit_applied_amount`, and the shares never change.
- A line is never updated except its `line_state`, `cancel_reason_code`, `unit_cost` (once, from the shipment), and the split's quantity and money; variant, price, and discount never change in place.
- No domain event payload and no log line carries a ship to field, the customer note, or a raw phone.
- One order row lock per write path, taken first; two orders are locked only in ascending id.

### Security model

- Audience `staff` only; no portal, partner, or hook route here (the portal reads orders later through a service of its own feature).
- Permissions, all existing in spec 0008 (none new is needed): `orders.view` reads (the list, the page, the options are `orders.confirm`); `orders.confirm` creates sale orders, edits, confirms, and cancels; `orders.gift` creates gifted orders and is also required to edit one; `fulfillment.work` packs and unpacks; `audit.read` sees the edit history panel; `cost.view` sees `unitCost`. Every one of these except `orders.gift` is marked personal (P) in spec 0008, so no external hat can reach an order.
- Law 151: ship to fields, the customer note, and raw phones are personal data. They are already in `PERSONAL_DATA_KEYS`, so the `RedactingLogger` and the audit trail redact them; the orders module logs by order id only, and domain events carry no personal data.
- Errors at the edge carry a stable code and never echo an address, phone, or note (`InvalidPhone` never carries the input).
- The write paths for other features are in process calls, not routes, so a carrier or a job never gets an http surface here.

### Configuration required

No new environment variable. One setting, requested from feature 9: `sales_tax_rate` (core, default `"14.00"`, a money string 0 to 100, `whoMayChange: manager`, reason required, exposure `staff`), used for manual order lines and for every order's `shipping_tax_amount`. One pg-boss queue, `orders.post_shipment`, declared through the platform job registry of spec 0009 with the capability `orders.shipment_posting` (core) when that registry exists. The `orders` module row in the spec 0009 module registry (`core`, no toggle) and `@RequiresModule('orders')` on its controller, when that registry exists.

### Critical test scenarios

- Manual order thread: create a two line COD order with 50.00 shipping in Arabic, see it first in `/orders` with `MAIN` beside `SO-2026-000001`, open it, see two `new`/`unpaid` events, outcome `open`, COD expected and due equal to the total; repeat the same `clientRef` and get the same order, verifies **AC-1**, **AC-3**, **AC-4**, **AC-5**, **AC-6**.
- Unparseable phone: create with `01x 2345` → `customer_id` null, `contact_phone_raw` kept, `OrderAttentionRaised(phone_unparseable)` published, no log line contains the text; fix it by an edit → customer linked, raw cleared, verifies **AC-1**, **AC-9**, **AC-19**.
- Gifted: support (no `orders.gift`) gets 403 on `/api/orders/gifted`; a manager creates one with a 500.00 line and 500.00 discount → `nothing_to_collect`, type `gifted`; an edit adding a priced line gets 422 `GIFT_MUST_STAY_FREE`, verifies **AC-2**, **AC-19**.
- B1: stores `ESS` and `MAIN` both hold `#1001`; the list search `1001` returns both, each with its store; a second `#1001` into `ESS` from `createFromChannel` with another ref throws `OrderNumberTaken`; the audit label is `ESS/#1001`, verifies **AC-3**, **AC-14**.
- Edit: replace the M line by an L and fix the address in one call → old line `cancelled`/`edit_removal`, new line at the next position, totals and allocation recomputed, one `order.edited` entry whose `before` and `after` show `"[REDACTED]"` for the sentinel address and phone and list them in `personal_fields`, and no sentinel text anywhere in `audit_entries`; reservation released for M and made for L, verifies **AC-9**, **AC-11**, **AC-13**.
- Edit refusals: stale `expectedUpdatedAt` → 409 `ORDER_STALE`; removing the last open line → 422 `ORDER_NEEDS_A_LINE`; a fully prepaid order gets a new line → 422 `EDIT_CHANGES_PAYMENT`; a Shopify store order while write back is unavailable → 409 `EDIT_IN_SHOPIFY`; after `recordCarrierDelivery` → 409 `ORDER_LOCKED` and `cod_expected_amount` unchanged, verifies **AC-8**, **AC-9**, **AC-10**.
- Packed guard: an edit queues a command (fixture connector), `write_back_state` becomes `waiting` in the same transaction, the list's hold filter finds the order, and `pack` answers 409 `WRITE_BACK_OPEN`; with `write_back_state` forced to `none` but the command still open, `pack` is still refused; after the command syncs, `pack` succeeds; an edit in `packed` writes `packed` to `confirmed`, verifies **AC-7**, **AC-12**.
- Cancel: cancel a confirmed COD order with `duplicate` and its target → lines still `open`, totals unchanged, `cod_due_amount` 0, cash event `unpaid` to `nothing_to_collect` by `system_job`, `related_order_id` set, reservations released; cancel without a target → 422 `DUPLICATE_TARGET_REQUIRED`, verifies **AC-7**, **AC-13**.
- Transition table: a person moving `new` to `shipped` gets 409 `INVALID_TRANSITION`; every allowed pair writes exactly one event; two events in one transaction replay to the stored states; a handler that throws on `OrderStateChanged` leaves no event, no state change, and no audit entry, verifies **AC-6**, **AC-18**.
- Channel intake: `createFromChannel` twice with one ref → one order, `created: false`; `applyChannelEdit` that drops a line and changes a quantity → one cancel and one cancel plus add; the same after `recordCarrierDelivery` → `applied: false` and `channel_edit_not_applied`; `cancelFromChannel` with `channel.customer` → `cancelled` by `system_job`, verifies **AC-14**.
- Carrier facts: `shipped` from `new` → moved, attention `shipped_without_confirmation`, `carrier_delivery_created_at` set, shipment job enqueued in the same transaction; the job posts and writes `unit_cost`; `cancelled` then `shipped` → moved with `shipped_after_cancellation`; `refused` with an unknown reason → `InvalidTransition` (feature 19 must map it to `other`); `returned_to_origin` → lines moved, `LinesReturnedToOrigin`, `cod_due_amount` 0, cash `nothing_to_collect`, verifies **AC-15**.
- Partial delivery: the spec 0002 worked example (three pieces, 2,400.00 plus 50.00, one back) → `cod_due_amount` 1,650.00, `cod_expected_amount` 2,450.00, `order.partial_delivery_split` written, verifies **AC-16**.
- Cash: collection 1,000.00 then a correction to 1,650.00 → two events, `cod_collected_amount` 1,650.00; a person's collection without a reason → `InvalidTransition`; with one → `order.collection_recorded_manually`; `remitted` without `depositedOn` → refused; `reconciled` and a revoke with a reason, verifies **AC-17**, **AC-11**.
- Reads for customers: three orders of two merged customer ids page by two through `forCustomers` with no gap or repeat; `countsForCustomers` counts one refused and one with a returned line since the given day, skips an older one and a refused gifted one, and counts every order when `sinceDay` is null, verifies **AC-21**.
- Phone search: `GET /api/orders?q=01001234567` answers 400 `PHONE_IN_URL` without the digits in the body; the same in `POST /api/orders/search` finds the order by its second phone, verifies **AC-4**, **AC-19**.
- Access: each route without its permission → 403; the route sweep has a fixture per route; `unitCost` absent without `cost.view`, verifies **AC-19**.
- Screens: the list, page, form, and dialogs in both languages, keyboard only, axe clean, one `<h1>`, verifies **AC-20**.
- Scale: with 150,000 orders, the unfiltered page and each filter alone under 150 ms p95, verifies **AC-4**.

## Build plan

Tracer Bullet: milestone 1 runs one real manual order through every layer (contract, database, service, events, audit, route, screen, both languages). Each later milestone thickens one segment end to end: editing and its hold, then the channel intake feature 13 needs, then the carrier and cash moves features 19, 21, and 22 need, with the scale check. Each milestone is one commit. The one migration lands in milestone 1, the first that needs a column (`channel_order_ref` for the form's `clientRef`).

**Milestone 1: one manual order through every layer.** Needs 0012's variant search and read, 0014's `findOrCreate`, `findByPhone`, `canonicalOf`, `idsOf`, and `briefs`, and 0015's store and channel reads (if 0015 has not built the channels module yet, Igris sequences 0015's read service first; the orders build never reads `stores` or `channels` itself).

1. [ ] `DomainEvents` in `apps/api/src/platform/events/` (registration, ordered awaited handlers with the publisher's transaction, a throwing handler rolls back), exported by `PlatformModule`, documented in the platform README, with its unit test, satisfies **AC-18**
2. [ ] Migration: `channel_order_ref` with its partial unique index, `customer_note`, and the five list indexes; schema e2e and tenant checks pass, satisfies **AC-1**, **AC-3**, **AC-4**, **AC-14**
3. [ ] Contracts: `order-api.ts` (list query and item, detail, create bodies, `ChannelOrderInput`, edit body, cancel and action bodies), `order-reasons.ts`, `order-attention.ts`, `codDue` with `fulfillmentState`, the `system_job` cancel row and its exhaustive test, the four audit codes with labels in both catalogs, satisfies **AC-1**, **AC-2**, **AC-6**, **AC-7**, **AC-11**
4. [ ] `orders` module: `order-writer.ts` (lock, write, events, recompute, outcome), `OrderIntake.createManual` with numbering, pricing, customer link, raw phone and attention, idempotent `clientRef`, `order.created_manually`, `OrderPlaced` and `OrderStateChanged`; single writer test; replay test with two events in one transaction, satisfies **AC-1**, **AC-2**, **AC-3**, **AC-6**, **AC-11**, **AC-18**
5. [ ] `OrderQueries` (`summaryOf`, `forCustomers`, `countsForCustomers`, the list SQL with keyset, filters, and search) and routes `GET /api/orders`, `POST /api/orders/search`, `GET /api/orders/:id`, `GET /api/orders/options`, `POST /api/orders`, `POST /api/orders/gifted` with permissions, error map, route sweep fixtures, cost serializer, and `apps/api/test/orders.e2e-spec.ts` for the create, read, list, search (phone never in a URL), gifted, and read service cases, satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-19**, **AC-21**
6. [ ] Web: `/orders` list (filters, keyset "load more", chips and flags), `/orders/[orderId]` page (all blocks of AC-5 except write back and reservation, which arrive in milestone 2), `/orders/new` form with the variant picker and gifted mode, nav entry, i18n keys in both languages, component specs with axe, and `apps/web/e2e/orders.spec.ts` for the thread in both languages, satisfies **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-20**

**Milestone 2: editing, confirming, cancelling, packing, the hold, and reservations.** Needs 0011's reservation calls and 0015's connectors reads and events (a fixture connector stands in for Shopify in tests).

7. [ ] `edit-plan.ts` (pure operations to planned change, with unit tests for every operation and refusal) and `OrderEditing.edit` with `expectedUpdatedAt`, the lock, the payment and gift rules, the Shopify write back rule, phone relink, `packed` to `confirmed`, `order.edited`, `OrderEdited`, satisfies **AC-8**, **AC-9**, **AC-10**, **AC-11**
8. [ ] `OrderTransitions.confirm`, `cancel` (duplicate link, lines kept, `codDue` 0, automatic `nothing_to_collect`), `markPacked` (asks `openCommandsFor`), `unpack`, and their routes, satisfies **AC-7**, **AC-8**, **AC-19**
9. [ ] Reservations through the inventory service on create, edit, and cancel; the "short" mark on the order page, satisfies **AC-13**, **AC-5**
10. [ ] `write-back.projection.ts` on the `OutboundCommand*` events; the hold flag and filter in the list and the command block on the order page, satisfies **AC-12**, **AC-4**, **AC-5**
11. [ ] Web: the edit dialog (ship to, lines, shipping, reason), the cancel dialog (reason, duplicate target search), confirm, pack, and back to confirmed actions, the "edit in Shopify" state, the manager's edit history panel; `apps/api/test/orders-audit.e2e-spec.ts` (the sentinel privacy case) and the edit, cancel, and pack e2e cases; Playwright edit thread in both languages, satisfies **AC-7**, **AC-9**, **AC-10**, **AC-11**, **AC-20**

**Milestone 3: the channel intake contract for feature 13.**

12. [ ] `OrderIntake.createFromChannel` (idempotent ref, `OrderNumberTaken`, unmapped lines, customer note, source fields, import first states), `applyChannelEdit` (diff by channel line id through `edit-plan.ts`, lock and payment refusals as attentions), `cancelFromChannel`, with `apps/api/test/orders-intake.e2e-spec.ts` driven by recorded Shopify shaped fixtures (no live call), satisfies **AC-14**, **AC-11**, **AC-18**

**Milestone 4: the carrier and cash moves, the shipment posting, and scale.** Needs 0011's shipment posting call.

13. [ ] `recordCarrierDelivery`, `recordShipmentFact` (line moves, attentions, `LinesReturnedToOrigin`, automatic `nothing_to_collect`), `recordPartialDelivery` (split, audit), `recordCollection` and `reverseCollection` (person audit), `recordSettlement`, `markExchanged`, with `apps/api/test/orders-transitions.e2e-spec.ts` covering every carrier and cash row of the tables and the spec 0002 worked examples, satisfies **AC-15**, **AC-16**, **AC-17**, **AC-6**, **AC-11**
14. [ ] `orders.post_shipment` job (enqueued with the transition, posts through inventory, writes `unit_cost` on the line and its split rows, `shipment_not_posted` attention after retries, skips unmapped lines with `shipped_with_unmapped_lines`), satisfies **AC-15**
15. [ ] Scale: add the orders list reads to `apps/api/test/scale.e2e-spec.ts` (unfiltered, each filter alone, the search) with p95 under 150 ms at 150,000 orders, add an index only for a filter that misses, record the measured values here; measure the per request access read (spec 0008 follow up) on the order list route, satisfies **AC-4**

## Consequences

**Positive**:

- One file writes orders, so the state machines, the money, and the outcome cannot drift apart, and features 13, 18, 19, 21, 22, and 34 each build against a documented call instead of a table.
- Every order change and its consequences (events, attention, outbound command, audit entry, reservation) commit or roll back together.
- The hold of carried B2 is enforced twice (the packed guard asks the connectors service) and shown where the warehouse looks (carried n1).
- A Warehouse only install still has a plain Confirm and Pack, so stock moves on orders without the Operations bundle.

**Negative / tradeoffs**:

- Every caller shares the order row lock; a burst of carrier facts for one order queues behind an agent's edit. Acceptable at one order per lock and a few events per order per day.
- With the Shopify write back step off, staff must edit Shopify orders in Shopify (Q-16.3), which is slower for the confirmation agent until feature 18 turns the step on.
- Reserving at creation (Q-16.2) holds stock for orders that will be cancelled as fake or unanswered, so available stock reads lower until they are cancelled.
- An edit that changes whether anything is left to collect is refused; a fully prepaid order that gains a piece needs the payment path of feature 18 first.
- `OrderAttentionRaised` opens no task until feature 17 lands; until then the attention is visible only in tests and logs by order id.
- A channel edit or cancel after the carrier delivery exists is not applied; a person must reconcile the parcel with Shopify by hand from the task.
- Lines on a cancelled order stay `open`, so any reader of line states must also read the order's fulfillment state (the metric dictionary, feature 24).

**Neutral**:

- Two columns and five indexes on `orders`, in one forward migration; no new table.
- Two small rule changes in `packages/contracts` (`system_job` cancel, `codDue` on a cancelled order), with spec 0002 amended beside the lines they change.
- The platform gains `DomainEvents`, which every later projection reuses.

## Follow-up

- [ ] Feature 13: map Shopify's cancel reasons to `channel.` codes; decide whether Shopify fulfillments call `recordCarrierDelivery`; publish `OutboundCommand*` events with `linkedType` and `linkedId`; expose `writeBackAvailable`, `openCommandsFor`, `syncStateFor`; skip write back for `OrderEdited` with `origin = 'channel'`.
- [ ] Feature 17: listen to `OrderAttentionRaised` and open one task per kind and order (owner hat by kind: operations for sync and shipment, support for phone, warehouse for unmapped lines).
- [ ] Feature 18: the deposit path (domain review D2, `prepaid_purpose`), payment changes that today answer `EDIT_CHANGES_PAYMENT`, the address picker that fills the area codes through `OrderEditing.edit`, and turning on `step.shopify_order_edit_write_back`.
- [ ] Feature 19: refused parcels in transit (`cod_due_amount` stays full until the parcel comes back; carried D3 refused half), mapping unknown refusal reasons to `other`, the delivery COD check against `cod_expected_amount`.
- [ ] Feature 24: read the fulfillment state with line states (lines on a cancelled order stay `open`); exclude `type = 'gifted'`.
- [ ] Feature 28: the credit projections on `orders` (`returned_credit_amount`, `exchange_consumed_amount`) through a handler that calls the order writer, and the outcome recompute they trigger.
- [ ] Spec 0010 follow up "align names: `order_events.actor_type` uses `system`": already `system_job` in the built enum; nothing to rename.

## Questions for the owner

Each is decided with the recommended answer and built that way unless the owner says otherwise.

1. **Q-16.1 Where are WhatsApp, Instagram, and phone orders entered?** _Decided: in the app, into an internal store (`MAIN`), numbered `SO-2026-000123` (recommended)._ Other options: only in Shopify as draft orders (then this feature's form is for gifts only), or both. Why: it gives every channel one list and a Warehouse only brand a way in; the cost is that in mirror mode the Bosta delivery for such an order is created by hand in Bosta's dashboard with the order number as its business reference.
2. **Q-16.2 When does an order hold stock?** _Decided: at creation (recommended)._ Other options: at confirmation; or never before shipping. Why: Shopify already counts the piece as sold at creation, so the app's available stock matches what the brand sees there; fake and unanswered orders release on cancel.
3. **Q-16.3 May staff edit a Shopify order in the app while the Shopify write back step is off?** _Decided: no, the order page says to edit it in Shopify and the edit syncs back (recommended)._ Other options: allow the edit and warn that Shopify and the Bosta app still have the old values. Why: in mirror mode the Bosta app ships what Shopify says, so an edit that never reaches Shopify is the 11:40 wrong size parcel of review B2, silently.
