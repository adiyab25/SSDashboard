# apps/api/src/auth

## Overview

Staff sign in for the api: Better Auth wired into NestJS, a global session guard, lockout and rate limits kept in PostgreSQL, two factor, and the break glass commands. Governed by [spec 0005](../../../../docs/specs/0005-staff-sign-in/index.md). The run book for operators is [docs/runbooks/staff-sign-in.md](../../../../docs/runbooks/staff-sign-in.md).

## Key files

| File | Owns |
|---|---|
| `auth.factory.ts`, `mount-auth.ts` | Builds Better Auth and mounts it at `/api/auth` |
| `session.guard.ts`, `public.decorator.ts` | The global guard. Every `/api` route needs a session unless marked `@Public()` |
| `roles.guard.ts`, `roles.decorator.ts` | Admin only routes |
| `current-staff.ts` | Reads the signed in user from the request. Ledger routes take the poster from here |
| `session-policy.ts`, `sign-in-lockout.ts` | 12 hour sliding session with a 7 day cap, five strikes lockout |
| `auth-hooks.ts` | Origin check, forced password change, lockout counting |
| `first-admin.ts`, `reset-admin.ts` | The logic behind `create-admin` and `create-admin --reset-password` |
| `auth-cleanup.job.ts` | Nightly worker job that deletes expired sessions, tokens and counters |
| `locks.ts` | The advisory lock that protects the last admin rule |

## Commands

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --email <email> --name <name>
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-password --email <email>
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-two-factor --email <email>   # add --reset-password to do both in one transaction
```

`create-admin` prints a live temporary password to stdout. Never capture or log that output.

## Conventions

- Add a route that should be open to the public with `@Public()`. Without it the guard answers 401.
- A route that posts to the ledger validates with `PostingRequest` or `ReverseRequest` from `@ssdashboard/contracts`, never `PostingInput`, and sets `postedBy` from `current-staff.ts`. `src/inventory/controller-contracts.spec.ts` fails if a controller imports the service schemas.
- Sign in failures give identical answers for unknown emails, wrong passwords and locked accounts, so the api never reveals which accounts exist.
- Take `ADMIN_RULE_LOCK` (`locks.ts`) before any change that could remove the last active admin.
- Cron settings (`AUTH_CLEANUP_CRON`, `LEDGER_RECONCILE_CRON`) are checked at startup in `src/config/env.ts`; a bad value stops the process.

## Gotchas

- Better Auth encrypts two factor secrets and backup codes with `BETTER_AUTH_SECRET`. Changing that secret makes every enrolled authenticator unusable.
- The `X-Forwarded-For` header is trusted only because `caddy` is the one service that publishes ports in `deploy/compose.yaml`. `test/compose-ports.spec.ts` guards that.
- Better Auth keeps pending two factor challenges as `verifications` rows with an identifier starting `2fa-`. Any reset that must end a half finished sign in has to delete them too.

## Related specs

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)

_Drafted by /sync from the introducing change, worth a quick human pass._
