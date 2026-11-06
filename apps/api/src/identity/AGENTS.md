# apps/api/src/identity

## Overview

The identity module: staff sign in for the api (Better Auth wired into NestJS, a global session guard, lockout and rate limits kept in PostgreSQL, two factor, the break glass commands) in `sign-in/`, and admin managed staff accounts in `staff/`, wired by one `IdentityModule` (`identity.module.ts`). Governed by [spec 0005](../../../../docs/specs/0005-staff-sign-in/index.md). The run book for operators is [docs/runbooks/staff-sign-in.md](../../../../docs/runbooks/staff-sign-in.md). What it owns and never touches: [README.md](README.md).

## Key files

| File | Owns |
|---|---|
| `identity.module.ts` | The one module: controllers, providers, the three global guards, and the only exports (`StaffDirectoryModule`, `MailRecipientsModule`) |
| `sign-in/auth.factory.ts`, `sign-in/mount-auth.ts` | Builds Better Auth and mounts it at `/api/auth`; the cookie contract (no `Domain`, `Path` from `STAFF_BASE_PATH`) and the portal host 404 |
| `sign-in/portal-host.ts` | Whether a request carries the `PORTAL_ORIGIN` host (`X-Forwarded-Host` or `Host`) |
| `sign-in/session.guard.ts`, `sign-in/public.decorator.ts` | The global guard. Every `/api` route needs a staff session unless its controller is `@Audience('public')` |
| `../platform/audience/` | `@Audience(...)` and the deny by default `AudienceGuard`; `audience.spec.ts` fails the build for a controller without exactly one |
| `sign-in/roles.guard.ts`, `sign-in/roles.decorator.ts` | Admin only routes |
| `sign-in/current-staff.ts` | Reads the signed in user from the request. Ledger routes take the poster from here |
| `sign-in/session-policy.ts`, `sign-in/sign-in-lockout.ts` | 12 hour sliding session with a 7 day cap, five strikes lockout |
| `sign-in/auth-hooks.ts` | Origin check, forced password change, lockout counting |
| `sign-in/first-admin.ts`, `sign-in/reset-admin.ts` | The logic behind `create-admin` and `create-admin --reset-password` |
| `sign-in/auth-cleanup.job.ts` | Nightly worker job that deletes expired sessions, tokens and counters |
| `sign-in/mail-recipients.ts` | `MailRecipients`: the recipient and token row the mail worker reads at send time |
| `sign-in/locks.ts` | The advisory lock that protects the last admin rule |
| `staff/staff.service.ts`, `staff/staff.controller.ts` | `/api/staff`: invite, edit, disable, reset, revoke |
| `staff/staff-directory.ts` | `StaffDirectory`: read only names for other modules |

## Commands

```bash
docker compose --env-file .env run --rm api node dist/create-admin.js --email <email> --name <name>
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-password --email <email>
docker compose --env-file .env run --rm api node dist/create-admin.js --reset-two-factor --email <email>   # add --reset-password to do both in one transaction
```

`create-admin` prints a live temporary password to stdout. Never capture or log that output.

## Conventions

- Other modules use identity only through `StaffDirectory`, `MailRecipients`, the `AuthenticatedRequest` type in `sign-in/current-staff.ts`, and the `@Public()` and `@Roles(...)` decorators. Never export the Better Auth instance, `SignInLockout` or `AuthAudit`; the auth tables are written only from here (`src/module-boundary.spec.ts` fails on any other module naming them).
- `StaffDirectory` and `MailRecipients` sit in their own small modules because the worker loads them: they must never depend on Better Auth, the guards or the mail producer.
- Every controller needs exactly one `@Audience(...)` on the class (`src/platform/audience/`); a spec fails the build without it, with two, on a handler, or with a path prefix that does not match (`partner`, `portal`, `hooks`). Open routes use `@Audience('public')` plus a class level `@Public()` (the spec keeps them equal). A staff session on a non staff audience gets 403 `WRONG_AUDIENCE`.
- `SessionGuard` still demands a staff session on every non public audience. Partner, portal and hook routes need `SessionGuard` made audience aware first (staff and partner sessions, a portal sealed token, a hook signature with no Origin check). Never use `@Public()` to get around it.
- A route that posts to the ledger validates with `PostingRequest` or `ReverseRequest` from `@ssdashboard/contracts`, never `PostingInput`, and sets `postedBy` from `sign-in/current-staff.ts`. `src/inventory/controller-contracts.spec.ts` fails if a controller imports the service schemas.
- Sign in failures give identical answers for unknown emails, wrong passwords and locked accounts, so the api never reveals which accounts exist.
- Take `ADMIN_RULE_LOCK` (`sign-in/locks.ts`) before any change that could remove the last active admin.
- One staff origin (`PUBLIC_URL` today, `STAFF_ORIGIN` after spec 0007's rename) is the Better Auth base URL, the only trusted origin, the Origin check, the `Secure` flag and the base of email links. Email links are that origin plus `STAFF_BASE_PATH` plus the route (`src/mail/mail.worker.ts`). Never add `PORTAL_ORIGIN` to the trusted origins.
- Cron settings (`AUTH_CLEANUP_CRON`, `LEDGER_RECONCILE_CRON`), `STAFF_BASE_PATH` and `PORTAL_ORIGIN` are checked at startup in `src/config/env.ts`; a bad value stops the process.

## Gotchas

- Better Auth encrypts two factor secrets and backup codes with `BETTER_AUTH_SECRET`. Changing that secret makes every enrolled authenticator unusable.
- The `X-Forwarded-For` header is trusted only because `caddy` is the one service that publishes ports in `deploy/compose.yaml`. `test/compose-ports.spec.ts` guards that.
- Better Auth keeps pending two factor challenges as `verifications` rows with an identifier starting `2fa-`. Any reset that must end a half finished sign in has to delete them too.
- Cookie `Path` comes from `advanced.defaultCookieAttributes.path`, which Better Auth 1.7.15 merges over its own `path: "/"` for every cookie it creates, the clearing on sign out included (`dist/cookies/index.mjs`). A per cookie `advanced.cookies.<name>.attributes` would override it, so never set one. `test/staff-cookie.e2e-spec.ts` proves the path and the missing `Domain`.
- `deploy/Caddyfile` sets only `X-Forwarded-For` on the way to the api; it does not set `X-Forwarded-Host` itself, and today it serves one site, so there is no portal host yet. The portal check reads both `X-Forwarded-Host` and `Host`, and only refuses. Recheck it when feature 26 adds the portal site block.

## Related specs

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)

_Drafted by /sync from the introducing change, worth a quick human pass._
