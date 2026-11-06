# Platform

Services every module shares: install settings, gap free document numbers, the per order cost rules, the audience and permission guards, request validation pipes, and the public client config route.

## Owns

- `GET /api/config`, open to everyone: [config.controller.ts](config.controller.ts)
- Typed install settings and local dates in the install time zone: [settings.service.ts](settings.service.ts)
- Gap free document numbers: [numbering.service.ts](numbering.service.ts)
- The per order cost rules in force on a day (`CostRulesService.ruleFor`, `not_set` and never 0 when no rule is set): [cost-rules.service.ts](cost-rules.service.ts), selection in [cost-rule-selection.ts](cost-rule-selection.ts)
- `@Audience(...)` and the deny by default guard: [audience/audience.decorator.ts](audience/audience.decorator.ts), [audience/audience.guard.ts](audience/audience.guard.ts)
- One permission declaration per route and its guard (spec 0008): `Access`, the immutable value object of what the caller may do ([access/access.ts](access/access.ts)), `@Permission(...)` and `@AnyHat()` ([access/permission.decorator.ts](access/permission.decorator.ts)), `@CurrentAccess()` ([access/current-access.decorator.ts](access/current-access.decorator.ts)) and `PermissionGuard` ([access/permission.guard.ts](access/permission.guard.ts)). It reads `request.access`, which identity's session guard sets, and never queries the database
- Request validation: [zod-body.pipe.ts](zod-body.pipe.ts), [zod-query.pipe.ts](zod-query.pipe.ts)
- Keyset paging cursors: [keyset-cursor.ts](keyset-cursor.ts)
- Mapping query errors to answers: [query-error.filter.ts](query-error.filter.ts)
- Auth events other modules can listen to: [events/auth-events.ts](events/auth-events.ts)
- The settings, document counter, custom field, and order cost rule tables (`install` too, written only by `migrate`, which also seeds one `not_set` rule per kind), defined in [packages/db](../../../../packages/db/src/schema/platform.ts)

## Never touches

- Ledger tables or the ledger service.
- Business rules of any module. It offers shared tools only.
- Another module's tables.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/platform
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api test:e2e test/numbering-reconcile.e2e-spec.ts test/cost-rules.e2e-spec.ts
```

[audience/audience.spec.ts](audience/audience.spec.ts) fails the build for a controller without exactly one `@Audience(...)`, and [access/permission.spec.ts](access/permission.spec.ts) for a `staff` or `partner` handler without exactly one valid permission declaration.

## Governing spec

- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md)
- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md) (audiences)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md) (permissions per route, `Access`)

## Decisions

- The projection rule (A6): a module publishes a past tense domain event inside its own transaction, and no module reads another module's table to fill an order projection column (`orders.write_back_state`, `returned_credit_amount`, `exchange_consumed_amount`, the cash amounts). See [0002 tenancy child](../../../../docs/specs/0002-core-data-model/0002-tenancy-platform.md).

Record other non obvious decisions as ADRs in docs/adr/ and link them here.
