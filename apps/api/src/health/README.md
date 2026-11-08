# Health check

A public route that tells the load balancer and Compose that the api is up.

## Owns

- `GET /api/health`, open to everyone (`@Audience('public')`): [health.controller.ts](health.controller.ts)
- Its module: [health.module.ts](health.module.ts)
- The response shape lives in [packages/contracts](../../../../packages/contracts/src/health.ts)

- Its registry row (spec 0009, AC-6, `packages/contracts/src/modules/module-registry.ts`): `health`, core, no toggle. Every controller here declares `@RequiresModule('health')` (`src/platform/modules/requires-module.spec.ts` fails the build otherwise), so the module gate never answers `MODULE_OFF` for it while the module is core.

## Never touches

- Business tables or services. A health check must not depend on business data.
- Staff sessions. The route is public.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/health
```

The unit spec is [health.controller.spec.ts](health.controller.spec.ts).

## Governing spec

- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
