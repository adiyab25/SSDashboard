# Channels

The brand's stores (where an order is numbered and priced) and channels (how an order arrived), read and created through one service so orders, customers, and the Shopify connector never touch the tables.

## Owns

- The `stores` and `channels` tables (defined in [packages/db](../../../../packages/db/src/schema/channels.ts)), owned by `channels` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts). Only this module reads or writes them. The seeds (the internal store `MAIN`, the channel `manual`) are in the baseline rules migration.
- `ChannelsService` ([channels.service.ts](channels.service.ts)), the one exported service:
  - `stores(ids, executor?)` and `channels(ids, executor?)`: code, names, kind, and for a channel its default store. Archived ones are answered, because an order keeps pointing at what it was made in.
  - `listStores({ kind? })` and `listChannels({ kinds? })`: the ones not archived, ordered by code, for forms.
  - `storeLabelsByConnection(connectionIds, executor?)`: `{ connectionId, storeId, storeCode, storeName }` per requested connection (an answer for an id not asked is dropped), ordered by store code then connection id, for the customer profile (spec 0014). The connection to store link comes from a `ConnectionStoreSource` the connectors module registers with `registerConnectionStores` (see Decisions); without one it throws `CONNECTION_STORES_NOT_REGISTERED`.
  - `createShopifyStore(tx, input)`: a store of kind `shopify` and its own channel (kind `shopify`, same code and name, default store this store) in the caller's transaction. Only the connectors module calls it, from the connect route. A code in use throws `STORE_CODE_TAKEN`; a code outside `^[A-Z0-9][A-Z0-9_-]{0,31}# Channels

The brand's stores (where an order is numbered and priced) and channels (how an order arrived), read and created through one service so orders, customers, and the Shopify connector never touch the tables.

## Owns

- The `stores` and `channels` tables (defined in [packages/db](../../../../packages/db/src/schema/channels.ts)), owned by `channels` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts). Only this module reads or writes them. The seeds (the internal store `MAIN`, the channel `manual`) are in the baseline rules migration.
- `ChannelsService` ([channels.service.ts](channels.service.ts)), the one exported service:
  - `stores(ids, executor?)` and `channels(ids, executor?)`: code, names, kind, and for a channel its default store. Archived ones are answered, because an order keeps pointing at what it was made in.
  - `listStores({ kind? })` and `listChannels({ kinds? })`: the ones not archived, ordered by code, for forms.
  - `storeLabelsByConnection(connectionIds, executor?)`: `{ connectionId, storeId, storeCode, storeName }` per connection, for the customer profile (spec 0014). The connection to store link comes from a `ConnectionStoreSource` the connectors module registers with `registerConnectionStores` (see Decisions); without one it throws `CONNECTION_STORES_NOT_REGISTERED`.
  - `createShopifyStore(tx, input)`: a store of kind `shopify` and its own channel (kind `shopify`, same code and name, default store this store) in the caller's transaction. Only the connectors module calls it, from the connect route.  or a name with no language throws `INVALID_STORE_INPUT`. Names are trimmed and only `en` and `ar` are kept.
  - `renameStore(tx, storeId, { name, publicName? })`: sets the names of a Shopify store (and its channel's name) so the connect job can fill them from the shop name; the code never changes, and an unknown or internal store throws `STORE_NOT_FOUND`.
- `ChannelsError` ([channels.errors.ts](channels.errors.ts)): the typed domain errors.
- The module wiring: [channels.module.ts](channels.module.ts) exports `ChannelsService`. Core, no toggle, no routes.

## Never touches

- Other modules' tables. In particular never `connections`: the connectors module owns it and tells this module which store a connection belongs to through `ConnectionStoreSource` ([connection-store-source.ts](connection-store-source.ts)).
- Deletes of a store or channel (archive instead, once an order references it), and the `MAIN` store and `manual` channel.
- Orders, customers, and the ledger.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/channels
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/channels.e2e-spec.ts
```

The unit suite needs no database. The e2e suite needs Postgres: it creates a scratch database, runs as the application role, and checks the reads, `createShopifyStore`, and the code clash.

## Governing spec

- [0015 Shopify connector](../../../../docs/specs/0015-shopify-connector/index.md) (build plan task 2, AC-1; the `ChannelsService` row of *Exported services and events*)
- [0002 Core data model](../../../../docs/specs/0002-core-data-model/0002-orders.md) (`stores`, `channels`)

## Decisions

- `storeLabelsByConnection` cannot read `connections` itself: the module wall (`src/module-boundary.spec.ts`) reserves that table for connectors. The connectors module registers a `ConnectionStoreSource` from its `onModuleInit` (the pattern of `AuditUndoRegistry`), which avoids an import cycle between the two modules. The connectors module (spec 0015 task 6) owes that registration.
