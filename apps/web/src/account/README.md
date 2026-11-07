# My account

One account screen for both audiences: the signed in person's own profile, password, and two factor. Staff open it at `/account`; a partner user at `/en/partner/account` or `/ar/partner/account`, inside the `PartnerFrame` (`AccountPage` takes `audience`, which picks `/api/me` or `/api/partner/me`, and `inFrame`, which leaves the one `h1` to the frame's title; a partner user sees no role or staff code). When the person cannot be loaded (the call fails, or `/api/partner/me` does not exist yet), the page shows an inline error with a Try again button (it asks `useMeState` again with a higher `attempt`) instead of loading forever; the way back is the frame's navigation.

## Owns

- The page: [account-page.tsx](account-page.tsx), routed from `src/app/(backoffice)/account/page.tsx` and, for partners, from `src/app/(partner)/[lang]/partner/account/page.tsx` through [partner](../partner/)
- Sections: [profile-section.tsx](profile-section.tsx), [password-section.tsx](password-section.tsx), [two-factor-section.tsx](two-factor-section.tsx)

## Never touches

- Other staff members' accounts. That is the [staff](../staff/) screen.
- Hard coded UI text. Every string goes through `t()` with keys in `packages/i18n/src/locales`.
- Business logic. The api decides every rule.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/account
pnpm --filter @ssdashboard/web test:e2e -- e2e/account.spec.ts e2e/partner-account.spec.ts
```

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)
- [0004 Localization](../../../../docs/specs/0004-localization/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
