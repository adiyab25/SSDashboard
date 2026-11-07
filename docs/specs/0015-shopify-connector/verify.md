# Verify: Shopify connector · spec 0015 · written 2026-11-07

_Steps derived from spec 0015 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Each milestone of the Build plan ticks the steps it makes runnable. Every step runs against the recorded fixtures or the replay server (`SHOPIFY_MOCK_ORIGIN`); none touches a live Shopify store._

## UI / manual
- [ ] Start the replay server and the app with `SHOPIFY_MOCK_ORIGIN` set; sign in as a manager, open `/connections/new`, connect store `ESS` with the fixture shop domain and keys → the connection appears with health `connecting`, then `ok`; the detail shows 13 webhook subscriptions present and the API version `2026-10` → AC-1, AC-23
- [ ] Connect the same shop domain again → "already connected" (409 `SHOP_ALREADY_CONNECTED`); connect with the "app not installed" fixture → health `failing` with the reason shown in plain words → AC-1
- [ ] On the connection detail, look for the secret anywhere (page, network tab, `/audit` entry) → only "set" and the last 4 characters of the client id → AC-2
- [ ] Replace the keys with a reason → health goes back to `connecting`, then `ok`; `/audit` shows `connection.credentials_replaced` without values → AC-2
- [ ] Mapping tab: pick the stock location from the fixture locations; the payment gateway names seen so far show with their payment method → AC-16, AC-23
- [ ] Backfill tab: start the backfill → products, then orders, with progress counts; open orders appear in the orders list as `new`, closed ones in their found state, each order number with its store → AC-7, AC-14
- [ ] Products tab: the fixture variant without SKU is listed as "needs a SKU" → AC-13
- [ ] Sign in as support: the shell shows "Shopify ESS: last order N minutes ago"; `/connections` shows the no access state → AC-15, AC-23
- [ ] Open `/stock/shopify-differences` as operations after the difference fixture → one row (variant, store, Shopify quantity, ledger target); acknowledge it with a reason code → it leaves the list and `/audit` shows `stock_difference.acknowledged` → AC-18
- [ ] Failed writes tab after the rejected command fixture → the command with its code; retry and resolve each write an audit entry → AC-20
- [ ] Switch to Arabic on every connection page → right to left, every label Arabic, codes and domains in `LtrText`; keyboard only through connect and mapping; axe clean in both languages; one `<h1>` per page → AC-23
- [ ] Archive the connection with a reason → subscriptions removed first (the replay server log shows the delete calls), status `archived`, the freshness line drops it → AC-23

## Commands
- [ ] `pnpm test` → `edit-netting.spec.ts` (size change, same day pair, pair across midnight Cairo, already applied half), `shopify-client.spec.ts` (throttle waits, 429, version header, requested cost of every recording at most 1,000), `connection-secrets.spec.ts`, `outbound-commands.spec.ts` (kind schemas refuse an address in an order payload) pass → AC-2, AC-9, AC-19, AC-21
- [ ] Add a test that calls an unrecorded Shopify URL and run `pnpm --filter @ssdashboard/api test` → it fails with `UnrecordedRequest` → AC-22
- [ ] `NODE_ENV=production` with `SHOPIFY_MOCK_ORIGIN` set → the api refuses to start, naming the variable → AC-22
- [ ] `pnpm build && pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/shopify-connect.e2e-spec.ts test/shopify-hooks.e2e-spec.ts` → connect, signature, shop domain, duplicate delivery, 413, archived connection cases pass → AC-1, AC-3, AC-4
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/shopify-orders.e2e-spec.ts` → two stores `#1001`, test order, cash on delivery and prepaid, gifted tag, size change, edit pair, cancel, fulfillment lock, write back hold, coalesced and stale events, crash and retry pass → AC-6, AC-7, AC-8, AC-9, AC-10, AC-11
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/shopify-catalog-customers.e2e-spec.ts` → product mapping, `needs_sku`, idempotent reapply, delete, customer with and without phone pass → AC-12, AC-13
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/shopify-backfill-sweep.e2e-spec.ts` → bulk backfill with resume at a line, sweep with a fixture clock (applied within 15 minutes), freshness `late`, subscription registered again, purge ages pass → AC-5, AC-14, AC-15
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/shopify-stock.e2e-spec.ts` → push within a minute, batches of 250, compare and set, stale round, step off sends nothing, echo, difference without a movement, reconcile pass → AC-16, AC-17, AC-18
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/outbound-commands.e2e-spec.ts` → `OrderEdited` person and channel origins, rejected and transient failures with events in the same transaction, retry, resolve, `STEP_OFF`, `writeBackAvailable` false without an executor pass → AC-19, AC-20
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/access-sweep.e2e-spec.ts` → every new route has a fixture and answers 403 to the wrong hats → AC-23
- [ ] `pnpm --filter @ssdashboard/web test:e2e -- e2e/connections.spec.ts --project=desktop` → connect on the replay server, mapping, backfill, both languages, keyboard only, axe clean → AC-23
- [ ] `pnpm lint` → module READMEs for `channels`, `connectors`, `connectors/shopify`, `apps/web/src/connections` present with the five headings → AC-23

## Value sourcing checks
- [ ] After the order, customer, and backfill fixtures, `SELECT payload FROM inbound_events` → only ids, topics, timestamps, and inventory numbers; no fixture name, phone, or address → AC-5 (payload source)
- [ ] For the `#1001` fixture: `order_number` is Shopify's `name`, `placed_at` is `createdAt`, `channel_order_ref` is the order gid, each line's `channel_line_id` is the line item gid → AC-7
- [ ] A cash on delivery fixture later marked as paid in Shopify → `prepaid_amount` stays 0 → AC-7 (prepaid from non cod gateways only)
- [ ] The edit pair fixture at 23:50 and 00:10 Cairo time → treated as two operating days by `ssd_operating_day`, not netted → AC-9 (operating day source)
- [ ] Cancel fixture with `cancelReason = CUSTOMER` → `cancel_reason_code = 'channel.customer'` → AC-10
- [ ] Stock push request body in the replay log → `quantity` equals `pushable` minus `shopify_stock_safety_buffer`, `changeFromQuantity` equals the level's `shopify_quantity`, and an idempotency key is present → AC-16
- [ ] `GET /api/connections/freshness` with `last_sweep_at` set 16 minutes back → `state: 'late'` → AC-15
- [ ] `GET /api/connections/:id` and the worker log at debug level during a connect → no secret or token string (search for the fixture secret) → AC-2
