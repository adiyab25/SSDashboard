# Api contracts (`@ssdashboard/contracts`)

The shared shapes of the api: Zod schemas and the types inferred from them. The api validates with them and the web parses answers with them.

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- One file per area of shapes, re-exported from [src/index.ts](src/index.ts): [auth](src/auth.ts), [catalog](src/catalog.ts), [inventory](src/inventory.ts), [locations](src/locations.ts), [platform](src/platform.ts), [staff](src/staff.ts), [stock](src/stock.ts), [stock-receipts](src/stock-receipts.ts), [health](src/health.ts)
- Two folders of pure modules, each re-exported from [src/index.ts](src/index.ts). Nothing in them reads a database, a clock, or the network:
  - [customers/](src/customers/): [egyptian-phone.ts](src/customers/egyptian-phone.ts) turns phone text into one E.164 number and its kind (`EgyptianPhone.parse`), and defines `InvalidPhone`.
  - [orders/](src/orders/): [order-states.ts](src/orders/order-states.ts) holds the fulfillment and cash state machines, their transition table, `nextState`, `firstCashState`, and `replayStates`.
  - [orders/](src/orders/): [order-outcome.ts](src/orders/order-outcome.ts) holds `deriveOrderOutcome`, the only place an order's outcome is computed, plus `refundedAmountOf` and `deliveredAmountOf`.
  - [orders/](src/orders/): [line-split.ts](src/orders/line-split.ts) holds `splitLine`, which divides a line on a partial delivery.
  - [orders/](src/orders/): [order-amounts.ts](src/orders/order-amounts.ts) holds `allocatePayments`, `codExpected`, `codDue`, and `linesGrossAmountOf`.
- Money rules: [src/money.ts](src/money.ts) (`Money`, `UnitCost`, `LineAmounts`)
- Localized text: [src/localized-text.ts](src/localized-text.ts)

## Never touches

- Floats for money. Amounts cross boundaries as `numeric` text.
- Hand written duplicate types. Export `z.infer` types from the schema.
- `apps/*`, the database, or NestJS. It is plain TypeScript and Zod.

## How to test

```bash
pnpm --filter @ssdashboard/contracts test
pnpm --filter @ssdashboard/contracts build
```

Specs sit in [test/](test/) and beside the source (`src/*.spec.ts`). The pure order and customer modules have their own: [egyptian-phone.spec.ts](test/egyptian-phone.spec.ts), [order-states.spec.ts](test/order-states.spec.ts), [order-outcome.spec.ts](test/order-outcome.spec.ts), [line-split.spec.ts](test/line-split.spec.ts), and [order-amounts.spec.ts](test/order-amounts.spec.ts). None of them needs a database.

## Governing spec

- [0002 Core data model](../../docs/specs/0002-core-data-model/index.md)
- [0002 orders child](../../docs/specs/0002-core-data-model/0002-orders.md) (`src/orders/`)
- [0002 customers, credit, and tasks child](../../docs/specs/0002-core-data-model/0002-customers-credit-tasks.md) (`src/customers/`)
- [0006 Core stock loop](../../docs/specs/0006-core-stock-loop/index.md)
- [0007 Stack and architecture for the operations layer](../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
