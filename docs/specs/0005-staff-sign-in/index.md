# 0005. Staff sign in with Better Auth: email and password, admin managed accounts, optional two factor

**Date**: 2026-11-03
**Status**: Proposed (amendment of 2026-11-05 for scope feature 7; the original decision was accepted and built)

## Summary

Staff sign in with an email and password. Sessions last up to 12 hours of inactivity and 7 days in total. An admin creates, edits and disables staff accounts, and a person can reset a forgotten password by email, or through an admin when the install has no mail. Two factor sign in with an authenticator app is optional for everyone. Every `/api` route then runs as a known user, which also fills the `posted_by` column on the stock ledger. The work is built as thin end to end slices, starting with plain sign in and sign out.

## Amendment 2026-11-05

**Why.** The product changed on 2026-11-05 ([rebuild plan](../../positioning/2026-11-05-rebuild-plan.md)) and [spec 0007](../0007-stack-architecture-operations-layer/index.md) chose Shape A: keep this spec and its built, reviewed code, and amend it. Sign in itself does not change. Better Auth, the email and password flow, lockout, rate limits, sessions, optional two factor, admin managed accounts and the `create-admin` commands all stay as built, and AC-1 to AC-26 keep holding unless a note below says a line is replaced. What changes is the world around it: there are now two audiences that sign in (staff and partner users) on one staff host, a separate public portal host that must never see a staff session, one tenant id on every row, an `identity` module that absorbs `auth` and `staff`, and roles that become hats (scope feature 8). Scope feature 7 shrinks to this delta. Its done when is: staff can sign in and out in both languages, repeated failures lock out safely, sessions expire, and the first admin and recovery steps are in a run book. The first three already hold and are re proved by the existing tests; this amendment closes the fourth against the new layout and adds the rest.

**Settled and not reopened.** The review in [docs/reviews/2026-11-04-feat-staff-sign-in.md](../../reviews/2026-11-04-feat-staff-sign-in.md) found no blockers. Its findings 1 to 7 are fixed and re checked (invited email change voids the old invite, one forwarded client address, self targeted admin actions refused, no query params in error output, server side `revokeOtherSessions`, shared pending challenge delete). Finding 8 (the lockout checks before it counts, so a parallel burst gets more than five tries, bounded by the 30 per minute IP limit) is fixed by the sign in slots of PR 11, folded into milestone 2 on 2026-11-06 with the gate session's agreement: AC-3 and AC-22 carry the slot rule, and `sign_in_slots` joins the baseline with `tenant_id`. The password rule, optional two factor and both mail adapters stay the owner's earlier choices.

**What this amendment adds or replaces** (each item names the original text it touches):

1. **One `identity` module** (adds AC-27; replaces the file locations in the `auth` and `staff` READMEs and in "Commands", behavior unchanged).
2. **Partner users sign in through the same pages, lockout and limits** (adds AC-28; extends AC-3, AC-4, AC-5, AC-8, AC-9, AC-20 to a second kind of person).
3. **An audience aware session guard** (adds AC-29; replaces the sentence in the original "Public routes" paragraph that the guard demands a staff session on every non public route).
4. **A host only staff cookie that the portal host never sees** (adds AC-30; replaces `PUBLIC_URL` as the source of the cookie, Origin and link settings in AC-1, AC-7, "Configuration required" and the Security model).
5. **The path based fallback scopes the cookie by `Path`** (adds AC-31; Carried m8 in spec 0007).
6. **`tenant_id` on every auth table** (adds AC-32; replaces the "Data model sketch" for keys and uniqueness).
7. **Sessions and hats** (adds AC-33; replaces "Roles for now ... feature 13" in the Security model, because roles became hats in feature 8; the hat model itself is spec 0008).
8. **Sign in pages and mail for both audiences, in both languages** (adds AC-34; keeps AC-24).
9. **Run book gains** (adds AC-35; extends the two run book follow-ups of the original).

### New requirements

Numbering continues from AC-26.

