# Staff sign in

Staff sign in for the api. Better Auth runs inside NestJS at `/api/auth`, a global session guard protects the routes, and lockout and rate limits live in PostgreSQL. It also holds the `create-admin` break glass commands and the signed in user's own profile route (`/api/me`).

Agent gotchas and the full file table: [AGENTS.md](AGENTS.md).

## Owns

- Better Auth setup and mounting: [auth.factory.ts](auth.factory.ts), [mount-auth.ts](mount-auth.ts)
- The session guard and the admin only guard: [session.guard.ts](session.guard.ts), [roles.guard.ts](roles.guard.ts)
- Session length and lockout rules: [session-policy.ts](session-policy.ts), [sign-in-lockout.ts](sign-in-lockout.ts)
- Sign in hooks (origin check, forced password change, lockout counting): [auth-hooks.ts](auth-hooks.ts)
- The signed in user's profile route `GET` and `PATCH /api/me`: [me.controller.ts](me.controller.ts), [profile.service.ts](profile.service.ts)
- The `create-admin` logic: [first-admin.ts](first-admin.ts), [reset-admin.ts](reset-admin.ts), [create-admin-args.ts](create-admin-args.ts)
- The nightly cleanup of expired sessions, tokens and counters: [auth-cleanup.job.ts](auth-cleanup.job.ts)
- Sign in and reset mail: [auth-mail.service.ts](auth-mail.service.ts)
- The auth tables are defined in [packages/db](../../../../packages/db/src/schema/auth.ts) and used only from here and from [staff](../staff/).

## Never touches

- Ledger tables or the ledger service. Other modules read the signed in user through [current-staff.ts](current-staff.ts); this module does not post stock.
- Other modules' tables.
- Account details in error answers. Sign in failures answer the same for unknown emails, wrong passwords and locked accounts.
- `process.env`. Config comes in through the `ENV` token.

## How to test

```bash
pnpm --filter @ssdashboard/api test -- src/auth
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api test:e2e -- test/sign-in.e2e-spec.ts
```

End to end specs in `apps/api/test`: `sign-in`, `sign-in-policy`, `two-factor`, `password-reset`, `profile`, `create-admin-reset`, `create-admin-two-factor`, `auth-cleanup`, `auth-error-log` (all `*.e2e-spec.ts`). They need Postgres.

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)
- [0007 Stack and architecture for the operations layer](../../../../docs/specs/0007-stack-architecture-operations-layer/index.md) (audiences)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
