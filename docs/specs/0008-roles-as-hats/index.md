# 0008. Roles as hats: fixed hats in the identity module, one permission per route, cost as a separate grant

**Date**: 2026-11-05
**Status**: Built 2026-11-07 (milestones 1 to 4)

## Summary

A person wears one or more hats (support, operations, warehouse, manager, and the external media buyer and partner hats), and each hat brings a fixed set of permissions written in code. Seeing cost and margin is a separate grant on the person, never part of a hat. Every api route names the permission it needs right beside its `@Audience`, and a build test fails any route that names none, the same way `audience.spec.ts` works today. Hats live in two small tables owned by the identity module, not in Better Auth's organization plugin, because one database already holds one brand and hat changes must commit in the same transaction as the session rules of spec 0005.

## Requirements

**User stories**:
- As a manager, I want to give a person one or several hats, so each of the four people in a small brand sees exactly the work they do, and a larger brand can split the same hats among forty.
- As an owner, I want cost and margin hidden from everyone I have not chosen, so margins stay private even from people who see orders all day.
- As an owner, I want the freelance media buyer to see campaign results and never a customer's name, phone, or address, so I stay within Law 151 while sharing results.
- As a consignment partner, I want to sign in and see only what I was given, sold, and owe, so I can check my statement without seeing other partners or the brand's customers.
- As a manager, I want every hat change recorded with who, when, before and after, so access changes are accountable.
- As a developer, I want a route with no permission to fail the build, so nobody ships an open route by forgetting a line.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: There are exactly six hats: four internal hats (`support`, `operations`, `warehouse`, `manager`) and two external hats (`media_buyer`, `partner`). Each hat grants exactly the permissions in the permission matrix below, defined once as data in `packages/contracts/src/access.ts` and used by the api and the web. A person's effective permissions are the union of the permissions of every hat they hold plus their extra grants (AC-6). The matrix is fixed in code in this version; no brand edits it on a screen.
- **AC-2**: One person can hold several hats at once. A person holding `support` and `warehouse` can call every route either hat allows, and a route neither hat allows answers 403 `FORBIDDEN`. Holding a hat twice is impossible (unique key).
- **AC-3**: Hats are stored in `hat_assignments` and extra grants in `permission_grants`, both owned by the identity module, both with `tenant_id` by the rule of spec 0002 AC-15, with the keys and checks in the data model below. A `partner` row names exactly one partner account and no other hat row names one. Both tables are in the table ownership map and pass the tenant schema test.
- **AC-4**: Every handler of a controller whose audience is `staff` or `partner` resolves to exactly one permission declaration: `@Permission(...)` (one or more permissions, all required) or `@AnyHat()` (any person whose hats allow this audience), declared on the handler or else on the class. A handler declaration replaces the class one. At runtime `PermissionGuard` answers 500 `PERMISSION_MISSING` for a route with no declaration and 403 `FORBIDDEN` (message "You do not have access to this.", naming no permission) when the caller lacks one. A unit test, `apps/api/src/platform/access/permission.spec.ts`, walks the same controllers as `audience.spec.ts` and fails the build when a staff or partner handler has no declaration or two, when a declared permission is not in the catalog, when a permission belongs to the other audience, or when a `portal`, `hook`, or `public` controller declares any permission.
- **AC-5**: Every existing route carries the permission in the route mapping table below. `@Roles`, `RolesGuard`, the `StaffRole` contract, and every read of `users.role` in `apps/api` and `apps/web` are gone; the type checker proves it because `role` is no longer on `CurrentStaff` or `MeResponse`.
- **AC-6**: Seeing cost and margin is the permission `cost.view`. No hat includes it; it exists only as an extra grant in `permission_grants`. Without `cost.view`, no api answer contains a field named in `COST_FIELD_KEYS` (`packages/contracts/src/access.ts`), on any route, replays included. The fields are removed by one serializer per response type that takes the caller's `Access`, as spec 0006 did for admins. Saving or reading per order cost rules, cost records, and any export template with a cost column also needs `cost.view` (the rule features 15, 45, and the cost rules screen build to).
- **AC-7**: `cost.view` can be granted to a person holding any internal hat or `media_buyer`, and never to a person holding `partner` (422 `GRANT_NOT_ALLOWED`). When a manager first gives a person a hat on the people screen, the cost switch starts on for `manager` and `operations` and off for `support`, `warehouse`, and `media_buyer` (the owner question 1 default); the manager can change it before saving.
  > Amended 2026-11-06 (gate ruling, security review of milestone 1): adding or removing a `cost.view` grant, on any path (`PUT /api/staff/:id/access`, `POST /api/staff` with `costView` true), also needs the actor to hold `cost.view`, else 403 `FORBIDDEN`; and nobody adds or removes their own `cost.view` (409 `SELF_HAT_CHANGE`), the same rule as hats (spec 0005 AC-33 f).
- **AC-8**: The media buyer hat holds only `campaigns.view`. A person whose only hat is `media_buyer` gets 403 `FORBIDDEN` on every staff route except those declared `@AnyHat()` (`GET` and `PATCH /api/me`) and those needing only `campaigns.view` (and `cost.view` when granted). No permission marked as reaching personal data is in the media buyer or partner hat (a unit test on the matrix proves it). An end to end sweep calls every route as a media buyer and finds no key from `PERSONAL_DATA_KEYS` or `PERSONAL_DATA_PATHS` (`packages/config/src/redaction.ts`) in any answer. Campaign level profit is shown with `campaigns.view` alone; the cost of goods column and any per product margin need `cost.view` too (owner question 2 default). One exception, ruled 2026-11-07: the caller's own who-am-I answer (`GET` and `PATCH /api/me`, `GET` and `PATCH /api/partner/me`) carries the caller's own `phone`, because it is their own profile, not another person's data; the sweep lets `phone` through on those four routes only.
- **AC-9**: A person with the `partner` hat holds no other hat (422 `HAT_CONFLICT`), is bound to exactly one partner account (a `parties` row with `is_consignment_partner`), and uses only the partner audience. The guard puts `request.partner = { userId, partnerAccountId }` from the person's `hat_assignments` row on every partner request; no partner route reads a partner account id from a header, path, query, or body (a unit test fails a partner controller whose handler declares a param, query, or body field named `partnerAccountId`, `partyId`, or `partnerId`). Partner users hold `partner.view_own` and `partner.submit_sales` only.
- **AC-10**: The real `SessionAudiences` (spec 0005 AC-29) answers `partner` for a person with the `partner` hat and `staff` for a person with any other hat. A live session of a person with no hat is treated as ended: the guard deletes the person's sessions and answers 401 `SESSION_EXPIRED`. `home` is `partner` for the partner hat and `backoffice` otherwise.
  > Amended 2026-11-07 (review round 2): the sign in itself is refused too. After a correct password (or the code that finishes a two factor sign in) for a person with no hat, Better Auth's after hook deletes the session it just made, removes the cookie and answers 403 `NO_ACCESS`, and writes one log line (`SignInRefused`, reason `no_access`, ids, address and user agent, never an email; spec 0005 AC-23 is not changed). A wrong password still answers like any other. A refused backup code stays spent. Ruled 2026-11-07 (question 9): kept as built. The sign in and two factor screens show the translated `auth.signIn.noAccess` message in English and Arabic, never a generic failure.
