# 0008. Roles as hats: decision record

Build spec: [index.md](index.md).

## Context

Scope feature 8 ([foundations](../../scope/foundations.md), GA) asks for permissions as hats one person can wear several of: support, operations, warehouse, manager, plus external hats for the media buyer (campaign results only, no customer data) and partners (their own given, sold, owed only, or no access with the operations agent entering statements). Cost and margin are a separate permission, off for support by default. Teams and routing come later on the same data. Its done when: each default hat sees only what it should, a person can hold several hats, cost and margin hide without the cost permission, and the external hats cannot reach customer data.

The people behind it are small teams. The final plan (positioning, section 2 (kept private)) says a typical brand has four people (customer support, operations, warehouse, manager) plus a freelance media buyer and the consignment partners, and that the product "must feel right at four and work at forty". In a four person brand one person wears two or three hats on the same day. Section 6.6 of the same plan says Better Auth's organization plugin "supplies members, roles, permissions, and optional teams", which is a claim to test, not a decision.

What is already built and binding:
- **Sign in and sessions** (spec 0005, built, amended for feature 7): Better Auth 1.7.15 with the admin and two factor plugins, cookie caching off, the person read from the database on every request, an advisory lock (`ADMIN_RULE_LOCK`) protecting the last admin rule, and staff changes done in our own SQL in one transaction because Better Auth's admin calls run on their own connection. Two roles exist, `admin` and `staff`, as a checked `users.role` column, a `@Roles('admin')` decorator, and `RolesGuard` (`apps/api/src/identity/sign-in/roles.guard.ts`). The amendment's AC-28, AC-29, and AC-33 fix what this spec must meet: partner users on the same sign in, an audience aware session guard fed by a `SessionAudiences` port, sessions that follow hat changes (revoke in the same transaction through `revokeSessions(userId, tx)`, `HatsChanged`, `LAST_ADMIN` under the lock, no change to your own hats).
- **Audiences** (spec 0007 section 2, built as `apps/api/src/platform/audience/`): every controller declares exactly one of `staff`, `partner`, `portal`, `hook`, `public`; `audience.spec.ts` fails the build otherwise; a partner session is bound to one partner account whose id comes from the session, never from the request.
- **Cost privacy** (spec 0006 AC-11): unit cost, line totals, average cost, and stock value are removed from staff answers by one serializer per response type keyed on `role === 'admin'` (`apps/api/src/inventory/stock/stock.service.ts`, `receipts.service.ts`), and the web hides the columns.
- **Data model** (spec 0002 amendment, feature 4): one database per brand with `tenant_id` on every row and no row level security; identity owns the users and auth tables, and hats are this feature's; cost stays private behind the cost permission (`cost_records`, `order_cost_rules`, `order_lines.unit_cost`, margin); the media buyer never reads customer tables; tasks carry `owner_hat`; gifted orders default to the manager hat.
- **Law 151**: customer names, phones, and addresses are personal data (`packages/config/src/redaction.ts`). An outside freelancer seeing them is a disclosure the brand must be able to rule out.

Not deciding leaves `admin` and `staff` in place, which cannot express a support agent who must not see cost, a warehouse person who must not merge customers, a media buyer, or a partner login, and leaves every later feature (orders, confirmation, tasks, settlement, exports, partners, campaigns) without a permission to declare.

## Options considered

### Option 1: Own tables in the identity module, hat matrix as code (chosen)

Two small tables in identity (`hat_assignments`, `permission_grants`), a typed hat to permission matrix in `packages/contracts`, access loaded by the existing session guard on every request, and a platform `PermissionGuard` reading a `@Permission(...)` declaration next to `@Audience` (basis: spec 0007 section 2 and the built `platform/audience/` pattern).

**Pros**:
- Hat changes commit in the caller's transaction with `revokeSessions` and `ADMIN_RULE_LOCK`, which spec 0005 AC-33 requires (basis: spec 0005 Decision, "Better Auth's admin calls run on their own connection").
- The partner hat carries a real foreign key to `parties`, and the guard reads the partner account from a column, not a parsed string.
- One row per hat makes "who holds operations" an indexed query for task routing and the last manager count.
- Fits the tenant rule as is: `tenant_id` by default, unique keys led by it (basis: spec 0002 AC-15).
- The matrix is reviewed and tested like code, and the web reads the same constant.

**Cons**:
- We write and own the assignment service, its locking, and its tests.
- No ready made invitation, team, or member screens.
- A brand cannot reshape the matrix without a code change in this version.

### Option 2: Better Auth's organization plugin with static roles

One organization per install, every person a `member`, hats as organization roles defined with `createAccessControl`, several roles per member, optional teams, checks through `hasPermission` (basis: `organization-best-practices` skill).

**Pros**:
- Members, roles, permission checks, invitations, and teams come built and documented.
- Teams are a configuration switch away when routing arrives.
- Several roles per member are supported.

