# 0015. Shopify connector: rationale

Decision record for [index.md](index.md). `/develop` builds from the index; this file says why.

## Context

Shopify is where the brand's orders are born and where its customers see stock. For an Egyptian clothing brand selling cash on delivery, often through two stores of one brand, every downstream process (confirmation, shipping through the Bosta Shopify app in mirror mode, reconciliation, the owner's figures) is only as good as the copy of Shopify the back office holds. The reference brand's console proves the pain: it nets Shopify order edit pairs by hand in SQL because its return rate was mostly edits and cancellations, it added a freshness strip because pages contradicted each other, and it reads Bosta only because the Bosta Shopify app creates deliveries from whatever the Shopify order says (reference brand notes (kept private) items 2, 7, 8; spec 0007 carried M3).

Spec 0007 already fixed the pattern every connector follows: signed webhooks into a durable inbox answered within Shopify's 5 second budget, idempotent worker processing, outbound calls only from worker jobs through one queue per connection, a sweep as the truth, echo suppression for our own stock pushes, edit netting on the operating day, and a failure contract on every outbound command (carried B2, M3, m2, m3). Spec 0002 fixed the tables' keys (`connections`, `outbound_commands`, the planned `inbound_events` and `connection_external_ids`, one Shopify connection per store, order numbers unique per store). What is left is the Shopify specific design: how the app gets a token for a store it does not own, which topics it listens to, whether a webhook body is data or a hint, how the sweep keeps its promise within Shopify's cost based limits, who owns each field, how stock is set without overwriting a sale, and how tests prove all of it without a live call.

Forces: the pilot starts in mid March 2027 and slice 1a must land before it, so nothing here may wait on a Shopify review. Personal data (names, phones, addresses) is under Law 151 and must not spread into tables or logs that do not need it. The ledger is the single truth for stock (final plan 3.6). Four parallel specs own the modules this one feeds (0011 stock reads, 0012 catalog, 0013 orders, 0014 customers), so this design may call them but never write their tables. Shopify itself changed in the last year: new custom apps can no longer be created in the Shopify admin, inventory writes now require an idempotency key and a compare value, and API versions retire after about a year.

## Options considered

### Option 1: Webhook payloads as data, one admin created custom app token per store

Store a long lived Admin API token per store from a custom app made in the Shopify admin, and apply each webhook's JSON body directly; poll with the same REST shaped payloads.

**Pros**:
- Fewest reads: a webhook carries the whole order, so no call back to Shopify.
- A static token needs no refresh.

**Cons**:
- Impossible for a new brand: Shopify stopped the creation of custom apps in the admin on 1 January 2026; only apps made before that keep working.
- Two mappers: webhook bodies are REST shaped while the sweep and backfill read GraphQL, so the same order could be applied two ways, and edit netting needs the sales history (`agreements`) that the body lacks.
- Out of order and stale bodies must be reconciled field by field; a retry four hours later carries the old payload.
- Every inbox row would hold full customer personal data.

### Option 2: Brand owned Dev Dashboard app per store, client credentials, webhooks as hints read back through one mapper (chosen)

The brand creates one app per store in its own organization's Dev Dashboard and pastes the client id and secret; the worker gets 24 hour tokens by the client credentials grant. A webhook only names the changed object; the job reads it back with one GraphQL query and applies it through the mapper the sweep and the bulk backfill also use. Stock is pushed from the ledger with `inventorySetQuantities`, compare and set, and an idempotency key.

**Pros**:
- Available today with no Shopify review, and exactly what the reference brand runs on its two stores (`src/lib/shopify/auth.ts` in the reference console).
- One mapper: webhook, sweep, and backfill produce identical results, and the read back always sees the latest state, so ordering and staleness reduce to one `updatedAt` comparison.
- The inbox keeps ids and timestamps only, never personal data.
- The brand owns the apps, so leaving the vendor needs no action on Shopify.

