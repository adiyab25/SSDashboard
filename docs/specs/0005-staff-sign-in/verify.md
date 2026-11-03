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

# Slice 3: mail and password reset · updated 2026-11-03

_AC-9, AC-10, AC-11, and the rest of AC-4 and AC-8 for the reset routes. Run against a throwaway database with the api and the worker both running (`node dist/main.js` and `node dist/worker.js`, same environment). For mail, point `MAIL_DRIVER=smtp` at any SMTP catcher (MailHog on port 1025, or a local test server) with `SMTP_SECURITY=none`. The sign in and reset pages are best checked in a real browser at `PUBLIC_URL`._

## UI / manual

- [ ] Open `/sign-in` → expect a "Forgot your password?" link under the password field, left aligned (English) and right aligned (Arabic) → AC-9, AC-24
- [ ] Open `/forgot-password` with mail on, enter a real email → expect the "Check your email" screen, the heading focused, and the same screen for an email with no account → AC-9
- [ ] Open the catcher → expect one email within a few seconds, from the `MAIL_FROM` sender, with a button and a plain link → AC-9, AC-11
- [ ] Click the link → expect the "Choose a new password" page with the rules list, all unticked → AC-9, AC-8
- [ ] Type `abc` then `Abcdefg1`, one key at a time → expect each rule to tick off as it is met, with an icon change and not only a colour change → AC-8, AC-24
- [ ] Submit `abc` → expect nothing sent, focus on the field, and the "does not meet the rules" message → AC-8
- [ ] Paste a strong password with a password manager or the clipboard → expect it to be accepted (paste is never blocked), and `autocomplete="new-password"` on the field → AC-8, AC-24
- [ ] Submit a strong password → expect "Your password is set" with the heading focused, then sign in with the new password → expect success; the old password → expect the generic error → AC-9
- [ ] Click the same email link again → expect the "This link is no longer valid" screen with a "Request a new link" button, before any typing → AC-9
- [ ] Set the language to Arabic and repeat the forgot, reset and invalid link screens → expect right to left, every string translated, and a left to right link in the email body → AC-24, AC-11
- [ ] Run the api with `MAIL_DRIVER=none` and open `/forgot-password` → expect "Ask an administrator" with no email field → AC-10
- [ ] Press Tab through each new screen with no mouse → expect every control reachable in a sensible order with a visible focus ring → AC-24
- [ ] Open `/reset-password?token=abc&invite=1` → expect the heading "Set your password" and the invite wording → AC-13 (the invite email itself arrives in slice 4)

## Commands

- [ ] `POST /api/auth/request-password-reset` for a real and an unknown email, with timing → expect the same 200 body for both and at least 500 ms each → AC-9
- [ ] A disabled person requests a reset → expect the same 200 body, no email in the catcher, and no row left in `verifications` for them → AC-9
- [ ] An account that has never signed in requests a reset → expect an email (invited accounts are included) → AC-9
- [ ] Request twice for one person → expect two emails, only the second link working, and one `reset-password:%` row left in `verifications` → AC-9
- [ ] `GET /api/auth/reset-password/<token>?callbackURL=<PUBLIC_URL>/reset-password` with `-i` and no redirect following → expect 302 to `.../reset-password?token=<token>`, and `?error=INVALID_TOKEN` for a wrong, used or expired token → AC-9
- [ ] `POST /api/auth/reset-password` with `abc`, `alllowercase1`, `ALLUPPERCASE1`, `NoDigitsHere` → expect 422 `WEAK_PASSWORD` with the matching `unmet` list each time, and the token still usable → AC-8
- [ ] `POST /api/auth/reset-password` with a strong password → expect 200, all that person's sessions gone (`GET /api/me` with an old cookie is 401), `users.email_verified = true`, `must_change_password = false`, and no `sign_in_attempts` rows for them → AC-9
- [ ] Use the same token again → expect 400 `INVALID_TOKEN` → AC-9
- [ ] Four more `request-password-reset` calls from one address inside 15 minutes → expect 429 with `X-Retry-After` on the fourth; six `reset-password` calls → expect 429 on the sixth → AC-4
- [ ] `POST /api/auth/reset-password` with `origin: https://evil.example` → expect 403 → AC-7
- [ ] `curl http://localhost:3001/api/config` with mail on and with `MAIL_DRIVER=none` → expect `mailEnabled` true, then false → AC-10
- [ ] With `MAIL_DRIVER=none`, request a reset → expect the same 200 body, no job in `pgboss.job` for `mail.send`, and no `reset-password:%` row left → AC-10, AC-11
- [ ] `SELECT data FROM pgboss.job WHERE name = 'mail.send'` → expect only `userId`, `kind` and `tokenId`, never a token or link → AC-11
- [ ] Stop the mail server, request a reset → expect 200 at once, and the worker log to say `failed (try 1), will retry` with the job id and no link; start the server again before the retry → expect the email to arrive → AC-11
- [ ] Read the api and worker logs → expect `PasswordResetRequested` and `PasswordResetCompleted` lines with actor, target, `ip` and `userAgent`, and no token, link, password or email text → AC-23, AC-11
- [ ] `MAIL_DRIVER=smtp` with no `MAIL_FROM`, then with no `SMTP_HOST`, then with only `SMTP_USER` → expect the process to stop at startup naming the missing setting; `MAIL_DRIVER=postmark` with no token → same → AC-11
- [ ] `pnpm --filter @ssdashboard/api test:e2e` → expect every suite to pass, `password-reset` included → AC-9, AC-10, AC-11

## Value sourcing

- [ ] Send a reset request with `x-forwarded-host: evil.example` or a `redirectTo` on another site → expect the email link to still start with `PUBLIC_URL` (the base comes from the env, never a header) and an off site `redirectTo` to be refused → AC-9
- [ ] Give one person `language = 'ar'` and another none, with the install default set to `ar` → expect Arabic for both; set the install default to `en` → expect English for the second only (saved language, then install default, then English) → AC-11
- [ ] Set `CLIENT_DISPLAY_NAME=Acme Home` → expect it in the subject, the footer and the sender display name via `MAIL_FROM` → AC-11
- [ ] Read `verifications.expires_at` for a reset token → expect about 1 hour after the request (invite tokens will show 7 days from slice 4) → AC-9
- [ ] Set `MAIL_DRIVER=postmark` with a token and a verified sender → expect the same email through Postmark; with an unverified sender → expect a worker log line with Postmark's error code and message → AC-11
- [ ] Rotate nothing, but read `GET /api/config` from a web page served by an older api image → expect `mailEnabled` to default to false and the forgot page to say to ask an administrator → AC-10

## Acceptance-criteria coverage

- AC-9 … neutral answer and timing, older tokens deleted, one use, session and lockout clearing, invalid link screen · covered by UI steps 1 to 9 and Commands steps 1 to 8
- AC-10 … no mail mode · covered by UI step 11 and Commands steps 11, 12
- AC-11 … queue holding ids only, worker send, retries, language, no link in logs · covered by UI steps 3, 10 and Commands steps 13 to 16 and Value sourcing steps 2 to 5 (the final retry log line is covered by the worker unit tests, since a real run takes about 15 minutes)
- AC-8 … rule shown before submit, paste allowed, 422 `WEAK_PASSWORD` on reset · covered by UI steps 5 to 7 and Commands step 6 (change password is checked in slice 4)
- AC-4 … reset limits · covered by Commands step 9
- AC-23 … reset events · covered by Commands step 15