**Cons**:
- One database is one brand (spec 0007 section 7), so the `organization` table holds exactly one row forever, and every session needs an active organization set after sign in (`activeOrganizationId` on the session, `dist/plugins/organization/organization.mjs`).
- Several roles are stored as one comma joined string in `member.role` and split on every check (`dist/plugins/organization/routes/crud-members.mjs`), so "who holds operations" is a text search and the partner account binding has no place to live with a foreign key.
- Its membership changes run through Better Auth's own endpoints and adapter, outside our transaction, so the revoke and last manager rules of spec 0005 AC-33 cannot commit with them; its own "last owner" protection is a second, unlocked copy of our last admin rule.
- Its invitation flow duplicates the invite through `verifications` that spec 0005 built and tested, and every one of its routes would need closing in the allowlist anyway.
- It adds four or more tables (`organization`, `member`, `invitation`, optional `team`, `teamMember`, `organizationRole`) to carry what two tables carry.

### Option 3: Better Auth's admin plugin access control, several roles in `users.role`

The admin plugin, already installed, accepts custom roles and an access control statement; a user's roles sit comma separated in `users.role` (basis: `dist/plugins/admin/schema.mjs`, the installed plugin).

**Pros**:
- No new table and no new plugin.
- Permission statements are typed by Better Auth's access helper.

**Cons**:
- The same comma joined string: no index per hat, no partner binding, no granted by or granted at.
- The plugin's `setRole` route is closed (spec 0005 AC-15), so every change is our SQL on a Better Auth owned column anyway.
- Couples the business word "hat" to a library field whose meaning can change across upgrades.

### Option 4: A roles table editable per brand (dynamic roles)

