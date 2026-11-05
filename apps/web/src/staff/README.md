# Staff screens

The admin page at `/staff` to list, invite, edit, disable and reset staff accounts.

## Owns

- The page: [staff-page.tsx](staff-page.tsx)
- Dialogs: [staff-form-dialog.tsx](staff-form-dialog.tsx), [staff-confirm-dialog.tsx](staff-confirm-dialog.tsx), [staff-setup-dialog.tsx](staff-setup-dialog.tsx)
- Calls to the api: [staff-api.ts](staff-api.ts)
- The route: `src/app/(backoffice)/staff/page.tsx`

## Never touches

- The signed in user's own profile. That is [account](../account/).
- Account rules such as the last admin rule. The api enforces them.
- Hard coded text. Use `t()`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/staff
pnpm --filter @ssdashboard/web test:e2e -- e2e/staff.spec.ts
```

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
