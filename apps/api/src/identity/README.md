# Identity

Who may use the back office and the partner pages: sign in for staff and partner users (Better Auth inside NestJS at `/api/auth`, a global audience aware session guard, lockout and rate limits in PostgreSQL, optional two factor, the `create-admin` break glass commands, the signed in person's own profile at `/api/me`), which audiences a person may use and how their sessions follow hat changes, and the admin managed staff accounts at `/api/staff`. One `IdentityModule` ([identity.module.ts](identity.module.ts)); the sign in parts live in [sign-in/](sign-in/), the audience and session parts in [sessions/](sessions/), and the staff administration parts in [staff/](staff/).

Agent gotchas and the full file table: [AGENTS.md](AGENTS.md).

## Owns

- The auth tables `users`, `sessions`, `accounts`, `verifications`, `two_factors`, `rate_limits`, `sign_in_attempts`, `sign_in_slots` (defined in [packages/db](../../../../packages/db/src/schema/auth.ts)) and the access tables `hat_assignments` and `permission_grants` (spec 0008, defined in [identity.ts](../../../../packages/db/src/schema/identity.ts)), all owned by `identity` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts). Only this module reads or writes them. `users.role` belongs to Better Auth's admin plugin: it is always `user` and nothing reads it.
- What a person may do, read on every request: `AccessLoader` reads their hats, extra grants and partner account into platform's `Access`, which the session guard puts on `request.access` for platform's `PermissionGuard` (spec 0008): [access/access-loader.ts](access/access-loader.ts)
- Better Auth setup and mounting, the staff cookie contract (host only, `Path` from `STAFF_BASE_PATH`) and the portal host refusal: [sign-in/auth.factory.ts](sign-in/auth.factory.ts), [sign-in/mount-auth.ts](sign-in/mount-auth.ts), [sign-in/portal-host.ts](sign-in/portal-host.ts)
- The session guard, audience aware (staff and partner sessions; portal, hook and public routes never read the cookie), which also loads the person's `Access`; the three global guards run session, audience, permission in that order: [sign-in/session.guard.ts](sign-in/session.guard.ts), registered in [identity.module.ts](identity.module.ts)
- Which audiences a person may use and where they land (`home`): the `SessionAudiences` port and its hat based implementation `HatSessionAudiences` (`partner` for the partner hat, `staff` for any other, none for no hat; the pure rule is `audiencesOfHats`), [sessions/session-audiences.ts](sessions/session-audiences.ts)
- What a hat change does to sessions: `revokeSessions(userId, tx)` and the AC-33 (b) rule, [sessions/revoke-sessions.ts](sessions/revoke-sessions.ts); the hat change log line, [sessions/hat-change-log.ts](sessions/hat-change-log.ts)
- Session length and lockout rules: [sign-in/session-policy.ts](sign-in/session-policy.ts), [sign-in/sign-in-lockout.ts](sign-in/sign-in-lockout.ts)
- Sign in hooks (origin check, forced password change, taking and giving back a sign in slot, lockout counting): [sign-in/auth-hooks.ts](sign-in/auth-hooks.ts)
- The signed in person's profile route `GET` and `PATCH /api/me`: [sign-in/me.controller.ts](sign-in/me.controller.ts), [sign-in/profile.service.ts](sign-in/profile.service.ts)
- The `create-admin` logic (the first person wears `manager` with the `cost.view` grant; the resets refuse anyone without `manager`): [sign-in/first-admin.ts](sign-in/first-admin.ts), [sign-in/reset-admin.ts](sign-in/reset-admin.ts), [sign-in/create-admin-args.ts](sign-in/create-admin-args.ts)
- The nightly cleanup of expired sessions, tokens, counters and stale sign in slots: [sign-in/auth-cleanup.job.ts](sign-in/auth-cleanup.job.ts)
- Sign in and reset mail callbacks: [sign-in/auth-mail.service.ts](sign-in/auth-mail.service.ts)
- Staff administration under `/api/staff` (`people.manage`), staff audience and staff people only (a partner user is never listed, found, counted as a manager or made one). Until spec 0008 milestone 2 its `role` field is a preset (`StaffAccessPreset`) the service turns into hats with the AC-16 mapping, and the last admin rule counts active managers: [staff/staff.controller.ts](staff/staff.controller.ts), [staff/staff.service.ts](staff/staff.service.ts)
- What other modules may import, the public surface. `IDENTITY_PUBLIC_FILES` in [src/module-boundary.spec.ts](../module-boundary.spec.ts) holds this list, and its import wall fails any other import of a file inside `identity/` from another module (spec 0005, AC-27). `IdentityModule` has no Nest `exports`; the app entry points and `apps/api/test` sit outside the wall.
  - the module itself, for the app root: [identity.module.ts](identity.module.ts)
  - the current user reader, the request type ledger routes take `postedBy` from: [sign-in/current-staff.ts](sign-in/current-staff.ts)
  - `StaffDirectoryModule`, read only display names for "posted by": [staff/staff-directory.ts](staff/staff-directory.ts)
  - `MailRecipientsModule`, the recipient and token row a queued email needs (never log what it returns): [sign-in/mail-recipients.ts](sign-in/mail-recipients.ts)
  - the route decorator `@Public()`: [sign-in/public.decorator.ts](sign-in/public.decorator.ts). Route permissions (`@Permission(...)`, `@AnyHat()`, `@CurrentAccess()`) live in platform, [../platform/access/](../platform/access/), so no module imports identity for them.

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

End to end specs in `apps/api/test` (all `*.e2e-spec.ts`, they need Postgres and a build): `access` (the warehouse and manager thread of spec 0008), `sign-in`, `sign-in-policy`, `two-factor`, `password-reset`, `profile`, `staff`, `staff-cookie`, `create-admin-reset`, `create-admin-two-factor`, `auth-cleanup`, `auth-error-log`, `auth-tenant`, and `session-audiences` (runs the api in process with the real `HatSessionAudiences` wrapped to count its calls, on real hat rows: partner users, `home`, and sessions following hat changes). The guard's audience rules over real HTTP, with test only controllers, are `sign-in/session-guard-routes.spec.ts`. The table wall and the identity import wall are `src/module-boundary.spec.ts`.

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md), including the amendment of 2026-11-05 (AC-27 to AC-35)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md) (milestone 1: the hat tables, `Access` on every request, `HatSessionAudiences`, `create-admin` as a manager)
- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md) (audiences, the module map)
- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md) (A5, the module wall)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
