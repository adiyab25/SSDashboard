# 0002 child: stores, channels, and orders with two state machines

Part of the [2026-11-05 amendment of spec 0002](index.md#amendment-2026-11-05). Satisfies **AC-18** to **AC-23** and **AC-35**. Sources: final plan sections 6.1, 6.14, 7.1, 7.2 (`docs/positioning/2026-11-05-egypt-order-operations-layer.md`); spec 0007 section 1 (connections, stores, outbound commands) and section 7 (order number per store); carried B1 and B2.

## Summary

An order belongs to one store and one channel, carries where it came from (campaign, ad set, ad, media buyer, influencer), and has a type: a sale, an exchange replacement, or a gift. It moves through two separate state machines, one for the parcel (fulfillment) and one for the money (cash), and every move is an append only event. A partial delivery splits a line into a delivered row and a returned row with exact money. One pure function derives the order's outcome (kept, cancelled before shipping, failed delivery, refunded, partially refunded, open) from those states, so every report reads the same answer.

**Built here versus later.** This feature migrates the tables marked ★ with every check, index, and trigger, and builds the pure pieces in `packages/contracts/src/orders/`: `order-states.ts` (both transition tables, `nextState` which raises `InvalidTransition`, and `replayStates` which rebuilds both states from an order's events), `order-outcome.ts` (`deriveOrderOutcome`), and `line-split.ts` (the split amounts). `OrdersService`, which applies them inside transactions and writes `order_events`, is feature 16; the carrier side is feature 19 and the delivery failures feature 21. Test scenarios tagged with a feature number are proven by that feature's tests.

## Tables

★ migrated by this feature. ○ designed here at the level other tables need (keys and the columns this spec relies on), built by the named feature without a breaking change. Every table also has `tenant_id` ([tenancy child](0002-tenancy-platform.md)); `created_at` and `updated_at` on mutable tables as in the original conventions.

**Channels module**

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `stores` | `id`, `code text`, `name jsonb` (bilingual), `public_name jsonb` (what the portal shows when a phone and order number match in two stores), `kind` enum (`shopify`, `internal`), `archived_at` | unique (`tenant_id`, `code`). An internal store holds manual, landing page, and WhatsApp orders (spec 0007 section 1). Seeded: one internal store, code `MAIN` |
| ★ `channels` | `id`, `code text`, `name jsonb`, `kind` enum (`shopify`, `landing_page`, `manual`, `whatsapp`, `instagram`, `consignment_partner`, `wholesale`), `default_store_id fk null`, `location_id fk null` (the partner or wholesale location a partner channel reports for), `archived_at` | unique (`tenant_id`, `code`); index (`location_id`). Seeded: `manual` |
| ○ `channel_codes` (feature 40) | per channel codes and texts mapped to a variant, with status `mapped`, `suggested`, `retired`, `not_a_product`, confidence and evidence; replaces the original `channel_mappings` sketch | unique (`tenant_id`, `channel_id`, `code`) |

A store is where an order is numbered and priced (one per Shopify connection, plus internal stores). A channel is how the order arrived, and the key the export rules matrix and channel code mapping use. A Shopify store's orders arrive on a channel of kind `shopify`; a brand with two Shopify stores has two stores and may use one `shopify` channel or one per store (feature 13 decides; nothing here depends on it).

**Connectors module** (key columns only; the rest is feature 13 and 19 detail per spec 0007 section 1)

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `connections` | `id`, `provider` enum (`shopify`, `bosta`, `meta`, `whatsapp`, `telegram`), `label text`, `store_id fk null`, `status` enum (`active`, `paused`, `restricted`, `archived`), `restricted_at null`, `created_at`, `updated_at` | check: `provider <> 'shopify' OR store_id IS NOT NULL`; partial unique (`tenant_id`, `store_id`) where `provider = 'shopify'` (one Shopify connection per store); index (`store_id`). A `bosta` connection with `store_id` null serves every store; one with a store is bound to it (B1). Credentials, mode, and health columns: features 13, 19 |
| ★ `outbound_commands` | `id`, `connection_id fk`, `kind text` (for example `shopify.order_edit`), `linked_type` enum (`order`, `customer`, `variant`, `exchange`, `refund`), `linked_id uuid`, `payload jsonb`, `idempotency_key text`, `sync_state` enum (`waiting`, `synced`, `failed`, `resolved`), `failure_reason text null`, `attempts int default 0`, `synced_at null`, `resolved_at null`, `resolved_by fk users null`, `resolution` enum null (`retried`, `fixed_in_provider`, `edit_undone`), timestamps | unique (`tenant_id`, `idempotency_key`); partial index (`linked_type`, `linked_id`) where `sync_state in ('waiting', 'failed')`; check `resolution` set exactly when `sync_state = 'resolved'` |
| ○ `inbound_events`, `connection_external_ids` (feature 13) | spec 0007 section 1 | unique (`tenant_id`, `connection_id`, dedupe key); unique (`tenant_id`, `connection_id`, `entity`, `external_id`) |

**Orders module**

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `orders` | identity: `id`, `store_id fk`, `channel_id fk`, `order_number text`, `type` enum (`sale`, `exchange_replacement`, `gifted`), `original_order_id fk null` (self), `exchange_id uuid null` (key added by feature 34), `customer_id fk null`, `placed_at timestamptz`, `operating_day date` (stamped). States: `fulfillment_state` enum, `cash_state` enum, `outcome` enum, `write_back_state` enum (`none`, `waiting`, `failed`) default `none`. Money (all `numeric(14,2)`, EGP, VAT inclusive like line `gross`): `lines_gross_amount`, `shipping_charged_amount`, `total_amount`, `prepaid_amount`, `credit_applied_amount`, `cod_expected_amount`, `cod_collected_amount`, `remitted_amount`, `delivered_amount`, `returned_credit_amount`, `exchange_consumed_amount`; `payment_method` enum (`cod`, `gateway`, `instapay`, `bank_transfer`, `wallet`, `none`). Source: `source_captured_from` enum (`landing_page`, `shopify_journey`, `whatsapp_thread`, `manual`, `none`), `source_campaign_id`, `source_adset_id`, `source_ad_id`, `source_utm_source`, `source_utm_medium`, `source_utm_campaign`, `source_utm_content`, `source_landing_page`, `source_referrer` (all `text null`), `source_media_buyer_id fk users null`, `source_influencer_code text null`. Ship to (personal data): `ship_to_name`, `ship_to_phone` (normalized E.164), `ship_to_address`, `ship_to_governorate_code`, `ship_to_city_code`, `ship_to_zone_code`, `courier_note` (all `text null`). Lifecycle: `confirmed_at`, `confirmed_by fk users null`, `cancelled_at`, `cancel_reason_code text null`, `pickup_created_at null` (edits lock here), `gift_reason_code text null`, timestamps | **unique (`tenant_id`, `store_id`, `order_number`)** (B1); check `type = 'exchange_replacement'` exactly when `original_order_id IS NOT NULL`; check `type <> 'gifted' OR (lines_gross_amount = 0 AND gift_reason_code IS NOT NULL)`; check every amount `>= 0`; check `cod_expected_amount = total_amount - prepaid_amount - credit_applied_amount`; indexes: (`store_id`, `placed_at desc`, `id desc`) for lists; partial (`placed_at`, `id`) where `fulfillment_state = 'new'` (the confirmation queue, oldest first); (`customer_id`); (`operating_day`, `store_id`); (`original_order_id`); partial (`cash_state`) where `cash_state not in ('reconciled', 'nothing_to_collect')`; partial (`write_back_state`) where `write_back_state <> 'none'` |
| ★ `order_lines` | `id`, `order_id fk`, `position int`, `variant_id fk null` (null only while an imported line is unmapped), `title text` (the channel's line text, kept for unmapped lines and history), `quantity int > 0`, `unit_price numeric(14,2)`, `discount_amount`, `net_amount`, `tax_rate numeric(5,2)`, `tax_amount`, `gross_amount numeric(14,2)` (the original money shape, VAT inclusive gross after every discount), `unit_cost numeric(14,4) null` (frozen from the shipment's ledger movement; null until shipped), `line_state` enum (`open`, `cancelled`, `delivered`, `returned_to_origin`, `returned`), `split_from_line_id fk null` (self), `channel_line_id text null` (the channel's own line id) | unique (`tenant_id`, `order_id`, `position`); index (`order_id`), (`variant_id`), (`split_from_line_id`); check amounts `>= 0` and `gross_amount = net_amount + tax_amount` |
| ★ `order_events` (append only) | `id`, `order_id fk`, `machine` enum (`fulfillment`, `cash`), `from_state text null` (null for the first event), `to_state text`, `amount numeric(14,2) null` (cash events: the amount the event records), `actor_type` enum (`person`, `carrier`, `system`, `import`), `actor_id fk users null`, `reason_code text null`, `source_type text null` and `source_id uuid null` (the carrier event, settlement match, or exchange that caused it), `occurred_at timestamptz`, `recorded_at timestamptz default now()`, `operating_day date` (stamped from `occurred_at`) | index (`order_id`, `recorded_at`); index (`operating_day`, `machine`, `to_state`) for "shipped yesterday" style reports; BRIN (`recorded_at`) |
| ○ `shipments` (feature 19) | `id`, `order_id fk`, `connection_id fk`, `store_id fk`, `tracking_number text`, `business_reference text null`, `delivery_type` enum (`send`, `exchange`, `customer_return_pickup`, `return_to_origin`), `carrier_state_code text`, `cod_amount`, `attempts int`, fee and cash cycle columns from the single delivery read | unique (`tenant_id`, `connection_id`, `tracking_number`); index (`order_id`) |

## Fulfillment state machine

Values: `new`, `confirmed`, `packed`, `shipped`, `delivered`, `partially_delivered`, `failed_attempt`, `returned_to_origin`, `exchanged`, `refused`, and `cancelled`. `cancelled` is added to the final plan's list because an order cancelled at confirmation (cancelled with reason, duplicate, fake) must leave the queue in a named state; the outcome `cancelled before shipping` reads it.

| From | To | Who | Rule |
|---|---|---|---|
| `new` | `confirmed` | person | the confirmation outcome "confirmed" (feature 18) |
| `new`, `confirmed`, `packed` | `cancelled` | person | reason code required; refused after `pickup_created_at` |
| `confirmed` | `packed` | person | refused while `write_back_state <> 'none'` or while the connectors service reports an open command on the order (spec 0007 section 1, blocking rule) |
| `packed` | `confirmed` | person | an edit after packing, before pickup |
| `new`, `confirmed`, `packed` | `shipped` | carrier | the carrier reports pickup. A carrier report is a fact and is never refused; from `new` it also opens a task "shipped without confirmation" (mirror mode, where the carrier's own app creates deliveries) |
| `cancelled` | `shipped` | carrier | a fact that contradicts the cancellation; always opens a task |
| `shipped`, `failed_attempt` | `failed_attempt` | carrier | each failed attempt is its own event (the attempt count is the number of these events) |
| `shipped`, `failed_attempt` | `delivered` | carrier | every `open` line becomes `delivered` |
| `shipped`, `failed_attempt` | `partially_delivered` | carrier or person | requires the line split below; at least one line `delivered` and one `returned_to_origin` |
| `shipped`, `failed_attempt` | `refused` | carrier | refused at the door; a refusal with a request for another size opens an exchange request (feature 21) |
| `shipped`, `failed_attempt`, `refused` | `returned_to_origin` | carrier | the parcel is back with the brand; every `open` line becomes `returned_to_origin` |
| `delivered`, `partially_delivered` | `exchanged` | system | an exchange on this order completed (feature 34) |

Final states: `delivered` and `partially_delivered` (except to `exchanged`), `returned_to_origin`, `exchanged`, `cancelled` (except the carrier fact). Any other pair raises `InvalidTransition` with both states. **Imports** (feature 15, and an importer from a brand's own console) set the first state as found with one event `from_state = null`, `actor_type = 'import'`; they never replay a path. A carrier state with no mapping here (for example "lost") is mapped by the carrier adapter to one of these states plus a reason code (feature 19 decides "lost").

## Cash state machine

Values: `unpaid`, `collected_by_carrier`, `remitted`, `reconciled`, plus `prepaid` and `nothing_to_collect`. The final plan names the first four; the other two are added because a gateway paid order and a gifted, fully credited, or never delivered order have nothing for a carrier to collect, and the license wind down needs a final cash state for each order (spec 0007, *Switching off on lapse*). The carrier's COD fee and shipping fee are never netted into these amounts: they are settlement lines of their own ([settlement child](0002-settlement.md)).

**First state**, set when the order is created: `nothing_to_collect` if `cod_expected_amount = 0` and `prepaid_amount = 0`; `prepaid` if `cod_expected_amount = 0` and `prepaid_amount > 0`; otherwise `unpaid`.

| From | To | Who | Rule and amounts |
|---|---|---|---|
| `unpaid` | `collected_by_carrier` | carrier | the carrier reports COD collected; `cod_collected_amount` = the reported amount, which may be below `cod_expected_amount` (partial) |
| `collected_by_carrier` | `collected_by_carrier` | carrier | a further collection or a corrected amount; one event per change, `amount` = the new total |
| `collected_by_carrier` | `remitted` | system | a settlement line depositing this order's cash is matched; `remitted_amount` from the matched lines |
| `remitted` | `reconciled` | system | every settlement line of the order is matched (fees and refunds included) |
| `unpaid` | `nothing_to_collect` | system | fulfillment reaches `cancelled`, `returned_to_origin`, or `refused` with nothing collected |
| `nothing_to_collect` | `collected_by_carrier` | carrier | a late carrier report of cash on an order thought uncollected; opens a task |
| `prepaid` | `reconciled` | system or person | the gateway payout is matched (gateway settlement is later; until then the owner decides, see Questions for the owner) |
| `reconciled` | `remitted` | system | a match or a period close was revoked (reason required) |
| `remitted` | `collected_by_carrier` | system | a deposit match was revoked (reason required) |
| `collected_by_carrier` | `unpaid` | carrier | the carrier reversed a collection (reason required) |

Final cash states: `reconciled`, `nothing_to_collect`, and `prepaid` until gateway settlement exists.

## Partial delivery splits lines

When a carrier or a person records that `d` of a line's `q` units were delivered and `r = q − d` came back (`0 < d < q`), the orders service, in one transaction: inserts a new line with `quantity = r`, the same `variant_id`, `unit_price`, `tax_rate`, `title`, and `channel_line_id`, `split_from_line_id` = the original, `line_state = 'returned_to_origin'`, and money: `gross_amount`, `net_amount`, and `discount_amount` each = `round(original × r / q, 2)` half away from zero (computed in exact `numeric`, the original spec's rounding rule), and `tax_amount` = the new gross minus the new net; then updates the original line to `quantity = d`, `line_state = 'delivered'`, and each money column to `original − new`. The two rows always sum to the original, so `lines_gross_amount` and every order total stay unchanged by a split, and the check `gross_amount = net_amount + tax_amount` holds on both rows. A line with `quantity = 1` cannot split; it is delivered or returned whole. The before and after go to the audit trail (feature 10). The returned row then follows the returned to origin path (restock by scan, feature 21); the cash side records the partial amount on `cod_collected_amount`.

## The derived outcome

One pure function, `deriveOrderOutcome`, in `packages/contracts/src/orders/order-outcome.ts`, is the only place the outcome is computed. The orders service stores its result on `orders.outcome` in the same transaction as any change to its inputs; nothing sets the column directly.

Inputs: `fulfillment_state`, `delivered_amount` (sum of `gross_amount` over `delivered` lines), and `refunded_amount = max(0, returned_credit_amount − exchange_consumed_amount)`, where `returned_credit_amount` is the return credits posted on this order's lines and `exchange_consumed_amount` is the credit consumed by replacement orders whose `original_order_id` is this order (both projections from the credit ledger). So a refund, a payout, or credit kept as store credit counts as refunded, while credit spent on this order's own exchange does not.

| `fulfillment_state` | Condition | Outcome |
|---|---|---|
| `cancelled` | | `cancelled_before_shipping` |
| `new`, `confirmed`, `packed`, `shipped`, `failed_attempt` | | `open` |
| `refused`, `returned_to_origin` | | `failed_delivery` |
| `delivered`, `partially_delivered`, `exchanged` | `refunded_amount = 0` | `kept` |
| `delivered`, `partially_delivered`, `exchanged` | `0 < refunded_amount < delivered_amount` | `partially_refunded` |
| `delivered`, `partially_delivered`, `exchanged` | `refunded_amount >= delivered_amount` | `refunded` |

So a partial delivery with nothing refunded is `kept` (the returned rows show in line states and in the returned to origin rate), and an exchange whose replacement cost at least the returned credit is `kept`; both are owner questions with these defaults. The function is total over the enum (an exhaustive `switch`, AGENTS.md).

## Order types and gifted orders

- **`sale`**: the default.
- **`exchange_replacement`**: created by the exchange flow (feature 34) with `original_order_id` and `exchange_id`. Its lines are priced normally. `credit_applied_amount` is the credit it consumed ([credit ledger](0002-customers-credit-tasks.md#customer-credit-ledger)); `cod_expected_amount` is the balance due the courier collects. Metric dictionary rules (feature 24) decide how its revenue counts; the model only marks it.
- **`gifted`**: every line's `unit_price` and amounts are 0 (check above), `payment_method = 'none'`, first cash state `nothing_to_collect`, a `gift_reason_code` is required (for example influencer, giveaway, staff). Excluded from revenue and from return rates by its type (feature 24 filters on it). Its stock leaves through a normal `order_shipment` posting at ledger cost, and its carrier fees arrive as normal settlement lines; the export rules matrix (feature 45) and reports class both as marketing cost because the order's type is `gifted`. Who may create one is an owner question (default: the manager hat, feature 8).

## Edits until pickup, and outbound sync (B2)

An order is editable (address, variant, added line) until `pickup_created_at` is set; each edit writes an audit entry (feature 10) and, for a Shopify order, an `outbound_commands` row in the same transaction. **`outbound_commands.sync_state` is the single truth** for whether a write back landed. `orders.write_back_state` is the orders module's projection of its open commands (`failed` if any is failed, else `waiting` if any is waiting, else `none`), updated in the command writer's transaction through domain events (A6 in the [tenancy child](0002-tenancy-platform.md#projections-and-domain-events-a6-decided-here-built-by-the-first-feature-that-needs-it)), so the confirmation queue and the pick list can filter on it with an index and show "edit not synced, hold" (carried n1). The `packed` transition does not trust the projection: it asks `ConnectorsService.openCommandsFor('order', id)` inside its transaction. A failed command opens a task through `OutboundCommandFailed` (feature 17).

## Value sourcing

| Action | Value | Source |
|---|---|---|
| create order | `store_id` | the Shopify connection's store, or the internal store chosen by the person or the landing page's setting |
| create order | `channel_id` | the connector or entry point (feature 13, 18, 53) |
| create order | `order_number` | Shopify's order name for Shopify stores; `numbering.next` for internal stores (feature 16 sets the document type) |
| create order | `operating_day` | trigger from `placed_at` |
| create order | `customer_id` | `CustomersService.findOrCreateByPhone(ship_to_phone)` ([customers child](0002-customers-credit-tasks.md)); null when the phone does not parse |
| create order | line `discount_amount` | the channel's own discount allocation per line (Shopify gives one); for manual orders an order discount is spread over lines by `gross` share, the last line taking the rest |
| create order | `total_amount` | `lines_gross_amount + shipping_charged_amount` |
| create order | `cod_expected_amount` | `total_amount − prepaid_amount − credit_applied_amount` |
| create order | first `cash_state` | the first state rule above |
| create order | source columns | landing page click, Shopify customer journey, or WhatsApp thread (feature 48); `source_captured_from = 'none'` when nothing is known |
| any transition | allowed? | the transition tables above, `packages/contracts/src/orders/order-states.ts` |
| any transition | `order_events` row | from, to, actor, reason, source, `occurred_at` (the carrier's event time or now) |
| partial delivery | split amounts | `round(original × r / q, 2)` on the new row, the rest on the original |
| delivery change | `delivered_amount` | sum of `gross_amount` over `delivered` lines |
| any input change | `outcome` | `deriveOrderOutcome` |
| credit events | `returned_credit_amount`, `exchange_consumed_amount`, `credit_applied_amount` | `CreditEntryPosted` events (credit module) |
| settlement events | `remitted_amount`, `cash_state` moves to `remitted` or `reconciled` | `SettlementLineMatched` and revoke events (settlement module) |
| command events | `write_back_state` | `OutboundCommand*` events (connectors module) |
| shipment | line `unit_cost` | the `order_shipment` movement's `unit_cost` for that line (`source_line_id` = the order line id) |

## Critical test scenarios

- Two stores both import order `#1001`: both stored; a second `#1001` in one store fails on the unique key; a Shopify connection without a store fails its check; a second Shopify connection on one store fails; a Bosta connection with and without a store both insert, verifies **AC-18**.
- `nextState` accepts every allowed fulfillment and cash pair for its actor and raises `InvalidTransition` for every other pair (an exhaustive test over the enum product, including `delivered` to `new`, a person moving `cancelled` to `shipped`, and `reconciled` to `unpaid`); `replayStates` over a recorded event list gives the last states; `UPDATE` and `DELETE` on `order_events` fail, verifies **AC-19**, **AC-20**, **AC-33**.
- `nextState` refuses `confirmed` to `packed` when the input says a write back is open; `outbound_commands` rejects `resolved` without a resolution, verifies **AC-19**, **AC-35**.
- (feature 16) Every transition writes exactly one `order_events` row in the same transaction as the state change, and a replay of the stored events equals the stored states, verifies **AC-19**, **AC-20**.
- Partial delivery: a line of 3 at gross 1,000.00 with discount 100.00 splits into 2 delivered and 1 returned (returned row gross 333.33, discount 33.33; original 666.67, 66.67), order totals unchanged; a line of 1 cannot split, verifies **AC-21**.
- Outcome: one case per table row, plus a 800 to 500 exchange (refunded 300 of 800, `partially_refunded`) and a 500 to 800 exchange (`kept`), verifies **AC-22**.
- Gifted: a gifted order with a non zero line fails the check; it starts `nothing_to_collect`; an exchange replacement without `original_order_id` fails, verifies **AC-23**.
