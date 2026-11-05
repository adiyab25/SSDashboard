# Verify: roles as hats · spec 0008 · updated 2026-11-05

_Steps derived from spec 0008 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Nothing is built yet, so every box is open. Personas used below: Sara (`support`), Omar (`operations`), Wael (`warehouse`), Mona (`manager` with cost), Hany (`support` and `warehouse`), Mai (`media_buyer` only), and Ziad (a `partner` user of partner account `NILE`)._

## UI / manual
- [ ] Sign in as Wael → the sidebar shows Stock, Receipts, SKUs; no Staff, no Locations management actions; the Stock page has no average cost or stock value column → AC-6, AC-11
- [ ] Sign in as Mona → the same pages show cost columns and the Staff item → AC-6, AC-11
- [ ] As Wael, open `/staff` by typing the URL → the no access state inside the backoffice frame, one `<h1>`, no `/api/staff` call succeeds (403 in the network panel) → AC-11
- [ ] As Mona, open Wael's row on `/staff`, choose Edit hats, tick `support`, keep cost off, give a reason, save → the row shows `support, warehouse`; Wael's open tab shows the Customers item on the next navigation without signing in again → AC-2, AC-12
- [ ] As Mona, give Sara the `operations` hat → the cost switch turns on by itself (default), Mona switches it off, saves → Sara still sees no cost → AC-7
- [ ] As Mona, try to change your own hats (the dialog, or `PUT /api/staff/<own id>/access`) → 409 `SELF_HAT_CHANGE`, nothing changes → AC-12
- [ ] On the Partner logins tab, create Ziad for `NILE` → invite or temporary password as for staff; Ziad never appears on the Staff tab → AC-15, AC-18
- [ ] Sign in as Ziad → lands on `/partner`; typing `/stock` lands back on `/partner` → AC-10, AC-11
- [ ] Sign in as Mai → only the campaign pages (once features 48 and 49 exist) and the Account page; every other backoffice URL shows the no access state → AC-8, AC-11
- [ ] Switch to Arabic on `/staff` (both tabs) and the hats dialog → right to left, every hat and permission described in Arabic, keyboard only works, axe clean → AC-18

## Commands
- [ ] `pnpm --filter @ssdashboard/contracts test` → the matrix test passes: no hat holds `cost.view`, no external hat holds a personal permission, manager holds every staff permission except `cost.view`, every permission is used → AC-1, AC-6, AC-8
- [ ] `pnpm --filter @ssdashboard/api test -- src/platform/access` → passes; then delete one `@Permission` from `catalog.controller.ts` and rerun → fails naming the handler; restore → AC-4
- [ ] Add `@Permission('stock.view')` to `HealthController` and rerun → fails ("public controller declares a permission"); restore → AC-4
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → the tenant schema test passes with `hat_assignments` and `permission_grants`; the ownership map lists both under identity → AC-3
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- test/hats.e2e-spec.ts` → the same cookie test, the concurrent last manager test, stale, self, conflict, and grant refusals → AC-2, AC-7, AC-12, AC-14
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- test/access-sweep.e2e-spec.ts` → every route, every hat alone: 403 exactly per the matrix, no cost key without `cost.view`, no personal data key for Mai or Ziad; a route missing from the fixture map fails the run → AC-5, AC-6, AC-8
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- test/partner-users.e2e-spec.ts` → partner user create, reset, disable, account move with session revoke, `WRONG_AUDIENCE` on staff routes → AC-9, AC-10, AC-15
- [ ] `pnpm --filter @ssdashboard/web test` → the nav test fails a nav item without `needs` → AC-11
- [ ] `pnpm --filter @ssdashboard/web test:e2e -- e2e/hats.spec.ts e2e/audiences.spec.ts` → the persona threads above in both languages → AC-11, AC-18
- [ ] `grep -rn "\.role\b\|@Roles\|RolesGuard\|StaffRole" apps/api/src apps/web/src packages/contracts/src` → no match outside Better Auth configuration → AC-5, AC-16

## Value sourcing checks
- [ ] With Wael's cookie, `GET /api/stock` → no `avgUnitCost` or `totalValue`; Mona grants cost; the same cookie, next request → present; Mona removes it → gone, with no new sign in → AC-6 (access read on every request)
- [ ] Ziad calls `GET /api/partner/me?partnerAccountId=<other id>` → still his own `partnerAccountId`; the static test fails a planted partner handler with `@Query('partnerAccountId')` → AC-9 (partner account from the hat row)
- [ ] `GET /api/me` as Hany → `hats: ['support','warehouse']`, `permissions` is the sorted union, `partnerAccountId: null`, `home: 'backoffice'` → AC-2, AC-11 (`permissionsFor`)
- [ ] `PUT /api/staff/:id/access` with an `updatedAt` from before another manager's change → 409 `STALE_RECORD`, nothing changes → AC-12 (`users.updated_at`)
- [ ] Two managers remove each other's `manager` hat at the same moment → one 200, one 409 `LAST_ADMIN`, one manager left → AC-12, AC-14 (`ADMIN_RULE_LOCK`)
- [ ] Move Ziad to partner account `DELTA` → his `sessions` rows are gone in the same transaction, next request 401 `SESSION_EXPIRED`; add `support` to Wael → his session row stays → AC-12 (spec 0005 AC-33 b)
- [ ] After a hat change, the audit entry (or, before feature 10, the log line) and `HatsChanged` hold actor, target, ip, user agent, time, before, after, reason, and no email or phone → AC-13
- [ ] Run the migration on a database holding one `admin` and one `staff` → `manager` plus `cost.view`, and `support`, `operations`, `warehouse`; every `users.role` is `user` → AC-16
- [ ] `INSERT INTO tasks (..., owner_hat) VALUES (..., 'media_buyer')` → check violation → AC-17
- [ ] A dev user with no hat row signs in → 401 `SESSION_EXPIRED`, sessions deleted → AC-10

## Acceptance-criteria coverage
- AC-1 Commands 1 · AC-2 UI 4, Value sourcing 3 · AC-3 Commands 4 · AC-4 Commands 2 and 3 · AC-5 Commands 6 and 10 · AC-6 UI 1 and 2, Value sourcing 1, Commands 6 · AC-7 UI 5, Commands 5 · AC-8 UI 9, Commands 1 and 6 · AC-9 Value sourcing 2, Commands 7 · AC-10 UI 8, Value sourcing 10 · AC-11 UI 1 to 3, Commands 8 and 9 · AC-12 UI 4 and 6, Value sourcing 4 to 6 · AC-13 Value sourcing 7 · AC-14 Value sourcing 5, Commands 5 · AC-15 UI 7, Commands 7 · AC-16 Value sourcing 8, Commands 10 · AC-17 Value sourcing 9 · AC-18 UI 7 and 10, Commands 9