- **AC-11**: `GET /api/me` (staff audience) and `GET /api/partner/me` (partner audience) return the same `MeResponse`, which adds `hats`, `permissions` (the effective list, sorted), `partnerAccountId` (null for staff), and `home`. The web reads these once per page load and hides every navigation item, action, and column the person cannot use: each nav item declares `needs` (a permission), and a unit test fails a nav item without one. A page opened by its URL without the permission renders inside its frame a "no access" state with one `<h1>` and loads no business data. The web never grants anything: a hidden button's route still answers 403.
- **AC-12**: Only a person with `people.manage` changes access. For staff, `PUT /api/staff/:id/access` carries the full new set (`hats` with at least one hat and never `partner`, `costView`); for a partner user, `PUT /api/partner-users/:id/access` carries the new `partnerAccountId`. Both carry the `updatedAt` read before; a mismatch answers 409 `STALE_RECORD`. A person cannot change their own hats or cost grant (409 `SELF_HAT_CHANGE`). Removing `manager` from the last active manager (an active person holding `manager`) answers 409 `LAST_ADMIN`, checked under `ADMIN_RULE_LOCK` in the same transaction. Sessions follow spec 0005 AC-33 and revoke at least as much: an empty set is refused (422 `NO_HAT`), a move between the staff and partner audiences is refused (no route turns a staff person into a partner user or back, owner question 2 of spec 0005), and binding a partner user to another partner account calls `revokeSessions(userId, tx)` in the same transaction. Any other change keeps the sessions alive and acts on the next request.
  > Amended 2026-11-06: the cost grant rules of the AC-7 note apply to every access change here. The same rule covers taking over a cost holder's sign in: resetting the password or two factor of, or changing the email of, a person who holds `cost.view` needs the actor to hold it too (403 `FORBIDDEN`, nothing changes).
  > Ruled 2026-11-07 (owner, review item n6): signing in is not a change to the record a manager edits. A sign in stamps `users.last_sign_in_at` only and never moves `users.updated_at`, so a manager whose dialog was opened before the person signed in still saves (no 409 `STALE_RECORD`); a real change by another manager still answers 409. The forced password change of a first sign in is part of signing in: clearing `must_change_password` after the person's own password change (forced or not) does not move `updated_at` either. A two factor enable or disable by the person does move it (a change the person made).
- **AC-13**: Every hat or cost change writes, in the same transaction, one audit entry through the audit module of feature 10 (actor, time, target, before and after as `{ hats, costView, partnerAccountId }`, optional reason up to 500 characters) and, after commit, one log line and one `HatsChanged` event carrying `actorId`, `targetId`, `ip`, `userAgent`, `at`, `before`, `after`, and `reason`. Until feature 10 lands, the log line and the event are the record (spec 0005 AC-23 shape). No personal data beyond ids is in the payload.
- **AC-14**: Creating a staff person (`POST /api/staff`) requires `hats` (one or more internal hats or `media_buyer`) and `costView`; a partner user is created only through `POST /api/partner-users`. `create-admin` creates a person with `manager` and `cost.view` and refuses when an active manager exists. `create-admin --reset-password` and `--reset-two-factor` refuse a person without `manager`. The last admin rule of spec 0005 AC-17 counts active managers; disabling the last one answers 409 `LAST_ADMIN`. A partner user can never hold `manager`.
- **AC-15**: A person with `people.manage` lists, creates, edits, disables, enables, resets the password and two factor of, resends the invite to, and revokes the sessions of partner users through `/api/partner-users`, reusing the invite, reset, and lockout mechanics of spec 0005 unchanged. Partner users never appear in `/api/staff`. An unknown partner account, or a party that is not a consignment partner, answers 422 `UNKNOWN_PARTNER_ACCOUNT`.
- **AC-16**: The migration maps today's roles: `admin` becomes `manager` plus `cost.view`; `staff` becomes `support`, `operations`, and `warehouse` (exactly what staff could do before, still without cost). After the mapping every `users.role` is `user`, the check becomes `role = 'user'`, and Better Auth's admin plugin is configured with `defaultRole: 'user'`. The tables and the mapping go into the feature 4 baseline when it has not shipped, else into a forward migration (see the migration plan).
- **AC-17**: `tasks.owner_hat` holds only internal hats: `packages/contracts` exports `InternalHat`, and the baseline check on `tasks.owner_hat` lists exactly `support`, `operations`, `warehouse`, `manager`. External hats never own a task.
- **AC-18**: The people screen (`/staff`) shows each person's hats and whether they see cost, edits them in one dialog (a checkbox per hat with its plain description, the cost switch, an optional reason), and has a Partner logins tab for partner users; all of it in English and Arabic, right to left, by keyboard alone, and to WCAG 2.2 AA, with one `<h1>`.

### Permission matrix

The hats, and what each one lets a person do. `P` marks a permission that reaches customer personal data (Law 151); no external hat may hold one (AC-8). `cost.view` is not in any hat (AC-6).