**Cons**:
- One extra GraphQL read per order event, and dependence on Shopify being reachable at processing time.
- A manual onboarding step per store; a missing scope surfaces only at connect.
- Tokens expire daily and must be refreshed by the worker.

### Option 3: Vendor owned custom distribution app per store, installed by link

The vendor creates an app per store in its own organization with custom distribution, sends the brand an install link, and receives an offline token through the authorization code grant; processing as Option 2.

**Pros**:
- The brand clicks one link instead of configuring an app; the vendor controls scopes and versions centrally.
- Offline tokens for custom apps do not expire.

**Cons**:
- Still one app per store: custom distribution installs on one store unless the stores share a Plus organization, which the target brands do not have.
- Needs an OAuth callback route, state handling, and token exchange on the staff host, more surface before the pilot.
- The brand's access depends on the vendor's account; the exit package would have to include handing over or recreating apps.

### Option 4: One public app on the Shopify App Store

One vendor app listed publicly, installed by any brand.

**Pros**:
- One app for all brands; a familiar install flow.

**Cons**:
- App Store review and protected customer data review (name, phone, address are level 2 fields) before any brand can use it, with an uncertain timeline against a March pilot.
- New public apps must use expiring offline tokens, and public apps carry compliance webhooks and listing obligations.
- One shared client secret signs every brand's webhooks, a wider blast radius than one secret per store.

## Rationale

Option 2 wins on the forces that bind hardest. The pilot date rules out anything waiting on a Shopify review (Option 4), and Shopify's own change of 1 January 2026 rules out Option 1 for every new brand. Between Options 2 and 3 both need one app per store, so the vendor owned route buys a nicer click for the brand at the cost of an OAuth surface and of tying the brand's Shopify access to the vendor, which works against the exit package the product promises from day one; the brand owned route is also proven on the reference brand's two stores. Treating webhooks as hints is what makes spec 0007's promise cheap to keep: the sweep and the backfill must exist anyway, so making the webhook path use their mapper turns three code paths into one, removes the stale payload problem, gives edit netting the sales history it needs, and keeps personal data out of the inbox. The extra read costs a few hundred GraphQL calls a day per store, far inside a Standard plan's 100 points a second.

For stock, the ledger is the truth, so Shopify must be set, not adjusted, but a plain set races with a Shopify sale that the app has not ingested yet. Shopify's compare and set (`changeFromQuantity`, required from `2026-04`) turns that race into a refusal the job can resolve by waiting for its inbox to drain, and spec 0013's reservation at order creation (Q-16.2) makes the ledger's `pushable` already account for every ingested order. Inbound inventory messages therefore can only be echoes or differences, which matches carried m2 exactly. Which side wins a difference is a business rule, not a technical one (Q-13.6): a Shopify figure above the ledger can oversell within minutes and is pushed down at once, while one below it is usually a person's deliberate hold (a damaged piece, an exchange line) and is the safe side, so it waits for a person. Because Shopify sends `orders/create` and `inventory_levels/update` as separate deliveries in no fixed order, a difference is judged only after a 5 minute recheck with the order inbox drained, and an older message never overwrites a newer reading. The first push overwrites every variant in Shopify, so it waits for spec 0011's online gate (counted opening stock, open orders held, this feature's Shopify checks) and for a confirmed preview per connection.

### What the domain review changed (2026-11-07)

The domain review (kept private) accepted the design with changes; both citation checks held. Each finding and where it landed:

