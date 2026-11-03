# Verify: staff sign in · spec 0005 · updated 2026-11-03

_Steps derived from spec 0005 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones. This file holds the thin thread slice (AC-1, AC-6, AC-7, AC-21, AC-25). Each later slice appends its own steps._

## UI / manual

Run against a throwaway database with a created admin (see Commands), the api on one port and the web dev server on another, `PUBLIC_URL` set to the web address.

- [ ] Open `/design` signed out → expect a redirect to `/sign-in?returnTo=%2Fdesign`, no sidebar or user menu, exactly one `h1` → AC-7
- [ ] Sign in with the admin email typed in capitals and the temporary password → expect to land on `/design`, the user menu shows the name → AC-1
- [ ] Open the user menu → expect name, email (left to right), and role "Administrator" → AC-1, AC-25
- [ ] Open `/sign-in?returnTo=//evil.example`, then `/sign-in?returnTo=https://evil.example`, sign in each time → expect to land on `/` both times → AC-7
- [ ] Sign in with a wrong password, then with an unknown email → expect the same message each time, typed values kept → AC-2 (full lockout rules arrive in the next slice)
- [ ] User menu → Sign out → expect `/sign-in`, then go back with the browser button → expect a redirect to sign in again → AC-6
- [ ] Open the browser tools, Application tab, cookies → expect the session cookie `HttpOnly`, `SameSite=Lax`, no `Domain`, and `Secure` only when `PUBLIC_URL` is https → AC-1
- [ ] Switch the language to Arabic on the sign in page → expect the form to flip to right to left with every string translated → AC-24 (full screen audit in the hardening slice)

## Commands

- [ ] `node apps/api/dist/create-admin.js --email owner@example.com --name "Owner One"` on an empty database → expect "Admin created" and a 16 character temporary password printed once → AC-21
- [ ] Run the same command again with another email → expect exit code 1 and "An active admin already exists" → AC-21
- [ ] `curl -i http://localhost:3101/api/me` with no cookie → expect 401 `UNAUTHENTICATED` → AC-7
- [ ] `curl -i http://localhost:3101/api/locations` with no cookie → expect 401 `UNAUTHENTICATED` → AC-7
- [ ] `curl -i http://localhost:3101/api/config` and `/api/health` with no cookie → expect 200 → AC-7
- [ ] `curl -i -X POST http://localhost:3101/api/auth/sign-up/email -H "origin: <PUBLIC_URL>" -H "content-type: application/json" -d '{}'` → expect 404; same for `/api/auth/admin/list-users`, `/api/auth/get-session`, `/api/auth/update-user`, `/api/auth/change-email` → AC-7, AC-15
- [ ] Sign out, then `curl -i http://localhost:3101/api/me -H "cookie: <old cookie>"` → expect 401 `SESSION_EXPIRED` → AC-6
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- sign-in` → expect all tests pass → AC-1, AC-6, AC-7, AC-21

## Value sourcing

- [ ] Sign in with `returnTo=/staff?q=sam` → expect to land on `/staff?q=sam` (the path and query come only from `returnTo`) → AC-1, AC-7
- [ ] Run the api with an `https` `PUBLIC_URL` and sign in → expect the cookie to be `Secure`; with `http` → expect it not to be (the scheme of `PUBLIC_URL` decides) → AC-1
- [ ] Disable the admin in the database (`UPDATE users SET banned = true`) while signed in → expect the next `/api/me` to be 401 `SESSION_EXPIRED` (the person comes from the `users` row on every request) → AC-7
- [ ] Send a request with a cookie but no live session, then one with no cookie → expect `SESSION_EXPIRED`, then `UNAUTHENTICATED` (cookie present or not decides the code) → AC-7
- [ ] Send `x-pathname: //evil.example` on a page request while signed out → expect `returnTo` to be absent in the redirect (the proxy overwrites the header, then the path is validated) → AC-7
- [ ] Create the first admin, then read `users` → expect `must_change_password = true` and `accounts.account_id = users.id` → AC-21

## Acceptance-criteria coverage

- AC-1 … sign in, cookie flags, landing page, user menu · covered by UI steps 2, 3, 7 and Value sourcing steps 1, 2 (the `last_sign_in_at` write is checked in the e2e test)
- AC-6 … sign out and the old cookie · covered by UI step 6 and Commands step 7
- AC-7 … guard on `/api`, shell redirect, `returnTo` safety, closed Better Auth routes · covered by UI steps 1, 4 and Commands steps 3 to 6 (Origin check on writes is covered by the guard unit tests; the Better Auth before hook arrives in the next slice)
- AC-21 … first admin command · covered by Commands steps 1, 2 and the last Value sourcing step (reset mode arrives in slice 7)
- AC-25 … user menu with real identity and Sign out · covered by UI steps 3, 6 (the Account link and the admin only Staff page arrive in slices 4 and 5)
- AC-2, AC-24 … only partly built here, see the notes on the steps above

# Slice 2: session policy and lockout · updated 2026-11-03

_AC-2, AC-3, AC-4, AC-5, AC-8, AC-23. Run against a throwaway database. Every request to the api needs an `x-forwarded-for` header, because Caddy sets it in a real install. Use a different address for each scenario so the per address limits do not mix._

