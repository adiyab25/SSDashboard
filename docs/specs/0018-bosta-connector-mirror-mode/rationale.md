# 0018 rationale: Bosta connector, mirror mode

The decision record for [index.md](index.md). `/develop` reads index.md; this file holds the why, the options, and the Bosta evidence the design rests on.

## Context

Most of an Egyptian clothing brand's cash sits with Bosta between the courier's pickup and Bosta's remittance. In mirror mode the brand's own Bosta Shopify app creates every delivery, so the app has to learn each parcel's state, fees, and cash cycle from Bosta without ever writing to it ([spec 0007](../0007-stack-architecture-operations-layer/index.md) section 1, *Carrier abstraction*). Slice 1a's acceptance needs one real month of Bosta settlement matched line by line ([scope](../../scope/confirmation-to-cash.md)), which is only possible if every delivery's fees and cash cycle are recorded as Bosta itself reports them.

Bosta's API makes this awkward. Webhooks fire on state changes only, carry no signature and no event id, and are registered by a person in Bosta's dashboard. The list endpoint returns ten rows a page with no fees, no exception reasons, and no "updated since" filter. Fees, the cash cycle, and attempt reasons appear only on the single delivery read, and Bosta answers 429 after about sixty quick single reads. The cash cycle appears days or weeks after delivery with no webhook at all ([domain review M1](../../reviews/domain-stack.md)).

Two more forces come from the confirmation queue. The brand's Bosta app may create a delivery as soon as the Shopify order arrives (auto sync), before an agent confirms it. A size change at confirmation then changes what the customer owes while Bosta still holds the old COD, and in mirror mode the app cannot fix Bosta (the independent audit of 2026-11-11, section 4 item 9, from the copy the lead supplied; not in the repo). Spec 0013 freezes an order's money at the first carrier fact, which, read literally, would forbid that edit altogether.

Features 21 (failures and returned to origin) and 22 (settlement) are specced next and must build on this connector without calling Bosta themselves. The licence wind down ([spec 0009](../0009-settings-toggles-bundles/index.md) AC-18) must keep following parcels that were already out with Bosta at a lapse, and only those.

## Options considered

### Option A: apply the webhook payload directly, poll only as a backup

Each webhook moves the order at once from its `state`, `cod`, and `numberOfAttempts`; a nightly poll catches what was missed.

**Pros**:
- Fastest possible update, one call fewer per change.
- Simple to build.

**Cons**:
- Webhooks carry no fees, no cash cycle, and no exception list, so money facts still need detail reads.
- No signature: anyone holding the header could move orders.
- Bosta documents no retries and new deliveries have no webhook at all, so the nightly poll would be the real truth anyway, a day late.

### Option B: sweep only, no webhooks

Read every open delivery on a timer and ignore webhooks.

**Pros**:
- One path, no public endpoint, no manual webhook setup.

**Cons**:
- To be within minutes for hundreds of open deliveries the sweep must read far more often than Bosta's limit allows; at 1 read a second and 750 open deliveries, a full pass takes 12.5 minutes and nothing is left for cash cycles.
- Slower for exactly the deliveries that just changed.

### Option C: webhooks as hints into one prioritised detail read queue (chosen)

A webhook (or a list pass that sees a changed state, or a new delivery) only moves the delivery up a per connection queue. One job drains the queue under a stated budget (1 second spacing, a 429 budget, a run budget), least recently read first within each priority, and applies everything from one detail parse. A separate priority serves the cash cycle sweep.

**Pros**:
- Every fact, money included, comes from Bosta's own detail; the webhook's lack of a signature cannot move an order.
- The rate limit can never stall the mirror; a burst only reorders the queue.
- The cash cycle sweep has its own budget and window, which carried M1 asks for.

**Cons**:
- One detail read per change, so a change lands up to a run later than the webhook.
- More moving parts (priorities, windows, budgets) to test.

### Option D: settlement file only

Skip the API for money; import Bosta's downloaded sheet monthly.

**Pros**:
- No rate limit worries for money.

**Cons**:
- No states at all, so no order moves and no attention; the sheet's columns are unknown (research Q4).
- Kept as feature 22's fallback, not the main path.

### Sub decisions

