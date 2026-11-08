# Orders

The one place that writes an order: the order, its lines, and the history of every move of its two state machines (the parcel and the money). Other features never touch the order tables; they call named moves inside one order transaction.

## Owns

- The order tables (defined in [packages/db](../../../../packages/db/src/schema/orders.ts)): `orders`, `order_lines`, `order_events` (append only), and `shipments`, all owned by `orders` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts). Only this module reads or writes them.
- `OrderWriter` ([writer/order-writer.ts](writer/order-writer.ts)), the only file that issues `INSERT` or `UPDATE` on `orders` and `order_lines` and `INSERT` on `order_events` (`orders-single-writer.spec.ts` fails otherwise). It writes figures that [writer/order-money.ts](writer/order-money.ts) computed with the contract functions (`LineAmounts`, `allocatePayments`, `codExpected`, `codDue`, `deriveOrderOutcome`) and publishes one `OrderStateChanged` per event row.
- `OrderTransactions.run(work)` and the `OrderTransaction` type ([order-transactions.ts](order-transactions.ts), spec 0013 AC-22): the only way to open an order unit of work; a `run` inside a `run` throws `OrderTransactionNested`. Until spec 0011's `LedgerService.transaction` lands it is a plain READ COMMITTED transaction with the same contract, so callers do not change when it is switched: lock waits capped at 5 seconds (`OrderLockTimeout`, 503 `BUSY`), one rerun of the whole `work` after a deadlock. **Because `work` can run twice it must be rerunnable**: read its inputs again inside, keep no state outside it between runs, call no provider or other connection inside it, and write every row of its unit inside it. Every orders write method takes an `OrderTransaction`, so a plain Drizzle transaction does not type check.
- `OrderIntake.createManual` ([intake/order-intake.service.ts](intake/order-intake.service.ts)): the manual, gifted, reopened, and replacement order (AC-1, AC-2, AC-23), idempotent on `clientRef` (stored as `channel_order_ref`, found under an advisory lock and the partial unique index). It takes the customer from `CustomersService.findOrCreate`, the number from `NumberingService.next` as its last step, and writes `order.created_manually`.
- The public events ([orders.events.ts](orders.events.ts)): `OrderPlaced`, `OrderStateChanged`, `OrderAttentionRaised` (ids and codes only), published through the platform `DomainEvents`.
- `OrderQueries` ([reading/order-query.service.ts](reading/order-query.service.ts)): the list and search (keyset on `placed_at`, `id`), the order page, the form options, and the reads other modules call (`summaryOf`, `forCustomers`, `countsForCustomers`, `writeBackViewOf`), with the cost serializer ([reading/order-cost.ts](reading/order-cost.ts)).
- `OrdersController` ([reading/orders.controller.ts](reading/orders.controller.ts)): `GET /api/orders`, `POST /api/orders/search`, `GET /api/orders/options`, `GET /api/orders/:id`, `POST /api/orders`, `POST /api/orders/gifted`, all `@Audience('staff')`. `options` is declared before `:id`.

## Never touches

- Other modules' tables. Stores and channels come from `ChannelsService`, customers from `CustomersService`, SKU codes from `CatalogService`, actor names from the staff directory, and settings from `SettingsService`.
- The stock ledger. Reservations and the shipment posting arrive in milestones 4 and 5 through the inventory module's services.
- Personal data in logs, errors, domain events, and audit columns (Law 151): ship to fields, the customer note, and raw phones are redacted by the shared list, the module logs by order id only, and an error never echoes a phone.
- A state change outside the transition tables of `packages/contracts/src/orders/order-states.ts`, and `orders.outcome` set by hand: it is written only from `deriveOrderOutcome`.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/orders src/platform/events
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/orders.e2e-spec.ts test/orders-audit.e2e-spec.ts test/access-sweep.e2e-spec.ts
```

The unit suite needs no database. The e2e suites need Postgres: they run the real routes as the application role on a scratch database.

## Governing spec

- [0013 Orders and their state machines](../../../../docs/specs/0013-orders-state-machines/index.md) (milestone 1, build plan tasks 1 to 6)
- [0002 Core data model, orders child](../../../../docs/specs/0002-core-data-model/0002-orders.md) (the tables, the transition tables, and the money rules)
- [Scope feature 16](../../../../docs/scope/confirmation-to-cash.md)

## Decisions

- **Migrations 0009 and 0010**: the columns, checks, and indexes are one generated migration; the `goodwill_for` enum value is its own generated migration (`ALTER TYPE ... ADD VALUE` alone in its file), not a hand written custom one, because Drizzle generates it and a second `generate` must report no changes. Nothing in 0009 uses the new value, so the single migrate transaction is safe.
- **Actor with a hat**: a person actor carries the hat they act under (`access.actingHat('orders.confirm')`), because the spec 0010 audit actor needs it; the spec's `{ type: 'person', userId }` is the same shape plus `hat`.
- **A second phone that does not parse** is refused (422 `INVALID_PHONE_ALT`), unlike the main phone, which is kept as typed with `phone_unparseable`: dropping it would lose the courier's second number silently.
- **Channel kinds of a manual order**: `manual`, `whatsapp`, and `instagram`, active only; any other channel is 422 `CHANNEL_NOT_ALLOWED`. A manual order's campaign source is `whatsapp_thread` on a WhatsApp channel and `manual` otherwise; a reopened order copies the original's.
- **Prepayment shape**: `cod` carries no prepayment and any other method is a full prepayment (the body schema enforces the pairing); the amount is checked against the computed total (422 `PARTIAL_PREPAYMENT_NOT_SUPPORTED`).
- **A sale with a total of 0 is refused** (`INVALID_BODY`): a sale needs an amount to collect or a prepayment, and a gift goes through `POST /api/orders/gifted`. A sale line whose net is 0 is refused (`LINE_FULLY_DISCOUNTED`) unless the person also holds `orders.gift`.
- **Reopening**: only for the customer of the original (canonical on both sides, an order with no customer on either side is refused) and once while the reopened order is open (the original's row is locked, `orders_related_order_idx` serves the check). Replacement and goodwill links are not tied to the customer.
- **`sales_tax_rate`** is a registered core setting (default `14.00`, manager, reason required), read with `SettingsService.get(key, tx)` inside the order transaction.
- **Counts for the returner signal**: a refusal counts by the operating day of its `refused` event, a returned line by the operating day the order was placed.
