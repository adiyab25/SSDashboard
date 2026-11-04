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

# Slice 4: staff administration and the forced password change · updated 2026-11-04

_AC-12 to AC-18, AC-14 on the web, and AC-23 for the staff events. Run against a throwaway database with the api (and, for the mail steps, the worker and an SMTP catcher). Create the first admin with `create-admin`, sign in, and change the temporary password first._

## UI / manual

- [ ] Sign in as the new first admin with the temporary password → expect the "Change your password" screen, never the app, with the page you asked for kept in `returnTo` → AC-14
- [ ] On that screen type a wrong current password → expect "The current password is not right"; type a weak new password → expect the rules list to show what is missing and nothing sent; use a good one → expect to land on the page you asked for → AC-8, AC-14
- [ ] While the flag is set, open `/staff` by typing the address → expect the change password screen again, and "Sign out instead" to work → AC-14
- [ ] Sign in as an admin → expect "Staff" in the sidebar and in the command palette; sign in as a staff role → expect neither, and `/staff` to say "Only administrators can manage staff" → AC-15, AC-25
- [ ] Open `/staff` → expect one `h1`, a table with name, email (left to right), role, status, last sign in and two factor, and no sideways scroll of the whole page on a phone width → AC-24
- [ ] Search for part of a name, an email, a staff code, and for `50%` → expect only real matches each time, and a pause of about a third of a second after typing → AC-15
- [ ] Filter by Invited, Active and Disabled → expect each list to match the status column → AC-15
- [ ] Add a person with mail off → expect the "Temporary password for ..." dialog showing 16 characters once, a Copy button, and after Done the password is gone from the page → AC-12
- [ ] Add the same email in capitals, then the same staff code → expect the error on that field with focus on it → AC-12
- [ ] Sign in as the new person with the temporary password → expect the change password screen first → AC-14
- [ ] Edit a person who has signed in → expect the email field disabled with a note; edit one who is still invited → expect it editable → AC-15
- [ ] Row menu → Reset password (mail off) → expect a confirmation that names the action, then a new temporary password once; the person's old password and open sessions stop working at once → AC-18
- [ ] Row menu → Disable with a reason, then try the person's open browser → expect their next click to land on sign in; then Enable → expect them able to sign in again → AC-16
- [ ] Try to disable your own row → expect no Disable item; try to demote or disable the only admin → expect "There must always be at least one active administrator" → AC-17
- [ ] Switch to Arabic and repeat the add, reset and disable dialogs → expect right to left, every string translated, and the email and temporary password left to right → AC-24
- [ ] Press Tab through the page, open a row menu with the keyboard, and close a dialog with Escape → expect a visible focus ring and focus returning to the row button → AC-24

## Commands

