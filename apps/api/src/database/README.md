# Database access

The Drizzle client provider and the small SQL helpers every module shares.

## Owns

- The `DATABASE` provider that hands out the Drizzle client: [database.module.ts](database.module.ts)
- The `Transaction` and `Executor` types and `pgArray` (an array as one bound literal): [sql.ts](sql.ts)
- PostgreSQL error code helpers: [pg-error.ts](pg-error.ts)

## Never touches

- Table definitions. They live in [packages/db](../../../../packages/db/), not here.
- Migrations. Only the `migrate` entry point runs them.
- Business rules. This folder knows nothing about stock, orders or staff.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/database
```

The unit specs are [sql.spec.ts](sql.spec.ts) and [pg-error.spec.ts](pg-error.spec.ts). The migrate end to end spec is `apps/api/test/migrate.e2e-spec.ts` (needs Postgres, build first).

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