`roles (name, permissions jsonb)` plus `user_roles`, with a screen where the manager defines roles (the organization plugin's dynamic access control does the same with `organizationRole`).

**Pros**:
- Every brand can shape its own hats without a release.
- Covers the "work at forty" case with custom roles.

**Cons**:
- Every permission bug becomes a data bug per brand, invisible to CI; the "no customer data for external hats" guarantee can no longer be proven by a unit test.
- A screen and a migration story for role definitions that four person brands do not need.
- Client differences belong in settings on top of a sound default (AGENTS.md), which a later setting over Option 1's tables gives without this cost.

## Rationale

Option 1 wins on the two hard constraints from Context. First, spec 0005 AC-33 makes hat changes a transactional affair: the change, the session revoke, and the last admin check under `ADMIN_RULE_LOCK` must commit together. Spec 0005 already found that Better Auth's plugin calls run outside our transaction and chose our own SQL for staff changes; Options 2 and 3 would reopen that exact problem for hats. Second, one database is one brand. The organization plugin's value is many organizations per user; with one organization per install it brings a singleton table, an active organization to set on every session, and comma joined roles, while the things this product needs (a partner account foreign key, an indexed hat for task queues, the cost grant, an audit trail with before and after) all have to be built beside it anyway. Positioning 6.6's line about the plugin was written before the one database per tenant decision of spec 0007 and is overridden here, which is why the skill is listed as weighed and not adopted.

The matrix lives in code rather than data (Option 4 rejected) because the strongest promise of this feature, that the media buyer and partners can never reach customer data, is only provable when the matrix is a constant a unit test can read. Brands that want a different split later get a per brand setting layered over the same tables, the way spec 0007 wants client differences: settings over a sound core, never core edits.

Cost is a grant on the person rather than a hat permission because the owner described it as separate and off for support by default. That reads as a switch per person with a sensible starting position per hat, which is what `COST_VIEW_DEFAULT` gives. It also keeps the manager hat meaningful for a brand that wants a store manager who does not see margins, and lets the media buyer see profit only when the owner chooses.

Permissions are declared per handler, not per class, because one controller already mixes reads and admin actions (`receipts.controller.ts` posts, reads, and voids). The declaration sits in `platform/access/` beside `platform/audience/` so every module can use it without importing a file inside identity, which spec 0005 AC-27's boundary test forbids. The build test copies the proven shape of `audience.spec.ts`: walk the module graph and the controller files, fail on a missing or wrong declaration.

The personal data guarantee is enforced twice and in the api: statically (no external hat holds a permission flagged as reaching personal data) and by a route sweep that calls every route as each hat. A runtime scan of every answer was weighed and rejected: the redaction list deliberately leaves bare `name` and `email` out because products and staff have them, so a key scan would either miss customer names or block product lists.

### Decisions settled here, with runner ups

| Decision | Pick | Why | Runner up |
|---|---|---|---|
| Storage | `hat_assignments`, `permission_grants` in identity | transaction with session rules; partner foreign key | organization plugin |
| Matrix | constant in `packages/contracts/src/access.ts` | provable by unit test, shared with web | `roles` table per brand |
| Cost | extra grant `cost.view` per person | "separate" in the owner's words; manager without cost possible | cost flag per hat row |
| Declaration | `@Permission(...)` or `@AnyHat()`, handler or class | reads and writes share controllers | class only |
| Several permissions in one declaration | all required | explicit combined cases | any of |
| Location scoping | none | one warehouse plus partner locations in the target brands | location id on the hat row |
| Partner hat | exclusive, one account, partner audience only | spec 0007 section 2; spec 0005 question 2 default | partner plus staff hats on one login |
| Media buyer | staff audience, `campaigns.view` only | signs in on the staff host; spec 0007 has no media audience | a new audience |
| Who administers people | manager (`people.manage`) | creating logins is a security act | operations for partner logins |
| `users.role` | kept, `user` for everyone, unread | the admin plugin writes it and stays for the ban check | drop plugin and column |
| Hat removal | delete the row, history in the audit trail | no soft deleted rows in the guard query | `revoked_at` |
| Who am I | `/api/me` and `/api/partner/me` | one audience per controller | a self audience |
| Leak proof | static matrix test plus route sweep | `name` is not a personal key in general | response scanning interceptor |

## Evidence from the installed code

- `apps/api/src/identity/sign-in/roles.guard.ts`, `roles.decorator.ts`: the role check this spec replaces; `@Roles('admin')` appears in `catalog.controller.ts`, `locations.controller.ts`, `receipts.controller.ts`, `sku-lifecycle.controller.ts`, `staff.controller.ts`.
- `apps/api/src/inventory/stock/stock.service.ts` (`serializeStockRow`, `serializeSkuStock`, `serializeMovement`) and `receipts.service.ts` (`serializeReceipt`): the cost serializers keyed on `role === 'admin'`.
- `apps/api/src/inventory/locations/locations.controller.ts`: the archived filter checks `request.staff.role !== 'admin'` inside the handler.
- `apps/api/src/identity/sign-in/auth.factory.ts`: `admin({ defaultRole: 'staff', adminRoles: ['admin'] })` and `twoFactor(...)`; cookie cache off.
- `better-auth` 1.7.15 in `node_modules`: `dist/plugins/admin/schema.mjs` declares `role`, `banned`, `banReason`, `banExpires` on the user and `impersonatedBy` on the session; `admin.mjs` writes `defaultRole` (default `user`) on user creation and refuses a banned user at sign in. `dist/plugins/organization/organization.mjs` adds `activeOrganizationId` (and `activeTeamId` with teams) to the session and an `organizationRole` table with dynamic access control; `routes/crud-members.mjs` and `routes/crud-invites.mjs` split `member.role` on commas.
- `apps/web/src/shell/nav.ts`: `adminOnly` on nav items, filtered by `role !== 'admin'`; `apps/web/src/inventory/stock-page.tsx`, `receipt-view.tsx`, `locations-page.tsx`, `staff-page.tsx`, `catalog/sku-edit-body.tsx` read `me.role`.
- `packages/contracts/src/auth.ts`: `StaffRole` and `MeResponse.role`.
- `packages/config/src/redaction.ts`: `PERSONAL_DATA_KEYS` excludes bare `name` and `email` on purpose.
- `zod` 4.6.7 is installed (`.meta()` and registries exist), noted for a later option of tagging cost fields in the contracts; not used by this spec.

## References

**Project sources** (verifiable, in this repo):
- `AGENTS.md`: domain modules, audiences deny by default, one schema per shape, personal data rule, migrations forward only
- [Spec 0005](../0005-staff-sign-in/index.md) amendment: AC-27 (identity boundary), AC-28 (partner users), AC-29 (`SessionAudiences`), AC-33 (sessions and hats), questions for the owner 1 and 2
- [Spec 0002](../0002-core-data-model/index.md) amendment: AC-15 (tenant id), the tenancy child's ownership map, the security model (cost private, media buyer), question 8 (gifted orders); customers child (`tasks.owner_hat`)
- [Spec 0006](../0006-core-stock-loop/index.md): AC-11 and the serializer per response rule
- [Spec 0007](../0007-stack-architecture-operations-layer/index.md): section 2 (audiences, partner bound to one account), section 7 (one database per tenant), Carried M9
- Final plan (kept private): sections 2, 6.6, 6.8, 7
- Scope features 8, 17, 41, 42, 49 ([foundations](../../scope/foundations.md), [confirmation to cash](../../scope/confirmation-to-cash.md), [consignment and accounting](../../scope/consignment-and-accounting.md), [Meta and WhatsApp](../../scope/meta-and-whatsapp.md))
- Installed skills: `organization-best-practices`, `better-auth-best-practices`, `better-auth-security-best-practices` (private `.claude/skills/`)

**Practices & standards**:
- Deny by default with a build time check per route
- Least privilege, with sensitive fields removed at the api, not hidden in the client
- Role based access control with additive roles (union of permissions)
- Optimistic concurrency with an `updatedAt` check, and a row lock for invariants across rows
- Expand and contract migrations
- Audit logging for every access control change