| Finding | Change in the spec |
|---|---|
| X1 failed inbound order events were invisible and never retried | AC-8: transient read errors retry and never end `failed`; domain failures publish `InboundEventFailed` (a task in feature 17), show on a Failed reads tab and as a count in the freshness line; the sweep retries with its own dedupe key `sweep-retry:<operating day>:<attempt>:<failed event id>`, at most 3 times a day for 7 operating days |
| M1 exchanges made by editing the delivered order | AC-12 and Q-13.5: added lines become a linked replacement order through spec 0013's `relatedOrder` with `replacement_for`; the Q-13.3 reasoning no longer claims free orders are usually replacements |
| M2 netting keys and a snapshot that could drop a live line | AC-11: pairs keyed on the sale's action type (`UPDATE` against `ORDER`), as the reference brand verified against Shopify Analytics; the snapshot is always every line with current quantity above 0, and netting only names line ids for metrics; a sales history check per recorded day |
| M3 which difference is overwritten, and when | AC-21 and Q-13.6: higher pushed the next minute, lower held for a person; a 5 minute recheck; inbound messages set the compare and set base; older messages ignored |
| M4 go live day and the first push | AC-17, Q-13.7, AC-19: a go live instant; open orders before it enter `confirmed` with `go_live_import` (spec 0013 AC-25); a preview and a confirmation before the first push, behind spec 0011's gate; the opening count is physical on hand at the same instant (contract with feature 15) |
| M5 the owner's onboarding | AC-1, AC-3, Q-13.8: organization and protected data checks, scopes for slice 1b listed now and checked hourly, an app owned by a person warned, names prefilled from the shop, the owner types the secret on a call |
| M6 gateway names | AC-17: a gateway scan before the backfill and `GATEWAYS_UNMAPPED`; `rederivePaymentMethod` (spec 0013 AC-25) on a mapping change; Bosta's COD amount is the cash truth (feature 19) |
| M7 the second store sells the first store's SKUs | Q-13.4 reasoning corrected; an order in one store pushes the other within seconds |
| M8 orders that arrive before their product | AC-9: the product is read first in the same job; a late link through `linkChannelLineVariant` (spec 0013 AC-25), never an edit |
| M9 and spec 0011 review M2, other Shopify locations | AC-22: reported, `degraded`, and a failing `OnlineStockGate` check until turned off or set to 0 |
| m1 failed write count in the shell | AC-18 freshness counts |
| m2 write back availability per kind | AC-24 `writeBackAvailable(orderId, kind)` |
| m3 every discount code | *Value sourcing*: the first non shipping code on the order, every code on the mapping |
| m4 which day | AC-11 states the operating day is used on purpose; `SHOP_TIMEZONE_DIFFERS`; the verify step sets the cutoff |
| m5 a read back that returns nothing | AC-7 `not_visible` |
| m6 one refused item fails a batch | AC-19 per item errors |
| m7, m9 | carried in Follow-up to features 17 and 19 |
| m8 freshness wording | AC-18 "checked N minutes ago" and the store's public name |

### Decisions settled here (the RECOMMEND items)