## UI / manual

- [ ] On `/sign-in` enter a real email with a wrong password five times in a row, then the correct password → expect the same "wrong email or password" message every time, with no hint that the account is locked → AC-2, AC-3
- [ ] Repeat with an email that has no account → expect exactly the same messages and timing feel as the real one → AC-2, AC-3
- [ ] Disable the person in the database, then sign in with the correct password → expect the "account disabled, ask an administrator" message and no session; with a wrong password → expect the generic message → AC-2
- [ ] Sign in, then set `sessions.created_at` to 8 days ago and reload any page inside the shell → expect a redirect to `/sign-in?returnTo=<that page>` → AC-5
- [ ] Send more than 30 sign in attempts in a minute from one address → expect the form to show the "too many attempts, try again later" message → AC-4

## Commands

- [ ] Five wrong passwords for one email from one address, then the correct one → expect 401 `INVALID_EMAIL_OR_PASSWORD` with a body identical to the wrong password answer, and no `set-cookie` → AC-2, AC-3
- [ ] `SELECT scope, failures, locked_until FROM sign_in_attempts` → expect one row for the address and one `*` row, both with 5 failures, and `locked_until` about 15 minutes ahead on the address row → AC-3
- [ ] Twenty wrong passwords for one email from twenty different addresses, then the correct one from a new address → expect 401 and a locked `*` row → AC-3
- [ ] Ten wrong passwords for one email fired at the same moment → expect `failures = 10` on both rows (no lost counts) → AC-3
- [ ] Set `locked_until` and `window_started_at` in the past, then sign in with the correct password → expect 200 and no rows left for that email → AC-3
- [ ] Four wrong passwords, a correct sign in, then four wrong passwords and a correct one → expect 200 (the counter reset after the full sign in) → AC-3
- [ ] 31 sign ins in a minute from one address → expect the 31st to be 429 with an `X-Retry-After` header; restart the api and try again → expect 429 still → AC-4
- [ ] `SELECT key, count FROM rate_limits` → expect the counter row for that address and path → AC-4
- [ ] `UPDATE sessions SET expires_at = now() + interval '10 hours'` then `GET /api/me` → expect 200, a new `set-cookie`, and `expires_at` about 12 hours ahead; `GET /api/me` right after a fresh sign in → expect no `set-cookie` → AC-5
- [ ] `UPDATE sessions SET expires_at = now() - interval '1 minute'`, then `GET /api/me` → expect 401 `SESSION_EXPIRED` → AC-5
- [ ] `UPDATE sessions SET created_at = now() - interval '7 days 1 minute'` on a session used a minute ago, then `GET /api/me` → expect 401 `SESSION_EXPIRED` and the session row gone → AC-5
- [ ] `curl -i -X POST .../api/auth/sign-in/email -H "origin: https://evil.example"` → expect 403 and no cookie → AC-7
- [ ] Read the api log after the sign in steps → expect one `SignInFailed` line per failure (reason `bad_credentials`, `locked` or `disabled`), one `AccountLocked` line when a lock starts, one `SignedIn` line per full sign in, each with actor, target, `ip` and `userAgent`, and no password, no email text → AC-23
- [ ] `pnpm --filter @ssdashboard/api test:e2e` → expect every suite to pass, `sign-in-policy` included → AC-2, AC-3, AC-4, AC-5, AC-23

## Value sourcing

- [ ] Sign in with `Sam@Example.com` five times wrong, then `sam@example.com` → expect the lock to apply (the key is the lowercase trimmed email text) → AC-3
- [ ] Send the same five wrong attempts with different `x-forwarded-for` values → expect no address lock, only the `*` row growing (the scope is the first forwarded address) → AC-3
- [ ] Send `x-forwarded-for: *` → expect it to be counted under the `unknown` address, never the `*` row → AC-3
- [ ] Lock an email, then read `locked_until` → expect server time plus 15 minutes → AC-3
- [ ] Read `sessions.created_at` of a session older than 7 days that was renewed → expect the 7 day cap to count from `created_at`, not from `expires_at` → AC-5
- [ ] Unit: `unmetPasswordRules` for `abc` → expect `min_length`, `uppercase`, `digit`; for 129 characters → expect `max_length` → AC-8 (the 422 `WEAK_PASSWORD` answer is checked when the reset and change routes open in slices 3 and 4)

## Acceptance-criteria coverage

- AC-2 … identical answers, disabled rules · covered by UI steps 1 to 3 and Commands step 1
- AC-3 … lockout by pair and by email, atomic count, reset after a full sign in · covered by Commands steps 1 to 6 and Value sourcing steps 1 to 4
- AC-4 … database rate limits, 429 with `X-Retry-After`, survives a restart · covered by UI step 5 and Commands steps 7, 8 (reset and second factor limits are configured but their routes open in slices 3 and 6)
- AC-5 … 12 hour sliding session, 7 day cap, `SESSION_EXPIRED` and the client redirect · covered by UI step 4 and Commands steps 9 to 11 and Value sourcing step 5
- AC-8 … password rule · covered by the unit step, the temporary password test, and the 422 step to run in slices 3 and 4
- AC-23 … logging and events for sign in outcomes · covered by Commands steps 13, 14 (the staff, reset and two factor events arrive with their slices)
