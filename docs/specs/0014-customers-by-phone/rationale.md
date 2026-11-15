# 0014. Customers by phone: decision record

The reasoning behind [index.md](index.md). `/develop` builds from the index; this file says why.

## Context

The brand's customers today are split by store and saved in four phone formats, so one person is two or four records, matching is a heuristic on the last 10 digits, and nothing merges them (reference brand notes (kept private), the reference brand's own console). Repeat returners cannot be seen, and the brand keeps its blacklist of fake and refusing customers by hand, swapped between brands as a list of phones (brand owner debate (kept private), item 7). In cash on delivery, the customer who refuses at the door twice is the cost: every refusal is two shipping legs and a piece out of stock for a week.

Spec 0002 already fixed the shape: a customer is a normalized phone, a phone belongs to one customer per tenant, a customer holds many phones and channel ids, a merge sets a pointer and never rewrites another module's rows, an undo restores exactly the prior pointers, and a risk flag has a kind and a source ([customers child](../0002-core-data-model/0002-customers-credit-tasks.md)). The tables, `EgyptianPhone`, and the database guards are built. What is not built is everything that uses them: the one entry point other modules call, the search, the merge screen the debate called "a daily workflow with its own screen", the undo, the flag a person can see and set, and the timeline "from the same records, read through role lenses" (final plan (kept private), section 6).

Four forces shape the design. First, three other slice 1a specs are written at the same time: orders (0013) and Shopify (0015) must link customers without touching customer tables, and the timeline must read orders without touching order tables, while the orders module itself depends on customers. Second, the merge must be fast enough to be routine for a team of four, and safe enough that a wrong one costs a tap. Third, Law 151: names, phones, and notes are personal data that must never reach logs or the append only history, and the media buyer and partners must never see them ([spec 0008](../0008-roles-as-hats/index.md) AC-8). Fourth, the pilot window: slice 1a must land before mid March 2027, so whatever can be deferred without a migration is deferred.

## Options considered

### Option 1: Customers as a thin data access layer, each module matching on its own

Orders, Shopify, and imports each normalize the phone and look up `customer_phones` through a small shared query helper; merge and the flag get routes; the profile page reads orders by joining in SQL.

**Pros**:
- Least code in the customers module; each caller writes exactly the lookup it needs.

**Cons**:
- Three modules would name customer tables, which the module wall (`apps/api/src/module-boundary.spec.ts`) forbids, and each would invent its own rule for a phone and a Shopify id that disagree.
- Concurrent webhooks for one new phone race on the unique key in three places.
- The profile joining orders breaks the module rule in the other direction.

### Option 2: One `CustomersService` as the only door, merge by pointer, suggestions in their own table, the timeline in a leaf module (chosen)

`CustomersModule` exports one service (`findOrCreate`, `addPhone`, `canonicalOf`, `idsOf`, `briefs`, `lockCustomers`, `setFlagFromImport`) with one written rule set for every caller. Merge and undo follow spec 0002 exactly. Conflicts become rows in a small `customer_merge_suggestions` table a person works. The profile and timeline live in `CustomerProfileModule`, a leaf imported only by `AppModule`, which imports spec 0013's `OrderQueries` (`forCustomers`, `countsForCustomers`) and spec 0015's `ChannelsService.storeLabelsByConnection`.

**Pros**:
- One rule set, one lock order, one place to test concurrency; orders and Shopify never see a customer table.
- No module cycle: orders imports `CustomersModule`; only the leaf imports orders. The same leaf pattern already holds the audit undo (`AuditUndoModule`).
- Suggestions carry their evidence and a pair key, so a dismissed pair stays dismissed.

**Cons**:
- One more table and module to own.
- The leaf module imports every module that adds a timeline kind, so its import list grows with features 17, 28, 34, and 50.

### Option 3: Option 2 with a timeline provider registry instead of a leaf module

Each module registers a timeline source with `CustomerTimelineRegistry` from `onModuleInit`, the way owners register undo handlers with `AuditUndoRegistry`.

**Pros**:
- Customers never imports another module; adding a kind touches only its owner.

**Cons**:
- The dependency is invisible to the type checker and the module wall: a source that never registers just shows fewer entries, which a test must catch.
- A second registry pattern for something four modules use in this version.

### Option 4: Option 2 with merge suggestions as tasks (feature 17) instead of a table

A conflict opens a task of type `customer.merge_suggested` linked to one customer, with a dedupe key on the pair.

**Pros**:
- Suggestions appear in My work with no extra list; the task primitive exists for exactly "a process opens work for a person".

**Cons**:
- A task links one record; the pair, the evidence row, and "dismissed for ever" would live in a dedupe key and an outcome code, and a closed task does not block a new one (spec 0002 tasks: the partial unique only covers open tasks), so a dismissed pair would come back.
- It ties this feature's merge screen to feature 17's build order.

## Rationale

Option 2 is the only one that keeps the module rule both ways while orders depends on customers. The rule set of `findOrCreate` is the heart of it: the phone is the key (spec 0002 decided default 10), a channel id may find a customer when the phone is new or did not parse, and when the two disagree nothing moves and a person decides. Moving rows automatically would make a wrong match silent; refusing would lose the order. A suggestion is the honest middle, and the merge screen makes acting on it a tap.

