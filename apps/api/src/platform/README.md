# Platform

Services every module shares: install settings, gap free document numbers, the audience guard, request validation pipes, and the public client config route.

## Owns

- `GET /api/config`, open to everyone: [config.controller.ts](config.controller.ts)
- Typed install settings and local dates in the install time zone: [settings.service.ts](settings.service.ts)
- Gap free document numbers: [numbering.service.ts](numbering.service.ts)
- `@Audience(...)` and the deny by default guard: [audience/audience.decorator.ts](audience/audience.decorator.ts), [audience/audience.guard.ts](audience/audience.guard.ts)
- Request validation: [zod-body.pipe.ts](zod-body.pipe.ts), [zod-query.pipe.ts](zod-query.pipe.ts)
- Keyset paging cursors: [keyset-cursor.ts](keyset-cursor.ts)
- Mapping query errors to answers: [query-error.filter.ts](query-error.filter.ts)
- Auth events other modules can listen to: [events/auth-events.ts](events/auth-events.ts)
- The settings, document counter and custom field tables, defined in [packages/db](../../../../packages/db/src/schema/platform.ts)

## Never touches

- Ledger tables or the ledger service.
- Business rules of any module. It offers shared tools only.
- Another module's tables.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/platform
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api test:e2e -- test/numbering-reconcile.e2e-spec.ts
```

[audience/audience.spec.ts](audience/audience.spec.ts) fails the build for a controller without exactly one `@Audience(...)`.

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md) (audiences)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
