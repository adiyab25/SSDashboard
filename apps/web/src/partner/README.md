# Partner area

A placeholder page at `/partner` for consignment partners. It uses a minimal frame with no staff shell and no session check yet.

## Owns

- The page: [partner-page.tsx](partner-page.tsx)
- The route: `src/app/(partner)/partner/page.tsx`

## Never touches

- Staff routes or staff data. The partner audience must not call staff api routes.
- The staff app shell.
- Any other audience's screens ([portal](../portal/), back office).

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/partner
pnpm --filter @ssdashboard/web test:e2e -- e2e/audiences.spec.ts
```

## Governing spec

- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
