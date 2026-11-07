# 0015. Shopify connector: one brand owned app per store, webhooks as hints read back through one mapper, a sweep with a 15 minute promise, and stock pushed from the ledger with compare and set

**Date**: 2026-11-07
**Status**: Proposed
**Scope feature**: 13, Shopify connector (GA), in [Slice 1a: confirmation to cash](../../scope/confirmation-to-cash.md)
**Depends on**: the feature 4 baseline ([spec 0002 orders child](../0002-core-data-model/0002-orders.md): `stores`, `channels`, `connections`, `outbound_commands`); the connector pattern of [spec 0007](../0007-stack-architecture-operations-layer/index.md) section 1; [spec 0008](../0008-roles-as-hats/index.md) (permissions); [spec 0009](../0009-settings-toggles-bundles/index.md) (`JobRegistry`, `ModuleStateService`, executing steps, `LicenseService.acceptsHook`; read only here, see *Settings requested from feature 9*); [spec 0010](../0010-audit-trail/index.md) (`AuditService.record`). Written in parallel with the four specs it calls, each named with the exact call below: [0011](../0011-stock-ledger-locations/index.md) (online stock reads), [0012](../0012-catalog-styles-variants/index.md) (`CatalogChannelSync`), [0013](../0013-orders-state-machines/index.md) (`OrderIntake`, `DomainEvents`), [0014](../0014-customers-by-phone/index.md) (`CustomersService.findOrCreate`).

## Summary

This feature connects each of a brand's Shopify stores to the app, so orders, products, and customers flow in on their own and the ledger's stock flows back out. Each store is joined through a small app the brand creates in its own Shopify account and pastes into the app's connection screen (owner decision Q-13.1, recommended). A webhook (a message Shopify sends when something changes) only tells the app *what* changed; the app then reads the current record back from Shopify and applies it through one mapping path, the same path a sweep every 5 minutes and the first backfill use, so a lost webhook shows up within 15 minutes and processing never depends on how a change arrived. Stock is owned by the ledger: the app sets Shopify's sellable quantity with a compare and set (it only writes when Shopify still holds the number it last saw), and Shopify's own stock messages never change the ledger, they only flag differences for a person. Every write to Shopify is a recorded command with a visible state, and a failed one raises an event that opens a task.

## Requirements

**User stories**:
- As the brand's manager, I want to connect each Shopify store once by pasting its app's keys, and see whether it is healthy, so that I never wonder if orders are arriving.
- As a support agent, I want a new Shopify order in the app within seconds, and never more than 15 minutes late even when Shopify's message is lost, so that the confirmation queue is always complete and oldest first.
- As an operations agent, I want every order shown with its store, and an order edit in Shopify (a size swap, a removed piece) to reach the app as an edit, never as a return, so that the return rate stays true.
- As the warehouse, I want Shopify to sell only what the ledger says we hold online, and a change made in Shopify's stock screen to show up as a difference for someone to fix, so that we neither oversell nor lose track.
- As the developer of the confirmation queue (18) and of returns write back (37), I want one command shape and one failure path for every write to Shopify, so that my feature never calls Shopify itself.
- As the vendor, I want every Shopify behaviour proven on recorded fixtures with no live call, so that CI never depends on a real store or touches customer data.

**Acceptance criteria**:

*Connecting a store*
- **AC-1** (connect): a manager (`settings.manage`) connects a store on `POST /api/connections/shopify` with a label, a store code, the store's English and Arabic names and public names, the shop domain (`<name>.myshopify.com`), and the app's client id and client secret. In one transaction the channels module creates the store (kind `shopify`) and its own channel (kind `shopify`, default store this store, one channel per store), the connectors module creates the connection bound to that store with health `connecting`, the credentials encrypted, and the audit entry `connection.created`, and a `connect` job is enqueued. The job obtains a token by the client credentials grant, reads the shop, the granted scopes, and the locations, registers the webhook subscriptions, and sets health `ok`, or `failing` with one code: `APP_NOT_INSTALLED`, `CREDENTIALS_REJECTED`, `SCOPES_MISSING` (with the missing handles), `CURRENCY_MISMATCH` (the shop's currency is not the install's `currency` setting), or `PUBLIC_URL_NOT_HTTPS`. A second connection to the same shop domain answers 409 `SHOP_ALREADY_CONNECTED`; a store code already in use 409 `STORE_CODE_TAKEN`.
- **AC-2** (secrets): the client id and secret are stored only as AES-256-GCM ciphertext under `CONNECTOR_SECRET_KEY`, with the key version beside it. No response, log line, audit entry, error, inbox row, or command payload carries the secret or an access token; the screen shows "set" and the last 4 characters of the client id. Access tokens live only in the worker's memory and are fetched again 60 seconds before they expire. Replacing the keys (`PUT /api/connections/:id/credentials`, reason required) writes `connection.credentials_replaced` without values and runs the `connect` checks again.

*Webhooks and the inbox*
- **AC-3** (signature first): `POST /api/hooks/shopify/:connectionId` reads at most 2 MB of raw body (413 above), and before parsing anything checks `X-Shopify-Hmac-SHA256` against a base64 HMAC SHA256 of the raw bytes keyed with that connection's client secret, compared in constant time, and checks `X-Shopify-Shop-Domain` equals the connection's shop domain. A missing or wrong signature, a wrong shop, an unknown connection id, or an archived connection all answer the same 401 with no body detail, write no inbox row, and count a failure on the connection (at most one write per connection per minute).
- **AC-4** (durable inbox): a verified delivery inserts one `inbound_events` row (dedupe key `X-Shopify-Webhook-Id`, `ON CONFLICT DO NOTHING` on (`tenant_id`, `connection_id`, `dedupe_key`)) and enqueues its job in the same transaction, then answers 200; a repeat delivery answers 200 and adds nothing. A paused connection still records events and processes them after it is resumed. Hook routes never answer 404 for module state: the handler asks `LicenseService.acceptsHook` (spec 0009 AC-18) and records `ignored_unlicensed` when told to.
- **AC-5** (no personal data in the inbox): an inbox row's `payload` holds only the topic, the Shopify object id, its update time, and for inventory messages the item, location, and quantity; never a customer name, phone, email, address, note, or line text, from a webhook, a sweep, or a backfill. Processed, ignored, and echo rows are purged after 90 days, failed rows after 180 days, sync runs after 90 days.

*Reading back and applying*
- **AC-6** (one mapper): every order, product, and customer event is processed by reading the current object from the Admin GraphQL API (API version pinned at `2026-10`) and applying it through one mapper, whatever brought it (webhook, sweep, backfill). A snapshot whose `updatedAt` is not newer than the version last applied for that object is recorded `ignored` with outcome `stale`; one read back marks every other `received` event of the same object as `processed` with outcome `coalesced` in the same transaction; the domain change and the event status commit together, so a crash leaves the event `received` and a retry is safe.
- **AC-7** (orders in): a Shopify order that is not a test order becomes one order through `OrderIntake.createFromChannel` (spec 0013 AC-14) in the connection's store and channel, with `channelOrderRef` the Shopify order id, `orderNumber` Shopify's order name, `placedAt` its creation time, lines keyed by the Shopify line item id with `quantity` its current quantity, the Shopify customer passed as `channelCustomer` (`shopify_customer`, the connection id, the customer id), and every other field from the mapping table below. The same order name in two stores gives two orders, each shown with its store. The order and its lines are mapped in `connection_external_ids`.
- **AC-8** (gifted): an order whose total (lines and shipping) is 0 and which carries a tag listed in the setting `shopify_gift_tags` arrives as `gifted` with that tag's reason code; a listed tag on an order with a total above 0 arrives as a `sale` and is listed on the connection screen as "gift tag on a paid order" (owner decision Q-13.3, recommended).
- **AC-9** (edits, netted): a later change to the order's lines or ship to fields reaches the order through `OrderIntake.applyChannelEdit` with a snapshot built from Shopify's current lines, so a size change (one M removed, one L added) arrives as an edit removal plus an added line, never as a return. Before applying, the adapter classifies the order's sales history: a line added by an edit and removed again by an edit on the same operating day (by `ssd_operating_day`) for the same variant and the same absolute value is an edit pair, matched one to one in a fixed order; the pair never appears in a snapshot, and when its added half was already applied in an earlier read back, the adapter publishes `ChannelEditNetted` with those line ids so the metric dictionary (feature 24) counts neither half. Shopify refunds are recorded as `ChannelRefundRecorded` and change no order in slice 1a.
- **AC-10** (cancels and fulfillment): a Shopify cancellation calls `OrderIntake.cancelFromChannel` with the reason code `channel.` plus Shopify's cancel reason in lower case (`channel.other` when it does not fit the reason code shape); the first Shopify fulfillment of an order calls `OrderTransitions.recordCarrierDelivery` with its time and source `shopify_fulfillment`, because Shopify itself refuses edits to fulfilled lines.
- **AC-11** (one owner per field): each field has exactly one owner as the *Field ownership* table says; inbound processing never writes an app owned or ledger owned field; while an order has a write back command `waiting` or `failed`, its read backs record outcome `held_write_back_open` and change nothing, and when that command syncs or is resolved one read back of the order is enqueued.
- **AC-12** (customers): `customers/create` and `customers/update` read the customer back, parse its phone with `EgyptianPhone.parse` at this edge, and call `CustomersService.findOrCreate(tx, { phone, channelCustomer, name, seenAt })` (spec 0014 AC-1); outcome `no_phone` writes nothing and is recorded on the event. Orders never call `findOrCreate` from this module: `OrderIntake.createFromChannel` does it from `channelCustomer` (spec 0013 value sourcing).
- **AC-13** (products): `products/create` and `products/update` read the product back and call `CatalogChannelSync.applyProduct` (spec 0012 AC-14) with the ids from `connection_external_ids`, then store the returned style and variant ids and each variant's inventory item id. One Shopify product is one style (spec 0012 Q-12.4); its variants are read 250 at a time up to Shopify's limit of 2,048 per product, so no read exceeds the cost cap. Variant outcomes `needs_sku`, `invalid_sku`, `sku_mismatch`, `barcode_conflict`, and `option_conflict` are listed on the connection screen and each publishes `ChannelProductNeedsAttention` once per variant and outcome, the event the tasks module (feature 17) turns into a task to fix the variant in Shopify (spec 0012 Q-12.2). `products/delete` marks the mappings removed and changes nothing in the catalog; archiving a connection calls `CatalogChannelSync.unlink` for the styles and variants no other active connection maps, so the app owns their fields again.