- [ ] `GET /api/staff` with no cookie, with a staff role, with an admin → expect 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 200 → AC-15
- [ ] `POST /api/auth/admin/list-users`, `/api/auth/sign-up/email`, `/api/auth/update-user`, `/api/auth/change-email` → expect 404 each → AC-15
- [ ] `POST /api/staff` with a name, email and role (mail off) → expect 201, `setup.mode = temporary_password`, `must_change_password = true`, and only a hash stored → AC-12
- [ ] The same with a bad email, a name over 100 characters, a phone of 4 characters, and an unknown language → expect 422 `VALIDATION_FAILED` or `INVALID_LANGUAGE` → AC-12
- [ ] Email in capitals and a staff code in lowercase → expect the stored email lowercase and the staff code uppercase; a duplicate of either → expect 409 `EMAIL_TAKEN` or `STAFF_CODE_TAKEN` → AC-12
- [ ] Sign in with the temporary password, then `GET /api/me` → expect 200 with `mustChangePassword: true`; `GET /api/locations` and `GET /api/staff` → expect 403 `PASSWORD_CHANGE_REQUIRED` → AC-14
- [ ] `POST /api/auth/change-password` with a weak password, a wrong current password, then a good one with `revokeOtherSessions` → expect 422 `WEAK_PASSWORD`, 400 `INVALID_PASSWORD`, then 200, with other sessions gone and `GET /api/locations` now 200 → AC-8, AC-14
- [ ] Five wrong current passwords on change password → expect the same lock as sign in, and then the right current password also gets 400 `INVALID_PASSWORD` → AC-3
- [ ] `GET /api/staff?limit=2` and follow `nextCursor` until it is null → expect every row once, ordered by lowercase name; `limit=101`, `limit=0`, `cursor=AAAA`, `status=banned` → expect 400 `INVALID_QUERY` → AC-15
- [ ] `GET /api/staff/<id>` → expect phone, staffCode, language, disableReason and createdAt; an unknown or malformed id → expect 404 → AC-15
- [ ] `PATCH /api/staff/<id>` with a new name, an empty phone, a new role → expect the new values and a cleared phone; a new email on someone who has signed in → expect 409 `EMAIL_LOCKED` → AC-15
- [ ] `POST /api/staff/<id>/disable` with a reason → expect `status = disabled`, the reason in `disableReason`, no rows left in `sessions` or `verifications` for them, the `users` row kept, and sign in with the right password 403 `BANNED_USER` → AC-16
- [ ] `POST /api/staff/<id>/enable` → expect `disableReason` cleared and sign in working → AC-16
- [ ] Two admins each disable the other in the same instant → expect exactly one 200, the other 409 `LAST_ADMIN` or 401, and one active admin left; demote the only active admin → expect 409 `LAST_ADMIN`, but allowed when an invited admin exists → AC-17
- [ ] `POST /api/staff/<id>/disable` on yourself → expect 409 `SELF_DISABLE` → AC-17
- [ ] `POST /api/staff/<id>/reset-password` (mail off) → expect a temporary password, the old password refused at once, sessions gone, the lock cleared, `must_change_password = true` → AC-18
- [ ] `POST /api/staff/<id>/revoke-sessions` → expect `{count}` and the password unchanged; an unknown id on any action → expect 404 → AC-18
- [ ] `POST /api/staff/<id>/resend-invite` on someone active, and on an invited person with mail off → expect 409 `NOT_INVITED`, then 409 `MAIL_DISABLED` → AC-12
- [ ] With mail on, create a person → expect `setup.mode = email`, an invite email in the person's language, a link that works for 7 days, redirecting to `/reset-password?invite=1&token=...`, and a strong password setting `email_verified = true` and clearing the flag → AC-12, AC-13
- [ ] Resend the invite → expect a second email, and the first link now `INVALID_TOKEN`; admin reset with mail on → expect a 1 hour reset link and `setup.mode = email` → AC-13, AC-18
- [ ] Read the api log after the steps above → expect `StaffCreated`, `StaffUpdated`, `StaffRoleChanged`, `StaffDisabled` (with the reason), `StaffEnabled`, `StaffPasswordReset`, `StaffSessionsRevoked` and `PasswordChanged` lines with actor, target, `ip` and `userAgent`, and no temporary password → AC-23
- [ ] `pnpm --filter @ssdashboard/api test:e2e` → expect every suite to pass, `staff` included → AC-12 to AC-18

## Value sourcing

- [ ] Compare `GET /api/staff` status with the database → expect `disabled` when `banned`, `invited` when `last_sign_in_at` is empty, else `active` (status is derived, never stored) → AC-15
- [ ] Give a person a name with `%` and `_`, search for them → expect an exact contains match, not a pattern match → AC-15
- [ ] Add a person with `language` set to a language the install does not enable → expect 422 `INVALID_LANGUAGE`; the allowed set comes from `GET /api/config` → AC-12
- [ ] Set `MAIL_DRIVER=smtp` then `none` → expect the setup result to be `email` then `temporary_password`, and the Resend invite item to appear only with mail on (`mailEnabled` from `GET /api/config`) → AC-12
- [ ] Change a person's role while signed in as them elsewhere → expect their next request to see the new role (the guard reads the user fresh every time) → AC-15
- [ ] Read a created person's `accounts` row → expect `provider_id = credential` and `account_id` equal to the user id → AC-12

## Acceptance-criteria coverage

- AC-12 … create, setup result, duplicates · covered by UI steps 8, 9 and Commands steps 3 to 5, 18, 19, and Value sourcing steps 3, 4, 6
- AC-13 … invite link sets the first password · covered by Commands steps 19, 20 and the Slice 3 UI step for `?invite=1`
- AC-14 … forced change gating, web redirect, flag cleared on change · covered by UI steps 1 to 3, 10 and Commands steps 6, 7
- AC-15 … admin only, list, search, filters, paging, edit, email lock, closed Better Auth routes · covered by UI steps 4 to 7, 11 and Commands steps 1, 2, 9 to 11 and Value sourcing steps 1, 2, 5
- AC-16 … disable and enable · covered by UI step 13 and Commands steps 12, 13
- AC-17 … last admin, self disable, simultaneous disable · covered by UI step 14 and Commands steps 14, 15
- AC-18 … admin reset and revoke · covered by UI step 12 and Commands steps 16, 17, 20
- AC-23 … staff events and logs · covered by Commands step 21
- AC-24, AC-25 … covered by UI steps 4, 5, 15, 16 (the Account link arrives in slice 5)

# Slice 5: account page and language sync · updated 2026-11-04

_AC-19, AC-25 (the Account link), and AC-8 for the self service password change. Run against a throwaway database with the api and web both running._

## UI / manual

