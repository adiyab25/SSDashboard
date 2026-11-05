# Returns portal

A placeholder page at `/returns` for the public exchange and return portal. Anonymous, with a minimal frame.

## Owns

- The page: [returns-page.tsx](returns-page.tsx)
- The route: `src/app/(portal)/returns/page.tsx`

## Never touches

- Staff api routes. The root providers must stay free of staff calls, because a 401 sends the browser to staff sign in.
- The staff app shell or session check.
- Any other audience's screens ([partner](../partner/), back office).

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/portal
pnpm --filter @ssdashboard/web test:e2e -- e2e/audiences.spec.ts
```

## Governing spec

- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