- **AC-27**: The code of `apps/api/src/auth/` and `apps/api/src/staff/` lives in one Nest module, `apps/api/src/identity/`, with one `IdentityModule`, one README (Owns, Never touches, How to test, Governing spec, Decisions) and one `AGENTS.md`. The sign in parts and the staff administration parts keep separate sub folders. Nothing observable changes: every route, error code, event name, table name, environment name and the `create-admin` entry point (`node dist/create-admin.js`) stay as they are, and every existing unit and end to end test passes with only import paths changed. Other modules use identity only through exported services (the current user reader that ledger routes use for `postedBy`, `StaffDirectory`, and the session revoke service of AC-33), and a boundary test (today `apps/api/src/module-boundary.spec.ts` guards tables for every module, spec 0002 A5; the import path wall around `identity/` is this feature's own test) fails when another module imports a file inside `identity/` or reads an auth table. The auth tables are written only by identity.
- **AC-28**: A partner user (spec 0007 section 2: a Better Auth session with the partner hat, bound to one partner account) signs in on the same `(auth)` pages with an email and password. Every rule applies to a partner user exactly as to staff: the lockout of AC-3, the per IP limits of AC-4, session lifetime and cap of AC-5, password rules of AC-8, reset and mail of AC-9 to AC-11, the must change flow of AC-14, and optional two factor of AC-20. The lockout and the sign in answers are keyed on the email text and never on the kind of person, so a partner email, a staff email and an unknown email give identical answers and timing (no probing of who is a partner). After a full sign in, `GET /api/me` also returns `home`, either `backoffice` or `partner`, and the sign in page sends the person there when `returnTo` is absent or invalid. The `returnTo` of AC-7 is followed only when it points into the pages of the person's own audience; otherwise the person lands on `home` (a partner asking for `/stock` lands on `/partner`). Partner users get the same Account screen (name, phone, language, password, two factor) inside the partner frame. `/api/staff` lists, edits and disables staff only; the last active admin rule (AC-17) counts staff admins only; a partner user can never be an admin; `create-admin` creates staff only. Who creates partner users, and the partner account binding, belong to feature 8 and the partners module; this spec requires only that they reuse the invite and reset mechanics of AC-12, AC-13 and AC-18 unchanged. Until spec 0008 lands, every person is staff and `home` is `backoffice`.
  > Amended 2026-11-05: `home` for a partner user comes from `GET /api/partner/me` (partner audience), not `GET /api/me`, because a controller has exactly one audience; both routes return the same `MeResponse` ([spec 0008](../0008-roles-as-hats/index.md) AC-11). The sign in page asks `/api/me` and, on 403 `WRONG_AUDIENCE`, `/api/partner/me`.
- **AC-29**: `SessionGuard` becomes audience aware, using the `@Audience(...)` of the route (`apps/api/src/platform/audience/`). A `staff` route needs a live session whose person may use the staff audience; a `partner` route needs a live session whose person may use the partner audience, and the partner account id comes from the session's user row, never from the request; a live session that does not fit the route's audience gets 403 `WRONG_AUDIENCE`; no cookie gets 401 `UNAUTHENTICATED` and a dead session 401 `SESSION_EXPIRED`, as in AC-5. `portal`, `hook` and `public` routes never read the session cookie at all, so a staff cookie cannot act on a portal route by any path (a test sends a valid staff cookie to a portal route and a hook route and proves the handler sees no user). Which audiences a person may use comes through a port, `SessionAudiences` (**Assumed** name), that identity exports: given a user id it returns the audiences the person's hats allow. Before spec 0008 the one implementation returns `staff` for every user. Spec 0008 supplies the real one, and tests for this criterion use a fake that returns `partner`. The must change flag, the 7 day cap, the disabled check and the Origin check of AC-7 apply to every audience the guard serves. The Origin check on Better Auth routes and on non GET routes compares against the staff origin of AC-30.
- **AC-30**: The staff session cookie, and every other cookie Better Auth sets (the second factor challenge cookie, the dont remember cookie), is host only: no `Domain` attribute is ever sent (Better Auth's `advanced.crossSubDomainCookies` stays off, a test reads the `Set-Cookie` of a real sign in and fails on a `Domain`), `HttpOnly`, `SameSite=Lax`, and `Secure` when the staff origin is https. It is set only on answers from the staff host. Better Auth is reachable only on the staff host: when a request carries the portal host (as `X-Forwarded-Host`, set by Caddy; **Assumed**, to be checked against `deploy/Caddyfile` in milestone 1), every `/api/auth/*` route answers 404, and the web `(auth)` pages are not served there (Caddy's job in feature 26, listed in the run book). Auth uses one staff origin for the Better Auth base URL, trusted origins, the Origin check, the `Secure` flag, `returnTo` validation and the links in emails. Today that value is `PUBLIC_URL`; it becomes `STAFF_ORIGIN` when spec 0007's configuration rename lands (the rename itself is feature 3 and 26 work, not done here). The portal origin is never a trusted origin of Better Auth.
- **AC-31**: In the path based fallback (a brand with no spare subdomain, so the staff pages and the staff api share a host with the portal under different path prefixes), the staff cookies carry `Path=<STAFF_BASE_PATH>` (**Assumed** name, proposed like the other names in spec 0007's "Configuration"; empty by default, meaning `Path=/`). The value must start with `/`, must not end with `/` and must not contain `..`, checked at startup in `apps/api/src/config/env.ts`, which stops the process with `Invalid environment` otherwise. Better Auth is told the path through `advanced.defaultCookieAttributes.path` (a documented option that Better Auth merges over its own `path: "/"`, checked in the installed 1.7.15 `dist/cookies/index.mjs`). Sign out, session renewal and the second factor cookie use the same path, so sign out really clears the cookie (a browser clears a cookie only when the path matches); a test proves a signed out `Set-Cookie` repeats the path. Links in emails and redirects are the staff origin plus `STAFF_BASE_PATH` plus the route. This spec states the cookie contract only. Whether the whole staff surface (pages and `/api`) can sit under one prefix is a deployment and web question for features 26 and 47 (see Risks).
- **AC-32**: Every table in `packages/db/src/schema/auth.ts` (`users`, `sessions`, `accounts`, `verifications`, `two_factors`, `rate_limits`, `sign_in_attempts`) has `tenant_id uuid not null`, defaulting to `current_setting('ssd.tenant_id')::uuid`, by the rule spec 0007 section 7 sets and the data model spec (feature 4) owns in its baseline migration. No auth code names the column: Better Auth's inserts, our raw SQL (the lockout upsert, token writes, the `create-admin` commands) and the nightly cleanup all work with the default, and an end to end test proves rows made by a sign in, a reset, a two factor enrolment, a lockout and a rate limit hold the install's tenant id. Unique business keys include the tenant: email is unique on (`tenant_id`, `lower(email)`), staff code on (`tenant_id`, `staff_code`) where set, an account on (`tenant_id`, `provider_id`, `account_id`), and `sign_in_attempts` has the primary key (`tenant_id`, `email_key`, `scope`). `rate_limits` and `verifications` carry the column but keep the keys Better Auth owns. There is no row level security (one database holds one tenant). The feature 4 schema test, which fails on any table without the column, passes with the auth tables included. A partner who serves several brands has one login per brand stack (spec 0007 section 2); nothing here shares an account across brands.
- **AC-33**: Sessions follow a person's hats without a new sign in. (a) A session carries no hat and no permission: the guard reads the person's user row and hats from the database on every request, so a grant or a removal acts on the person's next request. This extends the existing rule that cookie caching is off, and a test proves a grant and a removal take effect with the same cookie. (b) A change that leaves the person with no hat at all, that moves them between the staff and partner audiences, or that binds them to a different partner account deletes all their sessions in the same transaction as the change, as disabling does (AC-16), so the next request is 401 `SESSION_EXPIRED`. A change that only adds or removes a hat while the person keeps at least one hat of the same audience leaves the sessions alive. (c) Identity exports a session revoke service, `revokeSessions(userId, tx)` (**Assumed** name), that takes the caller's transaction; the hat service of spec 0008 calls it, so the change and the revoke commit together. (d) The rule that at least one active admin always exists (AC-17) survives hats: removing the hat that grants user administration from the last active admin gets 409 `LAST_ADMIN` under `ADMIN_RULE_LOCK`, the same lock as today; spec 0008 names the hat, identity keeps the lock and the rule. (e) A hat change writes the log line and the past tense event of AC-23 shape (`actorId`, `targetId`, `ip`, `userAgent`, `at`, and the hats added and removed). The event name and payload fields are spec 0008's. (f) A person cannot change their own hats. Everything about which hats exist, what they allow, and how one person holds several is spec 0008. This criterion only fixes what a session does when that model changes.
- **AC-34**: All `(auth)` screens (sign in, forgot password, reset and invite, two factor, forced change) and all auth emails work in English and Arabic, right to left, by keyboard alone and to WCAG 2.2 AA for both audiences (AC-24 stays). Their wording is neutral about the kind of person: no string a partner can reach says "staff" or "employee" (the admin only invite wording on the staff page keeps it). The sign in page's saved language rule (AC-19) applies to partner users too. When message catalogs move to `packages/i18n` (spec 0007 section 10, feature 6), the auth screens and the mail templates move with them, keep every key, and stay inside the missing Arabic key test. How the `(auth)` pages render `lang` and `dir` (a server side render, or the existing head script) is decided by the localization spec (feature 6); this spec only requires that a partner never sees a wrong direction flash that a staff person would not.
- **AC-35**: The run book `docs/runbooks/staff-sign-in.md` is rewritten for the new layout and states the first admin and recovery steps in plain words for an operator who has never seen the code. It must gain, and the build plan names who writes it:
  1. The first admin steps for a vendor hosted client (the per client Compose project of spec 0007 section 6, `STAFF_ORIGIN`, `PORTAL_ORIGIN`, the per client `.env`) and for a self hosted install, with the sign in address taken from the staff origin and not `PUBLIC_URL`.
  2. The log driver check made explicit for a shared host: one Docker daemon serves many clients, so the check is of the host's default driver and happens once per host before any client's first admin is created.
  3. Where the tenant id comes from: `create-admin` relies on the database setting `ssd.tenant_id` that `migrate` makes; the symptom and fix when it is missing.
  4. Recovery for every kind of person: an admin (existing commands), staff (staff page), a partner user (reset and unlock from the partners screen of feature 8, with the same 15 minute lock and the same wait), and "the only admin and the second factor are both lost", unchanged.
  5. What hat changes do to live sessions, in operator words: a grant or removal acts on the person's next click; removing a person's last hat, or moving them to another audience or partner account, signs them out.
  6. Cookie symptoms: signed out at once after sign in behind the path fallback means `STAFF_BASE_PATH` does not match the prefix Caddy serves; the portal host never shows a sign in page; what a `Domain` cookie would mean and why it must never appear.
  7. The client address chain with the host level edge Caddy: where `TRUSTED_PROXIES` is set now, and that the per IP lockout and limits are only as good as the one forwarded address (section 4 of the run book, review finding 2 of 2026-11-04).
  8. The pre existing sections (lockout abuse, mail, nightly cleanup, rotation of `BETTER_AUTH_SECRET`, troubleshooting) stay, with `PUBLIC_URL` replaced by the staff origin wherever it appears, and the spec link pointing here.

### Design delta

**Data model delta** (all in `packages/db`, in the baseline migration feature 4 writes, not a separate migration; no install exists, spec 0007 "Keep list, Shape A")

| Table | Change | Rules and indexes |
|---|---|---|
| all seven auth tables | add `tenant_id uuid not null default current_setting('ssd.tenant_id')::uuid` | AC-32 |
| ★ `users` | the unique index on `lower(email)` becomes (`tenant_id`, `lower(email)`); the unique partial index on `staff_code` becomes (`tenant_id`, `staff_code`) where not null | the `role` column and its `admin or staff` check stay until spec 0008 replaces them with hats |
| ★ `accounts` | unique (`provider_id`, `account_id`) becomes (`tenant_id`, `provider_id`, `account_id`) | one `credential` row per user stays |
| ★ `sign_in_attempts` | primary key (`email_key`, `scope`) becomes (`tenant_id`, `email_key`, `scope`) | the atomic upsert in `sign-in-lockout.ts` changes its conflict target to match |
| ★ `sign_in_slots` (new, folded from PR 11 on 2026-11-06) | added with `tenant_id`, in the baseline | AC-3, AC-22; the slot rule of review finding 8 |

No new auth table besides `sign_in_slots` (review finding 8, folded from PR 11). Hats and partner account binding are tables of spec 0008.

**Interfaces delta**:
- `GET /api/me` adds `home` (`backoffice` or `partner`). `packages/contracts/src/auth.ts` gets the field; the web parses it.
  > Amended 2026-11-05: `GET /api/me` (staff) and `GET /api/partner/me` (partner) both return `home` ([spec 0008](../0008-roles-as-hats/index.md) AC-11).
- New error behavior: 403 `WRONG_AUDIENCE` also for a staff session on a partner route and the reverse. The code already exists for non staff audiences.
- Exports of the `identity` module: the current user reader, `StaffDirectory`, `SessionAudiences` (port), and `revokeSessions(userId, tx)`.
- Environment: `STAFF_ORIGIN` (replaces `PUBLIC_URL` for auth when the rename lands), `STAFF_BASE_PATH` (optional). Both are added to `env.ts` and to only the services that read them (`api`, `worker` for mail links). `PORTAL_ORIGIN` is read by auth only to refuse `/api/auth/*` for the portal host.
- No new route is added. No Better Auth route is opened or closed.

**Value sourcing delta**

| Action | Value produced / displayed | Source |
|---|---|---|
| Sign in | cookie `Domain` | never set (host only) |
| Sign in | cookie `Path` | `STAFF_BASE_PATH`, else `/` |
| Sign in | cookie `Secure` flag | scheme of the staff origin |
| Sign in | where the browser lands | valid `returnTo` inside the person's audience, else `home` from `GET /api/me` |
| Session check | audiences the person may use | `SessionAudiences`, read from the database on every request |
| Session check | partner account id on a partner route | the session's user row, never a header, path or body |
| Auth tables | `tenant_id` | the column default from the database setting `ssd.tenant_id` |
| Email | link base | staff origin plus `STAFF_BASE_PATH` plus route |
| Hat change | sessions deleted or kept | whether the person keeps a hat of the same audience and the same partner account |

> Amended 2026-11-05: for a partner user, `home` comes from `GET /api/partner/me` ([spec 0008](../0008-roles-as-hats/index.md) AC-11).

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: the full existing sign in, reset, invite, two factor and `create-admin` suites pass after the move to `identity/`, with only import paths changed, verifies **AC-27**
- Auth/permission: a module other than identity importing an identity file, or reading an auth table, fails the boundary test, verifies **AC-27**
- Happy path: with the fake `SessionAudiences` returning `partner`, a partner user signs in on the same page, lands on `/partner`, is locked after five wrong passwords with the same answer and timing as a staff email and an unknown email, and gets the same reset flow, verifies **AC-28**
- Auth/permission: a partner session on a staff route, and a staff session on a partner route, get 403 `WRONG_AUDIENCE`; a valid staff cookie sent to a portal and a hook route leaves the handler with no user, verifies **AC-29**
- Auth/permission: `Set-Cookie` of a real sign in has no `Domain`, and `/api/auth/*` answers 404 for the portal host, verifies **AC-30**
- Failure case: with `STAFF_BASE_PATH=/ops` the sign in, renewal, two factor and sign out cookies all carry `Path=/ops` and sign out clears it; a bad value stops startup, verifies **AC-31**
- Happy path: rows made by sign in, reset, two factor enrolment, lockout and rate limit hold the install's tenant id; the feature 4 schema test passes, verifies **AC-32**
- Failure case: with the same cookie, a granted hat is usable and a removed hat is refused on the next request; removing a person's last hat deletes their sessions, and two admins removing each other's administration hat at once leave one, verifies **AC-33**
- Happy path: Playwright and axe on every `(auth)` screen in both languages and directions for the staff audience, plus a copy check that finds no "staff" in strings a partner can reach, verifies **AC-34**
- Failure case: a fresh reader follows the run book on an empty vendor hosted stack and reaches a signed in admin, then recovers a locked admin, verifies **AC-35**

### Risks of the amendment

- **Path fallback is not buildable from this spec alone.** Next.js `basePath` is fixed at build time, and `AGENTS.md` forbids per client values baked into an image, so one prefix for pages and `/api` needs a deployment answer (features 26 and 47). If none exists, the fallback is dropped and the cookie `Path` setting stays harmless. Decide before feature 26 closes.
- **Cookie tossing.** Better Auth prepends `__Secure-` to the cookie name on https and takes no `__Host-` prefix (checked in `dist/cookies/index.mjs`), so a sibling subdomain of the brand's registrable domain could set a cookie with a wider `Domain` that the staff host would also receive. The cookie value is signed, which stops forging a session, but a planted valid session of the attacker's own is still possible. Mitigation is the origin separation this spec asks for plus the signed cookie; a `__Host-` name stays a follow up.
- **Client address chain.** The per IP lockout and limits assume the api receives one trustworthy `X-Forwarded-For`. A host level edge Caddy in front of many client stacks changes that chain; feature 26 must keep `test/compose-ports.spec.ts` meaningful.
- **Hats may need a different session rule.** AC-33 is deliberately conservative (it deletes sessions on any kind change). Spec 0008 may widen what keeps a session alive but must not narrow what AC-33 deletes.
- **The path fallback scopes the cookie, it does not isolate the surfaces** (security review of milestone 1, [docs/reviews/security-identity-m1.md](../../reviews/security-identity-m1.md) finding 4). With the portal and staff on one origin, any script on a portal page can call the staff api with the cookie, frame the staff pages, or plant a cookie on the staff path. Separate hostnames, or a strict content security policy plus a portal script policy, is a gate for features 26 and 47 before the fallback ships. Changing `STAFF_BASE_PATH` on a live install also leaves an old cookie on the wider path that shadows the new one, so the change needs every session revoked (finding 1, in the run book).
- **Host header trust.** The portal host refusal (AC-30) reads `X-Forwarded-Host`; in local development there is no Caddy, so the check applies only when `PORTAL_ORIGIN` is set.

## Build plan

Tracer Bullet: milestone 1 moves the module and puts the cookie contract in place with the one real sign in thread still passing, then each milestone thickens one segment. Depends on: the feature 4 baseline migration (milestone 2) and spec 0008 for the real hats (milestone 3 uses a fake until then). This amendment's work is only the tasks below; the original plan is kept under "Build plan (original, built)".

**Milestone 1: One identity module and the staff cookie contract** (backend)
1. [x] Move `apps/api/src/auth/` and `apps/api/src/staff/` into `apps/api/src/identity/` (`sign-in/` and `staff/` sub folders), add `IdentityModule`, one README from `docs/templates/module-readme.md` and one `AGENTS.md`, update every import and the `docs` links that name the old paths, satisfies **AC-27**
2. [x] Add `identity/module-boundary.spec.ts` like the inventory one (amended 2026-11-06: `apps/api/src/module-boundary.spec.ts` from spec 0002 A5 already guards every module and counts `auth` and `staff` as `identity`, so this item only removes the `mail.worker.ts` entries from its `KNOWN_BREACHES` through the identity service), and export only the current user reader, `StaffDirectory` and the revoke service, satisfies **AC-27**
3. [x] Set the cookie attributes in `auth.factory.ts`: no `Domain`, `advanced.defaultCookieAttributes.path` from `STAFF_BASE_PATH`, one staff origin value for base URL, trusted origins, Origin check, `Secure`, `returnTo` and mail links; validate `STAFF_BASE_PATH` in `env.ts`; refuse `/api/auth/*` for the portal host when `PORTAL_ORIGIN` is set, after checking the header in `deploy/Caddyfile`, satisfies **AC-30**, **AC-31**
  > Built 2026-11-06: the mail worker reads the recipient and the token through `MailRecipients` (identity), which identity exports beside `StaffDirectory`; the current user reader is the `AuthenticatedRequest` type and needs no provider; the revoke service arrives with milestone 3. `deploy/Caddyfile` sets no host header, so the portal refusal checks `X-Forwarded-Host` and `Host` (any entry) and only ever refuses; feature 26 confirms the header when it adds the portal site. `STAFF_BASE_PATH` also allows only letters, digits and `/ . _ ~ -`, and `PORTAL_ORIGIN` must be a different host from the staff origin.
4. [x] Tests: `Set-Cookie` has no `Domain`; with `STAFF_BASE_PATH=/ops` every cookie, sign out included, carries the path; a bad value stops startup, satisfies **AC-30**, **AC-31**

**Done when:** `pnpm build && pnpm typecheck && pnpm --filter @ssdashboard/api test && pnpm --filter @ssdashboard/api test:e2e` pass, and `pnpm lint` passes (module README and doc link checks included).

**Milestone 2: Tenant id on the auth tables** (backend)
1. [ ] Make sure the feature 4 baseline migration gives all seven auth tables `tenant_id` and the new unique keys; if it is not in yet, add them to the baseline, not to a separate migration, satisfies **AC-32**
2. [ ] Change the `sign_in_attempts` upsert conflict target to (`tenant_id`, `email_key`, `scope`) and check every raw SQL statement in identity and in the `create-admin` commands runs with no `tenant_id` named, satisfies **AC-32**
3. [ ] End to end test that rows made by sign in, reset, two factor, lockout and rate limit hold the install's tenant id, and that `create-admin` works on a fresh database, satisfies **AC-32**
4. [ ] Fold in the sign in slots of PR 11 (review finding 8): `sign_in_slots` with `tenant_id` in the baseline (`0001` regenerated, grants only in `0002`), the slot taking before hook and the give back after hook in `identity/sign-in/`, the nightly cleanup of old slots, and PR 11's burst, stale slot, give back and two factor code tests, satisfies **AC-3**, **AC-22**

**Done when:** `pnpm db:migrate && pnpm --filter @ssdashboard/db test:e2e && pnpm --filter @ssdashboard/api test:e2e` pass.

**Milestone 3: Audience aware guard, partner users and hat sessions** (backend)
1. [ ] Add the `SessionAudiences` port with the staff only implementation, make `SessionGuard` read the route's audience and answer 403 `WRONG_AUDIENCE` for a mismatch, and stop `portal`, `hook` and `public` routes from reading the cookie, satisfies **AC-29**
2. [ ] Add `home` to `GET /api/me` and to the contract in `packages/contracts/src/auth.ts`, satisfies **AC-28**
  > Amended 2026-11-05: also to `GET /api/partner/me`, built by spec 0008; the partner route is the one a partner user reads.
3. [ ] Keep `/api/staff`, the last admin rule and `create-admin` staff only, with tests using a fake partner user, satisfies **AC-28**
4. [ ] Export `revokeSessions(userId, tx)` and the log line shape for hat changes, and test the three rules of AC-33 (b) with fake hats, satisfies **AC-33**
5. [ ] Write the requirement notes spec 0008 must meet (the port, the revoke call, `HatsChanged`, `LAST_ADMIN` under the lock) into `AGENTS.md` of the identity module, satisfies **AC-33**

**Done when:** `pnpm --filter @ssdashboard/api test -- src/identity src/platform/audience && pnpm --filter @ssdashboard/api test:e2e` pass, and the audience test fails when one `@Audience` annotation is removed.

**Milestone 4: Pages for both audiences and the run book** (frontend, then docs)
1. [ ] Make the sign in page follow `home` and follow `returnTo` only inside the person's audience, with unit tests for `/partner` and `/stock`, satisfies **AC-28**
2. [ ] Reuse the account feature folder in the partner frame (shared component, partner route), satisfies **AC-28**
3. [ ] Copy pass: no "staff" in strings a partner can reach, in the web catalogs and the mail templates; keep the Arabic keys complete, satisfies **AC-34**
4. [ ] Update `docs/runbooks/staff-sign-in.md` for all eight points of AC-35 (the build owner or the docs writer; Igris routes it) and point the spec link to this amendment, satisfies **AC-35**
5. [ ] Re run the Playwright accessibility and keyboard suite for the `(auth)` screens in both languages, satisfies **AC-34**

**Done when:** `pnpm lint && pnpm --filter @ssdashboard/web test && pnpm --filter @ssdashboard/web test:e2e -- auth` pass, and a person who has not seen the code follows the run book on a fresh stack to a signed in admin (recorded in `verify.md`).

## Questions for the owner

None blocks the build. These are owner level choices, each with the default this amendment uses:

1. Should the manager hat (the successor of `admin`) be required to use two factor? **Default: no.** Two factor stays optional for everyone, as chosen earlier, and the run book recommends it for every admin. Revisit with spec 0008 and again at the pilot.
2. Does a partner user ever also work as staff with the same email? **Default: no**, one person has one kind; spec 0008 may allow it, and AC-33 works either way.
3. Is a brand without a spare subdomain a case you want to support? **Default: yes in the cookie contract only** (AC-31), with the full fallback decided in features 26 and 47.

## Requirements

**User stories**:
- As a staff member, I want to sign in with my email and password and stay signed in through my shift, so I can work without interruptions.
- As a staff member who forgot a password, I want to reset it myself, or get an admin to reset it when there is no mail, so I am never stuck.
- As an admin, I want to invite staff, change their details and role, and disable a leaver at once, so only current staff can reach stock and cost data.
- As an owner, I want every stock movement tied to a real person and a lost password never to lock the whole company out.
- As a security conscious staff member, I want to add an authenticator app code to my sign in.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: Signing in with a correct email (any letter case) and password creates a session. The cookie is host only, `HttpOnly`, `SameSite=Lax`, and `Secure` when `PUBLIC_URL` is https. The browser lands on the `returnTo` path when it is a relative path on this site, otherwise on `/`. `users.last_sign_in_at` is set. The user menu shows the person's name, email and role.

> Amended 2026-11-05: the cookie settings and the `Secure` flag come from the staff origin, and the cookie never carries a `Domain`; see AC-30 and AC-31. `PUBLIC_URL` below reads as the staff origin.
- **AC-2**: A wrong password, an unknown email, and a locked account all return the same 401 `INVALID_EMAIL_OR_PASSWORD` answer with the same message and shape. A disabled account that supplies the correct password gets 403 `BANNED_USER` with a clear "account disabled, ask an administrator" message and no session. A disabled account with a wrong password gets the generic answer. A correct password on a disabled account counts as neither a failure nor a reset of the lockout counter, and is logged as `SignInFailed` with reason `disabled`.
- **AC-3**: Five failed attempts within a fixed 10 minute window (started by the first failure) for the same email text (real or unknown) from the same client IP lock that pair for 15 minutes. Separately, 20 failures for that email from any addresses in the window lock the email for 15 minutes, so a spread out attack is slowed without letting one outsider keep a person locked out from a single address. During a lock every attempt, including the correct password, gets the generic answer of AC-2. The counter resets only after a full sign in (a session was issued and no second factor is pending). Whatever the concurrency, at most 5 passwords, second factor codes or current password answers are checked for one email and address pair, and at most 20 for one email from all addresses, within a window. Before Better Auth checks anything, the attempt must take a free slot, and a slot is free only while no lock is running and the window's failures plus the slots still held stay under the limit (5 for the pair, 20 for the email); slots for one email are handed out one at a time. An attempt that gets no slot is not checked and not counted: it gets the same answer as a locked attempt (on sign in the generic answer of AC-2, timing padded the same way and logged as `SignInFailed` with reason `locked`; on the other routes their own wrong password or wrong code answer), and, unless a lock is running, it does not end a pending sign in. An attempt that waits more than 2 seconds for its turn to take a slot is turned away the same way (not checked, not counted). When the attempt ends its slot is given back. A counted failure gives the slot back and adds the failure in one transaction, so no reader sees the slot gone before the failure counts. Every other ending (a full sign in, a password step that waits for a second factor, `BANNED_USER`, any other error) gives the slot back without counting or resetting anything. A slot older than 60 seconds no longer holds a place, so a request that dies before it can give its slot back blocks nothing for longer than that; the bound above holds for requests that finish within those 60 seconds. Counting itself is still one atomic upsert, so concurrent failures cannot skip a count, and only real failures start a lock. Wrong second factor codes (AC-20) and wrong current password answers on change password and two factor disable count toward the same lock; for a code attempt the key comes from the user of the pending sign in, and reaching a lock ends that pending sign in.
- **AC-4**: Public auth routes are rate limited per client IP, with counters stored in PostgreSQL so a restart does not reset them. Rate limiting is switched on in every environment (Better Auth turns it off outside production unless told otherwise). Going over a limit returns 429 with the `X-Retry-After` header. The limits are: 30 sign in attempts per minute (a shared warehouse network must survive a shift change), 3 reset requests per 15 minutes, 5 reset completions per 15 minutes, 15 second factor code attempts per 10 minutes (the per account lock of AC-3 is the tighter control).
- **AC-5**: A session expires after 12 hours without use (each use renews it, at most once an hour) and never lives longer than 7 days from sign in. Disabling cookie caching means a revoked or disabled session fails on the very next request. A request that carries a session cookie with no live session behind it (expired, signed out, disabled or revoked) returns 401 `SESSION_EXPIRED`, and a request with no cookie returns 401 `UNAUTHENTICATED`. In both cases the web app sends the person to sign in with `returnTo` set to the page they were on. Browser calls to `/api` renew the session cookie, and a test proves that a person who only loads pages is not signed out while their session row is still live.
- **AC-6**: Signing out ends only that session, clears the cookie, and sends the person to `/sign-in`. The old cookie value then fails with 401 `SESSION_EXPIRED`.
- **AC-7**: Every `/api` route except `/api/config`, `/api/health` and the allowed `/api/auth/*` routes returns 401 `UNAUTHENTICATED` without a valid session, including `GET /api/locations`. Web pages inside the shell redirect to `/sign-in?returnTo=<path>`. `returnTo` is accepted only when it starts with a single `/` (not `//` or `/\`), resolves to the `PUBLIC_URL` origin, and is not one of the `(auth)` paths; otherwise `/` is used (so `//evil.example` and full URLs are ignored). The path travels through the two factor and forced change steps. Next.js middleware passes the current path to the shell layout, because layouts cannot read it. Every non GET request to our routes must carry an `Origin` that matches `PUBLIC_URL` (CSRF defense beyond `SameSite=Lax`). Better Auth routes do not pass through the NestJS guard, so every Better Auth path not listed in the API surface returns 404 and the ones that remain apply the Origin check, the 7 day cap and the must change rule through a before hook.

> Amended 2026-11-05: the guard is audience aware, the Origin check compares against the staff origin, and portal, hook and public routes never read the session cookie; see AC-29 and AC-30. The `staff` role wording is replaced by hats (spec 0008).
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
- **AC-21**: The `create-admin` command creates the first admin from an email and name, prints a temporary password once, and sets the must change flag. It refuses when an active admin already exists or when the email already belongs to any account. Its reset mode sets a new temporary password for an existing admin, clears their lockout, and revokes their sessions. The password is written to the terminal only (the run book says not to capture it or send it to a log driver) and never to logs. It hashes with Better Auth's own password hasher and creates the `credential` account row with `account_id` equal to the user id. The reset mode does not touch two factor; recovering a lost second factor from the command line is AC-26, and the two modes can run together.
- **AC-22**: `created_by` and `posted_by` columns from spec 0002 become nullable foreign keys to `users.id`, added as `NOT VALID`, with any existing value that has no matching user set to null, then validated. Ledger posting takes `postedBy` from the signed in user. A nightly worker job (schedule `AUTH_CLEANUP_CRON`, in the timezone from the `timezone` setting, as the reconcile job reads it) deletes sessions and verifications whose `expires_at` has passed, `sign_in_attempts` rows whose lock has ended and whose window is over, `sign_in_slots` rows older than 60 seconds (normally none, since every request gives its slot back), and `rate_limits` rows whose `last_request` (milliseconds) is older than one day.
- **AC-23**: Sign in success, failure and lockout, reset requests and completions, password changes, two factor changes, and every staff admin action write one structured log line with the acting user id, target user id, client IP and user agent, and never a password, token, link or temporary password. The same actions emit past tense domain events, each carrying `actorId`, `targetId`, `ip`, `userAgent`, `at` and, where it applies, `reason`: `SignedIn`, `SignInFailed` (reason `bad_credentials`, `locked` or `disabled`), `AccountLocked`, `PasswordResetRequested`, `PasswordResetCompleted`, `PasswordChanged`, `TwoFactorEnabled`, `TwoFactorDisabled`, `StaffCreated`, `StaffUpdated`, `StaffRoleChanged`, `StaffDisabled`, `StaffEnabled`, `StaffPasswordReset`, `StaffSessionsRevoked`, `StaffTwoFactorReset`. `SignedIn` and the last sign in time are written only when a full session is issued, never after just the password step of a two factor sign in.
- **AC-24**: Every new screen works in English and Arabic (right to left), by keyboard alone, and meets WCAG 2.2 AA, including accessible authentication (no puzzle, memory test, or blocked paste). Errors are announced and focus moves to the first error. The auth screens sit outside the app shell and show the client name, a language switch and the theme choice.
- **AC-25**: The user menu replaces the placeholder with the signed in person's name, email and role, an Account link, and a working Sign out. The Staff page appears in the sidebar and command palette only for admins.
- **AC-26**: `node dist/create-admin.js --reset-two-factor --email <e>` is break glass for an admin who has lost both the authenticator app and every backup code, for example a sole admin, or every admin after a `BETTER_AUTH_SECRET` rotation. It runs only from a shell on the server, the same trust as `--reset-password` (which can already replace the password), and it is never offered over HTTP, by email, or on any screen. It refuses, exits with code 1 and changes nothing when the email has no account, when the account is not an admin (an admin resets that person's two factor from the staff page, AC-20), and when the account is disabled. In one transaction it takes `ADMIN_RULE_LOCK`, locks the user row with `FOR UPDATE`, deletes the person's `two_factors` row, sets `users.two_factor_enabled` to false, deletes all of their `sessions`, deletes their pending two factor challenge rows in `verifications` (identifier starting `2fa-`, value equal to the user id) together with each challenge's `2fa-attempts-<identifier>` counter row, and deletes the `sign_in_attempts` rows for that email so a lock built up by wrong codes (AC-3) does not outlast the recovery. It does not change the password, the must change flag, or reset tokens. An admin whose two factor is already off still succeeds with nothing to delete, so a repeated run is safe. On success it prints a confirmation naming the email to stdout and writes exactly one JSON line to stderr, `{"event":"auth.admin_break_glass_two_factor_reset","targetId":"<user id>","actor":"cli","at":"<ISO 8601 time>"}`, which holds no email, code, secret or password. `--reset-two-factor` and `--reset-password` may be given in one run: both changes happen in a single transaction (all or nothing, with the password hashed before the transaction opens), each mode writes its own audit line after the commit, and the temporary password prints once as in AC-21. `--name` with either reset flag, or either reset flag without `--email`, prints the usage and exits with code 1. The command runs outside the Nest app, so it emits no in process `StaffTwoFactorReset` event (no subscriber would receive it); the stderr line is the record until feature 14 decides durable audit, and if that feature turns the line into an event it maps to `StaffTwoFactorReset` with `actorId` null.

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
- Lockout slots (AC-3): the before hook takes a slot in `sign_in_slots` under a per email transaction advisory lock, and only real failures counted in the after hook start a lock. Why: it caps the passwords checked whatever the concurrency, a dead request frees its slot after 60 seconds on its own, and a lock never has to be undone. Runner up: count the attempt first and refund it after a success, which means taking back a lock that the refunded attempt may have started. Holding one advisory lock from check to count was rejected because it pins a pooled connection across the password hash and leaks it when the after hook does not run.
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
| ★ `sign_in_slots` | `id uuid` (`uuidv7()`); `tenant_id`; `email_key text not null`; `ip text not null`; `created_at timestamptz not null default now()` | primary key `id`; index on (`email_key`, `ip`); one row per password or code being checked right now (AC-3); no foreign key, so unknown emails behave like real ones; rows older than 60 seconds are ignored and removed nightly (AC-22); in the baseline (ADR 0003), no change to `sign_in_attempts` |

Relationships: `users` 1:N `sessions`; `users` 1:N `accounts` (in practice 1:1); `users` 1:0..1 `two_factors`. Later features' `created_by` / `posted_by` columns become nullable foreign keys to `users.id` (on delete restrict). Staff status is derived, never stored: `disabled` when `banned`, else `invited` when `last_sign_in_at` is null, else `active`.

> Amended 2026-11-05: every table also carries `tenant_id`, and the email, staff code, account and attempt keys include it; see AC-32 and the data model delta. The `role` check constraint is replaced by hats in scope feature 8 (spec 0008), not feature 13 as written here.

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

> Amended 2026-11-05: there is no OpenAPI document yet (see `AGENTS.md`); the Zod contracts are the only schema. `GET /api/me` gains `home` (AC-28).

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

> Amended 2026-11-05: the guard no longer demands a staff session on every non public audience; it checks the audience of the route (AC-29). The partner, portal and hook wording in `apps/api/src/auth/AGENTS.md` is replaced the same way.

*Web routes (`apps/web/src/app`)*: `(auth)/sign-in`, `(auth)/forgot-password`, `(auth)/reset-password` (reset and invite, same page with different wording when `invite=1`), `(auth)/two-factor`, `(auth)/change-password` (forced change); inside the shell: `account` (profile, password, two factor) and `staff` (list with create, edit and row actions). Next.js checks the session in the shell layout by calling `GET /api/me` over `API_INTERNAL_URL` with the cookie forwarded. A client side fetch wrapper turns any 401 from `/api` into a redirect to sign in.

*Commands*: `node dist/create-admin.js --email <e> --name <n>`, `node dist/create-admin.js --reset-password --email <e>`, `node dist/create-admin.js --reset-two-factor --email <e>`, and both reset flags together in one run (AC-26), a fourth entry point of the `app` image (`apps/api/src/create-admin.ts`).

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

> Amended 2026-11-05: roles are replaced by hats in scope feature 8 (spec 0008); location scoping and the cost permission belong there too. `admin` stays as built until then, and AC-33 fixes what sessions do when hats change.
- Public surface is limited to config, health and the listed Better Auth routes, all behind per IP rate limits. Sign up is closed (staff are created only by an admin or the first admin command).
- Sessions use a host only `HttpOnly` cookie; the 7 day cap and the disabled state are enforced on every request.

> Amended 2026-11-05: the staff cookie is host only on the staff host and the portal host never receives or reads it (AC-30); the path based fallback scopes it by `Path` (AC-31).
- Staff data (names, emails, phones) is personal data. Keep the fields minimal; disabled accounts are kept because the ledger needs them. No compliance regime is confirmed; erasure rules are a follow up.
- Every non GET request to our routes is rejected unless its `Origin` matches `PUBLIC_URL`, as Better Auth already does for its own routes.
- Account probing is closed on sign in (identical answers and lockout, AC-2 and AC-3), on reset (neutral answer, same timing), and by keying lockouts on email text.

**Configuration required**:
- `BETTER_AUTH_SECRET`: already generated by `bootstrap.sh`; now read and validated in `env.ts` (at least 32 characters). Rotating it signs everyone out and also makes every enrolled two factor secret and backup code unreadable, so those people need their two factor reset: by another admin from the staff page, or, for a sole admin or when no admin can pass the code step, by `create-admin --reset-two-factor` from the server shell (AC-26). The reset deletes the unreadable rows without decrypting them.
- `PUBLIC_URL`: browser facing URL; auth base URL, trusted origins and the links in emails. In `env.ts` and passed to `api` and `worker` in Compose.

> Amended 2026-11-05: replaced by `STAFF_ORIGIN` for auth when spec 0007 section "Configuration" lands, plus the optional `STAFF_BASE_PATH` (AC-30, AC-31). `PORTAL_ORIGIN` is never a trusted origin of Better Auth.
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
- Failure case: a parallel burst of 10 wrong passwords for one email and address pair has at most 5 passwords checked, read from the `SignInFailed` audit reasons (`bad_credentials` for a checked password, `locked` for one turned away); a slot left behind by a request that never finished stops counting after 60 seconds, verifies **AC-3**
- Failure case: a session older than 7 days, or idle past 12 hours, returns 401 `SESSION_EXPIRED` (test with a controllable clock), verifies **AC-5**
- Failure case: two admins disable each other at the same time; exactly one request succeeds and one admin remains, verifies **AC-17**
- Failure case: mail server down; the job retries and the sign in request still succeeds; after the last retry a log line without the link appears, verifies **AC-11**, **AC-23**
- Failure case: a used or expired reset link shows the invalid link screen, verifies **AC-9**
- Failure case: weak passwords are rejected on reset, change, invite and temporary password paths, verifies **AC-8**
- Auth/permission: every `/api` route except the public ones returns 401 without a session (include `GET /api/locations`); a `staff` role gets 403 on `/api/staff`; `/api/auth/admin/*`, `sign-up`, `update-user` and `change-email` return 404; a disabled person's old cookie fails on the next request, verifies **AC-7**, **AC-15**, **AC-16**
- Auth/permission: a `returnTo` of `//evil.example` or `https://evil.example` lands on `/`, verifies **AC-7**
- Happy path: enroll an authenticator app, sign in with a code, use a backup code once, have an admin reset it, verifies **AC-20**
- Failure case: break glass; with mail off and the only admin locked out, `create-admin --reset-password` restores access and clears the lockout, verifies **AC-21**
- Failure case: two factor break glass; the only admin has two factor on and no backup codes left (or `BETTER_AUTH_SECRET` was rotated), `create-admin --reset-two-factor` removes the second factor, ends sessions and pending challenges, clears the lockout, keeps the password, and the admin signs in with the password alone; the same command for a staff account, a disabled admin or an unknown email changes nothing and exits 1; run together with `--reset-password`, an integration test that fails the transaction partway leaves both the password and the two factor row unchanged; the stderr lines hold no email, code or password, verifies **AC-26**, **AC-21**
- Happy path: Arabic and English screens, keyboard only, with the Playwright accessibility suite on every new screen, verifies **AC-24**, **AC-19**
- Happy path: the nightly cleanup removes expired rows and leaves live ones, and posting a stock movement stores the signed in user as `posted_by`, verifies **AC-22**

## Build plan (original, built)

Tracer Bullet: the first slice is a real sign in through every layer, then each slice thickens one segment and ships on its own. Migrations follow the slices (users, sessions, accounts and verifications first; counters second; two factor table third; foreign keys last), so no slice carries tables it does not use.

1. **Thin thread, sign in and out end to end.** Add `BETTER_AUTH_SECRET` and `PUBLIC_URL` to `env.ts`; migration for `users`, `sessions`, `accounts`, `verifications`; mount Better Auth at `/api/auth` (body parser off for that path, sign up and the blocked routes closed); the `create-admin` entry point (create mode); the global `SessionGuard` with a public decorator; `GET /api/me`; the `(auth)/sign-in` page; the shell session check, a middleware that passes the path, and the redirect with a safe `returnTo`; the user menu with real name and role and a working Sign out. Satisfies **AC-1**, **AC-6**, **AC-7**, **AC-21**, **AC-25**
2. **Session policy and brute force protection.** 12 hour sliding session with the 7 day cap in the guard, cookie caching off, `SESSION_EXPIRED` handling and the client redirect; password rules shared as a Zod schema; migration for `rate_limits` and `sign_in_attempts`; per IP rate limits on database storage; the lockout hooks with identical answers; trusted proxy IP handling; the Better Auth route allowlist and before hook (Origin, 7 day cap, must change); the atomic lockout upsert; the after hook for last sign in and the counter reset; sign in logging and events. Satisfies **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-8**, **AC-23**
3. **Mail and password reset.** The mail module with the SMTP and Postmark adapters and env validation; pg-boss producer in the api and the `mail.send` queue in the worker with retries; English and Arabic templates; `mailEnabled` in `GET /api/config`; forgot password and reset pages; reset flow with session revocation, `onPasswordReset`, old token deletion, the padded response time, and the token check redirect. Satisfies **AC-9**, **AC-10**, **AC-11**
4. **Staff administration.** `StaffService` (create, edit, disable, enable, reset password, revoke sessions, advisory lock for the last admin rule), temporary passwords, invites through `verifications`, resend invite, the must change flag gating, the `RolesGuard`, `/api/staff` endpoints with contracts, the `staff` page, the nav entry, the invite wording on the reset page, the forced `change-password` page, admin events and logs. Satisfies **AC-12**, **AC-13**, **AC-14**, **AC-15**, **AC-16**, **AC-17**, **AC-18**, **AC-23**
5. **Account page and language sync.** `PATCH /api/me`, the `account` page (profile, change password), and saving the language to the account and applying it at sign in. Satisfies **AC-19**
6. **Two factor.** Migration for `two_factors`; enable, verify, backup codes and disable; the `two-factor` sign in step; lockout counting of wrong codes; admin reset of two factor. Satisfies **AC-20**, **AC-3**
7. **Ledger link and cleanup.** Migration adding the foreign keys from `created_by` and `posted_by`; wire `postedBy` from the guard into ledger posting; the nightly `auth.cleanup` job in the worker with `AUTH_CLEANUP_CRON`; `create-admin --reset-password`. Satisfies **AC-22**, **AC-21**
8. **Hardening and finish.** English and Arabic catalogs for every screen, the Playwright flows and accessibility suite for the new screens, a sign in helper for the existing end to end tests, `deploy/.env.example` and `bootstrap.sh` updates, and a short run book for `create-admin` and break glass recovery. Satisfies **AC-24**, **AC-21**, **AC-7**
9. **Two factor break glass.** Status: done. Backend: add `--reset-two-factor` to `apps/api/src/create-admin.ts` and the reset logic beside `apps/api/src/auth/reset-admin.ts`, sharing one transaction when both flags are given; the usage text; the audit line; tests for the refusals, the combined run and the absence of secrets in the output. Docs: the run book replaces "no recovery from the command line" with this command. Done when: the AC-26 test plan case passes and the run book names the command. Satisfies **AC-26**, **AC-21**

## Consequences

**Positive**:
- Every `/api` route now runs as a known person, so costs and stock values can be protected by roles in feature 13 and every movement carries a real `posted_by`.
- Disabling a leaver takes effect on their next request, not at the end of a session.
- Works fully on premises: no outside identity service, and every recovery path (temporary passwords, `create-admin --reset-password`, `create-admin --reset-two-factor`) works with no mail and no internet.
- Account probing is closed at sign in and reset, and brute force is slowed twice (per IP and per email).
- One contract and one OpenAPI document cover all our own endpoints; the browser never talks to Better Auth's admin routes.

> Amended 2026-11-05: there is no OpenAPI document; the Zod contracts in `packages/contracts` are the single description.

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
- Anyone with shell access to the server can remove an admin's second factor. That is no wider than today, since the same access can already replace the password, but it means two factor protects against a stolen password, not against a compromised host.
- Every request reads the session and user from the database (cookie cache is off). That is fine at back office volumes and should be measured at feature 16.
- Staff cannot change their own email, and a live account's email cannot be changed by anyone, until a later feature.

**Neutral**:
- A fourth entry point, `create-admin`, ships in the `app` image next to `api`, `worker` and `migrate`.
- The api process starts a send only pg-boss client (no scheduling or maintenance) with a pool of 2 connections.
- Roles are just `admin` and `staff` until feature 13.

> Amended 2026-11-05: until spec 0008 (scope feature 8, roles as hats), not feature 13.
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

> Amended 2026-11-05: this is now scope feature 8 (spec 0008). Feature 13 is the Shopify connector.
- [ ] Feature 14: subscribe to the staff and sign in events and decide how audit entries are stored durably.

> Amended 2026-11-05: the audit trail is scope feature 10, not 14.
- [ ] Feature 16: alert on repeated mail job failures; measure per request session lookups.
- [ ] Needs a decision later: erasure or anonymising former staff data if a client falls under data protection rules; changing the email of a live account; session list with "sign out other devices".
- [ ] Existing end to end tests that call `/api/locations` unauthenticated need the new sign in helper (build plan step 8).
- [ ] Confirm the api port is not published outside Compose, so `X-Forwarded-For` cannot be forged around Caddy.
- [ ] The run book must cover lockout abuse and `create-admin --reset-password`, and say not to capture the `create-admin` output.
- [ ] The run book must document `create-admin --reset-two-factor` and the combined run, and drop the statement that a sole admin has no recovery after a rotation (docs writer).
- [ ] Pin the pg-boss major version and set `retryLimit`, delays and deletion options for the mail queue.
- [ ] If the pinned invite token test cannot hold across a Better Auth upgrade, fall back to Better Auth's own `requestPasswordReset` for invites.
- [ ] Test explicitly that the session cookie renews when a person only loads pages.