| Permission | What it lets you do | P | support | operations | warehouse | manager | media buyer | partner |
|---|---|---|---|---|---|---|---|---|
| `orders.view` | See orders, their lines, both states, the outcome, and the customer and ship to on them | P | ✓ | ✓ | ✓ | ✓ | | |
| `orders.confirm` | Work the confirmation queue: record outcomes, fix address and lines, cancel | P | ✓ | ✓ | | ✓ | | |
| `orders.gift` | Create a gifted order (spec 0002, owner question 8) | | | | | ✓ | | |
| `customers.view` | See customer profiles, phones, and history | P | ✓ | ✓ | | ✓ | | |
| `customers.merge` | Merge customers and undo a merge | P | ✓ | ✓ | | ✓ | | |
| `exchanges.handle` | Open exchanges and returns for a customer, work the review desk | P | ✓ | ✓ | | ✓ | | |
| `refunds.approve` | Approve refunds and post credit by hand | P | | ✓ | | ✓ | | |
| `fulfillment.work` | Pick, pack, ship, scan returns, restock | P | | ✓ | ✓ | ✓ | | |
| `stock.view` | See stock on hand, movements, receipts, and locations (no cost) | | ✓ | ✓ | ✓ | ✓ | | |
| `stock.receive` | Post receipts, transfers, and counts | | | ✓ | ✓ | ✓ | | |
| `stock.correct` | Void a receipt and post corrections | | | | | ✓ | | |
| `catalog.edit` | Create SKUs and products, edit names and prices | | | ✓ | ✓ | ✓ | | |
| `catalog.manage` | Change SKU codes, archive and delete SKUs, manage locations | | | | | ✓ | | |
| `channels.map` | Map partner and channel codes to variants | | | ✓ | | ✓ | | |
| `settlement.work` | Import carrier and partner statements, match lines, enter a partner's statement for them | P | | ✓ | | ✓ | | |
| `settlement.close` | Close a settlement period and revoke a close | | | ✓ | | ✓ | | |
| `exports.run` | Run accounting exports and mark them imported on the accountant's word (spec 0007, M9) | | | ✓ | | ✓ | | |
| `partners.manage` | Manage partner accounts and handovers | | | ✓ | | ✓ | | |
| `tasks.work` | See and work your own tasks and the queues of your hats | P | ✓ | ✓ | ✓ | ✓ | | |
| `tasks.assign` | Reassign any task | | | ✓ | | ✓ | | |
| `reports.view` | See the business dashboard (counts and cash, no customers) | | | ✓ | | ✓ | | |
| `campaigns.view` | See campaign results (spend, orders, kept revenue, return rate, campaign profit) | | | ✓ | | ✓ | ✓ | |
| `people.manage` | Manage staff and partner logins, hats, cost grants, sessions, two factor resets | | | | | ✓ | | |
| `settings.manage` | Change settings, module toggles, connections, and per order cost rules (with `cost.view`) | | | | | ✓ | | |
| `audit.read` | Read the audit trail: the list, an entry, a record's history | P | | | | ✓ | | |
| `audit.undo` | Undo an undoable audited action | P | | | | ✓ | | |
| `audit.export` | Export the audit trail | P | | | | ✓ | | |
| `partner.view_own` | Partner surface: see what was given, sold, and owed for the bound account only | | | | | | | ✓ |
| `partner.submit_sales` | Partner surface: upload a sales statement or declare a no sales day | | | | | | | ✓ |
| `cost.view` | See unit cost, stock value, cost of goods, and margin | | extra grant only, for any internal hat or media buyer (AC-7) | | | | | never |

> Amended 2026-11-06 (gate ruling, spec 0010 AC-13): the single `audit.view` became `audit.read`, `audit.undo` and `audit.export`, all on the manager hat only and marked personal, because an entry's before and after can carry customer data and costs.

**Location scoping**: none. Every permission applies to every location of the brand. The shell's location switcher stays a view filter, not a wall (owner question 5).

### Route mapping for existing routes (AC-5)

| Controller (today) | Route | Declaration |
|---|---|---|
| `MeController` | `GET /api/me`, `PATCH /api/me` | `@AnyHat()` |
| `CatalogController` | `POST /api/products`, `PATCH /api/skus/:id` | `catalog.edit` |
| `CatalogController` | `GET /api/skus`, `GET /api/skus/:id` | `stock.view` |
| `CatalogController` | `DELETE /api/skus/:id` | `catalog.manage` |
| `LocationsController` | `GET /api/locations` | `stock.view`; `status=archived` also needs `catalog.manage` (403 `FORBIDDEN`, checked in the handler through `Access`) |
| `LocationsController` | `POST`, `PATCH /:id`, `POST /:id/archive`, `POST /:id/unarchive`, `DELETE /:id` | `catalog.manage` |
| `ReceiptsController` | `POST /api/stock-receipts` | `stock.receive` |
| `ReceiptsController` | `GET /api/stock-receipts`, `GET /api/stock-receipts/:id` | `stock.view` |
| `ReceiptsController` | `POST /api/stock-receipts/:id/void` | `stock.correct` |
| `SkuLifecycleController` | `GET /api/skus/:id/usage` | `stock.view` |
| `SkuLifecycleController` | `PATCH /api/skus/:id/code`, `POST /:id/archive`, `POST /:id/unarchive` | `catalog.manage` |
| `StockController` | `GET /api/stock`, `GET /api/skus/:id/stock`, `GET /api/skus/:id/movements` | `stock.view` |
| `StaffController` | every route | `people.manage` (class) |
| `AuditEntriesController` | `GET /api/audit/entries`, `GET /api/audit/entries/:id` | `audit.read` (class; spec 0010) |
| `AuditRecordsController` | `GET /api/audit/records/:type/:id/entries` | `audit.read` (spec 0010; `AuditQueryService.forRecord` checks it again) |
| `AuditExportController` | `GET /api/audit/entries/export` | `audit.export` (spec 0010) |
| `HealthController`, `ConfigController` | `GET /api/health`, `GET /api/config` | none (public) |

## Decision

**Chosen option**: Option 1 in [rationale.md](rationale.md): own tables in the identity module with the hat matrix as code, one permission declaration per route, and cost as a separate grant.

Hats are rows in `hat_assignments`, extra grants are rows in `permission_grants`, the matrix is a constant in `packages/contracts`, the session guard loads the person's access on every request, and a platform `PermissionGuard` checks the route's declaration after the audience guard. Better Auth keeps sign in, sessions, two factor, and the ban check; its organization plugin is not installed.

