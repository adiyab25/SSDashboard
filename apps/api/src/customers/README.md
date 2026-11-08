# Customers by phone

One customer per normalized Egyptian phone number, however the number was typed: the one door that orders, Shopify, imports, and the confirmation queue link a customer through, plus search and the customer profile.

## Owns

- Its registry row (spec 0009, AC-6, `packages/contracts/src/modules/module-registry.ts`): `customers`, core, no toggle. Every controller here declares `@RequiresModule('customers')` (`src/platform/modules/requires-module.spec.ts` fails the build otherwise), so the module gate never answers `MODULE_OFF` for it while the module is core.
- The customer tables (defined in [packages/db](../../../../packages/db/src/schema/customers.ts)): `customers`, `customer_phones`, `customer_external_ids`, `customer_merges`, and `customer_merge_suggestions`, all owned by `customers` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts). Only this module reads or writes them.
- `CustomersService` ([customers.service.ts](customers.service.ts)), the one exported service. Milestone 1 holds:
  - `findOrCreate(tx, { phone, channelCustomer, name, seenAt })`: the six rules of spec 0014 AC-1 ([find-or-create/find-or-create.ts](find-or-create/find-or-create.ts)). It takes the phone lock, then the channel id lock, so parallel calls create one customer; it opens at most one merge suggestion per pair.
  - `findByPhone`, `canonicalOf`, `idsOf`, `briefs`: reads that resolve a merged customer to its survivor through one hop of `merged_into_id`.
  - `lockCustomers(tx, canonicalIds)`: the `customer` advisory locks over whole id sets ([customer-locks.ts](customer-locks.ts)), for credit and for merges.
- `POST /api/customers/search` ([search/](search/)) by phone, name fragment, or the flagged list (a per person throttle and one log line per search without personal data), and `GET /api/customers/:id` ([profile/](profile/)), both `@Audience('staff')` with `customers.view`.
- Later milestones of the same spec add merge and undo, `addPhone`, the flag, and the timeline; the routes `merges`, `merge-suggestions`, and `:id/timeline` must be declared before the `:id` profile route when they are added.

## Never touches

- Other modules' tables. Store and channel labels come from `ChannelsService`, the name of the person who set a flag from `StaffDirectory`; orders come only through the orders module's `OrderQueries` (milestone 4), never a table.
- Another module's customer id: a merge never rewrites it, every read resolves it.
- A phone or channel id on another customer: nothing here ever moves one.
- Personal data in logs and errors: a phone, name, or flag note never reaches a log line, an error message, or an audit entry (Law 151).
- The ledger and the owner database role.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/customers
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/customers.e2e-spec.ts test/access-sweep.e2e-spec.ts
```

The unit suite needs no database. The e2e suites need Postgres: they create a scratch database, run as the application role, and check the rules, twenty parallel calls, every phone form, and the log sentinel.

## Governing spec

- [0014 Customers by phone](../../../../docs/specs/0014-customers-by-phone/index.md) (build plan tasks 1 to 4 and 6 of milestone 1)
- [0002 Core data model, customers child](../../../../docs/specs/0002-core-data-model/0002-customers-credit-tasks.md) (the tables and the phone rules)
- [Scope feature 14](../../../../docs/scope/confirmation-to-cash.md)

## Decisions

- **Search throttle** ([search/customer-search-throttle.ts](search/customer-search-throttle.ts), security review M1): each person may run `CUSTOMER_SEARCH_LIMIT` (30) searches in a sliding `CUSTOMER_SEARCH_WINDOW_MS` (one minute); the next call answers 429 `SEARCH_RATE_LIMITED` with `Retry-After`. The windows live in the memory of the api process, which is right while one api process serves a client (spec 0007); a second process per client would need a shared store. The owner changes the two constants. A refused call is not counted, and every allowed search logs `person`, `mode`, `results`, and `paged`, never the typed phone or name.
- **Lock order of `lockCustomers`**: locks are taken in the order of their lock key (the `hashtext` value, then the id), not in plain ascending id as spec 0014 words it. Two ids that share a hash then still lock in one order, so two merges can never wait on each other in a circle. The set of locked customers is the same.
- **Names and caching**: a name is stripped of invisible format characters (`\p{Cf}`, such as direction marks) before it is stored, so a pasted name cannot hide text or differ from itself; both routes answer `Cache-Control: no-store`, and a refused (429) search logs one warning with the person id only.
- **Name search cursor**: the cursor holds only the id of the last row (never a name); the next page starts after that row's own name and id, and an id that names no customer is 400 `INVALID_CURSOR`.
- **Migrations 0006 to 0008**: the flag set time check is added by a generated migration after a hand written one that backfills it, so a database that already holds a flagged customer upgrades.
