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
