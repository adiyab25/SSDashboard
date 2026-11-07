# Partners

The brand's partner accounts: suppliers, factories, consignment partners and wholesale customers (`parties`). Today it holds only what identity needs to bind a partner login to a consignment partner (spec 0008 milestone 3); feature 41 builds the partner accounts and handovers on top of it.

## Owns

- The `parties` table (defined in [packages/db](../../../../packages/db/src/schema/parties.ts)), owned by `partners` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts). Only this module reads or writes it.
- `PartnerAccounts` ([partner-accounts.service.ts](partner-accounts.service.ts)), the one exported service: `isConsignmentPartner(id, executor)` (a consignment partner that is not archived, read `FOR SHARE` through the caller's transaction so archiving the party waits for the bind), `holdsRole(id, role, executor)` (whether an unarchived party holds a role flag, also `FOR SHARE`; inventory's location rules use it) and `list()` (`{ id, code, name }` of every such partner, ordered by code). Identity uses it for `/api/partner-users` and inventory for the location party role check; neither reads `parties` itself.
- The module wiring: [partners.module.ts](partners.module.ts) exports `PartnerAccounts`.

## Never touches

- Other modules' tables, and the ledger.
- A party's contact details (`contact`, `tax_id`) in any answer `PartnerAccounts` gives: an account is its id, code and name only.
- Writes to `parties`: nothing here writes it yet (feature 41 brings the partner screens).
- Logins: partner users, their hats and sessions belong to identity (`apps/api/src/identity/`).

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/partners
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/partner-users.e2e-spec.ts
```

The e2e suite needs Postgres (it binds partner users to real consignment partners and refuses a supplier and an archived partner). The module wall is `src/module-boundary.spec.ts`.

## Governing spec

- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md) (milestone 3: `PartnerAccounts`, AC-9, AC-15)
- [0002 Core data model](../../../../docs/specs/0002-core-data-model/index.md) (A5, `parties`)

## Decisions

None yet. Record non obvious decisions as ADRs in docs/adr/ and link them here.