Locks follow the repository's existing pattern (`pg_advisory_xact_lock` with a two integer key, as sign in does in `apps/api/src/identity/sign-in/locks.ts`). `findOrCreate` locks the phone and the channel id, never the customer: a phone attached to a customer that a merge is moving still lands on a row every read resolves, because spec 0002 keeps phones on their rows. That keeps the lock graph acyclic (link locks before customer locks, merges take customer locks only), so a webhook never deadlocks with a merge.

The leaf module beats the registry (Option 3) because an import is a dependency the compiler and the module wall check, while a missing registration is a silent gap; the registry stays the fallback if the leaf's import list becomes unwieldy. Suggestions get their own table (over Option 4) because the pair and "never again" are the whole point, and because feature 17 may land after this feature; a count in My work is a follow-up, not a dependency.

Search travels in a POST body because a phone or a name in a URL lands in proxy logs and browser history, which Law 151 forbids as surely as a log line. The flag note is the only free text and stays on the mutable `customers` row, never in an append only table, so an erasure request can clear it (spec 0002 security review S4, spec 0010 AS13: customer reasons are codes).

Undo has two doors (the customer screen with `customers.merge`, and `/audit` with `audit.undo`) and one code path. The customer screen cannot call the audit undo route, because `audit.undo` is the manager's alone (spec 0008) and spec 0008 gives undoing a merge to support and operations too. So the customer screen writes `customer.unmerged`, the audit screen writes `customer.merged_undone`, and both run the same service method with the same refusals.

The returner flag in slice 1a is set by a person, by an import, or by a person accepting a suggestion computed on read (Q-14.1). An automatic rule would need a stored "a person cleared this, do not flag again" memory and a domain event from orders, both more than the scope's done when asks ("a repeat returner flag shows on the record"); computing counts on read needs neither and shows the evidence beside the suggestion. The defaults (180 days, 2 and 2, Q-14.2) are a starting point the manager changes in settings.

The lens is enforced in the api by permissions, not by hat names, because spec 0008 makes permissions the only thing a route checks. In slice 1a the three hats that can open a profile see the same entries; the lens table exists now so the credit, exchange, task, and message kinds arrive gated.

## Evidence

**What is built today** (read 2026-11-07):
- `packages/db/src/schema/customers.ts`: the four tables with their checks; `risk_flag` single valued with source and note; `customer_merges` append only with `repointed_ids` and the undo uniqueness; no service yet (no `apps/api/src/customers/`).
- `packages/contracts/src/customers/egyptian-phone.ts`: `EgyptianPhone.parse`, `InvalidPhone` without the input.
- `packages/contracts/src/access.ts`: `customers.view` and `customers.merge` on support, operations, manager; warehouse holds `orders.view` but not `customers.view`.
- `packages/contracts/src/audit/audit-record-types.ts`: record type `customer` keeps reasons as codes, no label, personal keys `name`, `email`, `reason`, `externalid`.
- `packages/contracts/src/audit/audit-actions.ts`: no customer code yet; undoable codes need `undoHandler`, `undoReasonCodes` (for code reason record types), and `undoRefusalCodes`.
- `apps/api/src/audit/audit-undo.registry.ts`: an entry is undoable only when it carries `undo_action`, so only the merged record's entry carries the undo.
- `packages/db/src/schema/orders.ts`: `orders.customer_id` nullable with an index; `contact_phone_raw` for an unparsed phone.

**Spec 0002 lines this spec amends** (notes added beside each): the data quality queue for unparsed phones, the name `findOrCreateByPhone`, "only the main phone creates or finds the customer", and the customers table (two columns, one new table).

## References

**Project sources**:
- [Spec 0002 customers child](../0002-core-data-model/0002-customers-credit-tasks.md) and [orders child](../0002-core-data-model/0002-orders.md): tables, phone normalization, merge and undo, canonical values, decided default 10.
- [Spec 0007](../0007-stack-architecture-operations-layer/index.md): module map (`customers`), a phone unique per tenant (section 7), Law 151 conventions.
- [Spec 0008](../0008-roles-as-hats/index.md): permission matrix, the route sweep, AC-8.
- [Spec 0009](../0009-settings-toggles-bundles/index.md): the settings registry a feature adds its keys to (AC-1).
- [Spec 0010](../0010-audit-trail/index.md): actions table (`customer.merged`, `customer.unmerged`), AC-5 as amended (codes for customers), AC-6 (one entry per record, one correlation id), AC-14 (undo handlers).
- domain review of the data model (kept private): m8 (risk flag kinds), m10 (raw phone kept), question 7 (blacklist content).
- reference brand notes (kept private) and the brand owner debate (kept private): split customers, last 10 digit matching, merge as daily work, the shared blacklist.
- Installed skills: `postgresql-table-design` (foreign key indexes, `NULLS NOT DISTINCT`, partial indexes), `drizzle-orm-patterns`, `nestjs-best-practices`.

**Practices and standards**:
- Transaction scoped advisory locks taken in one global order to avoid deadlocks.
- Keyset pagination over a total order for merged multi source feeds.
- Personal data out of URLs and logs (Law 151 of 2020, Egypt's personal data protection law, as the project applies it).
