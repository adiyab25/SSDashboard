# Customers by phone

One customer per normalized Egyptian phone number, however the number was typed: the one door that orders, Shopify, imports, and the confirmation queue link a customer through, plus search and the customer profile.

## Owns

- Its registry row (spec 0009, AC-6, `packages/contracts/src/modules/module-registry.ts`): `customers`, core, no toggle. Every controller here declares `@RequiresModule('customers')` (`src/platform/modules/requires-module.spec.ts` fails the build otherwise), so the module gate never answers `MODULE_OFF` for it while the module is core.
- The customer tables (defined in [packages/db](../../../../packages/db/src/schema/customers.ts)): `customers`, `customer_phones`, `customer_external_ids`, `customer_merges`, and `customer_merge_suggestions`, all owned by `customers` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts). Only this module reads or writes them.
- `CustomersService` ([customers.service.ts](customers.service.ts)), the one exported service. It holds:
  - `findOrCreate(tx, { phone, channelCustomer, name, seenAt })`: the six rules of spec 0014 AC-1 ([find-or-create/find-or-create.ts](find-or-create/find-or-create.ts)). It takes the phone lock, then the channel id lock, so parallel calls create one customer; it opens at most one merge suggestion per pair.
  - `findByPhone`, `canonicalOf`, `idsOf`, `briefs`: reads that resolve a merged customer to its survivor through one hop of `merged_into_id`.
  - `lockCustomers(tx, canonicalIds)`: the `customer` advisory locks over whole id sets ([customer-locks.ts](customer-locks.ts)), for credit and for merges.
  - `addPhone(tx, customerId, phone, actor, { reasonCode?, correlationId? })` ([phones/add-phone.ts](phones/add-phone.ts), milestone 2): under the phone lock, `added` (not primary, on the canonical customer), `already_held`, or `held_by_other` with the other canonical id and one `second_phone_conflict` suggestion; a phone is never moved. A person's `added` writes `customer.phone_added`, under the caller's `correlationId` when given (so it joins the caller's business action), else a new one; a system job or import writes no entry.
- Merge and undo ([merges/](merges/), milestone 2, not exported: no other module merges): `CustomerMerges` (`merge`, `undo`, and the `mergeIn` and `undoIn` that take the caller's transaction) by pointer only, under `lockCustomers`, writing `customer.merged` and `customer.unmerged` (one entry per changed record under one correlation id); `MergeSuggestions` (the open list and dismiss, `customer.merge_suggestion_dismissed`); `CustomerMergeUndoHandler`, the audit undo handler `customers.merge_undo` that `CustomersModule.onModuleInit` registers, so the audit screen's undo of a `customer.merged` entry runs the same `undoIn` and records `customer.merged_undone`.
- The merge routes ([merges/customer-merges.controller.ts](merges/customer-merges.controller.ts)), all `@Audience('staff')`: `POST /api/customers/merges` and `POST /api/customers/merges/:id/undo` (`customers.merge`), `GET /api/customers/merge-suggestions` (`customers.view`), and `POST /api/customers/merge-suggestions/:id/dismiss` (`customers.merge`). Its controller is listed before the profile controller, so `merge-suggestions` is matched before `:id`. Every id it takes (`survivorId`, `mergedId`, `suggestionId`, and the path ids) is lower cased first, because Postgres answers ids in lower case.
- `POST /api/customers/search` ([search/](search/)) by phone, name fragment, or the flagged list (a per person throttle and one log line per search without personal data), and `GET /api/customers/:id` ([profile/](profile/)), both `@Audience('staff')` with `customers.view`.
- Later milestones of the same spec add the flag and the timeline; the route `:id/timeline` must be declared before the `:id` profile route when it is added.

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
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/customers.e2e-spec.ts test/customers-merge.e2e-spec.ts test/customers-audit.e2e-spec.ts test/access-sweep.e2e-spec.ts
```

The unit suite needs no database. The e2e suites need Postgres: they create a scratch database, run as the application role, and check the rules, twenty parallel calls, every phone form, and the log sentinel. `customers-merge.e2e-spec.ts` covers the merge chains, twenty parallel merges of one pair (and ten in each direction), an undo racing a merge of its survivor, undo from the customer route and the audit screen, `addPhone`, and the suggestions; `customers-audit.e2e-spec.ts` is the proof file of the customers audit codes.

## Governing spec

- [0014 Customers by phone](../../../../docs/specs/0014-customers-by-phone/index.md) (build plan tasks 1 to 4 and 6 of milestone 1; tasks 7 to 9 and the api tests of task 11 of milestone 2)
- [0002 Core data model, customers child](../../../../docs/specs/0002-core-data-model/0002-customers-credit-tasks.md) (the tables and the phone rules)
- [Scope feature 14](../../../../docs/scope/confirmation-to-cash.md)

## Decisions

- **Search throttle** ([search/customer-search-throttle.ts](search/customer-search-throttle.ts), security review M1): each person may run `CUSTOMER_SEARCH_LIMIT` (30) searches in a sliding `CUSTOMER_SEARCH_WINDOW_MS` (one minute); the next call answers 429 `SEARCH_RATE_LIMITED` with `Retry-After`. The windows live in the memory of the api process, which is right while one api process serves a client (spec 0007); a second process per client would need a shared store. The owner changes the two constants. A refused call is not counted, and every allowed search logs `person`, `mode`, `results`, and `paged`, never the typed phone or name.
- **Lock order of `lockCustomers`**: locks are taken in the order of their lock key (the `hashtext` value, then the id), not in plain ascending id as spec 0014 words it. Two ids that share a hash then still lock in one order, so two merges can never wait on each other in a circle. The set of locked customers is the same.
- **Names and caching**: a name is stripped of invisible format characters (`\p{Cf}`, such as direction marks) before it is stored, so a pasted name cannot hide text or differ from itself; both routes answer `Cache-Control: no-store`, and a refused (429) search logs one warning with the person id only.
- **Name search cursor**: the cursor holds only the id of the last row (never a name); the next page starts after that row's own name and id, and an id that names no customer is 400 `INVALID_CURSOR`.
- **Migrations 0006 to 0008**: the flag set time check is added by a generated migration after a hand written one that backfills it, so a database that already holds a flagged customer upgrades.
- **Merge locks, then read again**: a merge reads both id sets, takes `lockCustomers` over them, then checks again under the locks that both ids are still canonical and neither set moved, else 409 `CUSTOMER_CHANGED`. The canonical check under the locks matters: a merge that read the pair before another merge of it committed, and the sets after, sees the same sets twice. Twenty parallel merges of one pair give one merge and nineteen 409s (`SAME_CUSTOMER` or `CUSTOMER_CHANGED`).
- **Undo rule**: a merge (survivor `S`, merged `X`) is undone only when no undo row names it (else `MergeAlreadyUndone`, 409 `MERGE_ALREADY_UNDONE`) and, under the locks, `S` is canonical and `X` points at `S` (else `MergeNotLatest`, 409 `MERGE_NOT_LATEST`). Unlike a merge, the undo deliberately re-reads the merge row and the two pointers under the locks instead of comparing `idsOf` sets: what it restores is the merge row's own `repointed_ids`, and the conditional update of those rows refuses `MergeNotLatest` when any of them no longer points at `S`, so a set that grew since (a later merge into `S`) is left alone. The audit handler turns both into `UndoNotPossible` with the same code; any other refusal is a plain `UNDO_NOT_POSSIBLE`. An undo from the customer route writes `customer.unmerged`; the audit screen's undo writes only `customer.merged_undone` on the merged record (the handler never writes an entry), so the repointed records get no entry of their own there.
- **Audit entries**: `customer.merged` is written on each changed record (the merged one and every record repointed from it), not on the survivor, whose row does not change; only the merged record's entry carries the undo. `customer.merge_suggestion_dismissed` is written on both customers of the pair, resolved to today's canonical ids (one entry when the pair already resolves to one). Entries carry ids, `mergedIntoId`, counts, and reason codes only.
- **Suggestion closing rule**: a merge marks the suggestion it names `applied` with its merge id, and also marks `applied` (with the same merge id) every other open suggestion whose two customers now resolve to one, since the merge settled them. A suggestion the merge names must be about the two merged customers, else 409 `SUGGESTION_MISMATCH`; an unknown suggestion id is 404 `SUGGESTION_NOT_FOUND` (the dismiss route answers the same). An undo reopens (back to `open`, with no merge id, decider, or decision time) every suggestion its merge applied, the named one included, whose pair no longer resolves to one customer: an undone merge puts the pair back in To review, where a person can dismiss it. The named one is not kept `applied`, because no column records which suggestion a merge named (decided by the lead, 2026-11-08, review m2). One pair still has one row ever.
- **`addPhone` lands on the canonical customer**: a phone added through a merged id is attached to the survivor, so an undo restores pointers, not phones (spec 0014 Consequences).
- **Bodies**: a missing (absent, null, or empty) reason code the route requires is 422 `REASON_REQUIRED`; an unlisted one, or a null or empty one where the code is optional, 422 `REASON_INVALID`; any other bad body 422 `VALIDATION_FAILED` naming paths only (`CustomerBodyPipe`).
