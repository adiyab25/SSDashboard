# Partner area

A placeholder page at `/en/partner` and `/ar/partner` for consignment partners. It uses a minimal frame with no staff shell and no session check yet. The page is a server component: its text is rendered on the server in the URL's language (spec 0004, AC-16), inside the `PartnerFrame` (spec 0003, AC-18) with the neutral primary, the install's fallback name, and a navigation of only the pages that exist (the home page; statements, stock at your location and settlement join when they ship), and a plain link to the other language in the frame's actions slot. `/partner` redirects to the right language in the proxy.

## Owns

- The page: [partner-page.tsx](partner-page.tsx)
- The route: `src/app/(partner)/[lang]/partner/page.tsx` and its root layout `src/app/(partner)/[lang]/layout.tsx`

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