*Backfill, sweep, freshness*
- **AC-14** (first backfill): after a successful connect, a manager starts the backfill; it reads all products, then every order Shopify lets the app see (the last 60 days, owner decision Q-13.2, recommended), through bulk operations streamed line by line and never stored. Orders open at go live (not cancelled, not fulfilled) enter as live `new` orders; closed ones enter with the `import` actor and their found first states (`cancelled`, or `shipped` with the carrier delivery time of their first fulfillment). Progress shows on the connection screen; a backfill that stops resumes from its last recorded position.
- **AC-15** (sweep and freshness): every 5 minutes each active connection sweeps orders updated since its watermark minus 10 minutes, and every 30 minutes products; a found object newer than its applied version enters the inbox like a webhook. An order changed in Shopify whose webhook never arrives is applied within 15 minutes of the change. Each connection records its last inbound event, last order, and last successful sweep; the back office shell shows a freshness line ("Shopify ESS: last order 3 minutes ago") to every hat with `orders.view`, which turns to a warning when the last successful orders sweep is older than 15 minutes or health is `failing`. An hourly check registers again any webhook subscription Shopify removed.

*Stock*
- **AC-16** (stock push): with `step.shopify_stock_push` runnable (Warehouse licensed and the step on), every minute each connection reads `OnlineStockService.changedSince` (spec 0011 AC-4) and sets Shopify's `available` quantity at the connection's stock location to `pushable` minus the setting `shopify_stock_safety_buffer`, floored at 0, for every changed variant whose target differs from what was last pushed, through `inventorySetQuantities` with `changeFromQuantity` the last quantity seen in Shopify and an idempotency key, at most 250 quantities per call, each call one outbound command (`shopify.inventory_set`, linked to the connection) holding the values sent. A Shopify order lowers the pushed number by its quantity (it is reserved at creation, spec 0013 Q-16.2) and never raises it. With the step off or Warehouse not licensed nothing is pushed and the stock fixture test fails on any write request.
- **AC-17** (stale compare): when Shopify answers `CHANGE_FROM_QUANTITY_STALE`, the job reads the current quantity, waits until the connection has no `received` order event older than the answer, computes the target again, and pushes once more; it never overwrites a Shopify sale the ledger has not yet seen.
- **AC-18** (echo and drift, carried m2): an inbound inventory message never writes a stock movement. One whose quantity equals the last pushed quantity for that item and location within 10 minutes of the push is marked `echo`. Any other is compared, once the connection's inbox has no older `received` order event, with the target from `OnlineStockService.forVariants`: equal records nothing; different records a difference on the level (Shopify's quantity, the target, when seen) and publishes `StockDriftRecorded`. A nightly reconcile reads every level and records differences the same way. People with `stock.view` see the differences; `stock.receive` acknowledges one with a reason code (`stock_difference.acknowledged`, audited). The next push still sets Shopify from the ledger.

*Outbound commands*
- **AC-19** (one door out): other modules write to Shopify only through `ConnectorsService.enqueue(tx, command)` in their own transaction; the kinds and their payload schemas live in `packages/contracts/src/connectors/` (`shopify.inventory_set` built here; `shopify.order_edit`, `shopify.order_cancel` shaped here for feature 18; `shopify.return_record`, `shopify.refund` reserved for features 37 and 35). Order kind payloads hold ids only, never an address or phone. The connectors module turns `OrderEdited` with `origin = 'person'` into one `shopify.order_edit` command in the publisher's transaction and ignores `origin = 'channel'`.
- **AC-20** (failure contract, carried B2): commands run one at a time per connection; a transient error retries with backoff up to 5 attempts; when retries are exhausted or Shopify rejects the command, it becomes `failed` with a provider error code (never provider text) and `OutboundCommandFailed` is published in the same transaction; success makes it `synced` with `OutboundCommandSynced`; `OutboundCommandQueued` and `OutboundCommandResolved` complete the set, each with `commandId`, `connectionId`, `kind`, `linkedType`, `linkedId`. `openCommandsFor(linkedType, id, tx)` returns the `waiting` and `failed` commands; a person retries (`outbound_command.retried`) or resolves as fixed in Shopify with a reason code (`outbound_command.resolved`); a kind whose executing step is off fails its waiting commands with `STEP_OFF` (spec 0009 AC-21). `writeBackAvailable(storeId)` is true only when the store's connection is active and not `failing`, the kind's step is runnable, and an executor for `shopify.order_edit` is registered; while it is false the orders module refuses in app edits of that store's orders with 409 `EDIT_IN_SHOPIFY` (spec 0013 AC-10, Q-16.3), so in slice 1a, before feature 18, staff edit Shopify orders in Shopify and the edit syncs back.

*Limits, tests, screen*
- **AC-21** (rate limits hold): every Admin API call goes through one client that keeps each connection's throttle state from `extensions.cost.throttleStatus`, waits before a call whose expected cost exceeds what is available, never sends a query whose requested cost exceeds 1,000 points, retries `THROTTLED` errors and HTTP 429 after the advised wait, runs at most one call per connection at a time, and ends a sweep or backfill chunk after 60 seconds, leaving it `partial` to resume. A response whose `X-Shopify-API-Version` differs from the pinned version sets the health warning `API_VERSION_FELL_FORWARD`.
- **AC-22** (fixtures only): every test runs on recorded fixtures; the api test setup replaces `fetch` with one that answers only recorded requests and fails the test on any other, so no test can reach Shopify; fixtures come from a Shopify development store with invented customers, scrubbed of tokens and secrets; signature tests use known good and tampered bodies; a fixture replay server serves the same recordings to Playwright and local development and refuses to start when `NODE_ENV` is `production`.
- **AC-23** (connection screen): a manager opens `/connections` (list) and `/connections/[id]` (detail) and sees status, health and its reason, freshness, webhook subscriptions, the stock location and payment gateway mappings, backfill progress, unmapped variants, differences, and failed commands, with the actions connect, check again, start backfill, pause, resume, replace keys, and archive (archive removes the webhook subscriptions first). Other hats get the no access state. Both languages, right to left, no hard coded text, logical CSS, keyboard only, WCAG 2.2 AA, axe clean, one `<h1>`, built to `packages/ui/DESIGN.md`; no secret is ever shown.

## Decision

**Chosen option**: Option 2 in [rationale.md](rationale.md): a brand owned Dev Dashboard app per store with the client credentials grant; webhooks as hints, every object read back through one GraphQL mapper shared with the sweep and the backfill; stock owned by the ledger and pushed with compare and set; one outbound command door with a failure contract.

**Implementation skills**: `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `pg-boss-v12` (`sncollective/snc-platform`, `.claude/skills/pg-boss-v12/`) · `tl-pg-boss` (`toddlevy/tl-agent-skills`, `.claude/skills/tl-pg-boss/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

### Owner decisions taken as recommended

Written into the design as decided; each is cheap to change before milestone 2. See `## Questions for the owner`.

- **Q-13.1** The brand creates one app per store in Shopify's Dev Dashboard, in its own organization, installs it on that store, and pastes the client id and secret; the app gets tokens by the client credentials grant (owner decision Q-13.1, recommended).
- **Q-13.2** The first backfill reads the last 60 days of orders, the window Shopify allows without the `read_all_orders` scope (owner decision Q-13.2, recommended).
- **Q-13.3** A Shopify order becomes `gifted` by a configured tag on a free order (owner decision Q-13.3, recommended).
- **Q-13.4** Two stores selling from the one online location both receive the full sellable quantity; no split per store (owner decision Q-13.4, recommended).

## Rationale

Reasoning, options, and the decisions settled here: see [rationale.md](rationale.md).

## Feature design

### Where it lives

- `apps/api/src/channels/` (module `channels`, bundle `core`, no toggle): `ChannelsService` (exported; the only writer of `stores` and `channels`), `README.md`. No controller in this feature; stores are created through the connect route.
- `apps/api/src/connectors/` (module `connectors`, bundle `core`, no toggle):
  - `connectors.module.ts`, `connectors.service.ts` (`ConnectorsService`, exported), `connectors.events.ts` (the public event classes), `connectors.errors.ts`.
  - `connections/` (`ConnectionsController`, `ConnectionsService`, `connection-secrets.ts`: AES-256-GCM seal and open), `hooks/` (`ShopifyHooksController`, raw body reader), `inbox/` (`InboxService`, purge job), `outbox/` (`OutboxService`, the executor registry, `outbound-commands.controller.ts`), `freshness/` (`FreshnessController`).
  - `shopify/`: `shopify-client.ts` (GraphQL, token cache, rate policy, version check), `shopify-queries.ts` (every query and mutation text, one constant each), `connect.job.ts`, `inbox.job.ts`, `order-mapper.ts`, `edit-netting.ts` (pure), `product-mapper.ts`, `customer-mapper.ts`, `sweep.job.ts`, `backfill.job.ts`, `webhook-check.job.ts`, `stock-push.job.ts`, `stock-reconcile.job.ts`, `stock-differences.controller.ts`, `fixtures/` (the recordings, spec 0007 section 1 *Tests*), `README.md` (and the module README beside `connectors.module.ts`).
