# Connectors

The link to the brand's outside accounts (Shopify first): the commands written back to them and, from spec 0015 on, the connections, inbox, and mappings. Today a stand-in holding only what spec 0013 milestone 2 needs, until spec 0015 task 13 builds the outbound framework.

## Owns

- The connector tables (defined in [packages/db](../../../../packages/db/src/schema/connectors.ts)): `connections`, `outbound_commands`, `inbound_events`, `connection_external_ids`, `connection_stock_levels`, and `connection_sync_runs`, all owned by `connectors` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts). Today it only reads `outbound_commands` and a connection's store.
- `ConnectorsService` ([connectors.service.ts](connectors.service.ts)): `openCommandsFor(linkedType, id, tx)` (the `waiting` and `failed` commands of a record, read in the caller's transaction), `syncStateFor(linkedType, id)` (the same rows for the order page's command block), `storeOfConnection(connectionId, tx)` (a connection's store, which the orders module checks before it trusts a channel's customer id, until task 13 registers the `ConnectionStoreSource`), and `writeBackAvailable(orderId, kind)`, which answers false: no executor registers before feature 18 (the rule of spec 0015 AC-24), so Shopify orders are edited and cancelled in Shopify.
- Its registry row (spec 0009, AC-6, `packages/contracts/src/modules/module-registry.ts`): `connectors`, core, no toggle, requires `channels`, no capabilities yet (each lands with its code in spec 0015, AC-6); it has no controller yet (a controller added here declares `@RequiresModule('connectors')`, or `src/platform/modules/requires-module.spec.ts` fails the build).
- The events ([connectors.events.ts](connectors.events.ts)): `OutboundCommandQueued`, `OutboundCommandSynced`, `OutboundCommandFailed`, and `OutboundCommandResolved` (`commandId`, `connectionId`, `kind`, `linkedType`, `linkedId`, `failureCode`), published through the platform `DomainEvents` by whoever changes a command. Nothing here publishes them yet: spec 0015 task 13's `enqueue` and executors will, and the e2e suites use a fixture connector.

## Never touches

- Other modules' tables: the orders module keeps `orders.write_back_state` from these events itself (its write back projection), and stores come from `ChannelsService`.
- A command's `payload` in a log line, an error, or an event: it may hold an address (Law 151).
- Writing a command: `enqueue`, the executors, retry, and resolve are spec 0015 task 13, not built here.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/connectors
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/orders-edit.e2e-spec.ts
```

The unit test needs no database; the orders edit e2e suite drives `openCommandsFor` and the events against Postgres with a fixture connector.

## Governing spec

- [0015 Shopify connector](../../../../docs/specs/0015-shopify-connector/index.md) (AC-24 and the exported service table; task 13 builds the rest)
- [0013 Orders and their state machines](../../../../docs/specs/0013-orders-state-machines/index.md) (milestone 2: the fixture connector standing in for `openCommandsFor`, `writeBackAvailable`, and the events)

## Decisions

- **A stand-in, decided by the lead for spec 0013 milestone 2**: the module, its service file, and its events file carry the names spec 0015 gives them, so task 13 grows them in place rather than replacing a fake. No ADR yet.