- **Inbox payload minimized** to ids, topic, timestamps, and inventory quantities. Runner up: keep full bodies for debugging; rejected because the read back makes the body redundant and it is personal data.
- **Inbox retention 90 days** (failed rows 180), the audit window spec 0007 left to this feature; long enough to explain any order of the current and previous settlement month. Runner up: 30 days, too short for a disputed Bosta settlement.
- **Sweep every 5 minutes with a 10 minute overlap, promise 15 minutes** (carried M3). Runner up: every 15 minutes, which would make the promise 25 minutes and leave support blind for a whole call block. The 10 minute overlap is the reference brand's proven margin.
- **API version pinned at `2026-10`**, the latest stable on 2026-11-07, supported until 16 October 2027; Shopify falls forward silently when a version retires, so the client checks the response header. Runner up: follow the newest version each quarter; rejected because every move re-records fixtures.
- **One channel per Shopify store** (spec 0002 left it to this feature). The reference brand's accounting keys differ per store, and the export rules matrix matches on channel. Runner up: one shared `shopify` channel; it would force a store condition into every export rule.
- **Edit netting names lines, never removes them** (review M2). Spec 0013 diffs a full snapshot by line id and keeps removed lines as cancelled rows, so Shopify's negative sales never become lines; the snapshot is every line with current quantity above 0, and pairs (`UPDATE` against `ORDER` sales, the reference brand's verified keys) are published as `ChannelEditNetted` for the metric dictionary. Runner up: import Shopify's signed sales entries as rows, as the reference brand does; rejected because the order model is state based, not a sales ledger.
- **Shopify fulfillment sets the carrier delivery lock** (spec 0013 left it open): Shopify refuses edits to fulfilled lines anyway, so the lock reflects a fact. Runner up: wait for the Bosta mirror (feature 19), which leaves a window where an edit is allowed in the app but impossible in Shopify.
- **Prepaid only from non cash on delivery gateways**, frozen with the carrier delivery by spec 0013, so a "mark as paid" after delivery never looks like a prepayment. Runner up: Shopify's financial status, which the Bosta flow flips to paid after collection.
- **Echo window 10 minutes, recheck after 5 minutes**; differences outside the window are still compared with the ledger after the order inbox drains, so a late echo or an inventory message that beat its order records nothing. Runner up: 2 minutes and no recheck, which records a false difference for most orders whose inventory message arrives first.
- **Tests replace `fetch`** with a recording player that throws on anything unrecorded, rather than adding an interception library; the client uses only `fetch`. Runner up: undici's `MockAgent`, a new dependency for the same effect.
- **Order kind payloads hold ids only**; the executor reads the current order when it runs. Runner up: snapshot the address in the payload, which spec 0002 allowed but which spreads personal data into a long lived table.
- **Stock push every minute from spec 0011's change feed, plus at once on an order in another store with shared variants and on `ReservationFilled`, `ReservationShortened`, and `StockOverdrawn`.** The feed (with its 5 minute lag window) guarantees nothing is missed; the triggers cut the window in which the last piece sells twice to seconds (review M7). Runner up: the minute cron alone, which leaves about a minute.
- **Lines added after fulfillment become a replacement order** (Q-13.5), numbered `<order name>-R<n>` with a reference derived from the Shopify order id, so a rerun creates nothing twice; while spec 0013 refuses the link because the original is not yet delivered, the lines wait on the mapping and the hourly check tries again. Runner up: keep `channel_edit_not_applied`, which leaves the piece unreserved.
- **Unmapped gateway names default to `cod` when the order has no successful transaction**, else `gateway`, and are listed until mapped; the backfill refuses to run with unmapped names. Runner up: `gateway` for every unknown name, which makes a COD form app's orders look like card payments for good.

## References

**Project sources**
- [Spec 0007](../0007-stack-architecture-operations-layer/index.md) section 1 (connector layer, freshness, inbound, processing, backfill, outbound, failure contract, echo suppression, edit netting, tests) and *Carried from the domain review* (B2, M3, m2, m3).
- [Spec 0002 orders child](../0002-core-data-model/0002-orders.md) (stores, channels, connections, outbound commands, value sourcing) and [index](../0002-core-data-model/index.md) Follow-up (feature 13 items, m5).
- [Spec 0008](../0008-roles-as-hats/index.md) permission matrix (`settings.manage` covers connections); [spec 0009](../0009-settings-toggles-bundles/index.md) executing steps, capabilities, `JobRegistry`, `acceptsHook`; [spec 0010](../0010-audit-trail/index.md) audit registry and record types.
- Parallel contracts: [0011](../0011-stock-ledger-locations/index.md) `OnlineStockService`, `OnlineStockGate`, `ReservationFilled`, `ReservationShortened`, `StockOverdrawn`, the feature 15 opening rule; [0012](../0012-catalog-styles-variants/index.md) `CatalogChannelSync` and field ownership; [0013](../0013-orders-state-machines/index.md) `OrderTransactions.run`, `OrderIntake` (AC-14, AC-25), `relatedOrder` (AC-23), `writeBackAvailable(orderId, kind)`, `DomainEvents`, `OrderEdited`, `OrderCancelled`, Q-16.2, Q-16.3; [0014](../0014-customers-by-phone/index.md) `CustomersService.findOrCreate`.
- Domain review of spec 0007 (kept private) (B2, M3, m2, m3, n1); domain review of this spec (kept private) (X1, M1 to M9, m1 to m9, the brand questions); domain review of spec 0011 (kept private) (M1 the online gate, M2 other Shopify locations).
- reference brand notes (kept private); the reference brand's code (read only, outside this repo): `src/lib/shopify/auth.ts` (client credentials per store app), `src/lib/shopify/client.ts` (API version `2026-10`, throttle retries), `src/lib/shopify/orders.ts` (order selection with `agreements` and `sales`), `src/lib/shopify/sync.ts` (watermark minus 10 minutes), `src/lib/webhooks/verify.ts` (HMAC over the raw body), `src/app/api/webhooks/shopify/[store]/route.ts` (webhook as a hint), `src/lib/integrations/shopify-webhooks.ts` (subscription registration), `supabase/migrations/20261016140000_erp_net_order_edits.sql` and `20261017100000_analytics_edit_pairs_and_lost.sql` (edit pairs: `UPDATE` removals against `ORDER` additions, n-th to n-th by id), `src/lib/analytics/return-split.ts` and `src/lib/erp/generate-exports.test.ts` (exchanges by edit, the second store selling the first store's SKUs, as the domain review cites them).
- Installed skills: private `.claude/skills/pg-boss-v12/reference.md` (`group`, `groupConcurrency`, `priority`, `send` with `db`).

