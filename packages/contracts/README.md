# Api contracts (`@ssdashboard/contracts`)

The shared shapes of the api: Zod schemas and the types inferred from them. The api validates with them and the web parses answers with them.

Agent gotchas: [AGENTS.md](AGENTS.md).

## Owns

- One file per area of shapes, re-exported from [src/index.ts](src/index.ts): [auth](src/auth.ts), [catalog](src/catalog.ts), [inventory](src/inventory.ts), [locations](src/locations.ts), [platform](src/platform.ts), [staff](src/staff.ts), [stock](src/stock.ts), [stock-receipts](src/stock-receipts.ts), [health](src/health.ts)
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

Specs sit in [test/](test/) and beside the source (`src/*.spec.ts`).

## Governing spec

- [0002 Core data model](../../docs/specs/0002-core-data-model/index.md)
- [0006 Core stock loop](../../docs/specs/0006-core-stock-loop/index.md)
- [0007 Stack and architecture for the operations layer](../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