- [ ] Open the user menu → expect an "Account" item between the language rows and Sign out, opening `/account` → AC-25
- [ ] On `/account` → expect one `h1`, your email (left to right), role and staff code as plain text, and editable name, phone and language only, with the note that an administrator changes the rest → AC-19, AC-24
- [ ] Change the name and phone, press Save → expect "Your details are saved.", and the new name in the user menu after a reload → AC-19
- [ ] Empty the name, then enter a phone of 4 characters → expect each error linked to its field with focus on it, and nothing sent → AC-19
- [ ] Empty the phone and press Save → expect the phone cleared (it shows empty after a reload) → AC-19
- [ ] Choose a language in the user menu, then reload on another browser profile and sign in → expect that browser to open in the saved language → AC-19
- [ ] Sign in on a screen set to English with an account saved as Arabic → expect the app to open in Arabic and right to left, with the saved language beating the one picked on the sign in screen → AC-19
- [ ] Sign in with an account that has no saved language, with the screen set to Arabic → expect Arabic to stay → AC-19
- [ ] Change your password with a wrong current password, a weak new one, then a good one → expect the matching messages, the rules list ticking as you type, and a success note that says the other sessions were signed out → AC-8, AC-19
- [ ] After the change, open the app on another browser that was signed in → expect it to be sent to sign in → AC-19
- [ ] Press Tab through the page and use the language select with the keyboard → expect a visible focus ring and nothing that needs a mouse → AC-24
- [ ] Switch to Arabic → expect the page to flip right to left with every string translated, and the email left to right → AC-24

## Commands

- [ ] `PATCH /api/me` with `{"name":"  Samira Ali ","phone":"+20 100 123 4567","language":"ar"}` → expect 200 with the trimmed name, and `GET /api/me` to show the same → AC-19
- [ ] `PATCH /api/me` with `{"phone":"","language":""}` → expect both `null`; with `{"name":"Only"}` → expect the other fields untouched → AC-19
- [ ] `PATCH /api/me` with `{"language":"xx"}` → expect 422 `INVALID_LANGUAGE`; with an empty name or a 4 character phone → expect 422 `VALIDATION_FAILED` → AC-19
- [ ] `PATCH /api/me` with `email`, `role`, `staffCode`, `banned` or `mustChangePassword` in the body → expect 422 `VALIDATION_FAILED` and the stored values unchanged → AC-19
- [ ] `PATCH /api/me` naming another person's id or fields → expect only your own row to change → AC-19
- [ ] `PATCH /api/me` with no cookie, and with a temporary password still in force → expect 401, then 403 `PASSWORD_CHANGE_REQUIRED` → AC-14, AC-19
- [ ] As an admin, search `/api/staff?q=<new name>` after a person renamed themselves → expect the new name → AC-19
- [ ] `POST /api/auth/change-password` with a wrong current, a weak new, then a good one with `revokeOtherSessions` → expect 400 `INVALID_PASSWORD`, 422 `WEAK_PASSWORD`, then 200, with another session's `GET /api/me` now 401 → AC-8, AC-19
- [ ] `pnpm --filter @ssdashboard/api test:e2e` → expect every suite to pass, `profile` included → AC-19

## Value sourcing