- `apps/api/test/`: `shopify-fixture-fetch.ts` (the refusing `fetch` installed by the api's vitest setup files), `shopify-mock-server.ts` (the replay server), `shopify-*.e2e-spec.ts`. `apps/api/scripts/record-shopify-fixtures.ts` (a developer runs it by hand against the development store; never in CI).
- `packages/db/src/schema/connectors.ts` (amended and new tables), `packages/db/src/table-ownership.ts` (the three new tables under `connectors`).
- `packages/contracts/src/connectors/`: `connections.ts` (bodies, views, health codes), `connection-config.ts` (the Shopify config schema), `outbound-commands.ts` (kinds and payload schemas, sync state views), `freshness.ts`, `stock-differences.ts`, `connector-enums.ts` (in the enum parity test).
- `apps/web/src/connections/` (feature folder with README): `connections-page.tsx`, `connection-list-table.tsx`, `connect-store-form.tsx`, `connection-detail-page.tsx`, `connection-health-panel.tsx`, `connection-mapping-form.tsx`, `connection-backfill-panel.tsx`, `unmapped-variants-table.tsx`, `failed-commands-table.tsx`; `apps/web/src/inventory/shopify-differences-page.tsx` and `shopify-differences-table.tsx`; `apps/web/src/shell/connection-freshness-line.tsx`. Routes `(backoffice)/connections/page.tsx`, `connections/new/page.tsx`, `connections/[id]/page.tsx`, `(backoffice)/stock/shopify-differences/page.tsx`, all thin.

### Data model

Into the baseline while [ADR 0003](../../adr/0003-reset-migrations-to-one-baseline.md) still allows it (no pilot import has run), else one forward migration. Every element below is expressible in Drizzle except the grants, which follow the default privileges (none of these tables is append only). Every foreign key gets an index that leads with it (the `packages/db` rule); every unique key that holds a text column leads with `tenant_id`.

| Table | Change or fields | Constraints and indexes |
|---|---|---|
| `connections` (amended) | add `shop_domain text null`; `credentials_ciphertext bytea null`, `credentials_key_version smallint null`, `credentials_hint text null` (last 4 of the client id), `credentials_updated_at timestamptz null`; `config jsonb not null default '{}'` (the provider config, Zod `ShopifyConnectionConfig`: `stockLocationId` and `stockLocationName`, `gatewayMethods` map, `altPhoneAttribute`); `health` enum `connection_health` (`connecting`, `ok`, `degraded`, `failing`) default `connecting`, `health_reason text null` (a code), `health_changed_at timestamptz null`; `api_version text null`; `go_live_at timestamptz null`; `orders_swept_through`, `products_swept_through`, `stock_pushed_through` `timestamptz null` (watermarks); `last_inbound_at`, `last_order_at`, `last_sweep_at` `timestamptz null`; `hook_auth_failures int not null default 0`, `last_hook_auth_failure_at timestamptz null` | check `provider <> 'shopify' OR shop_domain IS NOT NULL`; check `shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'`; partial unique (`tenant_id`, `shop_domain`) where `shop_domain IS NOT NULL AND status <> 'archived'`; check (`credentials_ciphertext IS NULL`) = (`credentials_key_version IS NULL`); check `health_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'` when set |
| ★ `inbound_events` (new) | `id`, `tenant_id`, `connection_id fk`, `source` enum `inbound_source` (`webhook`, `sweep`, `backfill`, `reconcile`), `topic text` (`orders/create` and the like, or `sweep.orders`), `dedupe_key text`, `subject_type` enum `inbound_subject` (`order`, `product`, `customer`, `inventory_level`, `app`, `bulk_operation`), `subject_external_id text null`, `subject_version timestamptz null`, `payload jsonb not null default '{}'` (minimized, AC-5), `status` enum `inbound_status` (`received`, `processed`, `ignored`, `ignored_unlicensed`, `echo`, `failed`) default `received`, `outcome text null` (a code: `stale`, `coalesced`, `test_order`, `held_write_back_open`, `no_phone`, `gift_tag_not_free`, `edit_not_applied`), `attempts int not null default 0`, `failure_code text null`, `received_at timestamptz not null default now()`, `processed_at timestamptz null` | unique (`tenant_id`, `connection_id`, `dedupe_key`); partial index (`connection_id`, `subject_type`, `received_at`) where `status = 'received'` (coalescing and "inbox drained"); index (`connection_id`, `subject_type`, `subject_external_id`); partial index (`connection_id`, `received_at`) where `status = 'failed'`; BRIN (`received_at`) for the purge; check `attempts >= 0`; check `outcome` and `failure_code` match the code shapes |
| ★ `connection_external_ids` (new) | `id`, `tenant_id`, `connection_id fk`, `entity` enum `external_entity` (`product`, `variant`, `order`), `external_id text` (the Shopify gid), `local_id uuid null` (style, variant, or order id; null while unresolved), `external_version timestamptz null` (the `updatedAt` last applied), `state jsonb not null default '{}'` (variant: `inventoryItemId`, `tracked`, `lastOutcome`; order: `nettedLineIds`, `fulfilledAt`; product: `lastOutcome`), `removed_at timestamptz null`, `created_at`, `updated_at` | unique (`tenant_id`, `connection_id`, `entity`, `external_id`) (spec 0002); partial index (`entity`, `local_id`) where `local_id IS NOT NULL`; partial index (`connection_id`, `entity`) where `entity = 'variant' AND (state->>'lastOutcome') NOT IN ('created', 'linked', 'updated', 'unchanged')` (unmapped list) |
| ★ `connection_stock_levels` (new) | `id`, `tenant_id`, `connection_id fk`, `variant_id fk product_variants`, `inventory_item_id text`, `target_quantity int null`, `pushed_quantity int null`, `pushed_at timestamptz null`, `push_command_id fk outbound_commands null`, `shopify_quantity int null`, `shopify_seen_at timestamptz null`, `difference_shopify_quantity int null`, `difference_target_quantity int null`, `difference_seen_at timestamptz null`, `difference_acknowledged_at timestamptz null`, `difference_acknowledged_by fk users null`, `updated_at` | unique (`connection_id`, `variant_id`) (uuid only); index (`variant_id`); partial index (`push_command_id`) and (`difference_acknowledged_by`) where not null; partial index (`connection_id`, `difference_seen_at desc nulls first`, `id desc nulls first`) where `difference_seen_at IS NOT NULL AND difference_acknowledged_at IS NULL`; check (`difference_seen_at IS NULL`) = (`difference_shopify_quantity IS NULL`) |
| ★ `connection_sync_runs` (new) | `id`, `tenant_id`, `connection_id fk`, `kind` enum `sync_run_kind` (`connect`, `backfill_products`, `backfill_orders`, `sweep_orders`, `sweep_products`, `webhook_check`, `stock_push`, `stock_reconcile`), `status` enum `sync_run_status` (`running`, `succeeded`, `partial`, `failed`), `started_at`, `finished_at null`, `watermark_from`, `watermark_to` (`timestamptz null`), `cursor text null` (bulk operation id plus line number, or a page cursor), `counts jsonb not null default '{}'`, `cost_points int not null default 0`, `error_code text null` | index (`connection_id`, `kind`, `started_at desc nulls first`); BRIN (`started_at`) |
| `outbound_commands` (amended) | `linked_type` enum gains `connection`; add `provider_ref text null` (Shopify's job, edit, or mutation reference), `last_attempt_at timestamptz null` | `failure_reason` holds a provider error code only (spec 0002 Follow-up m5); index (`connection_id`, `kind`, `created_at`) |

`stores` and `channels` keep the spec 0002 shape; a Shopify store's channel has the same `code` as its store (codes are unique per table, so they never collide).

### Field ownership (one owner per field, AC-11)

| Record and fields | Owner | What the connector does |
|---|---|---|
| Order identity: number, store, Shopify id, placed time, test flag | Shopify | set once at creation, never changed |
| Order content: lines, quantities, prices, discounts, shipping charge, ship to name, phones, address, note, discount code, tags | Shopify | mirrored on every read back through `applyChannelEdit`; the app changes them only by a write back command, and holds read backs while one is open |
| Order source columns (UTM, landing page, referrer) | Shopify | set at creation from the customer journey; not changed later |
| Fulfillment state, cash state, outcome, confirmation, cancel reason of an app cancel, attentions | app (orders, spec 0013) | never written from Shopify, except the named moves `cancelFromChannel` and `recordCarrierDelivery` |
| Shopify's financial status, fulfillment status, "mark as paid" | nobody in the app | never read as cash truth; cash comes from the carrier (19) and settlement (22) |
| Prepaid amount and method | Shopify, until the carrier delivery exists | sent on create and on every edit; orders freezes it with the delivery |
| Catalog content (title, options, price, barcode, weight) | Shopify, source store (spec 0012 field ownership) | sent through `CatalogChannelSync`; catalog applies its own rules |
| Style, season, product group, cost, SKU code after creation | app (catalog) | never sent |
| Stock quantity at the online location | ledger (inventory) | pushed; Shopify side changes become differences, never movements |
| Customer identity (phones, merges, flags) | app (customers, spec 0014) | only `findOrCreate` inputs are sent |

### Shopify app, auth, and API version

- **App and token** (Q-13.1): the brand, in its own Shopify organization's Dev Dashboard, creates one app per store, selects the scopes below and the protected customer fields (name, phone, address, email), releases a version, and installs it on the store; the onboarding runbook (`docs/runbooks/shopify-store-connection.md`, written in milestone 4) lists the clicks. The worker exchanges the client id and secret for an access token at `https://<shop>/admin/oauth/access_token` (`grant_type=client_credentials`, form encoded, no `scope` parameter); the token lasts 86,399 seconds and is cached in the worker's memory per connection and fetched again 60 seconds before expiry. A brand that still has a legacy custom app made in the Shopify admin before 2026 may paste its Admin API access token instead (`credentials.kind = 'access_token'`, with that app's API secret as the webhook secret); no new one can be created.
- **Scopes** (`SHOPIFY_REQUIRED_SCOPES`, checked against `currentAppInstallation { accessScopes { handle } }` at connect): `read_orders`, `write_orders` (address and cancel write back), `write_order_edits`, `read_products`, `read_customers`, `read_inventory`, `write_inventory`, `read_locations`. Milestone 1 confirms the list against the development store and records it in the fixtures; `read_all_orders` is not requested (Q-13.2).
- **Version**: one constant `SHOPIFY_API_VERSION = '2026-10'` (supported until 16 October 2027). Moving to a newer version is a release step with the fixtures recorded again (Follow-up).
- **Webhook subscriptions** (registered per connection with `webhookSubscriptionCreate(topic, webhookSubscription: { uri, format: JSON })`, the shape the reference brand runs on `2026-10`): `ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_EDITED`, `ORDERS_CANCELLED`, `REFUNDS_CREATE`, `PRODUCTS_CREATE`, `PRODUCTS_UPDATE`, `PRODUCTS_DELETE`, `CUSTOMERS_CREATE`, `CUSTOMERS_UPDATE`, `INVENTORY_LEVELS_UPDATE`, `APP_UNINSTALLED`, `BULK_OPERATIONS_FINISH`. The address is `PUBLIC_URL` + `/api/hooks/shopify/<connection id>` and must be https. Subscriptions made through the Admin API are deleted by Shopify after 8 failed deliveries in a row (retried over 4 hours), which is why the hourly check exists. `APP_UNINSTALLED` sets health `failing` with `APP_NOT_INSTALLED`.

### Inbound processing

1. **Hook** (`@Audience('hook')`, `@RequiresModule('connectors')`): a raw body parser on `/api/hooks/*` mounted before the JSON parser in `app.setup.ts`, capped at 2 MB; the client secret is decrypted once and cached in process for 5 minutes per (connection, key version). Signature and shop checks as AC-3, then the inbox insert and the job send in one transaction (`send` with the `db` option, spec 0007 section 1), then 200. `last_inbound_at` is updated at most every 30 seconds per connection, so the connection row is never a hot spot.
2. **Queue**: one pg-boss queue `connector-shopify` for every Shopify job; each job is sent with `group: { id: connectionId }` and the worker uses `groupConcurrency: 1`, so one job per connection runs at a time across all worker processes (the pg-boss v12 group options, `.claude/skills/pg-boss-v12/reference.md`). Priorities: outbound commands 30, inbox events 20, stock push 15, sweeps 10, backfill chunks 0. Every job ends within 60 seconds and sends its own continuation when work remains.
3. **Inbox job**: skips unless the event is still `received`; reads the subject back (one GraphQL query for an order, product, or customer); compares `updatedAt` with `connection_external_ids.external_version`; applies through the mapper; marks the event and every other `received` event of the same subject (`coalesced`); all in one transaction with the domain calls. A domain error the mapper cannot handle sets `failed` with its code and counts toward `degraded`. Inventory level events use their own payload (no read back) and run the echo and difference rule.
4. **Order mapping** (`order-mapper.ts`, the Shopify order shape the reference brand's sync reads on `2026-10`, `src/lib/shopify/orders.ts` in the reference console): see *Value sourcing*. Test orders (`test: true`) are `ignored` with `test_order`. A new order with an existing mapping row is never created twice (`createFromChannel` is idempotent on `channelOrderRef` as well).
5. **Edit netting** (`edit-netting.ts`, pure, unit tested; carried m3): input is the order's line items and its `agreements` with their `sales` (each sale: action type, line type, quantity, signed amount, line item, the agreement's `happenedAt` and `reason`). Only product sales count. A sale belongs to an *edit agreement* when its agreement's reason is not the original order (the exact enum values are read from the recorded fixtures in milestone 1 and fixed as constants). Within one order, a positive sale from an edit agreement and a negative sale from an edit agreement pair when they share the variant, the operating day of `happenedAt` (computed by one SQL call to `ssd_operating_day` for the snapshot's distinct instants, never in TypeScript), and the absolute amount; the n-th removal pairs with the n-th addition ordered by sale id, the reference brand's rule. A line item whose quantity is wholly paired is left out of the snapshot; lines with current quantity 0 are left out; everything else is sent with its current quantity. If a paired line id is already mapped to an applied order line, its id goes into `ChannelEditNetted` once (remembered in `state.nettedLineIds`). Sales from refund agreements publish `ChannelRefundRecorded` once per refund id.
6. **Catalog and customers**: as AC-13 and AC-12. A product's `ChannelProductInput` carries the connection's `storeId`, the Shopify product gid as `externalProductId`, the mapped `styleId`, handle, title, product type, vendor, tags, options (Shopify's lone default option sent as none), and per variant its gid, mapped `variantId`, SKU, option values, price, compare at price, barcode, weight in grams, requires shipping, and tracked.

### Backfill and sweeps

- **Backfill** (AC-14): `bulkOperationRunQuery` for products (variants and inventory item ids nested), then orders filtered on `created_at` from `go_live_at` minus 60 days, with the same selection as the read back. A `BULK_OPERATIONS_FINISH` webhook or a poll every 30 seconds finds the result; the job streams the JSONL from the signed URL (valid one week), groups child lines under their parent by `__parentId`, and feeds each object to the same mapper with an inbox row per object (`source = 'backfill'`, dedupe `backfill:<bulk operation id>:<gid>`). Nothing of the file is stored; the cursor holds the line number reached, so a chunk that stops resumes there. If Shopify refuses the order selection because of nested connection depth (bulk queries allow two nested levels), the orders backfill falls back to paged queries of at most 1,000 points each (Risk).
- **Sweeps** (AC-15; spec 0007 carried M3): `orders(first: 250, sortKey: UPDATED_AT, query: "updated_at:>='<watermark minus 10 minutes>'")` selecting only `id` and `updatedAt`, then an inbox row (`source = 'sweep'`, dedupe `sweep:<gid>:<updatedAt>`) for each one newer than its applied version. The watermark moves to the newest `updatedAt` seen when the run completes; a `partial` run keeps its page cursor. Products the same way every 30 minutes. The 10 minute overlap is the reference brand's safety margin (`getWatermark` in `src/lib/shopify/sync.ts`). **Budget**: a sweep runs every 5 minutes, ends within 60 seconds, and its found events are processed at priority 20, so a lost webhook is applied within 15 minutes; a connection whose last successful orders sweep is older than 15 minutes is `degraded` with `SWEEP_LATE`.
- **Webhook check**, hourly: lists `webhookSubscriptions(first: 100)` and creates any missing (topic, address) pair; never deletes another app's subscription.

### Stock push, echo, and differences

- **Mapping**: the connection's `config.stockLocationId` is the one Shopify location fed from the app's one online location (spec 0011 AC-1). Without it, or with `NoOnlineLocation`, nothing is pushed and health is `degraded` with `NO_STOCK_LOCATION`.
- **Push** (AC-16): `stock-push` job per connection every minute (cron through `JobRegistry`, capability `connectors.shopify.stock_push`): pages `changedSince({ since: stock_pushed_through })`, computes each target as `max(pushable − shopify_stock_safety_buffer, 0)`, keeps variants mapped to a tracked Shopify inventory item whose target differs from `pushed_quantity`, and sends batches of up to 250 through `inventorySetQuantities` (`name: "available"`, `reason` and `referenceDocumentUri` per the recorded fixture, each quantity with `inventoryItemId`, `locationId`, `quantity`, `changeFromQuantity`), with the command's idempotency key in the `@idempotent` directive (required from `2026-04`). The batch is first written as one `shopify.inventory_set` command (payload: the item, location, quantity, and change from values sent) and then executed. On success each level's `pushed_quantity`, `pushed_at`, `push_command_id`, and `shopify_quantity` are set, and `stock_pushed_through` moves to the feed's watermark. A level with `shopify_quantity` unknown is read first. When `changedSince` reports a different online location than before, the job resyncs every level with `OnlineStockService.list`.
- **Stale compare** (AC-17): `CHANGE_FROM_QUANTITY_STALE` on any quantity reads those levels, waits for the order inbox to drain (no `received` order event older than the answer), recomputes, and sends a new command; after 3 stale rounds in one run the job ends `partial` and the next minute continues.
- **Echo and differences** (AC-18, carried m2): as written in the criterion; the echo window is 10 minutes. A difference stays open until acknowledged or until a later comparison finds the two equal, which clears it.
- **Nightly reconcile** (03:30 in the install `timezone`): a bulk read of the stock location's levels, compared with `OnlineStockService.list`, records differences and, when the step is runnable, marks the differing levels for the next push.

### Outbound commands

- **Writer**: `ConnectorsService.enqueue(tx, { connectionId, kind, linkedType, linkedId, payload, idempotencyKey })` validates the payload with the kind's schema, inserts the row (`ON CONFLICT` on the idempotency key returns the existing row), publishes `OutboundCommandQueued`, and sends the job, all in the caller's transaction.
- **Executor registry**: `OutboundExecutors.register(kind, { capability, step, execute })` at module start; the worker runs a command only when its capability and step are runnable (`ModuleStateService.isRunnable`), at the moment it acts.
- **Kinds** (payload schemas in `packages/contracts/src/connectors/outbound-commands.ts`):

| Kind | Linked to | Payload | Executes | Step (spec 0009) | Built by |
|---|---|---|---|---|---|
| `shopify.inventory_set` | `connection` | `{ locationId, quantities: [{ variantId, inventoryItemId, quantity, changeFromQuantity }] }` (1 to 250) | `inventorySetQuantities` | `step.shopify_stock_push` | this feature |
| `shopify.order_edit` | `order` | `{ orderId, auditEntryId, addedLineIds, cancelledLineIds, changedShipToFields, shippingChanged }` (ids and field names only, from `OrderEdited`) | reads the order's current lines and ship to through an orders read at execution time, then `orderEditBegin`, `orderEditAddVariant` and `orderEditSetQuantity`, `orderEditCommit` (`notifyCustomer: false`, a staff note), and `orderUpdate` for the shipping address | `step.shopify_order_edit_write_back` | shape here, executor feature 18 |
| `shopify.order_cancel` | `order` | `{ orderId, reasonCode }` | `orderCancel` (`restock: true`, `notifyCustomer: false`, reason mapped from the code), then polls its job | `step.shopify_duplicate_cancel` | shape here, executor feature 18 |
| `shopify.return_record` | `exchange` or `refund` | `{ sourceType, sourceId }` | feature 37 decides | `step.shopify_return_exchange_write_back` | reserved, feature 37 |
| `shopify.refund` | `refund` | `{ refundId }` | feature 35 decides | `step.refund_gateway_execute` | reserved, feature 35 |

- **Idempotency keys**: `shopify.inventory_set:<connection>:<run id>:<batch>`; `shopify.order_edit:<audit entry id>`; `shopify.order_cancel:<order id>`.
- **Failure contract** (AC-20): transient means a network error, a timeout (30 seconds per request), HTTP 5xx, 429, or `THROTTLED`; rejection means a `userErrors` entry or a 4xx other than 429. `failure_reason` stores `<SHOPIFY CODE or HTTP status>` only. `OutboundCommandFailed` is the event the tasks module (feature 17) listens to; this feature opens no task itself. Retry sets the command back to `waiting` with attempts kept; resolve sets `resolved` with `fixed_in_provider` (here) or `edit_undone` (only through `ConnectorsService.resolve` called by the orders undo of feature 18).

### Rate policy (AC-21)

One `ShopifyClient` per worker process, state per connection: the last `throttleStatus` (`maximumAvailable`, `currentlyAvailable`, `restoreRate`) and each operation's last `actualQueryCost`. Before a call it estimates the cost (last actual, else `requestedQueryCost` recorded in the fixtures) and, if above what is available now (restored at `restoreRate` since the last reading), waits the difference divided by the restore rate. A `THROTTLED` error waits the same way and retries up to 5 times; HTTP 429 waits `Retry-After` or 1 second (Shopify's advised backoff). Page sizes are constants chosen so every query's requested cost stays at or under 900 points; a unit test reads every recorded response and fails above 1,000. Bulk operations are used for backfill and reconcile because Shopify does not rate limit their execution. A sweep or backfill chunk also stops at 3,000 points spent.

### Fixtures and the mock server (AC-22)

- Recordings live in `apps/api/src/connectors/shopify/fixtures/<scenario>/NN-<operation>.json`, each with the request (operation name, variables, headers kept: API version) and the response (status, body, headers kept: `X-Shopify-API-Version`, `Retry-After`). The recorder runs against a Shopify development store with invented customers and strips access tokens, secrets, and the shop's real domain (replaced by `fixture-store.myshopify.com`).
- Scenarios: connect ok; app not installed; scope missing; currency mismatch; order created (cash on delivery, two stores both `#1001`); prepaid order; size change; edit pair on one day; edit pair across two days; cancel; gifted with tag; gift tag on a paid order; fulfillment; refund; product with variants and one without SKU; product deleted; customer update without phone; inventory echo; inventory difference; `inventorySetQuantities` ok and `CHANGE_FROM_QUANTITY_STALE`; throttled then ok; 429 then ok; bulk backfill (run, finish, JSONL); webhook subscription missing; version fall forward header.
- Webhook bodies are recorded, then signed in the test with a test secret; tampered copies change one byte.
- `shopify-fixture-fetch.ts` matches a request by URL path, operation name, and variables; an unmatched request throws `UnrecordedRequest` and fails the test. `shopify-mock-server.ts` serves the same files over HTTP; `SHOPIFY_MOCK_ORIGIN` points the client at it.

### Connection screen and freshness line

- `/connections` lists connections (label, store code, provider, status, health, freshness). `/connections/new` is the connect form. `/connections/[id]` has tabs: Overview (health and reason, freshness, webhook subscriptions present or missing, API version), Mapping (stock location picked from the locations the connect job read; payment gateway names seen on orders and their payment method), Backfill (start, progress counts, last runs), Products (unmapped variants with their outcome), Failed writes (failed commands with retry and resolve). Every action names what it will do and asks for a reason where the audit code requires one.
- The shell's freshness line reads `GET /api/connections/freshness` once a minute and shows one entry per active connection.
- `/stock/shopify-differences` lists open differences (variant, store, Shopify quantity, ledger target, seen) with acknowledge.

### State transitions

- `connections.health`: `connecting` to `ok` (connect job passed) or `failing` (a named code); `ok` to `degraded` (`SWEEP_LATE`, `WEBHOOKS_MISSING`, `NO_STOCK_LOCATION`, `API_VERSION_FELL_FORWARD`, or more than 10 failed events in an hour) and back when the cause clears; any to `failing` on `APP_NOT_INSTALLED` or `CREDENTIALS_REJECTED`; `failing` to `ok` only through a passed `connect` check.
- `connections.status` (spec 0002): `active` to `paused` (no Shopify calls; the inbox still records) and back; `active` or `paused` to `archived` (subscriptions removed first, jobs stop, `CatalogChannelSync.unlink` for what no other active connection maps, mappings kept for history; final).
- `inbound_events.status`: `received` to `processed`, `ignored`, `ignored_unlicensed`, `echo`, or `failed`; `failed` to `received` only by a retry from the screen (milestone 4) or a reprocess job.
- `outbound_commands.sync_state` (spec 0002): `waiting` to `synced` or `failed`; `failed` to `waiting` (retry) or `resolved`; `waiting` to `failed` with `STEP_OFF` or `MODULE_OFF` (spec 0009).

### API surface

Every controller: `@Audience` exactly once, `@RequiresModule('connectors')`, and one permission declaration per handler (spec 0008).

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/connections` | GET | `cursor?`, `limit?` (50, max 100) | items: id, label, provider, store code, status, health, freshness | `settings.manage` | 403 |
| `/api/connections/shopify` | POST | `label`, `storeCode`, `storeName {en, ar}`, `publicName {en, ar}`, `shopDomain`, `clientId`, `clientSecret` | 201 `{ id, health: 'connecting' }` | `settings.manage` | 409 `SHOP_ALREADY_CONNECTED`, `STORE_CODE_TAKEN`; 422 `INVALID_SHOP_DOMAIN`, `INVALID_BODY` |
| `/api/connections/:id` | GET | id | `ConnectionDetail` (never credentials) | `settings.manage` | 404 |
| `/api/connections/:id` | PATCH | `expectedUpdatedAt`, `label?`, `stockLocationId?`, `gatewayMethods?`, `altPhoneAttribute?`, `reason?` | `ConnectionDetail` | `settings.manage` | 409 `STALE_RECORD`; 422 `LOCATION_UNKNOWN` |
| `/api/connections/:id/credentials` | PUT | `clientId`, `clientSecret`, `reason` | `ConnectionDetail` (health `connecting`) | `settings.manage` | 422 `REASON_REQUIRED` |
| `/api/connections/:id/check` | POST | none | 202 | `settings.manage` | 409 `CONNECTION_ARCHIVED` |
| `/api/connections/:id/backfill` | POST | none | 202 `{ runId }` | `settings.manage` | 409 `BACKFILL_RUNNING`, `CONNECTION_NOT_READY` |
| `/api/connections/:id/pause`, `/resume`, `/archive` | POST | `reason` | `ConnectionDetail` | `settings.manage` | 409 `INVALID_STATUS`; 422 `REASON_REQUIRED` |
| `/api/connections/:id/sync-runs` | GET | `kind?`, `cursor?` | runs, newest first | `settings.manage` | 404 |
| `/api/connections/:id/unmapped-variants` | GET | `cursor?` | external id, SKU, title, outcome | `settings.manage` | 404 |
| `/api/connections/freshness` | GET | none | per active connection: id, label, store code, `lastOrderAt`, `lastSweepAt`, `state` (`fresh`, `late`, `failing`) | `orders.view` | none |
| `/api/hooks/shopify/:connectionId` | POST | raw body, Shopify headers | 200 `{}` | `@Audience('hook')`, signature | 401, 413 |
| `/api/stock/shopify-differences` | GET | `connectionId?`, `cursor?` | open differences | `stock.view` | 403 |
| `/api/stock/shopify-differences/:id/acknowledge` | POST | `reasonCode` | the level | `stock.receive` | 409 `NOT_OPEN`; 422 `REASON_INVALID` |
| `/api/outbound-commands` | GET | `linkedType` (`order` or `connection`), `linkedId` | commands: kind, state, failure code, attempts, updated | `order`: `orders.view`; `connection`: `settings.manage` (checked in the handler through `Access`) | 403, 422 |
| `/api/outbound-commands/:id/retry` | POST | none | the command | `order`: `orders.confirm`; `connection`: `settings.manage` | 409 `COMMAND_NOT_FAILED`, `STEP_OFF` |
| `/api/outbound-commands/:id/resolve` | POST | `reasonCode` (resolution `fixed_in_provider`) | the command | as retry | 409 `COMMAND_NOT_FAILED`; 422 `REASON_INVALID` |

Lists page with a keyset cursor (`apps/api/src/platform/keyset-cursor.ts`).

### Exported services and events

| Export | Methods or payload | Used by |
|---|---|---|
| `ChannelsService` (channels) | `stores(ids, tx?)`, `channels(ids, tx?)` (code, names, kind, default store); `listStores({ kind? })`, `listChannels({ kinds? })` for forms; `storeLabelsByConnection(connectionIds, tx?)` returning per connection `{ connectionId, storeId, storeCode, storeName }`; `createShopifyStore(tx, input)` (connectors only) | orders (0013), customers profile (0014), connectors |
| `ConnectorsService` (connectors) | `enqueue(tx, command)`, `openCommandsFor(linkedType, id, tx)`, `syncStateFor(linkedType, id)`, `writeBackAvailable(storeId)`, `resolve(tx, commandId, resolution, actor)`, `failWaitingCommands(capability, reason)` (the spec 0009 `MODULE_OFF` and `STEP_OFF` rule) | orders (0013), feature 18, feature 9 supervisor |
| `OutboundCommandQueued`, `OutboundCommandSynced`, `OutboundCommandFailed`, `OutboundCommandResolved` | `commandId`, `connectionId`, `kind`, `linkedType`, `linkedId`, `failureCode?` | orders projection (0013 AC-12), tasks (17) |
| `ChannelEditNetted` | `orderId`, `channelLineIds`, `operatingDay` | metric dictionary (24) |
| `ChannelRefundRecorded` | `orderId`, `externalRefundId`, `amount`, `occurredAt` | refunds (35), returns write back (37) |
| `ChannelProductNeedsAttention` | `connectionId`, `externalProductId`, `externalVariantId`, `variantId?`, `outcome` | tasks (17): one task per variant and outcome (spec 0012 Q-12.2) |
| `StockDriftRecorded` | `connectionId`, `variantId`, `shopifyQuantity`, `targetQuantity` | dashboard (24), daily report (25) |
| `ConnectionHealthChanged` | `connectionId`, `health`, `reason` | daily report (25) status line |

Events are published with `DomainEvents.publish(tx, event)` (spec 0013) and carry ids, codes, and amounts only.

### Calls this feature makes to the parallel specs

| Spec | Call | With |
|---|---|---|
| 0011 | `OnlineStockService.onlineLocation()`, `forVariants(variantIds)`, `list(query)`, `changedSince(query)` | variant ids from `connection_external_ids`; the stored `stock_pushed_through` |
| 0012 | `CatalogChannelSync.applyProduct(tx, ChannelProductInput, actor)` | as *Inbound processing* item 6; actor `system_job` |
| 0013 | `OrderIntake.createFromChannel`, `applyChannelEdit`, `cancelFromChannel`; `OrderTransitions.recordCarrierDelivery`; `DomainEvents`; listens to `OrderEdited`; an orders read of lines and ship to for the order edit executor (named by feature 18) | `ChannelOrderInput` and `ChannelOrderSnapshot` as *Value sourcing*; actor `system_job`, or `import` for backfilled closed orders |
| 0014 | `CustomersService.findOrCreate(tx, { phone, channelCustomer, name, seenAt })` for customer webhooks only | the parsed phone or null, `{ kind: 'shopify_customer', connectionId, externalId }`, first and last name joined, the customer's `updatedAt` |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| connect | store, channel, connection rows | the body; channel `code` = store code, kind `shopify`, `default_store_id` = the new store |
| connect job | token | client credentials grant with the decrypted keys |
| connect job | shop currency, time zone | the shop query; currency compared with the `currency` setting |
| connect job | granted scopes | `currentAppInstallation.accessScopes` |
| connect job | locations for the mapping | the locations query, kept in the run's `counts` for the form |
| hook | secret | `connections.credentials_ciphertext` opened with `CONNECTOR_SECRET_KEY` (or `_PREVIOUS` for its key version) |
| hook | dedupe key | header `X-Shopify-Webhook-Id` |
| hook | subject id, version | the body's `id` and `updated_at` (`admin_graphql_api_id` when present), the only fields kept |
| order create | `storeId`, `channelId` | the connection's store and that store's channel (`ChannelsService`) |
| order create | `channelOrderRef` | Shopify order `id` (the gid) |
| order create | `orderNumber` | Shopify order `name` (`#1001`) |
| order create | `placedAt` | `createdAt` |
| order create | `type`, `giftReasonCode` | `tags` and `totalPriceSet` with setting `shopify_gift_tags` (Q-13.3) |
| order create | `paymentMethod` | the order's payment gateway names through `config.gatewayMethods`; a name containing "Cash on Delivery" maps to `cod` by default; an unknown name maps to `gateway` and is listed on the Mapping tab |
| order create and edit | `prepaidAmount`, `prepaidMethod` | the sum of successful sale and capture transactions on gateways not mapped to `cod`, net of refunds; the method of those transactions; 0 and null when none |
| order create and edit | `shippingChargedAmount` | `totalShippingPriceSet.shopMoney` |
| order create | `discountCode` | the first discount code the order reports |
| order create | `customerNote` | `note` |
| order create | `channelCustomer` | `customer.id` with the connection id; null when the order has no customer |
| order create | source fields | `customerJourneySummary.lastVisit`, else `firstVisit`: `utmParameters` (source, medium, campaign, content), `landingPage` and `referrerUrl` kept with only allow listed UTM query keys (spec 0002 Follow-up m5); `source_captured_from = 'shopify_journey'` when a visit exists, else `none`; campaign, ad set, and ad ids left null (feature 48) |
| order create and edit | `shipTo.name`, `phone`, `address` | `shippingAddress`: name, `phone` (else `customer.phone`), `address1` and `address2` joined with city and province; control and direction characters stripped, at most 64 characters for phone text |
| order create and edit | `shipTo.secondPhone` | the order custom attribute named by `config.altPhoneAttribute`, else null |
| order create and edit | line `channelLineId`, `title`, `quantity` | line item `id`, `title` plus `variantTitle`, `currentQuantity` (after netting) |
| order create and edit | line `variantId` | `connection_external_ids` (`variant`, `variant.id`), else null (unmapped) |
| order create and edit | line `unitPrice`, `discountAmount` | `originalUnitPriceSet.shopMoney`; the sum of `discountAllocations` (line and order discounts, as Shopify Analytics sums them) |
| order create and edit | line `taxRate` | the line's tax lines rate, else the `sales_tax_rate` setting through orders (spec 0013) |
| order create (import only) | `firstStates` | cancelled orders `cancelled`; fulfilled orders `shipped` with `carrierDeliveryCreatedAt` = first `fulfillments.createdAt`; cash by the first cash rule of spec 0002 |
| first fulfillment | carrier delivery time | `fulfillments[0].createdAt` |
| cancel | reason code | `channel.` + lower case `cancelReason` |
| netting | operating day | `ssd_operating_day(happenedAt)` in SQL |
| product apply | every `ChannelProductInput` field | as *Inbound processing* item 6 |
| customer webhook | `phone` | `EgyptianPhone.parse(customer.phone)`, null when it does not parse |
| stock push | target | `max(pushable − shopify_stock_safety_buffer, 0)` from `OnlineStockService` |
| stock push | `changeFromQuantity` | `connection_stock_levels.shopify_quantity` |
| stock push | inventory item, location | `connection_external_ids.state.inventoryItemId`; `config.stockLocationId` |
| echo | last push | `pushed_quantity`, `pushed_at` |
| difference | Shopify quantity | the inventory message's `available`, or the reconcile read |
| freshness | last order, last sweep, state | `last_order_at`, `last_sweep_at`, `health`; `late` when `last_sweep_at` is older than 15 minutes |
| `writeBackAvailable` | yes or no | connection `status` and `health`, `ModuleStateService.isRunnable('step.shopify_order_edit_write_back')`, executor registered |
| any audit entry | actor | the session (person) or the job (`system_job`) |

### Key invariants

- The connectors module writes only `connections`, `inbound_events`, `connection_external_ids`, `connection_stock_levels`, `connection_sync_runs`, and `outbound_commands`; the channels module only `stores` and `channels`. Everything else changes through the named calls of the parallel specs.
- No Shopify call happens outside a worker job of the `connector-shopify` queue; at most one runs per connection.
- An inbox row exists only for a verified delivery or an object the app itself read from Shopify.
- No inbound path posts a stock movement or changes an app owned or ledger owned field.
- Every stock quantity sent to Shopify is in an `outbound_commands` row before it is sent.
- An order with a `waiting` or `failed` write back command is never changed by a read back.
- A secret is never readable outside `connection-secrets.ts` and the worker's memory.

### Security model

- Personal data (Law 151): order and customer read backs carry names, phones, and addresses; they pass through memory into the orders and customers modules and are never stored in the connectors tables or logs. `credentials_ciphertext`, `payload` of order kinds (ids only), and `failure_reason` (codes only) keep the connectors tables free of personal data; the redaction list gains `clientSecret`, `accessToken`, `credentials`, and `shippingAddress` as keys (`packages/config/src/redaction.ts`).
- The hook endpoint is public by necessity and proves itself only by signature and shop domain; it reveals nothing about which connections exist (same 401 for all failures). Rate limiting at the edge is feature 26's Caddy configuration.
- Connecting, mapping, backfill, pause, resume, archive, and keys: manager only (`settings.manage`). Freshness: `orders.view`. Differences: `stock.view` to read, `stock.receive` to acknowledge. Commands: by linked type as the API table says.
- Audit (spec 0010 registry additions, each with English and Arabic labels and its proof test): `connection.created`, `connection.edited`, `connection.credentials_replaced` (reason required), `connection.paused`, `connection.resumed`, `connection.archived` (reason required), `connection.backfill_started`, `outbound_command.retried`, `outbound_command.resolved` (reason code), `stock_difference.acknowledged` (reason code). New record types `connection` (reason text, label the store code) and `connection_stock_level` (reason code, label the SKU code). Entries never hold credentials.

### Configuration required

- `CONNECTOR_SECRET_KEY`: 32 random bytes, base64, required by the api and the worker (spec 0007 *Configuration*); in `env.ts`, `.env.example` (a generated dev value from `pnpm bootstrap`), and the api and worker env lists of `deploy/compose.yaml`.
- `CONNECTOR_SECRET_KEY_PREVIOUS`: optional, the old key during a rotation; a re-encrypt job moves every connection to the current key version.
- `SHOPIFY_MOCK_ORIGIN`: optional, dev and test only; points the Shopify client at the replay server; `env.ts` refuses it when `NODE_ENV` is `production`.
- Webhook address base: the existing `PUBLIC_URL` (it becomes `STAFF_ORIGIN` when spec 0007's rename lands); must be https for a real connection.
- Per brand, outside the app: one Dev Dashboard app per store (Q-13.1), as the runbook describes.

### Settings requested from feature 9

Exact rows for the feature 9 registry (`packages/contracts/src/settings/` and `packages/contracts/src/modules/`); this spec does not edit spec 0009.

| Kind | Key | Bundle | Default | Values and rule | Who, reason |
|---|---|---|---|---|---|
| module | `channels` | core | on, no toggle | requires nothing | none |
| module | `connectors` | core | on, no toggle | requires `channels`; capabilities below | none |
| capability | `connectors.shopify.sync` | core | | `kind: read`, `windDown: false`, `backfill`: an orders and products sweep from the gap start | none |
| capability | `connectors.shopify.stock_push` | warehouse | | `kind: write` (named in spec 0009) | none |
| capability | `connectors.shopify.order_write_back` | operations | | `kind: write`; executes the order kinds of feature 18 | none |
| executing step | `step.shopify_stock_push` | warehouse | `false` | precondition `SHOPIFY_STOCK_LOCATION_UNMAPPED`: every active Shopify connection has `config.stockLocationId`, and an online location exists (spec 0011) | manager, reason required |
| policy knob | `shopify_gift_tags` | core | `{}` | map of a Shopify tag (1 to 40 characters) to a gift reason code (`reasonCodeShape`), at most 20 entries (Q-13.3) | manager, reason optional |
| policy knob | `shopify_stock_safety_buffer` | warehouse | `0` | integer 0 to 1,000, pieces held back from every pushed quantity | manager, reason required |
| jobs | `connector-shopify` queue; crons `shopify-orders-sweep` (every 5 minutes), `shopify-products-sweep` (every 30 minutes), `shopify-webhook-check` (hourly), `shopify-stock-push` (every minute), `shopify-stock-reconcile` (03:30), `connector-inbox-purge` (04:00), in the install `timezone` | | | through `JobRegistry` with the capabilities above | |

The hook route calls `LicenseService.acceptsHook`; Shopify capabilities are core, so the answer is always `process` today.

### Permissions requested from feature 8

No new permission. Route mapping rows for spec 0008's table and the access sweep `FIXTURES` (`apps/api/test/access-sweep.e2e-spec.ts`): every `/api/connections*` route `settings.manage` except `/api/connections/freshness` (`orders.view`); `/api/stock/shopify-differences` `stock.view`, its acknowledge `stock.receive`; `/api/outbound-commands` and its retry and resolve declared `@AnyHat()` with the per linked type check in the handler through `Access` (403 `FORBIDDEN`), like the archived filter of `LocationsController`.

### Critical test scenarios

- Connect against fixtures: rows created in one transaction, health `ok`, 13 subscriptions registered; app not installed, a missing scope, and a USD shop each end `failing` with their code; a second connection to the same shop answers 409, verifies **AC-1**.
- Secrets: the connection detail, every log line of a connect and a webhook run, and the audit entry contain neither the secret nor the token (a sentinel secret is searched in all output); a key rotation keeps webhooks verifying, verifies **AC-2**.
- Hook: a good signature stores one row and answers 200; the same delivery again adds none; a tampered byte, a wrong shop domain, an unknown id, and an archived connection all answer the same 401 with no row; 2 MB plus one byte answers 413, verifies **AC-3**, **AC-4**.
- Inbox privacy: after the order, customer, and backfill scenarios, no `inbound_events.payload` contains a phone pattern, a fixture name, or an address line; the purge job removes a processed row aged 91 days and keeps a failed one aged 100 days, verifies **AC-5**.
- One mapper: the same order delivered by webhook, by sweep, and by backfill produces identical orders; three webhooks for one order inside one job cause one read back and two `coalesced` rows; an older snapshot is `ignored` `stale`; a crash injected after the read back leaves the event `received` and the retry creates one order, verifies **AC-6**.
- Orders: two stores each receive `#1001` and both orders show their store; a test order is ignored; a cash on delivery order has `paymentMethod = 'cod'` and prepaid 0 even after a later "mark as paid"; a card order is prepaid, verifies **AC-7**.
- Gifted: a free order tagged `gift-influencer` (with the setting mapping it to `influencer`) is `gifted`; the same tag on a paid order is a `sale` with `gift_tag_not_free`, verifies **AC-8**.
- Netting: a size change gives one `edit_removal` and one added line, never a return; an add and remove on one operating day leave no line; the same across 23:50 and 00:10 Cairo time are two separate edits; an add applied before its removal publishes `ChannelEditNetted` once, verifies **AC-9**.
- Cancel and fulfillment: a Shopify cancel with reason `CUSTOMER` cancels with `channel.customer`; the first fulfillment sets the carrier delivery time and a later edit is not applied (orders raises `channel_edit_not_applied`), verifies **AC-10**.
- Ownership: an order with a `waiting` command is not changed by a read back (`held_write_back_open`) and is read back once after the command syncs; no inbound path writes the cash state or posts a movement (asserted by row counts), verifies **AC-11**.
- Customers: an update with an Egyptian phone calls `findOrCreate` with the parsed phone and the channel id; one with no phone records `no_phone` and writes nothing, verifies **AC-12**.
- Products: a product with three variants and one without SKU maps three, lists one `needs_sku` and publishes `ChannelProductNeedsAttention` once; applying it again changes nothing and publishes nothing; a delete marks mappings removed and leaves the catalog untouched, verifies **AC-13**.
- Backfill: the bulk fixture loads products then orders; an open order is `new`, a cancelled one `cancelled` by `import`, a fulfilled one `shipped`; a chunk stopped at line 500 resumes at 501 with no duplicate; no file is written, verifies **AC-14**.
- Sweep: with a fixture clock, an order updated at 10:00 with no webhook is applied by 10:15; the freshness line turns `late` when the last sweep is 16 minutes old; a missing subscription is created again by the hourly check, verifies **AC-15**.
- Stock push: a receipt of 5 pieces leads within one minute to one `inventorySetQuantities` call with the new quantity, the previous Shopify quantity as `changeFromQuantity`, and an idempotency key, recorded as one command; 600 changed variants make 3 calls; a Shopify order lowers the next pushed number; with the step off no write request is attempted, verifies **AC-16**.
- Stale: a `CHANGE_FROM_QUANTITY_STALE` answer leads to a read, a wait for the inbox, and one new command with the recomputed target, verifies **AC-17**.
- Echo and differences: the inventory message after our push is `echo`; a Shopify side change of +3 records one difference and no movement (ledger row counts unchanged), shows on the differences page, and is acknowledged with an audit entry; the next push sets Shopify back to the ledger, verifies **AC-18**.
- Commands: an `OrderEdited` with `origin = 'person'` makes one `shopify.order_edit` row in the same transaction and one with `origin = 'channel'` makes none; an order kind payload with an address fails its schema, verifies **AC-19**.
- Failure: a fixture executor rejected by Shopify sets `failed` with the code and publishes `OutboundCommandFailed` in the same transaction; a 500 then 200 retries and syncs; retry and resolve write their audit entries; turning the step off fails waiting commands with `STEP_OFF`; `writeBackAvailable` is false with no executor registered, verifies **AC-20**.
- Rate limits: a throttled sequence makes the client wait the computed time before the next call; a 429 waits `Retry-After`; two jobs for one connection never overlap; every recorded request has a requested cost at most 1,000; a fall forward header sets the health warning, verifies **AC-21**.
- Fixtures: a test that calls an unrecorded URL fails with `UnrecordedRequest`; the replay server refuses to start with `NODE_ENV=production`, verifies **AC-22**.
- Screen and access: a manager connects a store on the mock server and sees health `ok` in both languages, keyboard only, axe clean; support, operations, and warehouse get the no access state on `/connections`; support sees the freshness line, verifies **AC-23**.

## Build plan

Tracer Bullet: milestone 1 proves one real thread (a recorded Shopify order through a signed webhook into the orders list) through every layer, starting from the recorded fixtures; each later milestone thickens one segment end to end. Each milestone is one commit.

**Build order across the wave.** Every event this feature publishes goes through spec 0013's `DomainEvents`, which spec 0013 builds in its milestone 1, so nothing here publishes before that lands. The order:
1. This spec's tasks 1 to 3 (fixtures, `ChannelsService`, the schema) first, as a prerequisite slice, because spec 0013's milestone 1 reads stores and channels only through `ChannelsService`.
2. Spec 0013 milestone 1 (`DomainEvents`), then its milestones 2 (a fixture connector stands in for `openCommandsFor` and the `OutboundCommand*` events) and 3 (`createFromChannel`, `applyChannelEdit`, `cancelFromChannel`).
3. This spec's tasks 4 to 7, closing milestone 1.
4. Specs 0012 milestone 4 (`CatalogChannelSync`) and 0014 milestone 1 (`findOrCreate`), then this spec's milestone 2.
5. Spec 0011 milestone 1 (`OnlineStockService`) and feature 9's executing steps, then this spec's milestone 3, which replaces spec 0013's fixture connector with the real one; then milestone 4.

**Milestone 1: recorded fixtures and one order through a signed webhook.**
1. [ ] Record the fixture scenarios from a Shopify development store with the recorder script; confirm and record the scope handles, the agreement reason values, the inventory message fields, the order fields used in *Value sourcing*, and the `inventorySetQuantities` reason value; install `shopify-fixture-fetch.ts` in the api's vitest setup; the replay server and `SHOPIFY_MOCK_ORIGIN` (refused in production), satisfies **AC-22**
2. [ ] The channels module: `ChannelsService` reads and `storeLabelsByConnection`, `createShopifyStore`, its README, satisfies **AC-1**
3. [ ] The schema: amended `connections` and `outbound_commands`, the four new tables and enums, the ownership map, the enum parity test, satisfies **AC-1**, **AC-4**, **AC-5**, **AC-16**, **AC-20**
4. [ ] `connection-secrets.ts` (seal, open, key versions, re-encrypt job), `CONNECTOR_SECRET_KEY` and `_PREVIOUS` in `env.ts`, `.env.example`, `pnpm bootstrap`, and `deploy/compose.yaml`; redaction keys, satisfies **AC-2**
5. [ ] `ShopifyClient` with the token cache, the rate policy, the version check, and the requested cost test over every recording, satisfies **AC-21**
6. [ ] Connect: route, `connect.job.ts`, webhook registration, health codes, `connection.created`; a minimal `/connections/new` form and list, satisfies **AC-1**, **AC-23**
7. [ ] The hook: raw body parser, signature and shop checks, inbox insert and job in one transaction, failure counter, `acceptsHook`; the inbox job with read back, stale and coalesced rules, and the order mapper calling `createFromChannel` (lines may be unmapped), satisfies **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-7**

**Milestone 2: catalog, orders in full, backfill, and the sweep.** Needs 0012's `CatalogChannelSync` and 0014's `findOrCreate`.
8. [ ] Products: mapper with variant paging, `applyProduct`, mappings with inventory item ids, outcomes and `ChannelProductNeedsAttention`, deletes, `unlink` on archive, satisfies **AC-13**
9. [ ] Orders in full: every *Value sourcing* row, gifted tags, payment and prepaid rules, cancel, first fulfillment, `applyChannelEdit` and the write back hold, satisfies **AC-7**, **AC-8**, **AC-10**, **AC-11**
10. [ ] `edit-netting.ts` with unit tests over every netting scenario, `ChannelEditNetted`, `ChannelRefundRecorded`, satisfies **AC-9**
11. [ ] Customer webhooks to `findOrCreate`, satisfies **AC-12**
12. [ ] Backfill through bulk operations with resume and the paged fallback; sweeps with watermarks and budgets; hourly webhook check; freshness endpoint and the shell freshness line; the purge job, satisfies **AC-5**, **AC-14**, **AC-15**

**Milestone 3: the outbound door and the stock push.** Needs 0011's `OnlineStockService` and feature 9's executing steps.
13. [ ] Outbound framework: `enqueue`, executor registry, failure contract and the four events, `openCommandsFor`, `syncStateFor`, `writeBackAvailable`, `failWaitingCommands`, the `OrderEdited` handler, the kind schemas, retry and resolve routes with audit, satisfies **AC-19**, **AC-20**
14. [ ] Stock push with `changedSince`, batching, compare and set, idempotency, the stale round, the online location resync, and the step gate, satisfies **AC-16**, **AC-17**
15. [ ] Echo, differences, `StockDriftRecorded`, nightly reconcile, the differences page with acknowledge and audit, satisfies **AC-18**

**Milestone 4: the connection screen, health, and the runbook.**
16. [ ] The full connection screen (Overview, Mapping, Backfill, Products, Failed writes; pause, resume, replace keys, archive with subscription removal), health transitions and `ConnectionHealthChanged`, all audit codes and record types, satisfies **AC-1**, **AC-2**, **AC-23**
17. [ ] Route mapping rows and access sweep fixtures for every new route; Playwright on the replay server in both languages with axe; the module READMEs; `docs/runbooks/shopify-store-connection.md` (creating the Dev Dashboard app, scopes, protected customer fields, cancelling stale open orders before go live), satisfies **AC-22**, **AC-23**

## Consequences

**Positive**:
- One mapper for webhooks, sweeps, and backfill means one set of tests proves all three paths, and a lost or out of order webhook can never leave an order half applied.
- The inbox and the connectors tables hold no personal data, so their retention is an audit question, not a Law 151 one.
- Stock is pushed with compare and set and an idempotency key, so a retry or a race with a Shopify sale can never inflate Shopify's sellable quantity.
- The command door gives features 18, 35, and 37 a ready failure path, hold rule, and task event; they only add executors.
- The brand owns the Shopify apps, so its exit package needs no vendor action on Shopify.

**Negative / tradeoffs**:
- Every order event costs one GraphQL read (about a few hundred reads a day per store), and the reads depend on Shopify being up; a Shopify outage delays orders until the sweep catches up.
- The brand must create and install one Dev Dashboard app per store, a manual onboarding step with a runbook; a mistake in scopes shows only at connect.
- Two stores sharing the online location can both sell the last piece in the minute before the second push (Q-13.4).
- Edit netting relies on Shopify's sales history fields (`agreements`), which the reference brand verified on `2026-10` but which Shopify may reshape in a later version; the yearly version move must record the fixtures again.
- Orders older than 60 days are not imported, so a customer's earlier history starts empty unless feature 15 imports it.
- A failed write back still needs a person; nothing here retries a rejected edit by itself.

**Neutral**:
- The baseline gains four tables and two amended ones; whichever of specs 0011 to 0015 lands second regenerates the baseline on top of the first.
- Customers without orders are created from `customers/create` when they have a phone (spec 0014 rule e).
- The freshness line is shown to every hat that sees orders, not only operations and manager (spec 0007 named those two; showing more harms nothing).

## Questions for the owner

Each is decided with the recommended answer and built that way unless the owner says otherwise.

1. **Q-13.1 How does the app reach each Shopify store?** _Decided: the brand creates one app per store in Shopify's Dev Dashboard in its own organization and pastes its client id and secret; tokens come from the client credentials grant (recommended)._ Other options: a vendor owned app per store with custom distribution, installed by a link the brand clicks (authorization code grant); or one public app on the Shopify App Store. Why: Shopify stopped new admin custom apps on 1 January 2026, the client credentials grant works only when app and store share an organization, custom distribution still needs one app per store outside a Plus organization, and a public app needs App Store review and protected data review before the pilot; the reference brand already runs exactly this setup on two stores.
2. **Q-13.2 How much order history does the first backfill bring?** _Decided: everything Shopify shows by default, the last 60 days (recommended)._ Other options: only open orders; 12 months or all (needs the `read_all_orders` scope selected on each app). Why: 60 days covers Bosta's 45 to 60 day cash and fee windows for reconciliation and needs no extra scope; deeper history is feature 15's import.
3. **Q-13.3 How does a Shopify order become a gifted order?** _Decided: a tag from the setting `shopify_gift_tags` on an order whose total is 0 (recommended)._ Other options: a list of 100 percent discount codes; every order with a total of 0. Why: a tag is explicit and staff already tag orders in Shopify; a free order without a tag is often an exchange replacement made in Shopify, which must not leave revenue as a gift.
4. **Q-13.4 With two stores selling from one warehouse, how is stock shared?** _Decided: both stores receive the full sellable quantity (recommended)._ Other options: a fixed share per store; a variant sold online in one store only. Why: the reference brand's two stores sell different product groups, so overlap is rare, and a split would hide stock from a store that needs it; the cost is a window of about a minute in which the last piece could sell twice.

## Follow-up

- [ ] Feature 18: build the `shopify.order_edit` and `shopify.order_cancel` executors to the shapes above, register `step.shopify_order_edit_write_back` and `step.shopify_duplicate_cancel`, and ask spec 0013 for an orders read of lines and ship to for the executor and for a way to set `channel_line_id` on lines the write back created, so the next read back matches them.
- [ ] Features 35 and 37: define the `shopify.refund` and `shopify.return_record` executors and listen to `ChannelRefundRecorded`.
- [ ] Feature 17: open a task on `OutboundCommandFailed` (one per command; one per connection for `shopify.inventory_set`) and on `ChannelProductNeedsAttention` (one per variant and outcome), and decide whether `StockDriftRecorded` opens one.
- [ ] Feature 24: exclude the line ids of `ChannelEditNetted` from edit removal counts.
- [ ] Feature 26: rate limit `/api/hooks/*` at Caddy; make the webhook address reachable over https; add `CONNECTOR_SECRET_KEY` to the per client secret store.
- [ ] Release runbook: move `SHOPIFY_API_VERSION` to a newer stable version and record the fixtures again before 16 October 2027.
- [ ] Spec 0008 route mapping and spec 0010 registry rows as listed above (Igris routes; this spec edits neither).
- [ ] Root `AGENTS.md` module list gains `channels` and `connectors` when they are built (`/sync`).
- [ ] Write the Shopify Admin GraphQL connector skill the rebuild plan calls for (spec 0007 Follow-up), from this spec and the recorded fixtures.
- [ ] Point of sale orders (`sourceName` from Shopify POS) arrive on the store's channel like any order; if a brand sells through POS, decide whether they need their own channel and should skip the confirmation queue.
