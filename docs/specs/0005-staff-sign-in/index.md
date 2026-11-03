# 0005. Staff sign in with Better Auth: email and password, admin managed accounts, optional two factor

**Date**: 2026-11-03
**Status**: In Progress

## Summary

Staff sign in with an email and password. Sessions last up to 12 hours of inactivity and 7 days in total. An admin creates, edits and disables staff accounts, and a person can reset a forgotten password by email, or through an admin when the install has no mail. Two factor sign in with an authenticator app is optional for everyone. Every `/api` route then runs as a known user, which also fills the `posted_by` column on the stock ledger. The work is built as thin end to end slices, starting with plain sign in and sign out.

## Requirements

**User stories**:
- As a staff member, I want to sign in with my email and password and stay signed in through my shift, so I can work without interruptions.
- As a staff member who forgot a password, I want to reset it myself, or get an admin to reset it when there is no mail, so I am never stuck.
- As an admin, I want to invite staff, change their details and role, and disable a leaver at once, so only current staff can reach stock and cost data.
- As an owner, I want every stock movement tied to a real person and a lost password never to lock the whole company out.
- As a security conscious staff member, I want to add an authenticator app code to my sign in.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: Signing in with a correct email (any letter case) and password creates a session. The cookie is host only, `HttpOnly`, `SameSite=Lax`, and `Secure` when `PUBLIC_URL` is https. The browser lands on the `returnTo` path when it is a relative path on this site, otherwise on `/`. `users.last_sign_in_at` is set. The user menu shows the person's name, email and role.
- **AC-2**: A wrong password, an unknown email, and a locked account all return the same 401 `INVALID_EMAIL_OR_PASSWORD` answer with the same message and shape. A disabled account that supplies the correct password gets 403 `BANNED_USER` with a clear "account disabled, ask an administrator" message and no session. A disabled account with a wrong password gets the generic answer. A correct password on a disabled account counts as neither a failure nor a reset of the lockout counter, and is logged as `SignInFailed` with reason `disabled`.
- **AC-3**: Five failed attempts within a fixed 10 minute window (started by the first failure) for the same email text (real or unknown) from the same client IP lock that pair for 15 minutes. Separately, 20 failures for that email from any addresses in the window lock the email for 15 minutes, so a spread out attack is slowed without letting one outsider keep a person locked out from a single address. During a lock every attempt, including the correct password, gets the generic answer of AC-2. The counter resets only after a full sign in (a session was issued and no second factor is pending). Counting is one atomic upsert, so concurrent attempts cannot skip a count. Wrong second factor codes (AC-20) and wrong current password answers on change password and two factor disable count toward the same lock; for a code attempt the key comes from the user of the pending sign in, and reaching a lock ends that pending sign in.
- **AC-4**: Public auth routes are rate limited per client IP, with counters stored in PostgreSQL so a restart does not reset them. Rate limiting is switched on in every environment (Better Auth turns it off outside production unless told otherwise). Going over a limit returns 429 with the `X-Retry-After` header. The limits are: 30 sign in attempts per minute (a shared warehouse network must survive a shift change), 3 reset requests per 15 minutes, 5 reset completions per 15 minutes, 15 second factor code attempts per 10 minutes (the per account lock of AC-3 is the tighter control).
- **AC-5**: A session expires after 12 hours without use (each use renews it, at most once an hour) and never lives longer than 7 days from sign in. Disabling cookie caching means a revoked or disabled session fails on the very next request. A request that carries a session cookie with no live session behind it (expired, signed out, disabled or revoked) returns 401 `SESSION_EXPIRED`, and a request with no cookie returns 401 `UNAUTHENTICATED`. In both cases the web app sends the person to sign in with `returnTo` set to the page they were on. Browser calls to `/api` renew the session cookie, and a test proves that a person who only loads pages is not signed out while their session row is still live.
- **AC-6**: Signing out ends only that session, clears the cookie, and sends the person to `/sign-in`. The old cookie value then fails with 401 `SESSION_EXPIRED`.
- **AC-7**: Every `/api` route except `/api/config`, `/api/health` and the allowed `/api/auth/*` routes returns 401 `UNAUTHENTICATED` without a valid session, including `GET /api/locations`. Web pages inside the shell redirect to `/sign-in?returnTo=<path>`. `returnTo` is accepted only when it starts with a single `/` (not `//` or `/\`), resolves to the `PUBLIC_URL` origin, and is not one of the `(auth)` paths; otherwise `/` is used (so `//evil.example` and full URLs are ignored). The path travels through the two factor and forced change steps. Next.js middleware passes the current path to the shell layout, because layouts cannot read it. Every non GET request to our routes must carry an `Origin` that matches `PUBLIC_URL` (CSRF defense beyond `SameSite=Lax`). Better Auth routes do not pass through the NestJS guard, so every Better Auth path not listed in the API surface returns 404 and the ones that remain apply the Origin check, the 7 day cap and the must change rule through a before hook.
- **AC-8**: A password is 8 to 128 characters with at least one lowercase letter, one uppercase letter and one digit. The same rule applies when setting a password from an invite or reset link, changing it, and for admin issued temporary passwords. A weak password returns 422 `WEAK_PASSWORD` with an `unmet` list, thrown by a before hook on `/reset-password` and `/change-password` from the shared Zod schema (Better Auth's own length errors never reach the browser). A wrong current password returns 400 `INVALID_PASSWORD`. The forms show the rules before submit, allow paste, and use the right `autocomplete` values so password managers work.
- **AC-9**: With mail on, requesting a reset for any email shows the same neutral confirmation, and the response is padded to at least 500 ms whether or not the account exists, so timing reveals nothing. For an existing account that is not disabled (including one still `invited`) one email is queued with a link valid for 1 hour and usable once; issuing it deletes that person's older reset and invite tokens. Setting the new password revokes all that person's sessions, clears any lockout, sets the email verified and clears the must change flag (all in Better Auth's `onPasswordReset` callback), and the person then signs in normally. The email link goes to Better Auth's token check, which redirects to the reset page with `?error=INVALID_TOKEN` when the token is used or expired, so the "link no longer valid" screen, with a way to request a new one, appears before the person types. A disabled account receives no email.
- **AC-10**: With mail off (`MAIL_DRIVER=none`), `GET /api/config` reports `mailEnabled: false`, the forgot password page tells the person to ask an administrator, and no email is attempted anywhere.
- **AC-11**: Emails are sent by the worker from a pg-boss queue. The job holds only `{userId, kind, tokenId}`; the worker reads the token from `verifications` when it sends, so no link sits in the queue. It tries up to 5 times (`retryLimit` 4, growing delays) with the whole retry span under 1 hour, so a reset email never arrives already expired, and the pg-boss major version is pinned. Each email is in the recipient's saved language (else the install's default language), through SMTP or Postmark according to `MAIL_DRIVER`. A send failure never fails the original request. A final failure is logged with the job id and never with the link.
- **AC-12**: An admin creates a staff account with name, email and role (`admin` or `staff`), and optionally phone, staff code and language (field rules are under Key invariants). With mail on, an invite email carries a link valid for 7 days. With mail off, the response shows a temporary password once and sets the must change flag. The account shows as `invited` until the first sign in. A duplicate email returns 409 `EMAIL_TAKEN` and a duplicate staff code returns 409 `STAFF_CODE_TAKEN`.
- **AC-13**: Opening an invite link shows a set password page. Setting a password marks the email verified and clears the must change flag, and the person then signs in. An expired invite can be resent by an admin with mail on, or replaced by an admin password reset with mail off.
- **AC-14**: While the must change flag is true, only `GET /api/me`, change password and sign out work. Every other route returns 403 `PASSWORD_CHANGE_REQUIRED` and the web app opens the change password page. Changing the password clears the flag and revokes the person's other sessions.
- **AC-15**: Only admins can use `/api/staff`; anyone else gets 403 `FORBIDDEN`. Admins can list staff (search by name, email or staff code as an escaped contains match, staff code also as a prefix; filter by status `invited`, `active`, `disabled`; keyset paging sorted by `lower(name), id`, default 50 and at most 100 per page) and edit name, phone, staff code, language and role. Email can be edited only while the account is `invited`, otherwise 409 `EMAIL_LOCKED`. `GET /api/staff/:id` also returns phone, staff code, language, disable reason and created date for the edit form. The routes `/api/auth/admin/*`, `/api/auth/sign-up/*`, `/api/auth/update-user` and `/api/auth/change-email` return 404, and so does every other Better Auth route not listed in the API surface.
- **AC-16**: Disabling an account sets it disabled, deletes all its sessions in the same transaction (its next request is 401), keeps every row and ledger reference, deletes the person's unredeemed reset and invite tokens, and stores the reason in `ban_reason` (shown on the staff detail). Enabling clears the reason and lets the person sign in again. The next request with the old cookie returns 401 `SESSION_EXPIRED`. No endpoint deletes a staff account.
- **AC-17**: An active admin is a user with role `admin` who is not disabled (an admin who has not yet signed in counts). The last active admin cannot be disabled or demoted (409 `LAST_ADMIN`) and an admin cannot disable themselves (409 `SELF_DISABLE`). Two admins disabling or demoting each other at the same moment cannot leave zero active admins. `StaffService` and `create-admin` take the same `pg_advisory_xact_lock` key, defined once as a named constant.
- **AC-18**: An admin password reset for someone else sends a reset link when mail is on, or shows a temporary password once when mail is off. Either way the old password stops working at once (the stored hash is replaced by an unusable random value in the same transaction), the person's sessions and older tokens are revoked, their lockout is cleared, and the must change flag is set. An admin can also revoke all of a person's sessions without resetting the password.
- **AC-19**: A signed in person can change their own name, phone and language, and change their password by entering the current one (this revokes their other sessions). They cannot change their own email, role or staff code. Choosing a language in the user menu also saves it to the account, and signing in on another device applies the saved language. After a successful sign in the sign in page calls `GET /api/me` and, when the account has a saved language, sets the `ss_lang` cookie through the same function the language switcher uses; the saved language wins over one chosen on the sign in screen.
- **AC-20**: Any person can turn on two factor: they scan a QR code or type the key into an authenticator app, confirm with a code, and are shown 10 backup codes once (the browser holds the codes Better Auth returns at enable time and shows them only after the code is confirmed). From then on sign in asks for a code after the password. A backup code works once. Turning it off needs the password. An admin can reset another person's two factor, which revokes their sessions. Trusted devices are never honored, and the email code routes (`send-otp`, `verify-otp`) and `get-totp-uri` return 404.
- **AC-21**: The `create-admin` command creates the first admin from an email and name, prints a temporary password once, and sets the must change flag. It refuses when an active admin already exists or when the email already belongs to any account. Its reset mode sets a new temporary password for an existing admin, clears their lockout, and revokes their sessions. The password is written to the terminal only (the run book says not to capture it or send it to a log driver) and never to logs. It hashes with Better Auth's own password hasher and creates the `credential` account row with `account_id` equal to the user id.
- **AC-22**: `created_by` and `posted_by` columns from spec 0002 become nullable foreign keys to `users.id`, added as `NOT VALID`, with any existing value that has no matching user set to null, then validated. Ledger posting takes `postedBy` from the signed in user. A nightly worker job (schedule `AUTH_CLEANUP_CRON`, in the timezone from the `timezone` setting, as the reconcile job reads it) deletes sessions and verifications whose `expires_at` has passed, `sign_in_attempts` rows whose lock has ended and whose window is over, and `rate_limits` rows whose `last_request` (milliseconds) is older than one day.
- **AC-23**: Sign in success, failure and lockout, reset requests and completions, password changes, two factor changes, and every staff admin action write one structured log line with the acting user id, target user id, client IP and user agent, and never a password, token, link or temporary password. The same actions emit past tense domain events, each carrying `actorId`, `targetId`, `ip`, `userAgent`, `at` and, where it applies, `reason`: `SignedIn`, `SignInFailed` (reason `bad_credentials`, `locked` or `disabled`), `AccountLocked`, `PasswordResetRequested`, `PasswordResetCompleted`, `PasswordChanged`, `TwoFactorEnabled`, `TwoFactorDisabled`, `StaffCreated`, `StaffUpdated`, `StaffRoleChanged`, `StaffDisabled`, `StaffEnabled`, `StaffPasswordReset`, `StaffSessionsRevoked`, `StaffTwoFactorReset`. `SignedIn` and the last sign in time are written only when a full session is issued, never after just the password step of a two factor sign in.
- **AC-24**: Every new screen works in English and Arabic (right to left), by keyboard alone, and meets WCAG 2.2 AA, including accessible authentication (no puzzle, memory test, or blocked paste). Errors are announced and focus moves to the first error. The auth screens sit outside the app shell and show the client name, a language switch and the theme choice.
- **AC-25**: The user menu replaces the placeholder with the signed in person's name, email and role, an Account link, and a working Sign out. The Staff page appears in the sidebar and command palette only for admins.

## Decision

**Chosen option**: Option 1: Better Auth with the admin and two factor plugins, wrapped by our own NestJS staff endpoints and database backed hardening.

Staff sign in runs on Better Auth inside the NestJS api, sessions are checked by one global guard, and all staff management goes through our own `/api/staff` endpoints. Lockout, mail, the nightly cleanup and the first admin command are small pieces we add around it.

**Implementation skills**: `better-auth-best-practices` (`better-auth/skills`, `.claude/skills/better-auth-best-practices/`) · `better-auth-security-best-practices` (`better-auth/skills`, `.claude/skills/better-auth-security-best-practices/`) · `email-and-password-best-practices` (`better-auth/skills`, `.claude/skills/email-and-password-best-practices/`) · `two-factor-authentication-best-practices` (`better-auth/skills`, `.claude/skills/two-factor-authentication-best-practices/`) · `create-auth` (`better-auth/skills`, `.claude/skills/create-auth/`) · `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`)

**Decisions settled here** (each: pick, why, runner up)
- Mail path: a mail interface with SMTP and Postmark adapters, sending through a pg-boss queue. Why: retries cover a mail server that is briefly down, and enqueuing takes the same time for known and unknown emails. Runner up: send inside the api request.
- Session check for the web app: Next.js calls `GET /api/me` (not `GET /api/auth/get-session`). Why: our guard enforces the 7 day cap and the must change flag, which Better Auth's route would not. Runner up: Better Auth's route plus a plugin. This refines the sessions paragraph of spec 0001.
- Domain events: `@nestjs/event-emitter` with typed event classes in `apps/api/src/platform/events/`. Why: it is the official, boring option and matches the past tense event rule in `AGENTS.md`. Runner up: a tiny hand written bus.
- Invites: a password setup token written straight into `verifications` with a 7 day life, using Better Auth's own `/reset-password` endpoint to redeem it. Why: no extra table, and one redeem path to test. Runner up: a separate invitations table.
- Staff changes (role, disable, session delete) use our own SQL in one transaction under an advisory lock. Why: the last admin rule must be atomic, and Better Auth's admin calls run on their own connection. Better Auth still owns password hashing, the ban check at sign in, and the extra user columns.
- Email language: the recipient's saved language, else the install's default language, else English.
- Auth screens live in their own `(auth)` route group outside the app shell. This is a documented exception to the "every page renders inside the app shell" rule in `AGENTS.md`.
- Better Auth hooks: Better Auth routes are an allowlist behind one before hook (Origin check, 7 day cap, must change rule). The last sign in time, `SignedIn`, and the lockout reset run in an after hook only when a full session was issued, because Better Auth creates a session after the password step of a two factor sign in and deletes it again.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch** (all in `packages/db`; ids are `uuid` from the same generator as other tables; table names plural snake case, mapped to Better Auth through its `modelName` options)

| Table | Columns | Rules and indexes |
|---|---|---|
| ★ `users` | `id`; `name text not null`; `email text not null`; `email_verified bool not null default false`; `role text not null default 'staff'` (`admin` or `staff`, enforced by a check constraint feature 13 replaces); `banned bool not null default false`; `ban_reason text null`; `ban_expires timestamptz null` (unused, bans are permanent); `two_factor_enabled bool not null default false`; `phone text null`; `staff_code text null`; `language text null`; `must_change_password bool not null default false`; `last_sign_in_at timestamptz null`; `created_at`; `updated_at` | unique index on `lower(email)`; unique partial index on `staff_code` where not null; never hard deleted |
| ★ `sessions` | `id`; `user_id` → users on delete cascade; `token text not null`; `expires_at`; `ip_address text null`; `user_agent text null`; `created_at`; `updated_at` | unique `token`; indexes on `user_id` and `expires_at` |
| ★ `accounts` | `id`; `user_id` → users on delete cascade; `provider_id text` (`credential`); `account_id text`; `password text null` (hash); `created_at`; `updated_at` | unique (`provider_id`, `account_id`); one `credential` row per user; the OAuth columns Better Auth adds stay unused |
| ★ `verifications` | `id`; `identifier text`; `value text`; `expires_at`; `created_at`; `updated_at` | index on `identifier` and `expires_at`; holds reset and invite tokens; single use |
| ★ `two_factors` | `id`; `user_id` → users on delete cascade; `secret text`; `backup_codes text` | unique `user_id`; Better Auth encrypts both fields |
| ★ `rate_limits` | `id`; Better Auth's own `key`, `count`, `last_request` (milliseconds, bigint) | per IP and path counters |
| ★ `sign_in_attempts` | `email_key text`; `scope text` (the client IP, or `*` for the all addresses row); `failures int not null`; `window_started_at`; `locked_until timestamptz null` | primary key (`email_key`, `scope`); keyed by lowercase trimmed email text so unknown emails behave like real ones |

Relationships: `users` 1:N `sessions`; `users` 1:N `accounts` (in practice 1:1); `users` 1:0..1 `two_factors`. Later features' `created_by` / `posted_by` columns become nullable foreign keys to `users.id` (on delete restrict). Staff status is derived, never stored: `disabled` when `banned`, else `invited` when `last_sign_in_at` is null, else `active`.

**State transitions**:
- Staff: `invited` → `active` (first sign in); `invited` or `active` → `disabled` (admin); `disabled` → back to `invited` or `active` by its history (admin enable). A lockout is a temporary condition, not a state.
- Session: created at sign in → used (renewed at most hourly) → expired (idle 12 hours, or 7 days from creation) or revoked (sign out, disable, password change or reset, admin revoke).
- Token (reset or invite): issued → redeemed once, or expired. Issuing a new reset token does not cancel older unexpired ones, but redeeming any password change revokes sessions.

**API surface**

*Better Auth routes under `/api/auth` (used by the web app through the Better Auth client; they keep Better Auth's own error codes)*

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/sign-in/email` | POST | email (req), password (req) | session cookie, or `twoFactorRedirect` | public | 401 `INVALID_EMAIL_OR_PASSWORD`, 403 `BANNED_USER`, 429 |
| `/sign-out` | POST | none | cleared cookie | session | none |
| `/request-password-reset` | POST | email (req) | neutral message | public | 429 |
| `/reset-password` | POST | token (req), newPassword (req) | ok | token | 400 `INVALID_TOKEN`, 422 `WEAK_PASSWORD`, 429 |
| `/change-password` | POST | currentPassword (req), newPassword (req), revokeOtherSessions=true | ok | session (allowed while must change) | 400 wrong current, 422 `WEAK_PASSWORD` |
| `/two-factor/enable` | POST | password (req) | totp URI, backup codes | session | 400 |
| `/two-factor/verify-totp` | POST | code (req) | session | pending sign in or enrolling session | 401, 429 |
| `/two-factor/verify-backup-code` | POST | code (req) | session | pending sign in | 401, 429 |
| `/two-factor/generate-backup-codes` | POST | password (req) | 10 new codes | session | 400 |
| `/two-factor/disable` | POST | password (req) | ok | session | 400 |

Every other Better Auth path is closed with 404 (an allowlist, not a block list), including `/admin/*`, `/sign-up/*`, `/update-user`, `/change-email`, `/get-session`, `/list-sessions`, `/revoke-session*`, `/two-factor/send-otp`, `/two-factor/verify-otp` and `/two-factor/get-totp-uri`. The Better Auth route handler is mounted at `/api/auth` with NestJS's body parser off for that path.

**Error codes in one place**: 401 `UNAUTHENTICATED` (no cookie), 401 `SESSION_EXPIRED` (cookie, no live session), 401 `INVALID_EMAIL_OR_PASSWORD` (sign in, including locked), 401 wrong second factor code (Better Auth's own code), 403 `BANNED_USER`, 403 `PASSWORD_CHANGE_REQUIRED`, 403 `FORBIDDEN`, 400 `INVALID_TOKEN`, 400 `INVALID_PASSWORD` (wrong current password), 422 `WEAK_PASSWORD` (with `unmet`), 409 `EMAIL_TAKEN`, `STAFF_CODE_TAKEN`, `EMAIL_LOCKED`, `LAST_ADMIN`, `SELF_DISABLE`, `NOT_INVITED`, `MAIL_DISABLED`, and 429 on every rate limit.

*Our NestJS routes (Zod contracts in `packages/contracts/src/auth.ts` and `staff.ts`, listed in the OpenAPI document)*

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/me` | GET | none | id, name, email, role, phone, staffCode, language, twoFactorEnabled, mustChangePassword | session (allowed while must change) | 401 `UNAUTHENTICATED`, 401 `SESSION_EXPIRED` |
| `/api/me` | PATCH | name, phone, language (all opt) | updated profile | session | 422 invalid language |
| `/api/staff` | GET | q, status, cursor, limit (opt) | rows (id, name, email, role, status, lastSignInAt, twoFactorEnabled), nextCursor | admin | 403 `FORBIDDEN` |
| `/api/staff` | POST | name, email, role (req); phone, staffCode, language (opt) | staff, setup: `{mode:'email'}` or `{mode:'temporary_password', temporaryPassword}` | admin | 409 `EMAIL_TAKEN`, 409 `STAFF_CODE_TAKEN`, 422 |
| `/api/staff/:id` | GET | none | one staff row with the same fields | admin | 404 |
| `/api/staff/:id` | PATCH | name, phone, staffCode, language, role, email (all opt) | staff | admin | 409 `LAST_ADMIN`, 409 `EMAIL_LOCKED`, 409 `STAFF_CODE_TAKEN`, 409 `EMAIL_TAKEN` |
| `/api/staff/:id/disable` | POST | reason (opt) | staff | admin | 409 `LAST_ADMIN`, 409 `SELF_DISABLE` |
| `/api/staff/:id/enable` | POST | none | staff | admin | 404 |
| `/api/staff/:id/reset-password` | POST | none | setup (as in create) | admin | 404 |
| `/api/staff/:id/resend-invite` | POST | none | ok | admin | 409 `NOT_INVITED`, 409 `MAIL_DISABLED` |
| `/api/staff/:id/revoke-sessions` | POST | none | count revoked | admin | 404 |
| `/api/staff/:id/reset-two-factor` | POST | none | staff | admin | 404 |
| `/api/config` | GET | none | existing fields plus `mailEnabled: boolean` | public | none |

Public routes (no session): `GET /api/config`, `GET /api/health`, and the Better Auth sign in, reset and token routes above. The guard lets a session with the must change flag reach only `GET /api/me`, `/api/auth/change-password`, and `/api/auth/sign-out`.

*Web routes (`apps/web/src/app`)*: `(auth)/sign-in`, `(auth)/forgot-password`, `(auth)/reset-password` (reset and invite, same page with different wording when `invite=1`), `(auth)/two-factor`, `(auth)/change-password` (forced change); inside the shell: `account` (profile, password, two factor) and `staff` (list with create, edit and row actions). Next.js checks the session in the shell layout by calling `GET /api/me` over `API_INTERNAL_URL` with the cookie forwarded. A client side fetch wrapper turns any 401 from `/api` into a redirect to sign in.

*Commands*: `node dist/create-admin.js --email <e> --name <n>` and `node dist/create-admin.js --reset-password --email <e>`, a fourth entry point of the `app` image (`apps/api/src/create-admin.ts`).

**Value sourcing**

| Action | Value produced / displayed | Source |
|---|---|---|
| Sign in | where the browser lands | `returnTo` query param, validated as a relative path; else `/` |
| Sign in | cookie `Secure` flag | scheme of `PUBLIC_URL` |
| Sign in | lockout key | lowercase trimmed email from the request body |
| Rate limit | client IP | `X-Forwarded-For` set by Caddy (the api trusts only the proxy) |
| Session check | absolute 7 day cap | `sessions.created_at` plus 7 days, compared by the guard |
| Session check | idle expiry | `sessions.expires_at` (12 hours, renewed hourly by Better Auth) |
| Session check | current user, role, must change flag | `users` row joined by the session, read on every request |
| Disabled message | disabled state | `users.banned` |
| Email | recipient language | `users.language`, else the default language from `GET /api/config` (spec 0004) |
| Email | link base | `PUBLIC_URL` plus the route path and token |
| Email | sender address and display name | `MAIL_FROM` and `CLIENT_DISPLAY_NAME` |
| Email | token life | reset 1 hour, invite 7 days (`verifications.expires_at`) |
| Temporary password | the value | server side random generator, 16 characters that satisfy AC-8, shown once, only the hash is stored |
| Two factor | authenticator app label and issuer | email and `CLIENT_DISPLAY_NAME` |
| Staff list | status | derived from `banned` and `last_sign_in_at` |
| Staff list | last sign in | `users.last_sign_in_at`, set in the sign in success hook |
| User menu | name, email, role | `GET /api/me` |
| Ledger posting | `postedBy` | the guard's current user id; null only for system jobs (spec 0002) |
| Staff admin screen | whether to show invite or temporary password wording | `mailEnabled` from `GET /api/config` |
| Account language | applied language after sign in | `users.language` written to the `ss_lang` cookie (spec 0004) when it is set |
| Lock end time | lock expiry | server clock plus 15 minutes, `sign_in_attempts.locked_until` |
| Lockout | key and scope | `email_key` from the request body (for code attempts, the user of the pending sign in) and the client IP; scope `*` for the all addresses row |
| Shell | current path for `returnTo` | Next.js middleware sets an `x-pathname` header the layout reads |
| API error | `SESSION_EXPIRED` or `UNAUTHENTICATED` | cookie present with no live session, or no cookie |
| Staff list | paging cursor | `lower(name)` and `id` of the last row |
| Reset page | whether the token is still valid | Better Auth's token check redirecting with `?error=INVALID_TOKEN` |
| Events and logs | actor, target, IP, user agent | the guard's current user, the route parameter, trusted `X-Forwarded-For`, the request header |

**Key invariants**:
- At least one active admin always exists (checked under an advisory lock inside the same transaction as the change).
- Staff accounts are never deleted; ledger rows reference them for good.
- Email is unique ignoring letter case; staff code is unique when set.
- Passwords exist only as hashes. Tokens are single use and short lived. A temporary password is shown once and never stored or logged.
- A session with the must change flag cannot reach any business route.
- A disabled person has no live session: disabling deletes them in the same transaction.
- `GET /api/me`, the guard and the shell all read the user fresh from the database; cookie caching is off.
- Field rules (all values trimmed): `name` 1 to 100 characters; `phone` 5 to 30 characters of digits, `+` and spaces; `staff_code` 1 to 20 characters, stored uppercase; `language` is one of the languages in `GET /api/config` (spec 0004); email is lowercased on create and on every lookup.
- An admin reset overwrites the stored hash with an unusable random value, so a possibly stolen old password stops working at once.

**Security model**:
- Roles for now: `admin` (everything, including `/api/staff`) and `staff` (everything else). Location scoping and finer permissions arrive with feature 13, which replaces the role check constraint.
- Public surface is limited to config, health and the listed Better Auth routes, all behind per IP rate limits. Sign up is closed (staff are created only by an admin or the first admin command).
- Sessions use a host only `HttpOnly` cookie; the 7 day cap and the disabled state are enforced on every request.
- Staff data (names, emails, phones) is personal data. Keep the fields minimal; disabled accounts are kept because the ledger needs them. No compliance regime is confirmed; erasure rules are a follow up.
- Every non GET request to our routes is rejected unless its `Origin` matches `PUBLIC_URL`, as Better Auth already does for its own routes.
- Account probing is closed on sign in (identical answers and lockout, AC-2 and AC-3), on reset (neutral answer, same timing), and by keying lockouts on email text.

**Configuration required**:
- `BETTER_AUTH_SECRET`: already generated by `bootstrap.sh`; now read and validated in `env.ts` (at least 32 characters). Rotating it signs everyone out and also makes every enrolled two factor secret and backup code unreadable, so those people need an admin two factor reset.
- `PUBLIC_URL`: browser facing URL; auth base URL, trusted origins and the links in emails. In `env.ts` and passed to `api` and `worker` in Compose.
- `API_INTERNAL_URL`: for the web container only, the internal address of the api.
- `MAIL_DRIVER`: `none` (default), `smtp` or `postmark`.
- `MAIL_FROM`: sender address; required unless the driver is `none`.
- `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURITY` (`starttls` default, `tls`, `none`), `SMTP_USER`, `SMTP_PASSWORD`: required when the driver is `smtp` (host always; user and password together).
- `POSTMARK_SERVER_TOKEN`: required when the driver is `postmark`. Prerequisite: the sender domain or address must be verified in Postmark before the first send.
- `AUTH_CLEANUP_CRON`: when the nightly cleanup runs, default `0 3 * * *`, in the install's timezone setting.
- `deploy/.env.example` documents all of these. `bootstrap.sh` prints the `create-admin` command as its next step.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Happy path: create the first admin with `create-admin`, sign in, change the forced password, land on the page in `returnTo`, see name and role in the user menu, sign out, verifies **AC-1**, **AC-6**, **AC-14**, **AC-21**, **AC-25**
- Happy path: admin invites a person (mail on, using a captured test mail), the person sets a password from the link and signs in; with mail off, the admin hands over a temporary password and the person is forced to change it, verifies **AC-9**, **AC-12**, **AC-13**, **AC-14**
- Failure case: five wrong passwords lock the email, the sixth with the correct password still gets the generic answer, and an unknown email behaves identically, verifies **AC-2**, **AC-3**
- Failure case: a session older than 7 days, or idle past 12 hours, returns 401 `SESSION_EXPIRED` (test with a controllable clock), verifies **AC-5**
- Failure case: two admins disable each other at the same time; exactly one request succeeds and one admin remains, verifies **AC-17**
- Failure case: mail server down; the job retries and the sign in request still succeeds; after the last retry a log line without the link appears, verifies **AC-11**, **AC-23**
- Failure case: a used or expired reset link shows the invalid link screen, verifies **AC-9**
- Failure case: weak passwords are rejected on reset, change, invite and temporary password paths, verifies **AC-8**
- Auth/permission: every `/api` route except the public ones returns 401 without a session (include `GET /api/locations`); a `staff` role gets 403 on `/api/staff`; `/api/auth/admin/*`, `sign-up`, `update-user` and `change-email` return 404; a disabled person's old cookie fails on the next request, verifies **AC-7**, **AC-15**, **AC-16**
- Auth/permission: a `returnTo` of `//evil.example` or `https://evil.example` lands on `/`, verifies **AC-7**
- Happy path: enroll an authenticator app, sign in with a code, use a backup code once, have an admin reset it, verifies **AC-20**
- Failure case: break glass; with mail off and the only admin locked out, `create-admin --reset-password` restores access and clears the lockout, verifies **AC-21**
- Happy path: Arabic and English screens, keyboard only, with the Playwright accessibility suite on every new screen, verifies **AC-24**, **AC-19**
- Happy path: the nightly cleanup removes expired rows and leaves live ones, and posting a stock movement stores the signed in user as `posted_by`, verifies **AC-22**

## Build plan

Tracer Bullet: the first slice is a real sign in through every layer, then each slice thickens one segment and ships on its own. Migrations follow the slices (users, sessions, accounts and verifications first; counters second; two factor table third; foreign keys last), so no slice carries tables it does not use.

1. **Thin thread, sign in and out end to end.** Add `BETTER_AUTH_SECRET` and `PUBLIC_URL` to `env.ts`; migration for `users`, `sessions`, `accounts`, `verifications`; mount Better Auth at `/api/auth` (body parser off for that path, sign up and the blocked routes closed); the `create-admin` entry point (create mode); the global `SessionGuard` with a public decorator; `GET /api/me`; the `(auth)/sign-in` page; the shell session check, a middleware that passes the path, and the redirect with a safe `returnTo`; the user menu with real name and role and a working Sign out. Satisfies **AC-1**, **AC-6**, **AC-7**, **AC-21**, **AC-25**
2. **Session policy and brute force protection.** 12 hour sliding session with the 7 day cap in the guard, cookie caching off, `SESSION_EXPIRED` handling and the client redirect; password rules shared as a Zod schema; migration for `rate_limits` and `sign_in_attempts`; per IP rate limits on database storage; the lockout hooks with identical answers; trusted proxy IP handling; the Better Auth route allowlist and before hook (Origin, 7 day cap, must change); the atomic lockout upsert; the after hook for last sign in and the counter reset; sign in logging and events. Satisfies **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-8**, **AC-23**
3. **Mail and password reset.** The mail module with the SMTP and Postmark adapters and env validation; pg-boss producer in the api and the `mail.send` queue in the worker with retries; English and Arabic templates; `mailEnabled` in `GET /api/config`; forgot password and reset pages; reset flow with session revocation, `onPasswordReset`, old token deletion, the padded response time, and the token check redirect. Satisfies **AC-9**, **AC-10**, **AC-11**
4. **Staff administration.** `StaffService` (create, edit, disable, enable, reset password, revoke sessions, advisory lock for the last admin rule), temporary passwords, invites through `verifications`, resend invite, the must change flag gating, the `RolesGuard`, `/api/staff` endpoints with contracts, the `staff` page, the nav entry, the invite wording on the reset page, the forced `change-password` page, admin events and logs. Satisfies **AC-12**, **AC-13**, **AC-14**, **AC-15**, **AC-16**, **AC-17**, **AC-18**, **AC-23**
5. **Account page and language sync.** `PATCH /api/me`, the `account` page (profile, change password), and saving the language to the account and applying it at sign in. Satisfies **AC-19**
6. **Two factor.** Migration for `two_factors`; enable, verify, backup codes and disable; the `two-factor` sign in step; lockout counting of wrong codes; admin reset of two factor. Satisfies **AC-20**, **AC-3**
7. **Ledger link and cleanup.** Migration adding the foreign keys from `created_by` and `posted_by`; wire `postedBy` from the guard into ledger posting; the nightly `auth.cleanup` job in the worker with `AUTH_CLEANUP_CRON`; `create-admin --reset-password`. Satisfies **AC-22**, **AC-21**
8. **Hardening and finish.** English and Arabic catalogs for every screen, the Playwright flows and accessibility suite for the new screens, a sign in helper for the existing end to end tests, `deploy/.env.example` and `bootstrap.sh` updates, and a short run book for `create-admin` and break glass recovery. Satisfies **AC-24**, **AC-21**, **AC-7**

## Consequences

**Positive**:
- Every `/api` route now runs as a known person, so costs and stock values can be protected by roles in feature 13 and every movement carries a real `posted_by`.
- Disabling a leaver takes effect on their next request, not at the end of a session.
- Works fully on premises: no outside identity service, and every recovery path (temporary passwords, `create-admin --reset-password`) works with no mail and no internet.
- Account probing is closed at sign in and reset, and brute force is slowed twice (per IP and per email).
- One contract and one OpenAPI document cover all our own endpoints; the browser never talks to Better Auth's admin routes.

**Negative / tradeoffs**:
- The password rule (8 characters with composition) is weaker than the length first approach current guidance prefers. It was your choice. Lockout, IP limits and optional two factor reduce the risk; revisit if a client asks for stricter rules.
- Better Auth has no per account lockout, so lockout, the 7 day cap and the safe admin rules are our own code around it. They need careful tests, and a Better Auth upgrade can change hook behavior.
- The invite token is written straight into `verifications`, which depends on Better Auth's internal token format. A test must pin it so an upgrade cannot break invites silently.
- Rotating `BETTER_AUTH_SECRET` now also destroys enrolled two factor secrets, not just sessions. Spec 0001 and the `.env.example` comment must say so.
- The queue job holds only a token id, so no link sits in the queue. Sending then depends on that `verifications` row still existing when the worker runs.
- Domain events through an in process emitter are not durable. Feature 14 must decide how it records audit entries so none are lost on a crash.
- Two mail adapters means two paths to test, although no client has asked for Postmark yet.
- Optional two factor adds enrollment, backup codes and admin resets to the support load.
- Lockout can still be abused: 20 failures from any addresses lock one email for 15 minutes. The run book documents `create-admin --reset-password`, which clears it.
- Every request reads the session and user from the database (cookie cache is off). That is fine at back office volumes and should be measured at feature 16.
- Staff cannot change their own email, and a live account's email cannot be changed by anyone, until a later feature.

**Neutral**:
- A fourth entry point, `create-admin`, ships in the `app` image next to `api`, `worker` and `migrate`.
- The api process starts a send only pg-boss client (no scheduling or maintenance) with a pool of 2 connections.
- Roles are just `admin` and `staff` until feature 13.
- Auth screens sit outside the app shell and need an exception note in `AGENTS.md`.

## Follow-up

- [ ] Spec 0001 refinements: the web check uses `GET /api/me`; rotating `BETTER_AUTH_SECRET` also breaks enrolled two factor; a fourth `create-admin` entry point. Update the spec (or let `/sync` flag it) once built.
- [ ] Spec 0003 follow-up is delivered here: session guard on `/api/locations`, rate limits on public routes, real user menu. Tick it in `/sync`.
- [ ] `AGENTS.md` rule "Every page renders inside the app shell" needs an exception for the `(auth)` screens. `/sync` owns that edit.
- [ ] You declined Agent Skill and MCP discovery for the SMTP library and Postmark. Record both under `Declined:` in `AGENTS.md`.
- [ ] Move the six Better Auth skills into `apps/api/src/auth/AGENTS.md` once that folder exists (already flagged in `apps/api/AGENTS.md`).
- [ ] Verify against the installed Better Auth version before building: `disabledPaths`, database rate limit storage, creating a verification value with a custom expiry, `revokeSessionsOnPasswordReset`, the ban check at sign in, and whether versioned secrets are supported (use them if so, so rotation does not destroy two factor data).
- [ ] Check pg-boss options for deleting completed jobs after an hour and failed jobs after a day on the installed version.
- [ ] Confirm Caddy overwrites a client supplied `X-Forwarded-For` header so IP rate limits cannot be spoofed.
- [ ] Feature 13: replace the `role` check constraint with real roles and permissions; hide unit cost and stock value from roles without cost permission.
- [ ] Feature 14: subscribe to the staff and sign in events and decide how audit entries are stored durably.
- [ ] Feature 16: alert on repeated mail job failures; measure per request session lookups.
- [ ] Needs a decision later: erasure or anonymising former staff data if a client falls under data protection rules; changing the email of a live account; session list with "sign out other devices".
- [ ] Existing end to end tests that call `/api/locations` unauthenticated need the new sign in helper (build plan step 8).
- [ ] Confirm the api port is not published outside Compose, so `X-Forwarded-For` cannot be forged around Caddy.
- [ ] The run book must cover lockout abuse and `create-admin --reset-password`, and say not to capture the `create-admin` output.
- [ ] Pin the pg-boss major version and set `retryLimit`, delays and deletion options for the mail queue.
- [ ] If the pinned invite token test cannot hold across a Better Auth upgrade, fall back to Better Auth's own `requestPasswordReset` for invites.
- [ ] Test explicitly that the session cookie renews when a person only loads pages.