**Implementation skills**: `better-auth-best-practices` (`better-auth/skills`, `.claude/skills/better-auth-best-practices/`) · `better-auth-security-best-practices` (`better-auth/skills`, `.claude/skills/better-auth-security-best-practices/`) · `organization-best-practices` (`better-auth/skills`, `.claude/skills/organization-best-practices/`, weighed and not adopted) · `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

**Decisions settled here** (each: pick, why, runner up)
- **Where hats live**: own tables in identity. Why: one database is one brand, so an organization table would hold one row forever; hat changes must share a transaction with `revokeSessions` and `ADMIN_RULE_LOCK`, which Better Auth's plugin calls cannot (they run on their own connection, spec 0005 Decision); the partner hat needs a foreign key to `parties`. Runner up: Better Auth's organization plugin with static roles. Full comparison in [rationale.md](rationale.md).
- **Hats fixed in code**: the matrix is a typed constant, versioned with the code that enforces it. Why: four to forty people, and a per brand editable matrix would turn every permission bug into a data bug. Runner up: a `roles` table editable per brand (the organization plugin's dynamic access control does this). A later per brand setting can override the matrix on the same tables.
- **Cost as an extra grant, not a hat permission**: why: the owner wants cost "separate" and off for support; a grant on the person lets a manager without cost exist and lets the media buyer see profit only when chosen. Runner up: a cost flag per hat row.
- **Declaration beside `@Audience`**: `@Permission(...)` or `@AnyHat()` on the handler or the class, in `apps/api/src/platform/access/` like `platform/audience/`, so every module can import it without crossing into identity (spec 0005 AC-27 boundary). Why: permissions differ per handler (a read and a void sit in one controller). Runner up: class only, like `@Audience`, which would split controllers by permission.
- **All listed permissions required**: `@Permission('settings.manage', 'cost.view')` needs both. Why: the rare combined case (cost rules) must be explicit. Runner up: any of.
- **Two "who am I" routes**: `GET /api/me` for staff and `GET /api/partner/me` for partners, one contract. Why: a controller has exactly one audience (`audience.spec.ts`), so one route cannot serve both, and the partner frame needs its own account route (spec 0005 AC-28). The sign in page asks `/api/me` and, on 403 `WRONG_AUDIENCE`, `/api/partner/me`; whichever answers gives `home`. Runner up: a third audience for self routes, which spec 0007 section 2 does not have.
- **Personal data guard is static plus a sweep**: the matrix marks personal permissions and a unit test keeps them off external hats; an end to end sweep proves no answer leaks. Why: a key based runtime scan cannot work because `name` is ordinary data on products and staff (`redaction.ts` keeps bare `name` off the key list for the same reason). Runner up: a response interceptor that scans every answer.
- **Hat removal deletes the row**: `hat_assignments` is current state; history lives in the audit trail (AC-13). Why: no soft deleted rows to filter in every guard query. Runner up: `revoked_at` on the row.
- **`users.role` kept as a plugin owned column**: Better Auth's admin plugin declares `role` and writes `defaultRole` on every new user (`better-auth` 1.7.15, `dist/plugins/admin/schema.mjs` and `admin.mjs`); the plugin stays for the ban check (spec 0005). The column holds `user` for everyone and nothing reads it. Runner up: drop the admin plugin and the column, and write the ban check ourselves.

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Modules and ownership

- **identity** (`apps/api/src/identity/`, after spec 0005 AC-27 moves `auth` and `staff` there): owns `hat_assignments` and `permission_grants`; adds `access/` (loading a person's `Access`, the real `SessionAudiences`), `hats/` (`HatService`: assignment under the user row lock, the conflict and last admin rules, `revokeSessions`, the audit call, `HatsChanged`), and `partner-users/` (controller and service reusing the staff mechanics). Exports: `SessionAudiences`, `HatDirectory.holdersOf(hat)` (ids of active people holding a hat, for task routing and notifications later), and what spec 0005 already exports.
- **platform** (`apps/api/src/platform/access/`): `Access` (an immutable value object: user id, hats, permissions, partner account id; validates on construction that permissions come from the catalog), `@Permission(...)`, `@AnyHat()`, `PermissionGuard`, the `@CurrentAccess()` parameter decorator, and `permission.spec.ts`. It reads `request.access`, which identity's session guard sets. It never queries the database.
- **partners** (`apps/api/src/partners/`): if feature 41 has not built it yet, milestone 3 creates the module with its README and one exported service, `PartnerAccounts` (`isConsignmentPartner(id, tx)`, `list()`), so identity never reads `parties`.
- **contracts** (`packages/contracts/src/access.ts`): `Hat`, `InternalHat`, `ExternalHat`, `Permission`, `PERMISSIONS` (each with its audience and personal flag), `HAT_PERMISSIONS`, `COST_VIEW_DEFAULT` (the form prefill of AC-7), `COST_FIELD_KEYS`, `permissionsFor(hats, grants)`, `AccessRequest`, and the `MeResponse` fields. `StaffRole` is deleted.
- **web** (`apps/web/src/access/`): `useAccess()` (reads `GET /api/me` or `/api/partner/me` through the existing query, returns `can(permission)`), `NoAccessState`; `apps/web/src/staff/` gains the hats dialog and the Partner logins tab.

### Data model sketch

All in `packages/db/src/schema/identity.ts` (the file per owning module of spec 0002 A5). Ids from `id()`, `tenant_id` from `tenantId()`.

| Table | Columns | Keys, checks, indexes |
|---|---|---|
| ★ `hat_assignments` | `id uuid pk`; `tenant_id`; `user_id uuid not null` → `users` restrict; `hat text not null`; `partner_account_id uuid null` → `parties` restrict; `granted_by uuid null` → `users` restrict (null for `create-admin` and the migration); `granted_at timestamptz not null default now()` | unique (`tenant_id`, `user_id`, `hat`); check `hat in ('support','operations','warehouse','manager','media_buyer','partner')`; check `(hat = 'partner') = (partner_account_id is not null)`; index (`hat`, `user_id`); index (`partner_account_id`) where not null |
| ★ `permission_grants` | `id uuid pk`; `tenant_id`; `user_id uuid not null` → `users` restrict; `permission text not null`; `granted_by uuid null` → `users` restrict; `granted_at timestamptz not null default now()` | unique (`tenant_id`, `user_id`, `permission`); check `permission in ('cost.view')` (the grantable extras; a later grant widens the check) |
| `users` (identity, changed) | `role` stays, owned by Better Auth's admin plugin | check `role = 'user'`, default `'user'`; no code reads it |
| `tasks` (tasks, spec 0002) | `owner_hat` | check `owner_hat is null or owner_hat in ('support','operations','warehouse','manager')` (AC-17) |

Relationships: `users` 1:N `hat_assignments` (1 to 6 rows, at least 1 for a person who can sign in); `users` 1:N `permission_grants` (0 or 1 today); `parties` 1:N `hat_assignments` (the partner users of one partner account). Rules a check cannot hold (partner is the only hat, cost never with partner, at least one hat) are enforced by `HatService` under `SELECT ... FOR UPDATE` on the person's `users` row, the only writer of both tables. Both tables are mutable current state (insert and delete); the app role gets `INSERT`, `SELECT`, `DELETE`, and no `UPDATE`.

**Reserved, not built (teams and routing)**: a team will be a group of people inside one hat (`teams (id, tenant_id, hat, name)`, `team_members (team_id, user_id)` in identity), and routing rules will be tasks settings that pick a team or a person for a task type. Both attach to the same `hat_assignments` rows; nothing here is built for them, and nothing here may assume one hat is one queue beyond `tasks.owner_hat`.

### Migration plan

**Strategy**: one step inside the feature 4 baseline when it has not shipped (spec 0002 tenancy child: the baseline counts as shipped at the pilot brand's first import); otherwise expand and contract across two releases.
**Phases**:
1. Baseline path: the baseline creates both tables, the `users.role` check `role = 'user'`, and the `tasks.owner_hat` check; its hand written part runs the mapping of AC-16 (a no op on an empty database, correct on any dev database that already holds people). `create-admin` grants `manager` and `cost.view`.
2. Forward path (baseline already shipped): release N adds both tables, widens the role check to `role in ('admin','staff','user')`, and runs the mapping; the code of this spec ships with it and reads only hats. Release N+1 sets every `role` to `user` and narrows the check.
**Rollback**: baseline path: revert the commit and recreate the dev database. Forward path: release N keeps `role` intact, so reverting the code restores the old behavior.
**Risks**: a dev database migrated before the mapping keeps people with no hat, who then cannot sign in (AC-10); the mapping covers it, and `create-admin` refuses nothing new for them because they are not managers.
  > Amended 2026-11-06 at the build: the regenerated `0001` creates `users` with `CHECK (role = 'user')`, so no `admin` or `staff` row can exist when `0002` runs and the mapping is a safe no op on every database the baseline path migrates; a dev database must be recreated after this baseline change (ADR 0003). `packages/db/test/hats.e2e-spec.ts` proves the mapping SQL itself by dropping the check and planting rows.

### State transitions

None beyond spec 0005. A person's access is a set, not a state machine: any valid set can replace any other valid set in one change. Valid sets: one or more of the five non partner hats with or without `cost.view` (cost only alongside an internal hat or `media_buyer`), or exactly `partner` with one partner account and no grant.

### API surface

*Changed and new routes* (contracts in `packages/contracts/src/auth.ts`, `staff.ts`, `access.ts`, `partner-users.ts`)

| Endpoint | Audience | Method | Key inputs | Key outputs | Declaration | Key errors |
|---|---|---|---|---|---|---|
| `/api/me` | staff | GET | none | `MeResponse`: existing fields minus `role`, plus `hats`, `permissions`, `partnerAccountId: null`, `home` | `@AnyHat()` | 401, 403 `WRONG_AUDIENCE` for a partner |
| `/api/partner/me` | partner | GET, PATCH | PATCH: name, phone, language (opt) | `MeResponse` with `partnerAccountId` | `@AnyHat()` | 401, 403 `WRONG_AUDIENCE` for staff |
| `/api/staff` | staff | GET | existing query plus `hat?` | rows with `hats`, `costView` instead of `role` | `people.manage` | 403 |
| `/api/staff` | staff | POST | name, email, `hats` (1+, no `partner`), `costView` (req); phone, staffCode, language (opt) | staff, setup | `people.manage` | 409 `EMAIL_TAKEN`, `STAFF_CODE_TAKEN`; 422 `HAT_CONFLICT`, `GRANT_NOT_ALLOWED` |
| `/api/staff/:id` | staff | PATCH | as today minus `role` | staff | `people.manage` | as today |
| `/api/staff/:id/access` | staff | PUT | `hats` (1+, no `partner`), `costView`, `updatedAt` (req); `reason` (opt, up to 500) | staff detail | `people.manage` | 409 `STALE_RECORD`, `SELF_HAT_CHANGE`, `LAST_ADMIN`; 422 `HAT_CONFLICT`, `GRANT_NOT_ALLOWED`, `NO_HAT`; 404 |
| `/api/partner-users` | staff | GET | `partnerAccountId?`, `q?`, `status?`, `cursor?`, `limit?` (up to 100) | rows (id, name, email, partnerAccountId, status, lastSignInAt), nextCursor | `people.manage` | 403, 400 `INVALID_QUERY` |
| `/api/partner-users` | staff | POST | name, email, `partnerAccountId` (req); phone, language (opt) | partner user, setup | `people.manage` | 409 `EMAIL_TAKEN`; 422 `UNKNOWN_PARTNER_ACCOUNT` |
| `/api/partner-users/:id` and `/:id/disable`, `/enable`, `/reset-password`, `/resend-invite`, `/reset-two-factor`, `/revoke-sessions` | staff | PATCH, POST | as the staff twins | as the staff twins | `people.manage` | as the staff twins; 404 for a staff id |
| `/api/partner-users/:id/access` | staff | PUT | `partnerAccountId`, `updatedAt` (req); `reason` (opt) | partner user | `people.manage` | 409 `STALE_RECORD`; 422 `UNKNOWN_PARTNER_ACCOUNT`; 404 |
| `/api/partner-users/partner-accounts` | staff | GET | none | `[{ id, code, name }]` from `PartnerAccounts.list()` | `people.manage` | 403 |

**Error codes in one place**: 500 `PERMISSION_MISSING` (our bug), 403 `FORBIDDEN`, 403 `WRONG_AUDIENCE` (spec 0005), 409 `SELF_HAT_CHANGE`, `LAST_ADMIN`, `STALE_RECORD`, 422 `HAT_CONFLICT`, `GRANT_NOT_ALLOWED`, `NO_HAT`, `UNKNOWN_PARTNER_ACCOUNT`.

**Guard order** (all global): `SessionGuard` (identity; sets `request.staff` or `request.partner`, and `request.access`) → `AudienceGuard` → `PermissionGuard`. Guards run before pipes, so a caller without the permission gets 403 before any body validation.

**Events**: `HatsChanged` (AC-13). `StaffCreated` (spec 0005 AC-23) gains `hats` and `costView`; `PartnerUserCreated`, `PartnerUserUpdated`, `PartnerUserDisabled`, `PartnerUserEnabled`, `PartnerUserPasswordReset`, `PartnerUserSessionsRevoked`, `PartnerUserTwoFactorReset` mirror the staff events with the same fields.

### Value sourcing

| Action | Value produced / displayed | Source |
|---|---|---|
| Any request | the person's hats, grants, partner account | `hat_assignments` and `permission_grants` joined to the session's user, read on every request (spec 0005 AC-33 a) |
| Any request | effective permissions | derived: `permissionsFor(hats, grants)` from `HAT_PERMISSIONS` |
| Any request | the permission a route needs | `@Permission(...)` or `@AnyHat()` metadata, handler first, else class |
| Session check | audiences the person may use | `SessionAudiences`: `partner` for the partner hat, else `staff`; none when no hat |
| Partner request | partner account id | the person's `partner` row in `hat_assignments`, never the request |
| Any answer with cost fields | include them or not | `access.has('cost.view')`, applied by the response type's serializer |
| `GET /api/me` | `home` | derived from hats: `partner` hat gives `partner`, else `backoffice` |
| Web nav, actions, columns | visible or hidden | `permissions` from `GET /api/me` or `/api/partner/me` |
| Hats dialog | cost switch starting value | `COST_VIEW_DEFAULT` for the hat being added (AC-7), else the stored grant |
| Hats dialog | hat descriptions in both languages | web message catalogs, one key per hat and permission |
| Hat change | actor, ip, user agent | the guard's current user, trusted `X-Forwarded-For`, the request header (spec 0005) |
| Hat change | before and after | the person's rows read under `FOR UPDATE`, then the new set |
| Hat change | whether sessions end | spec 0005 AC-33 b: only the partner account move can reach it, because an empty set and an audience move are refused (AC-12) |
| Last admin rule | active managers | `hat_assignments` with `hat = 'manager'` joined to `users` where not banned, under `ADMIN_RULE_LOCK` |
| Stale check | `updatedAt` | `users.updated_at`, which every hat or grant change sets in the same transaction and a sign in never sets (AC-12 ruling of 2026-11-07) |
| Partner user create | partner account validity | `PartnerAccounts.isConsignmentPartner(id, tx)` from the partners module, plus the foreign key |
| Partner logins tab | partner account names | `GET /api/partner-users/partner-accounts` |
| Migration | the new hats | `users.role` before the mapping (`admin`, `staff`) |
| Task queues (feature 17) | which hat queues a person sees | `access.hats` filtered to `InternalHat` |
| Campaign report (features 48, 49) | profit per campaign | `campaigns.view`; cost of goods column only with `cost.view` |

### Key invariants

- Every person who can sign in holds at least one hat. A person with `partner` holds nothing else and no grant.
- At least one active manager always exists (checked under `ADMIN_RULE_LOCK`).
- No hat contains `cost.view`; no external hat contains a personal permission.
- Every staff or partner handler has exactly one permission declaration; every declared permission is in the catalog and matches the controller's audience.
- Access is read from the database on every request; no hat or permission is stored in the session or a cookie.
- A partner account id on a partner request comes only from the person's hat row.
- `HatService` is the only writer of `hat_assignments` and `permission_grants`; every write locks the person's `users` row first.
- Nothing reads `users.role`.

### Security model

- Deny by default twice: no audience is a 500 (`audience.spec.ts`), no permission is a 500 (`permission.spec.ts`), and both fail the build first.
- The web only hides; the api decides. Every hidden action still answers 403.
- Cost and stock value are commercially sensitive: removed in the api by serializer, never only hidden in the screen (spec 0006 rule, now per permission).
- Customer names, phones, and addresses are personal data under Law 151: only personal permissions reach them, no external hat holds one, and the sweep proves no answer to an external hat carries a personal data key.
- Partner isolation: partner A can never name partner B's account, because no partner route accepts an account id.
- Hat changes are access control mutations: always audited (AC-13), never by the person on themselves, never from Better Auth routes (its `/admin/*` routes stay 404).
- Partner users and the media buyer sign in with the same lockout, limits, and optional two factor as staff (spec 0005 AC-28).

### Configuration required

None. No new environment variable; the matrix is code and the grants are data.

### Critical test scenarios

- Happy path: a person with `warehouse` posts a receipt and sees stock without cost; the same cookie after a manager adds `cost.view` sees cost on the next request; after it is removed, cost is gone, verifies **AC-2**, **AC-6**, **AC-12**
- Happy path: a person with `support` and `warehouse` reaches the routes of both hats and gets 403 on `people.manage` routes, verifies **AC-1**, **AC-2**
- Auth/permission: removing one `@Permission` from a staff handler, or adding one to a public controller, fails `permission.spec.ts`; a test controller with no declaration answers 500 `PERMISSION_MISSING`, verifies **AC-4**
- Auth/permission: the route sweep runs every staff and partner route as each hat alone (and the manager with and without cost): 403 exactly where the matrix says, no `COST_FIELD_KEYS` without `cost.view`, no personal data key for the media buyer or partner, verifies **AC-5**, **AC-6**, **AC-8**
- Auth/permission: a partner user gets 403 `WRONG_AUDIENCE` on every staff route, `GET /api/partner/me` returns their own account id, and a planted partner handler reading `partnerAccountId` from the query fails the static test, verifies **AC-9**, **AC-10**
- Failure case: two managers remove each other's `manager` hat at the same moment; exactly one succeeds and one manager remains (409 `LAST_ADMIN`), verifies **AC-12**, **AC-14**
- Failure case: a stale `updatedAt` answers 409 `STALE_RECORD` and changes nothing; a manager changing their own hats gets 409 `SELF_HAT_CHANGE`; `partner` with another hat gets 422 `HAT_CONFLICT`; cost for a partner gets 422 `GRANT_NOT_ALLOWED`, verifies **AC-7**, **AC-9**, **AC-12**
- Failure case: moving a partner user to another partner account deletes their sessions in the same transaction (next request 401 `SESSION_EXPIRED`); adding `support` to a warehouse person keeps their session, verifies **AC-12**, **AC-15**
- Happy path: a hat change writes one audit entry (or, before feature 10, one log line) and one `HatsChanged` with before and after and no email or phone, verifies **AC-13**
- Happy path: the migration on a database with one `admin` and one `staff` gives `manager` plus `cost.view` and `support`, `operations`, `warehouse`; `create-admin` on a fresh database gives `manager` plus `cost.view`, verifies **AC-14**, **AC-16**
- Happy path: the web hides the people nav item and the cost columns for a warehouse person, shows the no access state on `/staff` by URL, and the hats dialog works by keyboard in Arabic and English with axe clean, verifies **AC-11**, **AC-18**
- Auth/permission: inserting a task with `owner_hat = 'media_buyer'` fails the check, verifies **AC-17**

## Build plan

Tracer Bullet: milestone 1 runs one real thread through every layer (tables, guard, one route family, serializers, `GET /api/me`, the web nav and cost columns) using the internal hats only; each later milestone thickens one segment end to end. **Depends on**: the feature 4 baseline (spec 0002: `tenant_id`, `parties`, `tasks`, the ownership map) and the feature 7 amendment of spec 0005 (milestone 1 moves `auth` and `staff` into `identity`; milestone 3 adds the `SessionAudiences` port, `revokeSessions(userId, tx)`, and `home`). Milestone 1 here starts after spec 0005 milestone 1 and the baseline; milestone 3 here replaces spec 0005's staff only `SessionAudiences`.

**Milestone 1: Hats in the data and one permission per route** (backend, then frontend)
1. [x] Add `hat_assignments` and `permission_grants` to `packages/db/src/schema/identity.ts`, the `users.role` and `tasks.owner_hat` checks, the ownership map entries, and the role mapping, in the baseline or the forward migration per the migration plan, satisfies **AC-3**, **AC-16**, **AC-17**
2. [x] `packages/contracts/src/access.ts`: hats, permissions with audience and personal flag, `HAT_PERMISSIONS`, `COST_VIEW_DEFAULT`, `COST_FIELD_KEYS`, `permissionsFor`; delete `StaffRole`; a matrix unit test (no hat has `cost.view`, no external hat has a personal permission, manager has every staff permission but `cost.view`, every permission is used), satisfies **AC-1**, **AC-6**, **AC-8**
3. [x] `apps/api/src/platform/access/`: `Access`, `@Permission`, `@AnyHat`, `@CurrentAccess`, `PermissionGuard` registered after `AudienceGuard`, and `permission.spec.ts` with its planted failure cases, satisfies **AC-4**
4. [x] Identity: load `Access` in `SessionGuard` on every request, set `request.access`, implement `SessionAudiences` for the internal hats, end sessions of a person with no hat, satisfies **AC-2**, **AC-10**
5. [x] Declare a permission on every existing route per the mapping table; delete `@Roles`, `RolesGuard`, and `role` from `CurrentStaff`; move the spec 0006 serializers from `role` to `Access`, satisfies **AC-5**, **AC-6**
6. [x] `create-admin`, its reset modes, and the last admin rule count `manager`, satisfies **AC-14**
7. [x] `GET /api/me` returns `hats`, `permissions`, `partnerAccountId`, `home`; web: `apps/web/src/access/` with `useAccess`, nav items declare `needs` (with the unit test), cost columns and admin actions read `can(...)`, the user menu shows hats, satisfies **AC-11**
8. [x] End to end: the warehouse and manager thread (receipt, stock with and without cost, 403 on `/api/staff`), and the migration test, satisfies **AC-2**, **AC-6**, **AC-16**
  > Built 2026-11-06: the matrix also exports `HAT_AUDIENCE` and `GrantablePermission`; `Access` lives in `apps/api/src/platform/access/` and is loaded by identity's `AccessLoader` after the audience check; `audiencesOfHats(hats)` is the pure rule the port and its SQL share. Milestone 1 kept an `admin` / `staff` preset on `/api/staff` and read the database twice per request; milestone 2 removed the preset (hats and `costView` on every staff route) and folded the reads into one (`AccessLoader`, audiences derived with `audiencesOfHats`). The web nav uses `needs` per item, `ANY_HAT` for Home and Design only; `NoAccessState` is wired into `/staff` and `/locations` (the rest is milestone 4).

**Done when:** `pnpm db:migrate && pnpm build && pnpm typecheck && pnpm --filter @ssdashboard/contracts test && pnpm --filter @ssdashboard/api test && pnpm --filter @ssdashboard/db test:e2e && pnpm --filter @ssdashboard/api test:e2e && pnpm --filter @ssdashboard/web test` pass, and `pnpm --filter @ssdashboard/api test -- src/platform/access` fails when one `@Permission` is removed from `catalog.controller.ts`.

**Milestone 2: Giving and taking hats** (backend, then frontend)
1. [x] `HatService` in `identity/hats/`: set replace under the `users` row lock, one hat minimum, `HAT_CONFLICT`, `GRANT_NOT_ALLOWED`, `SELF_HAT_CHANGE`, `STALE_RECORD` on `users.updated_at`, `LAST_ADMIN` under `ADMIN_RULE_LOCK`, `revokeSessions(userId, tx)` per spec 0005 AC-33 b, satisfies **AC-7**, **AC-12**
2. [x] `PUT /api/staff/:id/access`, and `POST /api/staff` and the staff contracts with `hats` and `costView` instead of `role`, satisfies **AC-12**, **AC-14**
3. [x] Audit entry through feature 10's writer in the same transaction when it exists, else the log line; `HatsChanged` after commit; `StaffCreated` gains hats, satisfies **AC-13**
4. [x] Web: the hats dialog on `/staff` (checkbox per hat with its description, cost switch prefilled from `COST_VIEW_DEFAULT`, reason), the hats and cost columns in the list, both languages, satisfies **AC-7**, **AC-18**
5. [x] Tests: the concurrent last manager removal, stale and self refusals, same cookie grant and removal, session kept on a hat added, satisfies **AC-12**, **AC-14**
  > Built 2026-11-06: one audit entry per change (spec 0010 AC-1 and AC-13): `hat.revoked` when any hat or the cost grant is taken away, else `hat.granted`, with before and after `{ hats, costView, partnerAccountId }`; `staff_user.created`, `.disabled`, `.enabled` and `.password_reset` are written in the staff service's transactions. Identity writes through an `IdentityAudit` port shaped like `AuditService.record`, bound since the merge of spec 0010 milestone 1 (2026-11-06) to `AuditTrailIdentityAudit`, which writes real `audit_entries` rows in the change's transaction; the six codes are in `AUDIT_ACTIONS` with labels, and `apps/api/test/identity-audit.e2e-spec.ts` is their proof. `hat.revoked` is reason optional in the registry; the manager case passes `reasonRequired` and keeps HatService's 422 `REASON_REQUIRED`. The manager's free text `reason` is redacted on the hat change log line. `PATCH /api/staff/:id` is strict (a `role` field is refused). Over HTTP the acting manager always counts as another manager, so `LAST_ADMIN` on removal is proven by the concurrent test. There is no staff detail page, so "Edit hats" sits in the row menu. The run command for the hats e2e is `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/hats.e2e-spec.ts` (a `--` filter does not apply).

**Done when:** `pnpm --filter @ssdashboard/api test -- src/identity && pnpm --filter @ssdashboard/api test:e2e -- test/hats.e2e-spec.ts && pnpm --filter @ssdashboard/web test && pnpm --filter @ssdashboard/web test:e2e -- e2e/hats.spec.ts` pass.

**Milestone 3: The external hats** (backend, then frontend)
1. [x] Partners module with `PartnerAccounts` (`isConsignmentPartner`, `list`) if feature 41 has not built it, with its README, satisfies **AC-9**, **AC-15**
2. [x] `SessionAudiences` returns `partner` for the partner hat; `request.partner` from the hat row; `GET` and `PATCH /api/partner/me`; the static test that fails a partner handler reading an account id from the request, satisfies **AC-9**, **AC-10**, **AC-11**
3. [x] `/api/partner-users` routes reusing the staff service mechanics, the partner account move with session revoke, the partner user events, satisfies **AC-12**, **AC-15**
4. [x] The media buyer persona: create with `media_buyer` only, 403 everywhere but `@AnyHat()` and `campaigns.view` routes; the sign in page falls back to `/api/partner/me` on `WRONG_AUDIENCE`, satisfies **AC-8**, **AC-10**
5. [x] The route sweep `apps/api/test/access-sweep.e2e-spec.ts`: every route from the module graph, a path fixture per route (a route missing from the fixture map fails the test), every hat alone, cost keys and personal data keys, satisfies **AC-5**, **AC-6**, **AC-8**
6. [x] Web: the Partner logins tab on `/staff` (list, create with the partner account picker, the row actions), satisfies **AC-15**, **AC-18**
  > Built 2026-11-06 (backend; item 6, the Partner logins tab, built 2026-11-07 on the web side): `apps/api/src/partners/` with `PartnerAccounts` (an archived consignment partner counts as unknown); `request.partner` carries `partnerAccountId` from the hat row; the forced password change follows a `@WhoAmI()` mark on the two who-am-I handlers, not the path; staff and partner logins share `identity/accounts/account-actions.ts`; an account move is `hat.revoked` and ends every session in its transaction; partner login actions reuse the `staff_user.*` audit codes (same `users` row, record type `user`); one event beyond the six listed, `PartnerUserUpdated`, mirrors `StaffUpdated`. The route sweep (`apps/api/test/access-sweep.e2e-spec.ts`) pins each route's permission to the route mapping table and lets the `phone` key through only on the four who-am-I routes, where it is the caller's own phone (the AC-8 exception, ruled 2026-11-07). Also built (question 9, ruled 2026-11-07): a person with no hat is refused at sign in by the Better Auth after hook (`sign-in/no-access.ts`, 403 `NO_ACCESS`, logged), and taking over a cost holder's sign in answers its own code `COST_HOLDER_PROTECTED` (403).

**Done when:** `pnpm --filter @ssdashboard/api test && pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/access-sweep.e2e-spec.ts test/partner-users.e2e-spec.ts test/partner-move-rollback.e2e-spec.ts && pnpm --filter @ssdashboard/web test:e2e -- e2e/audiences.spec.ts e2e/hats.spec.ts` pass.

**Milestone 4: Hardening and docs** (frontend, then docs)
1. [x] `NoAccessState` on every backoffice page whose permission the person lacks, axe and keyboard checks of `/staff` (both tabs) and the no access state in both languages, satisfies **AC-11**, **AC-18**
2. [x] Identity README and `AGENTS.md`: the hats, the declaration rule, the cost rule, the reserved teams and routing note; `apps/api/AGENTS.md` and `apps/api/src/inventory/AGENTS.md` lines that name `@Roles` or admins replaced, satisfies **AC-4**, **AC-5**
3. [x] Fill `verify.md` results for every milestone, satisfies **AC-1** to **AC-18**
  > Built 2026-11-07: `NoAccessState` gates `/stock`, `/stock-receipts`, `/stock-receipts/[id]`, `/skus`, `/skus/[id]` (`stock.view`), `/stock-receipts/new` (`stock.receive`) and `/audit` (`audit.read`) the way `/staff` and `/locations` already were: each `*-page.tsx` checks the permission and renders a `*-view.tsx` whose queries wait for it, so nothing is asked of the api before access is known or without the permission; a failed `/api/me` shows `AccessErrorState` with Try again on every gated page, and the receipt form shows a skeleton while access loads (`apps/web/src/access/gated-pages.spec.tsx`, `apps/web/e2e/no-access.spec.ts`: axe and keyboard on the no access state and both `/staff` tabs, English and Arabic, desktop and mobile). Also built (AC-12 ruling of 2026-11-07, review item n6): sign in and the person's own password change write `last_sign_in_at` and `must_change_password` through `identity/sign-in/last-sign-in.ts`, never Better Auth's `updateUser`, so neither moves `users.updated_at` (`apps/api/test/hats.e2e-spec.ts`). Reviews: `docs/reviews/security-hats-m4.md`, `docs/reviews/review-hats-m4.md`. Known gap, routed to the shell owner: the shell's location switcher calls `/api/locations` (`stock.view`) for every person, so a media buyer sees "Locations unavailable" in the header.

**Done when:** `pnpm lint && pnpm format:check && pnpm --filter @ssdashboard/web test:e2e` pass and `node packages/config/scripts/check-doc-links.mjs` reports no broken link.

## Questions for the owner

None blocks the build. Each is built with the default shown until you rule.

1. **Which hats see cost by default?** *Default: manager and operations on, support, warehouse, and media buyer off.* It is only the starting position of the switch when a hat is given, plus the migration (former admins keep cost). If you want it on for warehouse too, or for the manager only, only `COST_VIEW_DEFAULT` changes.
2. **Does the media buyer see campaign profit?** Profit per campaign reveals cost of goods in total for that campaign. *Default: yes, campaign level profit with `campaigns.view` (scope feature 49 says profit is "for the owner and the media buyer"); the cost of goods column and product margins only with the cost grant.* If no: campaign profit moves behind `cost.view`, and the media buyer sees spend, orders, kept revenue, and return rate only.
3. **Who creates logins for partners and the media buyer?** *Default: the manager only (`people.manage`).* If operations should too: a new permission `people.manage_external` for partner users and media buyers, added to operations.
4. **Who may create a gifted order?** *Default: the manager only (carried from spec 0002, question 8).* If others: add `orders.gift` to the chosen hats.
5. **Should anyone be limited to one location?** *Default: no, every permission covers every location.* If yes (for example a second warehouse with its own team): a location scope on the hat row and a filter in every stock route, a later spec.
6. **Must the manager hat use two factor?** *Default: no, optional for everyone, as chosen in spec 0005 (question 1), and the run book recommends it.* If yes: sign in refuses a manager without two factor after a grace period, and `create-admin` prints the enrolment step.
7. **Do you want an accountant hat now?** *Default: no; the operations hat marks exports imported on the accountant's word (spec 0007, M9).* If yes: a seventh external hat with `exports.run` and no personal permission.
8. **May a partner user upload sales, or only read?** *Default: both read and upload (`partner.view_own`, `partner.submit_sales`); a partner without any login is the "no access" case where the operations agent enters statements.* If read only: drop `partner.submit_sales` from the partner hat.
9. **May a person with no hat sign in at all?** *Default: no. After a correct password (or two factor code) the sign in answers 403 `NO_ACCESS` and the session is deleted; the person sees "This account has no access yet" and a manager must give a hat first.* If yes: the person signs in and lands on the no access state; remove the one call to `refuseWhenNoHat` in `sign-in/auth-hooks.ts` and the file `sign-in/no-access.ts`. **Ruled 2026-11-07: no, as built.**

## Consequences

**Positive**:
- One person can wear the four hats of a small brand, and forty people can split the same hats, with no code change.
- A forgotten permission fails the build, not production; the sweep catches a forgotten serializer.
- Cost privacy no longer depends on a role name: anyone can be granted cost, and nobody gets it by accident.
- The media buyer and partners are walled off from customer data in the api, testable in CI.
- Hat changes commit with their session and last admin rules in one transaction.

**Negative / tradeoffs**:
- A fixed matrix means a brand that wants a different split waits for a code change (or the later per brand setting).
- Every request now loads hats too (one more indexed read per request, on top of the session and user reads of spec 0005); measure at feature 16.
- Every new route must declare a permission and be added to the sweep fixture map, a small tax on every feature.
- The route sweep is slow and needs a fixture per route; it is the price of proving "no customer data" rather than hoping.
- `users.role` stays as an inert column because Better Auth's admin plugin writes it.
- Two "who am I" routes and a sign in page fallback, because one controller has one audience.

**Neutral**:
- `StaffRole`, `@Roles`, and `RolesGuard` are deleted; the web's `adminOnly` becomes `needs`.
- A minimal partners module may appear before feature 41, holding one service.
- Teams and routing are reserved on the same data, not built.

## Follow-up

- [ ] Spec 0005 AC-28 says `GET /api/me` returns `home` to partner users; with one audience per controller that answer comes from `GET /api/partner/me` (this spec, Decision). Update AC-28 and its milestone 3 task in the next amendment.
- [ ] Spec 0002 customers child: `tasks.owner_hat` "hat names are feature 8 detail" is now decided (AC-17); add the check to the baseline table.
- [x] Spec 0006 security model and AC-11 say "admins"; they now read "people with the cost grant" (AC-6). `/sync` flags it. (Done: AC-11 amended 2026-11-06, AC-15 and the security model 2026-11-07, with spec 0005 AC-25.)
- [ ] Feature 10 (audit trail): accept the `HatsChanged` before and after shape as an audit entry kind written in the caller's transaction.
- [ ] Features 13 onward: every new response type with a cost field gets a serializer on `Access` and a sweep fixture; order line sale amounts never use a name in `COST_FIELD_KEYS`.
- [ ] Features 48 and 49: campaign routes declare `campaigns.view` and answer only aggregates, never an order or customer row.
- [ ] Feature 41: build `PartnerAccounts` fully (or adopt the one milestone 3 adds) and the partner screens on top of `/api/partner-users`.
- [ ] Measure the per request access read at feature 16 (spec 0005 already flags the session read).