- [ ] Save a language on one device, then `GET /api/me` from a new session → expect `language` to be the saved value (the account row, not a cookie) → AC-19
- [ ] After sign in, read the `ss_lang` cookie → expect it to equal `users.language` when set, written by the same function the language switcher uses → AC-19
- [ ] Disable a language in the `languages` setting, then save it from the account page → expect 422 `INVALID_LANGUAGE` (the allowed set is the install's enabled languages) → AC-19
- [ ] Read the Account page's role and staff code after an admin changes them → expect the new values on the next load (they come from `GET /api/me`, never from the form) → AC-19

## Acceptance-criteria coverage

- AC-19 … own name, phone and language; own password with the current one; no email, role or staff code; language saved from the menu and applied at sign in · covered by every step above
- AC-25 … the Account link · covered by UI step 1 (the admin only Staff page was covered in slice 4)
- AC-8 … rules before submit, paste allowed, right autocomplete values on the self service form · covered by UI steps 9, 11 and Commands step 8

# Slice 6: two factor sign in · updated 2026-11-04

_AC-20, and the two factor parts of AC-3, AC-4, AC-23 and AC-24. Run against a throwaway database with the api and web running, and a real authenticator app (or any TOTP tool) for the QR code steps._

## UI / manual

- [ ] Open `/account` → expect a "Two factor sign in" section showing Off, with a Turn on button only → AC-20
- [ ] Turn on with a wrong password → expect "The password is not right" and no QR code; then with the right password → expect the QR code and the setup key (left to right, in groups of four), and no backup codes yet → AC-20
- [ ] Scan the QR code with your authenticator app → expect an entry named after the install and your email → AC-20
- [ ] Type a wrong code → expect "That code is not right" and two factor still Off; close the dialog and reopen it → expect to start again from the password → AC-20
- [ ] Type the right code → expect the "Save your backup codes" step with 10 codes and a Copy codes button, and no way to see them again after "I saved them" → AC-20
- [ ] The section now says On with "New backup codes" and "Turn off" buttons → AC-20
- [ ] Sign out and sign in → expect the "Enter your code" screen after the password, with one `h1`, and no way into the app yet → AC-20, AC-24
- [ ] Enter a wrong code → expect the error with focus back in the field; enter the right code → expect the page you asked for in `returnTo`, and your saved language → AC-19, AC-20
- [ ] Sign in again, choose "Use a backup code instead", enter one backup code → expect to be signed in; reuse the same code on another sign in → expect "not right, or it was already used" → AC-20
- [ ] Wait 10 minutes on the code screen, then submit → expect "This sign in has expired or was stopped" with a way back → AC-20
- [ ] Enter 5 wrong codes in a row → expect the next try, even with the right code, to fail, and the password step from the same address to say the usual wrong email or password → AC-3
- [ ] New backup codes → expect the password to be asked, 10 new codes shown once, and the old ones refused at sign in → AC-20
- [ ] Turn off → expect the password to be asked, the section to say Off, and the next sign in to need no code → AC-20
- [ ] As an admin open the row menu of someone with two factor on → expect "Reset two factor" (and not for someone without it); confirm → expect their open sessions to end and their next sign in to need no code, with their password unchanged → AC-20
- [ ] Switch to Arabic and repeat the turn on, code and backup code screens → expect right to left, every string translated, and the setup key, codes and the code field left to right → AC-24
- [ ] Use only the keyboard through the dialog steps and the code screen → expect a visible focus ring, Escape to close the dialog, and focus returning to the button that opened it → AC-24

## Commands

- [ ] `POST /api/auth/two-factor/enable` with a wrong password, then the right one → expect 400 `INVALID_PASSWORD`, then 200 with `totpURI` (issuer is `CLIENT_DISPLAY_NAME`, label is the email) and 10 `backupCodes` → AC-20
- [ ] `SELECT secret, backup_codes, verified FROM two_factors` → expect both encrypted (neither the secret nor a backup code in plain text) and `verified = false` until the first code is confirmed; a sign in meanwhile needs no code → AC-20
- [ ] `POST /api/auth/two-factor/verify-totp` with a wrong then the right code, while signed in → expect 401 `INVALID_CODE`, then 200, `users.two_factor_enabled = true` and `GET /api/me` showing `twoFactorEnabled: true` → AC-20
- [ ] Sign in with the password only → expect 200 `{"twoFactorRedirect": true}`, a `two_factor` cookie and no session cookie, `GET /api/me` 401, `users.last_sign_in_at` unchanged, and the lockout counters not cleared → AC-3, AC-20
- [ ] Send the right code with that cookie → expect 200, a session cookie, `last_sign_in_at` set, the counters cleared, and one `SignedIn` log line → AC-20, AC-23
- [ ] Send 5 wrong codes with that cookie from one address, then the right one → expect 401 each time, a locked `sign_in_attempts` row, and the right code refused; the password step from that address → expect the generic 401; from another address → expect a code step that works → AC-3
- [ ] `POST /api/auth/two-factor/verify-backup-code` with a backup code, twice → expect 200 then 401 `INVALID_BACKUP_CODE` → AC-20
- [ ] `verify-totp` with `{"trustDevice": true}` → expect 400 `TRUST_DEVICE_NOT_SUPPORTED`, no `trust_device` cookie, and the next sign in still asking for a code → AC-20
- [ ] `POST /api/auth/two-factor/send-otp`, `verify-otp` and `get-totp-uri` → expect 404 each → AC-20
- [ ] `POST /api/auth/two-factor/generate-backup-codes` with a wrong then the right password → expect 400, then 10 new codes with the old ones refused → AC-20
- [ ] `POST /api/auth/two-factor/disable` with 5 wrong passwords from one address, then the right one → expect 400 each time (the lock applies), and the right password from another address → expect 200, the `two_factors` row gone, and `TwoFactorDisabled` in the log → AC-3, AC-20
- [ ] `POST /api/staff/<id>/reset-two-factor` as an admin → expect `twoFactorEnabled: false`, the person's sessions gone, the password still working, and `StaffTwoFactorReset` in the log; as staff → expect 403; unknown id → expect 404 → AC-20
- [ ] More than 15 code attempts in 10 minutes from one address → expect 429 with `X-Retry-After` → AC-4
- [ ] `POST /api/auth/two-factor/enable` while a temporary password is still in force → expect 403 `PASSWORD_CHANGE_REQUIRED` → AC-14
- [ ] Read the api log → expect `TwoFactorEnabled`, `TwoFactorDisabled`, `SignedIn` (only after the code), `SignInFailed` for wrong codes and `AccountLocked` when a lock starts, each with actor, target, `ip` and `userAgent`, and no code, secret or backup code → AC-23
- [ ] `pnpm --filter @ssdashboard/api test:e2e` → expect every suite to pass, `two-factor` included → AC-20

## Value sourcing

- [ ] Set `CLIENT_DISPLAY_NAME=Acme Home` and enroll again → expect the issuer `Acme Home` and the account email as the label → AC-20
- [ ] Read `users.two_factor_enabled` after an admin reset → expect false, and the Staff list column to match (the staff list reads the same column) → AC-20
- [ ] Rotate `BETTER_AUTH_SECRET` and sign in as someone with two factor on → expect the code to stop working (the secret was encrypted with the old key), which is why an admin reset is the recovery → AC-20
- [ ] Wrong codes for a person at the code step → expect the lock key to be that person's email (from the pending sign in) and the client address (from `X-Forwarded-For`) → AC-3

## Acceptance-criteria coverage

- AC-20 … enroll with a QR code and key, first code confirms, backup codes shown once, code at sign in, backup code once, turn off with the password, admin reset revokes sessions, no trusted devices, no email code routes · covered by UI steps 1 to 14 and Commands steps 1 to 12
- AC-3 … wrong codes and wrong current passwords count toward the lock, a lock ends the pending sign in · covered by UI step 11 and Commands steps 4, 6, 11
- AC-4 … code attempts limited per address · covered by Commands step 13
- AC-23 … two factor events and the sign in event only after the code · covered by Commands steps 5, 15
- AC-24 … keyboard, Arabic, accessible authentication (no puzzle, paste allowed, `one-time-code`) · covered by UI steps 7, 15, 16

---

# Slice 7: ledger link, nightly cleanup, break glass reset · verified 2026-11-04

_Covers AC-21 (reset mode) and AC-22. Run by the QA tester against the built app (`apps/api/dist`) and the dev Postgres 18 on port 5433, in a throwaway database `qa7` (dropped afterwards). Result key: PASS, FAIL, GAP (not testable yet or not built)._

## Gates

| Command | Result |
| --- | --- |
| `pnpm build` | PASS, 4 of 4 tasks |
| `pnpm typecheck` | PASS, 7 of 7 |
| `pnpm lint` | PASS, 8 of 8 |
| `pnpm test` | PASS: contracts 121, db 5, api 244, ui 22, web 333 |
| `pnpm --filter @ssdashboard/api test:e2e` | PASS: 16 files, 198 passed, 1 skipped (includes `auth-cleanup`, `create-admin-reset`, `ledger`) |
| `pnpm --filter @ssdashboard/db test:e2e` | 26 passed, 1 failed: `schema.e2e-spec > seeds the settings ...` (known stale failure from before this slice, expects 5 settings, finds 7). The new `migrate.e2e-spec` orphan test passes |
| `pnpm test:e2e` (root) | Stops at the db package because of that stale failure, so api and web never run from the root; api was run alone (above) |
| Playwright (`apps/web`) | NOT RUN: port 3000 is held by another project (`ssw-landing-web` container), `next dev --port 3000` fails with EADDRINUSE. This slice changes no UI |

## AC-22 clauses

- PASS: `posted_by` is a foreign key to `users.id`. Migration run through `node apps/api/dist/migrate.js` → "Migrations applied.", constraint `movement_groups_posted_by_users_id_fk` exists. An insert with an unknown user → `violates foreign key constraint`. Deleting a user that has postings → `violates RESTRICT setting`.
- PASS: orphans nulled, valid ones kept, then validated. Dropped the FK on `qa7`, inserted `known` (real user), `orphan` (no such user), `none` (null), removed the 0007 row from `drizzle.__drizzle_migrations`, re-ran `migrate.js` → rows `known = 1111…`, `orphan = NULL`, `none = NULL`; `SELECT convalidated ...` → `t`; `drizzle.__drizzle_migrations` count back to 8.
- PASS: append only trigger re-enabled and still rejecting. `SELECT tgenabled FROM pg_trigger WHERE tgname='movement_groups_append_only'` → `O` (enabled). `UPDATE movement_groups SET posted_by=NULL` as the owner role → `ERROR: movement_groups is append only: UPDATE is not allowed.` Also locked in by `packages/db/test/migrate.e2e-spec.ts` ("links posted_by to users, nulling orphans and keeping the append only trigger"). Not exercised: a mid migration failure leaving the trigger off; it relies on the migration running in one transaction (the SQL comment says so, not proven here).
- GAP: `created_by` columns. The spec says `created_by` and `posted_by` become foreign keys; `grep created_by packages/db/src/schema` finds none, only `posted_by` exists (movement_groups). Nothing to link yet; the Lead should confirm the spec wording is stale or that a later table owns it.
- GAP (stated plainly, not a failure): "ledger posting takes `postedBy` from the signed in user". No HTTP route posts to the ledger yet, so the guard to ledger wiring cannot be driven. Service level only: `ledger.e2e-spec` "stores the posting user as posted_by and rejects an unknown user" passes. To verify when the first posting route lands.
- PASS: nightly cleanup against seeded rows. Seeded in `qa7`: sessions expired/live, verifications expired/live, `sign_in_attempts` idle (window over), lock-ended, window-running, lock-running, `rate_limits` old (24h01m) and recent. Started `AUTH_CLEANUP_CRON="* * * * *" node apps/api/dist/worker.js` as the app role, waited 85 seconds → log `Removed 1 sessions, 1 tokens, 2 sign in counters, 1 rate limit counters.`; left behind: sessions `live`, verifications `live`, attempts `lock-running` and `window-running`, rate_limits `recent`. Second run removes nothing (`auth-cleanup.e2e-spec`).
- PASS: bad `AUTH_CLEANUP_CRON` rejected at startup. `AUTH_CLEANUP_CRON="banana"`, `"0 3 * *"` and `""` with `worker.js` → `Invalid environment: ✖ A 5 field cron expression ... at AUTH_CLEANUP_CRON`, exit 1.
- Not exercised: the `timezone` setting being honoured by the schedule (read once at startup, `tz` passed to pg-boss); only the cron firing in the default timezone was seen.

## AC-21 clauses (reset mode)

Flow on `qa7` with a sole admin: `create-admin --email Owner@Example.com --name Owner` → exit 0, password printed; sign in 200; 6 wrong passwords → 401 each; the right password while locked → 401; `sign_in_attempts` row `failures = 5`, locked.

- PASS: `create-admin --reset-password --email owner@example.com` → exit 0, "Password reset: owner@example.com. Sessions ended and lockout cleared." and a new temporary password printed once.
- PASS: lockout cleared: `SELECT count(*) FROM sign_in_attempts` → 0 afterwards.
- PASS: sessions revoked: `SELECT count(*) FROM sessions` → 0 (and `create-admin-reset.e2e-spec` shows the old cookie gets 401 on `/api/me`).
- PASS: must change flag set: `users.must_change_password` → `t` for the admin (I had cleared it first).
- PASS: access restored: old password → 401, new password → 200.
- PASS: password to the terminal only: the api log contains 0 occurrences of the new password. Not captured by the QA run beyond the shell variable.
- PASS: refusals change nothing: unknown email → "No account has the email ..." exit 1; non admin, disabled admin and bad arguments covered by `create-admin-reset.e2e-spec` (passes). The email is trimmed and lower cased (` Owner@Example.com ` works in the e2e).
- PASS: hashing and `account_id`: e2e asserts `account_id = users.id` and that the stored value is not the plain password; the hash is Better Auth's `hashPassword` (the sign in with the new password returns 200).

## Findings

- minor: `AUTH_CLEANUP_CRON="a b c d e"` passes the env regex (any five words) but the worker then crashes at bootstrap inside `cron-parser` with a stack trace, exit 1. It does fail fast, but not with the clean `Invalid environment` message. The existing `RECONCILE_CRON` uses the same regex, so this is a shared pre existing pattern.
- minor (environment): root `pnpm test:e2e` cannot reach the api and web suites until the stale `schema.e2e-spec` assertion is fixed.

# Slice 8: hardening and finish · verified 2026-11-04

_Covers AC-7, AC-21, AC-22, AC-24 and the spec's critical test scenarios. Run by the QA tester against the built app (`apps/api/dist`) and the dev Postgres 18 on port 5433, in a throwaway database `ssdashboard_e2e_s8e` (dropped afterwards). Web dev server on 3220 (a temporary `distDir` override in `next.config.ts` because another dev server already owned `.next`; restored to the same sha1, extra dist folder deleted), api on 3221, production project on 3320. Result key: PASS, FAIL, GAP (not testable yet or not covered)._

## Gates

| Command | Result |
| --- | --- |
| `pnpm build` | PASS, 4 of 4 tasks |
| `pnpm typecheck` | PASS, 7 of 7 (6 from turbo cache) |
| `pnpm lint` | PASS, 8 of 8 (7 from turbo cache) |
| `pnpm test` | PASS: contracts 129, db 5, api 252, ui 24, web 341 |
| `pnpm --filter @ssdashboard/api test:e2e` | PASS: 16 files, 199 passed, 1 skipped |
| `pnpm --filter @ssdashboard/db test:e2e` | PASS: 3 files, 27 passed (the stale `schema.e2e-spec` assertion from slice 7 is fixed) |
| Playwright full suite, `apps/web`, desktop + mobile + production | PASS after one setup fix: 317 tests, 274 passed, 40 skipped (project only tests), 3 failed in `production` because I started `next start` without `API_INTERNAL_URL`; rerun of `--project=production` with `API_INTERNAL_URL=http://localhost:3221` gave 5 passed. Not a code bug, see Findings |
| `--repeat-each=3` on auth-flows, account, staff, auth-accessibility (desktop + mobile) | PASS: 588 passed, 0 flaky, 0 failed |
| `shell.spec.ts` x 5 runs (desktop + mobile) | PASS 5 of 5, 28 passed each; the `/` color contrast flake did not appear (0 of 5) |

## Fresh install path (throwaway database, over HTTP)

- PASS: `migrate.js` gave "Migrations applied."; `create-admin --email Boss@Example.com --name "Boss One"` exit 0, 16 character temporary password on stdout, nothing on stderr.
- PASS: sign in with `BOSS@example.com` and the temporary password gave 200 with `mustChangePassword: true`; `GET /api/me` 200; `GET /api/locations` 403 `PASSWORD_CHANGE_REQUIRED`.
- PASS: change password with `abc` gave 422 `WEAK_PASSWORD` (`min_length`, `uppercase`, `digit`); with a strong one 200; `/api/locations` then 200; `mustChangePassword` false.
- PASS: sign out 200; the old cookie on `/api/me` gave 401 `SESSION_EXPIRED`; the new password signs in 200; the temporary password gave 401 `INVALID_EMAIL_OR_PASSWORD`.
- PASS: lockout. Five wrong passwords from one address, then the correct one, gave 401 with the same body; an unknown email gives the identical body. Six wrong passwords from six different addresses and then the correct one from a new address gave 200 (correct: the per email lock needs 20 spread failures).
- PASS: `create-admin --reset-password --email boss@example.com` exit 0, "Sessions ended and lockout cleared.", new 16 character password on stdout. stderr is exactly one line `{"event":"auth.admin_break_glass_reset","targetId":"<uuid>","actor":"cli","at":"..."}`; the new password occurs 0 times in stderr and 0 times in the api log. The old password gave 401, the new one 200, and `must_change_password` is `t`.
- Note: a first reset attempt ran against the `.env` database (the shared `ssdashboard`) because I had not exported `DATABASE_URL`; it answered "No account has the email", exit 1, and changed nothing. `create-admin` reads `DATABASE_URL` from `.env` when the environment does not set it.

## Critical test scenarios (end of the spec)

- PASS: first admin happy path (AC-1, AC-6, AC-14, AC-21, AC-25). Manual run above; `sign-in.e2e-spec` "creates the first admin, prints a temporary password once, and sets the must change flag", "signs in with the email in any letter case...", "signs out only that session..."; Playwright `auth-flows` "forced password change > changes the password from the keyboard alone and lands on the page asked for" and `sign-in.spec`.
- PASS with a gap: invite flow (AC-9, AC-12, AC-13, AC-14). Mail captured through a real SMTP catcher: `staff.e2e-spec` "invites by email with a 7 day link that sets the first password" (Arabic mail has `dir="rtl"`, the link lasts 7 days, the person signs in and reaches `/api/locations`). Mail off: "shows a temporary password once, then forces a change before anything else works" and Playwright `staff` "creates a person, shows the temporary password once, and the person must change it". GAP: no browser test clicks a real invite email link through the `/reset-password?invite=1` page (the page and an invalid token are covered by `auth-flows`, the redeem by the api test).
- PASS: five wrong passwords and generic answers (AC-2, AC-3). `sign-in-policy.e2e-spec` "locks an email and address after five failures, with the same answer for everything", "treats an unknown email like a real one", "locks the email for every address after 20 failures", "does not lose a count when attempts arrive at the same moment"; manual run above.
- PASS: session expiry (AC-5). `sign-in-policy.e2e-spec` "ends a session left idle for 12 hours", "ends a session 7 days after sign in even when it was used a minute ago", "renews an idle session...". Time is moved by editing `sessions` rows, not by a fake clock; same effect.
- PASS: auth and permission matrix (AC-7, AC-15, AC-16). Live: every mapped route except `GET /api/config` and `/api/health` gave 401 with no cookie (13 routes, including `GET /api/locations`); `POST /api/auth/sign-up/email`, `admin/list-users`, `update-user`, `change-email`, `get-session` gave 404; sign in with `origin: https://evil.example` gave 403. Tests: `sign-in.e2e-spec` "keeps config and health public and guards everything else", "closes every Better Auth route that is not on the allowlist"; `staff.e2e-spec` "answers 401 with no session and 403 FORBIDDEN to a staff role, and lets an admin in", "closes Better Auth routes that would bypass the staff service"; Playwright `staff` "the staff api answers 403 FORBIDDEN to reads and writes". Disabled person's old cookie: `sign-in.e2e-spec` "treats a disabled account as signed out on its next request", `sign-in-policy.e2e-spec` "answers a disabled person on their very next request", `staff.e2e-spec` "disables in one step: no sessions, no live links...".
- PASS: `returnTo` off site (AC-7). Playwright `sign-in.spec` "ignores a returnTo that points off site", `auth-flows` "an off site returnTo is ignored after the change".
- PASS: two factor (AC-20). `two-factor.e2e-spec` covers enrol, a right code, a backup code once, wrong codes counting toward the lock, and admin reset ("turns it off and ends their sessions"); Playwright `auth-flows` "enrol on the account page, then sign in asks for a code; a wrong code is announced; a backup code works once".
- PASS: break glass (AC-21). Manual run above and `create-admin-reset.e2e-spec` "restores access for a locked out sole admin".
- PASS: Arabic and English, keyboard only, axe (AC-24, AC-19). `auth-accessibility.spec.ts` runs each new screen in light and dark, ltr and rtl on desktop and mobile; keyboard tests in `auth-flows`, `account`, `staff`. 588 of 588 across 3 repeats.
- PASS with a gap: nightly cleanup and `posted_by` (AC-22). `auth-cleanup.e2e-spec` "deletes expired rows in all four tables and keeps live ones", "removes nothing on a second run"; `ledger.e2e-spec` "stores the posting user as posted_by and rejects an unknown user". GAP (unchanged from slice 7): no HTTP route posts to the ledger yet, so the guard to `posted_by` wiring cannot be driven end to end.
- PASS (extra, in the spec's list): two admins disabling each other, `staff.e2e-spec` "leaves one admin when two disable each other at the same moment"; weak passwords refused on the reset, change and invite paths (api tests above).
- GAP: AC-11 "after the last retry a log line without the link appears". `password-reset.e2e-spec` "does not fail the request, and the worker retries without ever logging the link" covers the first failure and the retry only; the final line is covered by worker unit tests (a real run takes about 15 minutes), as in slice 3.

## Contract: `postedBy` (AC-22)

Run: `pnpm exec vitest run test/inventory.spec.ts src/inventory.spec.ts` in `packages/contracts` gave 27 passed; `vitest run src/inventory/controller-contracts.spec.ts` in `apps/api` gave 2 passed; plus a direct parse against the built contracts.

- PASS: `PostingInput` without `postedBy` is rejected (`postedBy: invalid_type`); with `null` it is accepted. `ReverseInput` without `postedBy` is rejected (`invalid_type`).
- PASS: `PostingRequest` and `ReverseRequest` accept a clean body and reject a smuggled `postedBy` (a uuid, and also `null`) with `unrecognized_keys`, instead of stripping it.
- PASS: no non test code writes `posted_by` from request input. `grep -rnE "posted_by|postedBy" apps packages --include=*.ts --include=*.tsx`, minus specs, tests, schema and migrations, leaves only `ledger.service.ts` (the service level insert, taking the already validated `PostingInput.postedBy`, and mapping the FK error), `request-hash.ts` (excluded from the hash) and `packages/contracts/src/inventory.ts`. No controller, job or web file touches it. `controller-contracts.spec.ts` fails if a controller imports `PostingInput` or `ReverseInput`.
- Limit: that guard is an import scan. A controller that validated its body with some other schema would not trip it. There is no posting controller to check yet.
- Note (by design, documented in `request-hash.ts`): `postedBy` is not in the idempotency hash, so a replay of the same key from another user matches the first posting and keeps the first poster.

## Mobile dropdown menus (375 x 740, touch)

Driven with Playwright on a touch device against the dev server, using real screen taps (a scratch script run from stdin, nothing saved). The shell user menu is A, the staff row menu is B.

- PASS: A opens on tap, closes on Escape with focus back on its trigger, closes on an outside tap, toggles closed when its own trigger is tapped and reopens on the next tap, and picking "Account" closes it and navigates.
- PASS: B opens on tap, closes on Escape with focus back on its trigger, closes on an outside tap, toggles on its own trigger, and picking "Edit" closes it and opens a dialog.
- PASS: with A open, tapping B's trigger leaves exactly one menu, B's (Edit, Reset password, Sign out everywhere); with B open, tapping A's trigger leaves exactly one menu, A's.
- PASS: with A or B open, one tap on "Add staff" closes the menu and opens exactly one dialog; with A open, one tap on "Search pages" opens exactly one palette.
- Note: Playwright's `locator.tap()` cannot reach the page heading while a menu is open at 375 wide (the menu covers it); outside taps used `touchscreen.tap` on empty page area.
- GAP: no committed test covers any of this on the mobile project (the existing menu tests are Escape on desktop and axe with the row menu open). Worth a Playwright test.

## Findings

- minor (docs): the `production.spec.ts` comment "No api runs behind this server: the saved language is kept when config cannot load" is stale. Since the shell requires a session, the production project needs `API_INTERNAL_URL` pointing at a running api, or three tests show "This page couldn't load". Say so in the README or the config comment.
- minor (environment): `next dev` allows one server per directory; a stale server on 3200 held `.next`, so a second run needs a different `distDir`. There is no env hook for it in `next.config.ts` today.
- minor (carried over from slice 7, not re-run): `AUTH_CLEANUP_CRON="a b c d e"` still crashes inside `cron-parser` instead of the clean "Invalid environment" message.
- flake not reproduced: the pre existing `/` color contrast failure in `shell.spec.ts` did not occur in 5 runs, nor in the full run or the 3 repeat runs.
- No product bugs found in this pass. Ports 3200 and 3201 were left alone; the shared `ssdashboard` database was not changed.