- **Mirror table owner (Q-19.1).** A connector owned `carrier_deliveries` over orders' planned `shipments`, because most columns are provider facts and read bookkeeping and an unlinked delivery has no order to hang on.
- **Freeze timing (decision D-1, revised for the domain review).** Tell orders a delivery exists at first link with no freeze, and freeze at route assigned (20) for a confirmed order (else at confirmation or the first pickup) instead of at discovery, because Bosta lets the merchant edit COD only while the delivery is created (S10) and the reference brand creates deliveries before confirmation (research Q7). Whether a brand keeps auto sync is spec 0017's Q-18.1; D-1 works under both answers.
- **The stale flag on the order (decision D-2).** The flag is order data so that the order page, the confirmation queue, and `markPacked` all read one fact; the connector only decides when it changes.
- **Compare with `cod_expected_amount`** (spec 0002 review n1): it is what the courier was told and is frozen with the delivery; `cod_due_amount` drops on a partial delivery and would raise false alarms.
- **Areas (decision D-3).** Bosta's own area ids come from the v2 area reads (S3), which are partly undocumented, so an import command is the fallback.

## Rationale

Option C is the only one that meets all four forces at once: money facts only from the detail read (carried M1 and the scope's "never overwritten by a list sync"), a rate limit that cannot stall today's states, a stated freshness promise (carried M3), and a webhook without a signature that still cannot move an order. Option A fails the money force and the security force; Option B fails the freshness force inside Bosta's limit; Option D fails states entirely. The cost of Option C is a run's delay after a webhook and more to test, which the fixture scenarios cover.

The stale carrier record answers audit item 9 without breaking mirror mode: the app compares, tells the agent exactly where the fix is still possible for that Bosta state, and lets the next read prove the fix. It never claims to have changed Bosta because it cannot.

## Bosta API evidence

Copied from the research report the lead supplied (`bosta-api-research.md`, 2026-11-12, outside the repo). No live Bosta call was made and no key was read. The architect did not open these pages again; URLs are as the report recorded them. Labels: **doc** Bosta's docs, **help** Bosta's help center, **sdk** Bosta's own SDK, **3p** third party SDK, **SO** the reference brand's production code (the reference console, read only). "Unverified" means the design must tolerate the fact being different.

| # | Source as recorded |
|---|---|
| S1 | Bosta docs, Get Shipment Status via Webhook, http://docs.bosta.co/docs/how-to/get-delivery-status-via-webhook/ |
| S2 | Bosta docs, Get Your API Key, http://docs.bosta.co/docs/how-to/get-your-api-key/ |
| S3 | Bosta docs, Format Bosta Address, http://docs.bosta.co/docs/how-to/format-bosta-address/ |
| S4 | Bosta docs, Create Your First Delivery, http://docs.bosta.co/docs/how-to/create-your-first-delivery/ |
| S5 | Bosta docs, Whitelisting, http://docs.bosta.co/docs/how-to/whitelisting/ |
| S6 | Bosta docs, Integrate with Shopify, http://docs.bosta.co/docs/plugins-and-sdks/integrate-with-shopify/ |
| S7 | bosta-nodejs SDK, https://github.com/bostaapp/bosta-nodejs (v0 API) |
| S9 | shippulse/laravel-bosta, https://github.com/shippulse/laravel-bosta (v2 API) |
| S10 | Bosta help center, Orders modifications, https://bosta.freshdesk.com/en/support/solutions/articles/36000421217-orders-modifications |
| S11 | Bosta help center, wallet daily transactions, https://bosta.freshdesk.com/en/support/solutions/articles/36000339392-what-s-your-wallet-daily-transactions- |
| S12 | Bosta help center, wallet cash out transfers, https://bosta.freshdesk.com/en/support/solutions/articles/36000339388-your-e-wallet-cash-out-transfers |
| S14 | Shopify listing, Bosta Fulfillment, https://apps.shopify.com/bosta-fulfillment |
| SO | the reference console `src/lib/bosta/client.ts`, `sync.ts`, `fees.ts`, `attempts.ts`, `src/app/api/webhooks/bosta/route.ts`, `src/lib/webhooks/verify.ts`, and migrations `20260916150000_shipments.sql`, `20260924140000_bosta_fees.sql`, `20261010110000_delivery_overview.sql`, `20261022170000_cod_delivery_outcomes.sql` |

The official API reference (a client rendered page) could not be read, so the official detail schema and changelog are unverified.

**Base URL, auth, reads.**
- Current docs use `https://app.bosta.co/api/v2` (S2, S3, S4); the older SDK and the reference brand's production reads use `https://app.bosta.co/api/v0` (S7, SO client.ts:12). Design: v0 for the list, the detail version configurable per connection.
- `Authorization: <API key>` raw, no `Bearer` (S2, SO). Keys have scopes Read Only, Read/Write, Full Access; Read Only allows GET only (S2). Design: ask for Read Only; the app cannot check the scope (unverified that any read reveals it), so it warns.
- List `GET /deliveries?page=N`: 10 a page, newest first, `limit`, `type`, `state` ignored, body `{ deliveries: [...] }`, rows with a grouped state label and code, `pricing: {}`, no exception list (SO client.ts:6 to 11, 185 to 188). No updated since filter found (unverified in the docs).
- Detail v0 `GET /deliveries/{trackingNumber}` (S7, SO); the object may sit at the root, `data`, or `delivery` (SO client.ts:193). Detail v2 `GET /deliveries/business/{trackingNumber}`, cash cycle at `data.wallet.cashCycle` (S9). v2 search `POST /deliveries/search` (S9) is not used (a POST, and its paging is unverified).
- Detail fields (SO, S1, S9): `_id`, `trackingNumber`, `type { code, value }` (send 10, cash collection 15, return to origin 20 in S7 only, customer return pickup 25, exchange 30), `state { code, value, deliveryTime?, exception?: [{ reason, time, code }] }` (key on the code), `businessReference`, `shopifyInfo { orderId, storeName, orderNumber, createdAt }`, `receiver`, `dropOffAddress`, `pickupAddress`, `specs.packageDetails.itemsCount` (create side; unverified on read), `cod`, `shipmentFees`, `wallet.cashCycle`, `numberOfAttempts` or `attemptsCount` (both exist), `isDelayed`, `creationTimestamp` or `createdAt`.

**Webhooks (S1 unless marked).**
- Registered by hand in Bosta's dashboard (Settings, API Integration, Set Up Your Webhook) with an optional authorization header of a custom name and value; per order webhooks through the create call cannot reach deliveries made by the Shopify app (inference in the report).
- No signature documented; a static custom header. The reference brand compares it in constant time (SO verify.ts:44 to 59).
- Sent after each state change, not on creation (S1, SO route.ts:11).
- Payload: `_id`, `trackingNumber`, `state` (number), `type` (string enum `SEND`, `EXCHANGE`, `CUSTOMER_RETURN_PICKUP`, `RTO`, `SIGN_AND_RETURN`, `FXF_SEND`), `cod` (only in Delivered, the amount collected), `timeStamp`, `isConfirmedDelivery`, `deliveryPromiseDate`, `exceptionReason` and `exceptionCode` (only in Exception), `businessReference`, `numberOfAttempts`.
- Retries not documented; no event id; the reference brand dedupes on tracking number, state, and timestamp (SO route.ts:31). Whether the type flip to return to origin fires a webhook is unverified.

**Rate limits.** None published (S5 and others). Observed: 429 on detail reads after about 60 back to back in one run (incident 2026-09-21), with `Retry-After` in seconds or as a date (SO client.ts:47 to 61, sync.ts:36 to 46). The reference brand's settings: 1 s spacing, a 60 s 429 budget, a 10 minute run budget, backoff 500 ms capped at 8 s with jitter, 4 retries. Per endpoint limits unverified.

**Fees and cash (SO, checked on 21 and then 5,622 settled deliveries).**
- `shipmentFees` (before VAT) and `wallet.cashCycle { _id, shipping_fees, opening_package_fees, flex_ship_fees, vat, bosta_fees, cod, deposited_amt, deposited_at }`, single read only.
- `deposited_amt = cod − bosta_fees`, negative when the merchant owes Bosta (returned to origin and prepaid parcels: 2,248 of 5,622 rows).
- Numbers arrive as strings with float noise (`-15.760000000000005`); parse to 2 places and never derive VAT (SO fees.ts).
- `cashCycle` is null until Bosta settles; delivered COD parcels can wait weeks (18 worth 17,169.50 EGP waited on 2026-10-22).
- Compensation for a lost or damaged parcel is a wallet transaction named Compensation, paid with the next cash out, not a delivery field (S11). Cash out cadence varies by monthly volume (S12). No wallet or transactions API found (unverified).

**States (S1 list; meanings from S1 and SO).** 10 pickup requested; 11 waiting for route; 20 route assigned; 21 picked up from business; 22 and 23 picking up and picked up from consignee; 24 received at warehouse; 25 fulfilled; 30 in transit between hubs; 40 picking up (cash collection); 41 out for delivery (on send) or out for return (on return types); 45 delivered; 46 returned to business; 47 exception (a failed attempt, reason in `state.exception` or the webhook); 48 terminated (S1: after three failed pickup or cash collection attempts; for failed forward sends unverified); 49 canceled; 60 returned to stock; 100 lost; 101 damaged; 102 investigation; 103 awaiting your action (after three failed returns); 104 archived; 105 on hold (meaning undocumented). Exception codes 1 to 8, 12 to 14, 100, 101 (forward) and 20 to 30 (return) have no published text; production reasons are free text, often Arabic (SO). Three forward attempts is the reference brand's assumption, unverified.

**Returns.** A failed send turns into type return to origin on the same tracking number (SO delivery_overview.sql:5 to 8, cogs load.ts:125 to 126); the reference brand also treats a send at 46 as returned to origin. A customer return after delivery is a new customer return pickup delivery with its own tracking number, linked only by business reference or order number (SO sync.ts:70 to 79). Partial delivery: no evidence of any representation (unverified); the delivered webhook `cod` is the only place a short collection could show.

**Edits and the Shopify app (answers to carried B2).**
- S10 (Bosta's staff guide): while created (10) the business edits address, COD, schedule, open package, instructions, and phone from its own dashboard; picked up, at warehouse, in transit, route assigned: Bosta staff only, by a ticket to the hub (about 24 working hours); out for delivery or in exception: no changes, phone only by a ticket.
- The update call exists (`PUT /deliveries/{_id}`, S7) but mirror mode never uses it.
- S6: the Bosta Shopify app creates deliveries by hand ("Deliver with Bosta" on unfulfilled orders) or automatically with auto sync, on order creation; the newer Bosta Fulfillment app offers auto sync on order creation and auto cancel on cancellation (S14). Not tied to Shopify fulfillment. The app can mark Shopify orders fulfilled and paid after delivery (S6). COD is editable in the app only after the order synced (S6).
- The reference brand's data show an abandoned tail at 10 (136 parcels holding 104.6K EGP COD), so deliveries are created before confirmation there (SO cod-truth audit).
- **B2 answered**: deliveries are created on order creation (auto sync) or by hand, not on fulfillment; COD and address can change only while the delivery is created, then only by Bosta support until out for delivery, then not at all.

**Areas (S3).** On v2: `GET /cities?countryId=60e4482c7cb7d4bc4849c4d5` (Egypt), `GET /cities/{cityId}/districts`, `GET /cities/{cityId}/zones`, `GET /cities/getAllDistricts?countryId=...`. District fields `zoneId`, `zoneName`, `zoneOtherName`, `districtId`, `districtName`, `districtOtherName`, `pickupAvailability`, `dropOffAvailability`, `coverage`. City and zone response fields are not documented there; the old SDK reads a city's `_id` and `name` (S7). A governorate level is unverified.

## Domain review

[domain-bosta-mirror](../../reviews/domain-bosta-mirror.md), 2026-11-12: accept with changes (1 blocker, 8 majors, 9 minors, owner questions Q-19.7 to Q-19.9). Folded in the same day; every finding below is applied unless the row says otherwise.

| Finding | How it was closed |
|---|---|
| X1 (blocker) | Applied as the lead ruled: AC-20 compares five fields (`receiver_address`, `receiver_phone`, `carrier_area`, `cod`, `items_count`) with the order's confirmed values in memory through `OrderQueries.carrierCheckViewOf`; unverified fields compared only when present (*Carrier record fields*); events carry the mismatch list, amounts for `cod` and `items_count` only; `bosta_support_best_effort` for a phone at 41 and 47. Item 2: `recordCarrierDeliverySeen` at first link (D-1), requested from spec 0013. Item 3: brand question 1 in Follow-up. The reviewer's separate reason names (`address_area_differs`, `receiver_phone_differs`) are replaced by the lead's five field names. |
| M1 | Applied: `stuck_at_pickup` only for confirmed or packed orders, measured from the later of creation and `confirmed_at`; `new` orders counted as waiting for confirmation; `no_movement` limited to 11 and 20, `stalled` to picked up sends (AC-22). |
| M2 | Applied: `cash_cycle_overdue` (Q-19.7, `bosta_cash_cycle_overdue_days`), `cash_cycle_not_seen`, weekly reads with no end (AC-10, AC-22); the unmatched item carried to spec 0020. |
| M3 | Applied: `cancel_in_bosta` evaluated after every read, link, and cancel, with a 30 minute grace after the synced cancel (AC-19). |
| M4 | Applied: tenant wide unique number match (`order_number_unique`), candidate orders, and `/deliveries/unlinked` and `/deliveries/failed-reads` under `orders.confirm` (AC-12, AC-13, AC-28, AC-11). |
| M5 | Applied on this spec's side: D-1 states its assumption, Q-19.9 records the choice, `route_before_confirmation` and the freeze at confirmation; spec 0017's agreement listed in Follow-up. |
| M6 | Applied on this spec's side: `carrier.record_stale` goes to the editor with a 30 minute due time when every field is merchant fixable, then to operations (AC-30); spec 0017's banner agreement listed in Follow-up. |
| M7 | Applied: AC-31 (`COD_RULE_MISMATCH` from the last 50 deliveries, `cod_rule_mismatch` recorded without a flag), `origin` `at_creation` or `after_edit` on the `cod` mismatch, the hold shown on `/deliveries` and the carrier panel; the warehouse list and the pilot acceptance item carried to features 18 and 33 (out of this lane). |
| M8 | Applied: the first backfill over 60 days (AC-8), the pre go live rule stops only the stock posting (AC-25), `paymentMethodDiffers` on the `cod` mismatch (AC-20). |
| m1 | Applied: webhook `cod` stored only after a detail read confirms 45, reason `carrier.reported_by_webhook` (AC-16). |
| m2 | Applied: terminated after pickup stays on the open cadence (AC-17). |
| m3 | Applied: `return_stalled` with its own threshold (Q-19.8). |
| m4 | Applied: `no_longer_followed`, the task stays open, a list change follows again (AC-22). |
| m5 | Applied, then adjusted the same day for spec 0017 (its review m12): one cancel opens one task. Spec 0013's `terminate_carrier_delivery` stays the task when the delivery was known at the cancel, and this spec's `cancel_in_bosta` opens one only for a delivery found later; when Bosta reports 48 or 49 the connector resolves spec 0013's attention (`OrderAttentions.resolve`, requested), instead of the earlier request to suppress it. |
| m6 | Applied: relink on `OrderPlaced` (AC-12, AC-13). |
| m7 | Applied: latest attempt reason for `orders.confirm`, sorted by `attention_since`, state names from the catalog by code (AC-28). |
| m8 | Applied: COD totals by phase on the `/deliveries` header (AC-28), carried to feature 24. |
| m9 | Partly in lane: renewal backfill hook and the 60 day limit stated (AC-6); the scope feature 16 line is out of this lane and listed in Follow-up. |
| Brand questions 1 to 8 | Listed in Follow-up. |

### Change requests from specs 0019 and 0017 (2026-11-12)

Applied additively, no name removed: spec 0019's AC-16 delivered hold with `deliveredHeld` and `heldAt` on `CarrierCollectionDiffers`, `connectionId` on `CarrierAttemptFailed`, `deliveryType` and `beganAsSend` on `CarrierCashCycleRecorded`, the 46 row naming spec 0019's returned parcel, and the pick list (spec 0019 AC-25, Q-21.8) as the warehouse hold; spec 0017's `shopify_province_code` on governorate rows, the *Area levels* mapping, and resolving `terminate_carrier_delivery` on 48 or 49.


Later the same day, spec 0019's remaining requests, also additive: `opensTask` on `CarrierDeliveryNeedsAttention` (false for the kinds and flags spec 0019's own tasks replace, while `deliveries.carrier_failures` is runnable), `cancel_in_bosta` from `ManualHandoverRecorded`, and the 46, return pickup, and pick list wording.

## References

**Project sources**:
- `AGENTS.md` (modules, two database roles, Law 151, audiences, one schema per shape)
- [Spec 0007](../0007-stack-architecture-operations-layer/index.md) section 1 and *Carried from the domain review* (B1, B2, M1, M2, M3); [domain-stack review](../../reviews/domain-stack.md) (M1, M2, M5, n2)
- [Spec 0015](../0015-shopify-connector/index.md) (the inbox, hints read back through one mapper, sweeps, fixtures, the connection screen)
- [Spec 0013](../0013-orders-state-machines/index.md) (AC-8, AC-15, AC-16, AC-17, AC-24)
- [Spec 0009](../0009-settings-toggles-bundles/index.md) (AC-18, AC-27 to AC-29, the module registry)
- [Spec 0002 orders child](../0002-core-data-model/0002-orders.md) and [settlement child](../0002-core-data-model/0002-settlement.md); [domain-data-model review](../../reviews/domain-data-model.md) n1
- `apps/api/src/connectors/README.md`, `packages/db/src/schema/connectors.ts`, `packages/db/src/table-ownership.ts`

**Practices and standards**:
- Webhooks as hints, read back before applying
- Token spacing and retry with jitter and `Retry-After` as a floor
- Constant time comparison of shared secrets
- Append only history with idempotent keys

**Links**: the Bosta and Shopify pages in *Bosta API evidence*, as recorded by the research report; not fetched again by the architect.
