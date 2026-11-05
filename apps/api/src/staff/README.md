# Staff accounts

Admin management of staff: list, invite, edit, disable and enable, reset password, resend invite, reset two factor, and revoke sessions.

## Owns

- Routes under `/api/staff`, staff audience: [staff.controller.ts](staff.controller.ts)
- The account rules: [staff.service.ts](staff.service.ts)
- A read only name lookup for other modules, such as "posted by": [staff-directory.ts](staff-directory.ts)
- Wiring: [staff.module.ts](staff.module.ts)

## Never touches

- Better Auth internals or the auth tables outside the auth rules. Anything that could remove the last active admin takes the lock from [../auth/locks.ts](../auth/locks.ts).
- The ledger or any stock table.
- Writes from `StaffDirectory`. It only reads names, so the worker can load it without the auth and mail dependencies.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/staff
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api test:e2e -- test/staff.e2e-spec.ts
```

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