**Practices & standards**
- Transactional inbox and outbox; idempotency keys on every external side effect; compare and set for writes that race.
- Webhooks as notifications, reconciliation by polling as the truth.
- Data minimization (Law 151 of 2020).
- Contract tests on recorded fixtures with no live calls.

**Links** (opened during this design, 2026-11-07)
- Shopify changelog, legacy custom apps can't be created after January 1, 2026: https://shopify.dev/changelog/legacy-custom-apps-can-t-be-created-after-january-1-2026
- Client credentials grant (same organization only, `expires_in` 86399): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
- Select a distribution method (custom distribution, one store unless one Plus organization): https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
- Expiring offline access tokens required for new public apps from 1 April 2026 (custom apps and merchant built Dev Dashboard apps not affected): https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-public-apps-april-1-2026
- API versioning (2026-10 latest stable, supported until 16 October 2027, fall forward, `X-Shopify-API-Version`): https://shopify.dev/docs/api/usage/versioning
- API limits (250 item input arrays, one second backoff): https://shopify.dev/docs/api/usage/limits
- GraphQL Admin rate limits (100 points a second on Standard, 1,000 points per query, `throttleStatus`): https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
- HTTPS webhook delivery (HMAC with the client secret, 5 second timeout, 8 retries over 4 hours, deletion after 8 failures for Admin API subscriptions): https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- Webhook delivery headers (`X-Shopify-Webhook-Id`, `X-Shopify-Shop-Domain`, `X-Shopify-Triggered-At`): https://shopify.dev/docs/apps/build/webhooks/delivery-structure
- `inventorySetQuantities` (`write_inventory`, `changeFromQuantity`, `@idempotent` from 2026-04, `CHANGE_FROM_QUANTITY_STALE`): https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities
- `orderEditBegin` (`write_order_edits`): https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderEditBegin
- Edit existing orders (only unfulfilled line items; by default the last 60 days of orders, older ones need `read_all_orders`; `restock`, `staffNote`): https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/edit-orders
- `orderCancel` (asynchronous job, `restock`, `notifyCustomer`, `staffNote`): https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCancel
- `orderUpdate` (shipping address, `write_orders`): https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderUpdate
- Bulk operation queries (five at once from 2026-01, JSONL valid one week, `bulk_operations/finish`, two nested levels, execution not rate limited): https://shopify.dev/docs/api/usage/bulk-operations/queries
- Protected customer data (custom apps: levels 1 and 2 always available): https://shopify.dev/docs/apps/launch/protected-customer-data
- Product variant limit is now 2048 for all merchants (15 October 2025; confirms spec 0012's 2,048): https://shopify.dev/changelog/the-product-variant-limit-is-now-2048-for-all-merchants
