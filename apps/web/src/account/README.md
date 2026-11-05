# My account

The signed in staff member's own page at `/account`: profile, password, and two factor.

## Owns

- The page: [account-page.tsx](account-page.tsx), routed from `src/app/(backoffice)/account/page.tsx`
- Sections: [profile-section.tsx](profile-section.tsx), [password-section.tsx](password-section.tsx), [two-factor-section.tsx](two-factor-section.tsx)

## Never touches

- Other staff members' accounts. That is the [staff](../staff/) screen.
- Hard coded UI text. Every string goes through `t()` with keys in `packages/i18n/src/locales`.
- Business logic. The api decides every rule.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/account
pnpm --filter @ssdashboard/web test:e2e -- e2e/account.spec.ts
```

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)
- [0004 Localization](../../../../docs/specs/0004-localization/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
