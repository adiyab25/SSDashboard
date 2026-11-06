# Identity

Who may use the back office: staff sign in (Better Auth inside NestJS at `/api/auth`, a global session guard, lockout and rate limits in PostgreSQL, optional two factor, the `create-admin` break glass commands, the signed in person's own profile at `/api/me`) and the admin managed staff accounts at `/api/staff`. One `IdentityModule` ([identity.module.ts](identity.module.ts)); the sign in parts live in [sign-in/](sign-in/) and the staff administration parts in [staff/](staff/).

Agent gotchas and the full file table: [AGENTS.md](AGENTS.md).

## Owns

- The auth tables `users`, `sessions`, `accounts`, `verifications`, `two_factors`, `rate_limits`, `sign_in_attempts`, `sign_in_slots` (defined in [packages/db](../../../../packages/db/src/schema/auth.ts), owned by `identity` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts)). Only this module reads or writes them.
- Better Auth setup and mounting, the staff cookie contract (host only, `Path` from `STAFF_BASE_PATH`) and the portal host refusal: [sign-in/auth.factory.ts](sign-in/auth.factory.ts), [sign-in/mount-auth.ts](sign-in/mount-auth.ts), [sign-in/portal-host.ts](sign-in/portal-host.ts)
- The session guard and the admin only guard: [sign-in/session.guard.ts](sign-in/session.guard.ts), [sign-in/roles.guard.ts](sign-in/roles.guard.ts)
- Session length and lockout rules: [sign-in/session-policy.ts](sign-in/session-policy.ts), [sign-in/sign-in-lockout.ts](sign-in/sign-in-lockout.ts)
- Sign in hooks (origin check, forced password change, taking and giving back a sign in slot, lockout counting): [sign-in/auth-hooks.ts](sign-in/auth-hooks.ts)
- The signed in person's profile route `GET` and `PATCH /api/me`: [sign-in/me.controller.ts](sign-in/me.controller.ts), [sign-in/profile.service.ts](sign-in/profile.service.ts)
- The `create-admin` logic: [sign-in/first-admin.ts](sign-in/first-admin.ts), [sign-in/reset-admin.ts](sign-in/reset-admin.ts), [sign-in/create-admin-args.ts](sign-in/create-admin-args.ts)
- The nightly cleanup of expired sessions, tokens, counters and stale sign in slots: [sign-in/auth-cleanup.job.ts](sign-in/auth-cleanup.job.ts)
- Sign in and reset mail callbacks: [sign-in/auth-mail.service.ts](sign-in/auth-mail.service.ts)
- Staff administration under `/api/staff`, staff audience: [staff/staff.controller.ts](staff/staff.controller.ts), [staff/staff.service.ts](staff/staff.service.ts)
- What other modules may import, the public surface. `IDENTITY_PUBLIC_FILES` in [src/module-boundary.spec.ts](../module-boundary.spec.ts) holds this list, and its import wall fails any other import of a file inside `identity/` from another module (spec 0005, AC-27). `IdentityModule` has no Nest `exports`; the app entry points and `apps/api/test` sit outside the wall.
  - the module itself, for the app root: [identity.module.ts](identity.module.ts)
  - the current user reader, the request type ledger routes take `postedBy` from: [sign-in/current-staff.ts](sign-in/current-staff.ts)
  - `StaffDirectoryModule`, read only display names for "posted by": [staff/staff-directory.ts](staff/staff-directory.ts)
  - `MailRecipientsModule`, the recipient and token row a queued email needs (never log what it returns): [sign-in/mail-recipients.ts](sign-in/mail-recipients.ts)
  - the route decorators `@Public()` and `@Roles(...)`: [sign-in/public.decorator.ts](sign-in/public.decorator.ts), [sign-in/roles.decorator.ts](sign-in/roles.decorator.ts)

## Never touches

- Ledger tables or the ledger service. This module does not post stock.
- Other modules' tables.
- Account details in error answers. Sign in failures answer the same for unknown emails, wrong passwords and locked accounts.
- `process.env`. Config comes in through the `ENV` token.
- Writes from `StaffDirectory` or `MailRecipients`. They only read, so the worker can load them without Better Auth, the guards or the mail producer.
- The portal origin as a trusted origin, and a `Domain` on any cookie.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/identity
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/sign-in.e2e-spec.ts
```

End to end specs in `apps/api/test` (all `*.e2e-spec.ts`, they need Postgres and a build): `sign-in`, `sign-in-policy`, `two-factor`, `password-reset`, `profile`, `staff`, `staff-cookie`, `create-admin-reset`, `create-admin-two-factor`, `auth-cleanup`, `auth-error-log`, `auth-tenant`. The table wall and the identity import wall are `src/module-boundary.spec.ts`.

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md), including the amendment of 2026-11-05 (AC-27 to AC-35)
- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md) (audiences, the module map)
- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md) (A5, the module wall)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
