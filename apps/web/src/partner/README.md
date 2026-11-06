# Partner area

A placeholder page at `/en/partner` and `/ar/partner` for consignment partners, and their own account at `/en/partner/account` and `/ar/partner/account` (the shared [account](../account/) screen on `/api/partner/me`, which spec 0008 builds; until then it shows an inline error). Both pages have no staff shell and no session check yet, and are server components: their text is rendered on the server in the URL's language (spec 0004, AC-16), inside the `PartnerFrame` (spec 0003, AC-18) with the neutral primary, the install's fallback name, and a navigation of the pages that exist (home and My account; statements, stock at your location and settlement join when they ship), and a plain link to the other language in the frame's actions slot. The frame's `title` is the page's one `h1`, so the account screen is drawn with `inFrame` and adds none of its own. `/partner` redirects to the right language in the proxy.

## Owns

- The pages: [partner-page.tsx](partner-page.tsx), [partner-account-page.tsx](partner-account-page.tsx) with [partner-account-strings.tsx](partner-account-strings.tsx) (hands the account and sign in Arabic groups to the frame, which carries only the partner groups)
- The route: `src/app/(partner)/[lang]/partner/page.tsx` and its root layout `src/app/(partner)/[lang]/layout.tsx`

## Never touches

- Staff routes or staff data. The partner audience must not call staff api routes.
- The staff app shell.
- Any other audience's screens ([portal](../portal/), back office).

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/partner
pnpm --filter @ssdashboard/web test:e2e -- e2e/audiences.spec.ts e2e/partner-account.spec.ts
```

## Governing spec

- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
