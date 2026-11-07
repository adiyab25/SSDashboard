# 0014. Customers by phone: one customer per normalized phone, merged and undone as daily work, with one timeline read through each hat

**Date**: 2026-11-07
**Status**: Proposed
**Feature**: [scope feature 14, Customers by phone](../../scope/confirmation-to-cash.md) (slice 1a, Core, Beta)
**Depends on**: the feature 4 baseline as built ([spec 0002 customers child](../0002-core-data-model/0002-customers-credit-tasks.md): `customers`, `customer_phones`, `customer_external_ids`, `customer_merges`, `EgyptianPhone`); hats ([spec 0008](../0008-roles-as-hats/index.md)); the audit trail and its undo registry ([spec 0010](../0010-audit-trail/index.md)); the settings registry of [spec 0009](../0009-settings-toggles-bundles/index.md) milestone 1 (milestone 3 here only). Milestone 4 needs the orders read service of spec 0013 (scope feature 16). Specs 0013 (orders) and 0015 (Shopify) call this feature's `findOrCreate`, so milestone 1 lands before their first link.

## Summary

A customer is one normalized Egyptian phone number, however the number was typed. This feature builds the `customers` module on the tables spec 0002 already migrated: one service that every order and every Shopify customer goes through to find or create its customer, a search by phone, a fast merge screen with a one tap undo, a risk flag (the scope's repeat returner flag) that a person sets or accepts from a suggestion, and one timeline per customer that shows each hat only what its permissions allow. Nothing here rewrites another module's rows: orders keep the customer id they were written with, and every read resolves the merged customer to its survivor.

## Requirements

**User stories**:
- As a support agent, I want to type a phone in any form (010, 0010, +2010, Arabic digits) and land on the one customer behind it, so I see her whole history before I call.
- As a support agent, I want to merge two records of the same person in a few seconds and undo it in one tap when I was wrong, so merging is routine work, not a ticket.
- As an operations agent, I want the system to point out records that are probably the same person (one Shopify customer on two phones, a second phone that already belongs to someone), so duplicates do not pile up.
- As a support agent, I want a repeat returner or refuser to stand out on her record, with who flagged her and why, so I ask for a deposit or decline before shipping.
- As a manager, I want every merge, undo, and flag change recorded with who and why, so I can answer "who did this" without asking around.
- As a developer of orders and connectors, I want one call that links an order or a Shopify customer to its customer, so no module ever writes customer tables or guesses a match itself.

**Acceptance criteria** (the contract; each is checkable on its own):

*Linking and finding*
- **AC-1** (find or create): `CustomersService.findOrCreate(tx, input)` takes a normalized phone (`NormalizedPhone` from `EgyptianPhone.parse`, or null when the caller's text did not parse), an optional channel customer id (`shopify_customer` with its `connectionId`, or `partner_reference` with its `channelId`, plus the `externalId` text), an optional name, and `seenAt`, and answers `{ customerId, outcome }` where `customerId` is the canonical customer or null. Rules, in order: (a) the phone and the channel id both known on the same canonical customer: `matched`; (b) the phone known, the channel id unknown: the phone's customer, the channel id attached to it, `matched`; (c) the channel id known, the phone new: the channel id's customer, the phone attached to it (not primary), `matched_by_channel_id`; (d) both known on two different canonical customers: the phone's customer (the phone is the key, spec 0002 decided default 10), nothing moves, one merge suggestion opened for the pair (`channel_id_conflict`), `matched_with_conflict`; (e) neither known and a phone given: one new customer with that phone as primary (its `kind` from the parse) and the channel id, `created`; (f) no phone and an unknown or absent channel id: `customerId` null, nothing written, `no_phone`. A name is written only when the customer's name is empty; `last_seen_at` of a matched phone moves to `seenAt`.
- **AC-2** (safe under concurrency and replay): twenty parallel `findOrCreate` calls with the same new phone and channel id (in twenty transactions) create exactly one customer, one phone row, and one external id row, and every call answers the same `customerId`; a replay of a call answers the same result and writes nothing new. No call fails on a unique key.
- **AC-3** (one number however typed): every phone the customers routes accept goes through `EgyptianPhone.parse`; `01001234567`, `00201001234567`, `+20 100 123 4567`, `0010 0123 4567`, and `٠١٠٠١٢٣٤٥٦٧` typed into the search all find the same customer; text that does not parse answers 400 `INVALID_PHONE` whose body never contains the typed text. Phone and name searches travel in a POST body, never in a URL.
- **AC-4** (one customer, many phones and ids): `GET /api/customers/:id` answers the canonical customer with the union of phones over all its ids (primary first, each with its kind and first and last seen times), every channel id with the store or channel it came from (one customer may hold Shopify ids from two stores), the merges it absorbed, and its flag. Asked for a merged id, it answers the canonical customer with `resolvedFrom` set to the asked id, and the page replaces the address and says the record was merged.
- **AC-5** (find): `POST /api/customers/search` finds by exactly one of: `phone` (any form, exact match on the normalized number), `nameContains` (3 to 100 characters, case insensitive, Arabic or English), or `flagged: true` (every flagged customer, most recently flagged first). It answers canonical customers only (a merged id never appears on its own), keyset paged (`cursor`, `limit` 1 to 100, default 25) with no row skipped or repeated across pages.

*Merge and undo*
- **AC-6** (merge): `POST /api/customers/merges` with `survivorId`, `mergedId`, an optional reason code, and an optional `suggestionId`, in one transaction under the customer locks: sets `mergedId.merged_into_id` to the survivor, moves every customer that pointed at the merged one to the survivor (recorded in `repointed_ids`, so chains stay one hop), inserts the `customer_merges` row, writes one `customer.merged` audit entry per changed customer record under one correlation id (the merged record's entry carries the undo `customers.merge_undo` with `{ mergeId }`), marks the suggestion `applied` and closes every other open suggestion whose two customers now resolve to one, and changes no row of any other module. It answers 409 `SAME_CUSTOMER` when both resolve to one canonical customer, 409 `CUSTOMER_MERGED` when either id is no longer canonical, 409 `CUSTOMER_CHANGED` when the id sets moved while it waited for the locks, 409 `SUGGESTION_CLOSED` for a suggestion that is not open, and 422 `REASON_INVALID` for a code the registry does not list.
- **AC-7** (fast screen): the merge screen finds two customers by phone, shows them side by side (name, phones, channel ids, flag, created, and from milestone 4 the order count), preselects the survivor (the older record), and merges with one button; from a suggestion it is one tap to open and one to merge. A toast confirms the merge and offers Undo (reason code `wrong_merge`). English and Arabic, right to left, keyboard only, axe clean, one `<h1>`, built to `packages/ui/DESIGN.md`.
- **AC-8** (undo): `POST /api/customers/merges/:id/undo` with a required reason code restores exactly the pointers before the merge (the merged customer canonical again, its repointed customers back on it), inserts the `undo` row, and writes one `customer.unmerged` entry per changed record; a second undo answers 409 `MERGE_ALREADY_UNDONE`; undoing a merge whose survivor has since been merged into another customer answers 409 `MERGE_NOT_LATEST` (undo the later merge first). The audit screen's undo of the `customer.merged` entry (`audit.undo`, spec 0010 AC-14) runs the same service method through the handler `customers.merge_undo` and records `customer.merged_undone`; a refusal reaches the caller as 409 `UNDO_NOT_POSSIBLE` with `undoCode` `MERGE_NOT_LATEST` or `MERGE_ALREADY_UNDONE`.
- **AC-9** (suggestions): a merge suggestion is opened by `findOrCreate` rule (d) and by `addPhone` (AC-10); one pair has at most one suggestion ever, so a dismissed pair is never suggested again. `GET /api/customers/merge-suggestions` lists open suggestions oldest first with both customers and the reason, keyset paged, and hides a pair whose customers already resolve to one. Dismissing (`customers.merge`, optional reason code) writes `customer.merge_suggestion_dismissed`; merging with the `suggestionId` marks it `applied` with the merge id.
- **AC-10** (second phone): `CustomersService.addPhone(tx, customerId, phone, actor)` attaches a phone that no customer holds (not primary) and answers `added`; a phone already on the same canonical customer answers `already_held` and writes nothing; a phone held by another customer is never moved: it answers `held_by_other` with that customer's canonical id and opens a `second_phone_conflict` suggestion. A person's `added` writes `customer.phone_added`; a system or import call writes no entry.

*The flag*
- **AC-11** (set and clear): a person with `customers.flag` sets a flag kind (`returner`, `refuser`, `fake`, `abusive`) with an optional note (at most 500 characters, personal data) and an optional reason code through `PUT /api/customers/:id/flag`, which writes source `manual`, `risk_flag_set_at`, `risk_flag_set_by`, and `customer.flagged`; `POST /api/customers/:id/flag/clear` with a required reason code clears the flag on every id of the canonical customer and writes one `customer.unflagged` per changed record. Both carry `expectedUpdatedAt` and answer 409 `STALE_RECORD` on a mismatch; clearing an unflagged customer answers 409 `NOT_FLAGGED`. The flag shows on the profile header (kind, source, who, when, note) and on every search row; the canonical flag follows spec 0002's rule (the canonical row's, else the most severe on its ids: `fake`, `abusive`, `refuser`, `returner`).
- **AC-12** (import entry point): `CustomersService.setFlagFromImport(tx, customerId, kind, importRunId)` writes source `blacklist_import` with no person, never replaces a `manual` flag (answers `kept_manual`), and replaces an older import or rule flag; feature 15 calls it and writes its own import audit.
- **AC-13** (returner signal): the profile shows how many of the customer's orders were refused at the door and how many came back after delivery within the last `windowDays`, read through the orders read service (never the orders tables). When the customer has no flag and refusals reach `refusalsToSuggest` the header suggests `refuser`, else when returns reach `returnsToSuggest` it suggests `returner`; one tap (with `customers.flag`) applies it as a `manual` flag with reason code `suggestion_applied`, the counts in the entry's `after`. The three numbers come from the setting `customer_risk_signal` (owner decisions Q-14.1 and Q-14.2, recommended).

*Timeline and lenses*
- **AC-14** (one timeline): `GET /api/customers/:id/timeline` answers the entries of every id of the canonical customer, newest first, keyset paged with no entry skipped or repeated across pages and sources. Entry kinds in this feature: `order` (one per order: number with its store, placed time, fulfillment state, cash state, outcome, total, payment method, refusal reason), `merge`, `unmerge`, `phone_added`, `channel_id_added`, and `flag` (the current flag at its set time). Orders come only through spec 0013's exported read service; the module wall test (`apps/api/src/module-boundary.spec.ts`) fails if a customers file names an orders table.
- **AC-15** (lens per hat): each entry kind, and each guarded field or action on it, declares the permission it needs in one table, `CUSTOMER_TIMELINE_KINDS` in `packages/contracts`. The api leaves out every kind and field the viewer's permissions do not reach, so hats see the same records through their own lens: `order` needs `orders.view`; `merge`, `unmerge`, `phone_added`, `channel_id_added`, and `flag` need `customers.view`; the Undo action on a merge needs `customers.merge`; the "Open in audit" link needs `audit.read`. No answer carries a key from `COST_FIELD_KEYS`. A unit test with built `Access` sets proves that a viewer with `customers.view` but not `orders.view` gets no order entry.
- **AC-16** (who may call): every customers route declares the permission in the API table below; the warehouse hat (no `customers.view`), the media buyer, and partner users answer 403 on every customers route; each route has its `FIXTURES` entry in `apps/api/test/access-sweep.e2e-spec.ts`, and the media buyer sweep finds no personal data key in any answer.

*Privacy and the module*
- **AC-17** (Law 151): no phone, name, or flag note reaches a log line or an error message: the search body key `nameContains` joins `PERSONAL_DATA_KEYS`, a log sentinel test runs `findOrCreate`, search, merge, and flag with a sentinel phone and name and finds neither in the log output; audit entries of record type `customer` carry ids, flag kinds, sources, and reason codes only (never a name, phone, or note).
- **AC-18** (the screens): `/customers` (search and the flagged list, with a "To review" tab for suggestions), `/customers/[id]` (header and timeline), and `/customers/merge` (compare and merge) render inside the back office shell in English and Arabic, right to left, by keyboard alone, axe clean, with one `<h1>` each, phones inside `LtrText`, dates and numbers through `useFormat()`, and nav entries that declare `needs` (`customers.view`; Merge needs `customers.merge`). Opened without the permission they render `NoAccessState` and load nothing.
- **AC-19** (the module): `apps/api/src/customers/` is the only writer of the four customer tables and the new suggestion table (table ownership map and module wall), exports `CustomersService` with exactly the contract in *Exported service* below, holds a README with the five headings, and carries every new audit code in `AUDIT_ACTIONS` with labels in both languages and its proof file.

## Decision

**Chosen option**: Option 2 in [rationale.md](rationale.md): one `CustomersModule` whose exported `CustomersService` is the only way any module links, finds, or flags a customer, with merges by pointer as spec 0002 fixed them, merge suggestions in a small table of their own, the flag set by a person or an import with a read time suggestion from order counts, and the profile and timeline in a leaf module (`CustomerProfileModule`) that imports the orders read service, so the orders module can import `CustomersModule` without a cycle.

Runner up: Option 3, a timeline provider registry that each module fills from `onModuleInit` (like `AuditUndoRegistry`). Rejected for now because the leaf module gives the same freedom from cycles with plain imports that the type checker and the module wall can see; reconsider when more than four modules add entry kinds.

**Implementation skills**: `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

### Owner decisions taken as recommended

These are written into the design as decided; each is easy to change before milestone 3.

- **Q-14.1** How the repeat returner flag gets set in slice 1a: a person sets it, an import sets it (feature 15), and the profile *suggests* one from order counts that a person applies in one tap. No background rule writes a flag in this feature (owner decision Q-14.1, recommended).
- **Q-14.2** The suggestion's defaults: the last 180 days, 2 refusals at the door suggest `refuser`, 2 returns after delivery suggest `returner` (owner decision Q-14.2, recommended).
- **Q-14.3** Who may set and clear a flag: a new permission `customers.flag` (personal data) on the support, operations, and manager hats, for both setting and clearing; clearing needs a reason code (owner decision Q-14.3, recommended).
- **Q-14.4** Suggested merges are applied by a person, never automatically; the registry code `customer.merge_suggested_applied` of spec 0010 is not registered by this feature (owner decision Q-14.4, recommended).

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Where it lives

- `apps/api/src/customers/` (module `customers`, bundle `core`, no toggle): `customers.module.ts` (`CustomersModule`, imports `AuditModule`, exports `CustomersService`), `find-or-create/`, `merges/` (merge, undo, the audit undo handler, suggestions), `flags/`, `search/`, `profile/` (`CustomerProfileModule`, the leaf: profile and timeline controllers, imports `CustomersModule` and the orders module's read service; only `AppModule` imports it), `customer-locks.ts`, `README.md` (Owns, Never touches, How to test, Governing spec, Decisions).
- `packages/db/src/schema/customers.ts`: the new columns and `customer_merge_suggestions`; `packages/db/src/table-ownership.ts` adds the new table under `customers`.
- `packages/contracts/src/customers/`: beside `egyptian-phone.ts`, one file per concern: `customer-enums.ts` (`CustomerRiskFlag`, `CustomerRiskFlagSource`, `CustomerExternalIdKind`, `MergeSuggestionReason`, `MergeSuggestionStatus`, each in `enum-parity.e2e-spec.ts`), `customer-views.ts`, `customer-search.ts`, `customer-merges.ts`, `customer-flags.ts`, `customer-timeline.ts` (the entry union and `CUSTOMER_TIMELINE_KINDS`), `customer-reason-codes.ts`.
- `apps/web/src/customers/` (feature folder with README): `customers-page.tsx`, `customer-search-form.tsx`, `customer-results-table.tsx`, `merge-suggestions-table.tsx`, `customer-detail-page.tsx`, `customer-header.tsx`, `customer-flag-dialog.tsx`, `customer-timeline.tsx`, `merge-page.tsx`, `merge-compare.tsx`. Routes `apps/web/src/app/(backoffice)/customers/page.tsx`, `customers/[id]/page.tsx`, `customers/merge/page.tsx` stay thin. Nav group `customers` in `src/shell/nav.ts`.

### Data model

The four tables of spec 0002 stay as built. Two changes, both additive (expand only), into the baseline while [ADR 0003](../../adr/0003-reset-migrations-to-one-baseline.md) still allows it (no pilot import has run), else one forward migration:

| Table | Change | Constraints and indexes |
|---|---|---|
| `customers` | add `risk_flag_set_at timestamptz null`, `risk_flag_set_by uuid null` fk `users` (restrict) | check (`risk_flag IS NULL`) = (`risk_flag_set_at IS NULL`); check `risk_flag_set_by IS NULL OR risk_flag_source = 'manual'`; partial index (`risk_flag_set_by`) where not null (foreign key rule); partial index (`risk_flag_set_at` desc nulls first, `id` desc) where `risk_flag IS NOT NULL AND merged_into_id IS NULL` (the flagged list); GIN index on `name gin_trgm_ops` (`pg_trgm` is in the baseline) for `nameContains` |
| ★ `customer_merge_suggestions` (new, mutable) | `id`, `tenant_id`, `customer_low_id uuid` fk `customers`, `customer_high_id uuid` fk `customers` (the pair as canonical ids at opening time, ordered), `reason` enum `merge_suggestion_reason` (`channel_id_conflict`, `second_phone_conflict`), `evidence_external_id_id uuid null` fk `customer_external_ids`, `evidence_phone_id uuid null` fk `customer_phones`, `status` enum `merge_suggestion_status` (`open`, `applied`, `dismissed`) default `open`, `merge_id uuid null` fk `customer_merges`, `decided_by uuid null` fk `users`, `decided_at timestamptz null`, `dismiss_reason text null`, `created_at`, `updated_at` | unique (`customer_low_id`, `customer_high_id`) (only uuid columns, so the tenancy test exempts it); check `customer_low_id < customer_high_id`; check `reason = 'channel_id_conflict'` exactly when `evidence_external_id_id IS NOT NULL`, and `reason = 'second_phone_conflict'` exactly when `evidence_phone_id IS NOT NULL`; check (`status = 'applied'`) = (`merge_id IS NOT NULL`); check (`status = 'open'`) = (`decided_at IS NULL`); check `dismiss_reason` matches `reasonCodeShape` and is set only when `dismissed`; partial index (`created_at`, `id`) where `status = 'open'` (the list, oldest first); index (`customer_high_id`); partial indexes on `evidence_external_id_id`, `evidence_phone_id`, `merge_id`, `decided_by` where not null |

No other table changes. `customer_merges.reason` stays a code; the flag note stays the only free text and lives on the mutable `customers` row, so a Law 151 erasure can clear it.

**Entity relationships** (all within the customers module):

| From | To | Cardinality |
|---|---|---|
| `customers` | `customers` (`merged_into_id`) | many merged to one survivor, one hop |
| `customers` | `customer_phones` | 1 to many (a phone belongs to one customer per tenant) |
| `customers` | `customer_external_ids` | 1 to many (unique per issuer) |
| `customer_merges` | `customers` (survivor, merged) | many to 1 each |
| `customer_merge_suggestions` | `customers` (low, high) | many to 1 each; one row per pair ever |
| `customer_merge_suggestions` | `customer_merges` | 0 or 1 (when applied) |
| `orders.customer_id` (orders module) | `customers` | many to 1, never rewritten by a merge |

### Exported service (the contract for specs 0013, 0015, and features 15, 18, 28)

`CustomersService` is the only door; every method that writes takes the caller's `tx` and never opens its own transaction.

| Method | Called by | Answers |
|---|---|---|
| `findOrCreate(tx, { phone: NormalizedPhone \| null, channelCustomer: { kind: 'shopify_customer', connectionId, externalId } \| { kind: 'partner_reference', channelId, externalId } \| null, name: string \| null, seenAt: Date })` | orders create (0013), Shopify order and customer sync (0015), onboarding imports (15) | `{ customerId: string \| null, outcome: 'matched' \| 'matched_by_channel_id' \| 'matched_with_conflict' \| 'created' \| 'no_phone' }` (AC-1) |
| `addPhone(tx, customerId, phone: NormalizedPhone, actor: AuditActor)` | confirmation queue (18) when the agent confirms the second phone | `{ outcome: 'added' \| 'already_held' \| 'held_by_other', otherCustomerId? }` (AC-10) |
| `findByPhone(phone: NormalizedPhone, tx?)` | the order search box (0013) | the canonical customer id holding that phone, or null; writes nothing |
| `canonicalOf(id, tx?)`, `idsOf(canonicalId, tx?)` | orders lists by customer (0013), credit (28) | the survivor id; the survivor plus every id merged into it |
| `briefs(ids, tx?)` | order page and confirmation queue (0013, 18) | per asked id: canonical id, name, primary phone, flag kind and source; the caller checks its own permission before showing them |
| `lockCustomers(tx, canonicalIds)` | credit (28) | takes the `customer` advisory locks over the whole id sets, ascending, the same locks a merge takes (spec 0002) |
| `setFlagFromImport(tx, customerId, kind, importRunId)` | onboarding imports (15) | `'set' \| 'kept_manual'` (AC-12) |

The caller parses phone text with `EgyptianPhone.parse` at its own edge and keeps the raw text when it fails (spec 0002, `orders.contact_phone_raw`); `findOrCreate` never sees raw text. Only the main phone creates a customer (a channel id may also find one, rule c); the second phone joins through `addPhone` when an agent confirms it. An order linked to no customer (`no_phone`) is fixed where an agent already looks at every new order, the confirmation queue (feature 18): the agent types the right number, and the orders module calls `findOrCreate` again. This feature owns the rule, not a queue screen of its own (spec 0002 amended).

### Locks and concurrency

- `findOrCreate` takes `pg_advisory_xact_lock(CUSTOMER_PHONE_LOCK, hashtext(phone_e164))`, then, when a channel id is given, `pg_advisory_xact_lock(CUSTOMER_EXTERNAL_ID_LOCK, hashtext(kind || issuer id || external id))`, always in that order, then reads and inserts. A hash collision only serializes two unrelated calls. It takes no `customer` lock: a phone or channel id attached to a customer that a merge is moving lands on that id's row, which every read resolves to the survivor (phones and channel ids stay on their rows by spec 0002). The suggestion insert is `ON CONFLICT (customer_low_id, customer_high_id) DO NOTHING`.
- A merge reads `idsOf` of both customers, takes `pg_advisory_xact_lock(CUSTOMER_LOCK, hashtext(id))` on the union in ascending id order (namespace `customer`, the lock spec 0002 names for merges and credit), reads both id sets again, and answers 409 `CUSTOMER_CHANGED` if either moved. An undo locks the survivor's and the merged customer's id sets the same way. Lock constants live in `apps/api/src/customers/customer-locks.ts`, two integer form like `SIGN_IN_SLOT_LOCK` (`apps/api/src/identity/sign-in/locks.ts`).
- Undo rule: a merge (survivor `S`, merged `X`) may be undone only when `S` is canonical, `X.merged_into_id = S`, and no undo row names it; otherwise `MergeNotLatest` or `MergeAlreadyUndone` (typed domain errors, mapped at the edge to the 409 codes; the audit handler throws `UndoNotPossible` with the same code).

### Timeline and lenses

`CustomerTimelineService` (in the leaf module) merges sources by one total order: `at` descending, then source key, then entry id descending. The cursor is that triple, base64url encoded. Each source answers at most `limit` entries strictly after the cursor; the service merges and cuts to `limit`. Sources in this feature: the customers module's own rows (`customer_merges`, `customer_phones.first_seen_at`, `customer_external_ids.created_at`, the current flag) and spec 0013's orders read service. Later features add their own kind and source in their own build (credit 28, tasks 17, exchanges 34, messages 50), each declaring its permission in `CUSTOMER_TIMELINE_KINDS`.

| Entry kind | Shows | Needs | support | operations | manager | warehouse, media buyer, partner |
|---|---|---|---|---|---|---|
| `order` | order number with store, placed time, fulfillment and cash state, outcome, total, payment method, refusal reason; links to the order | `orders.view` | ✓ | ✓ | ✓ | no customer page (403) |
| `merge`, `unmerge` | the other customer's name and primary phone, who, when, reason code; Undo | `customers.view`; Undo needs `customers.merge`; "Open in audit" needs `audit.read` | ✓ with Undo | ✓ with Undo | ✓ with Undo and audit link | 403 |
| `phone_added`, `channel_id_added` | the phone (in `LtrText`) or store and id, when | `customers.view` | ✓ | ✓ | ✓ | 403 |
| `flag` | kind, source, who, when, note | `customers.view` | ✓ | ✓ | ✓ | 403 |
| later kinds (credit, exchange, task, message) | declared by features 28, 34, 17, 50 | their own permission | per spec 0008 | | | 403 |

In slice 1a support, operations, and manager see the same entries; the lens is built now so the kinds features 17, 28, 34, and 50 add are gated from their first entry, and so the warehouse hat sees a customer only through the order it is serving (`orders.view`), never through a profile.

### API surface

All routes are `@Audience('staff')`; bodies and answers are Zod schemas in `packages/contracts/src/customers/`. Lists page by keyset with `COLLATE "C"` on text keys.

| Endpoint | Method | Key inputs | Key outputs | Permission | Key errors |
|---|---|---|---|---|---|
| `/api/customers/search` | POST | exactly one of `phone` (text, any form), `nameContains` (3 to 100), `flagged: true`; `cursor?`, `limit?` (1 to 100, default 25) | `items[]` of `CustomerBrief` (id, name, primary phone, phone count, flag kind and source, created), `nextCursor` or null | `customers.view` | 400 `INVALID_PHONE` (no echo), 400 `INVALID_QUERY`, 400 `INVALID_CURSOR`, 403 |
| `/api/customers/:id` | GET | id | `CustomerProfile`: id (canonical), `resolvedFrom`, name, phones[], channel ids[] with store or channel label, absorbed merges[] (merge id, other customer brief, when, undoable), flag (kind, source, note, set at, set by name), `updatedAt`; from milestone 4 `signal` (refusals, returns, window days, suggested kind or null) and order count | `customers.view` | 404 `CUSTOMER_NOT_FOUND`, 403 |
| `/api/customers/:id/timeline` | GET | `cursor?`, `limit?` (1 to 50, default 25), `kinds?` | `items[]` (union by `kind`), `nextCursor` | `customers.view`, then per kind (lens table) | 404, 400 `INVALID_CURSOR`, 403 |
| `/api/customers/merges` | POST | `survivorId`, `mergedId`, `reasonCode?`, `suggestionId?` | `{ mergeId, survivor: CustomerBrief }` | `customers.merge` | 404 `CUSTOMER_NOT_FOUND`, 409 `SAME_CUSTOMER`, 409 `CUSTOMER_MERGED`, 409 `CUSTOMER_CHANGED`, 409 `SUGGESTION_CLOSED`, 422 `REASON_INVALID` |
| `/api/customers/merges/:id/undo` | POST | `reasonCode` (required) | `{ restoredId, survivorId }` | `customers.merge` | 404 `MERGE_NOT_FOUND`, 409 `MERGE_ALREADY_UNDONE`, 409 `MERGE_NOT_LATEST`, 422 `REASON_REQUIRED`, 422 `REASON_INVALID` |
| `/api/customers/merge-suggestions` | GET | `cursor?`, `limit?` | `items[]` (id, reason, created, both `CustomerBrief`s), `nextCursor`, `openCount` | `customers.view` | 400 `INVALID_CURSOR`, 403 |
| `/api/customers/merge-suggestions/:id/dismiss` | POST | `reasonCode?` | 204 | `customers.merge` | 404, 409 `SUGGESTION_CLOSED`, 422 `REASON_INVALID` |
| `/api/customers/:id/flag` | PUT | `kind`, `note?` (at most 500), `reasonCode?`, `expectedUpdatedAt` | the profile's flag block and new `updatedAt` | `customers.flag` | 404, 409 `STALE_RECORD`, 409 `CUSTOMER_MERGED`, 422 `REASON_INVALID`, 422 `NOTE_TOO_LONG` |
| `/api/customers/:id/flag/clear` | POST | `reasonCode` (required), `expectedUpdatedAt` | 204 | `customers.flag` | 404, 409 `STALE_RECORD`, 409 `NOT_FLAGGED`, 422 `REASON_REQUIRED`, 422 `REASON_INVALID` |

Search is a POST so the phone or name never lands in a URL, a proxy log, or browser history; the api's global Origin check covers it like the audit export.

### Audit actions (spec 0010 AC-11, AC-19)

New entries in `packages/contracts/src/audit/audit-actions.ts`, module `customers`, record type `customer` (reason kept as a code, no label), proof `apps/api/test/customers-audit.e2e-spec.ts`:

| Code | Reason | Auto | Undo | Reason codes |
|---|---|---|---|---|
| `customer.merged` | optional | no | yes, handler `customers.merge_undo`, only on the merged record's entry; `undoReasonCodes` `wrong_merge`, `different_people`; `undoRefusalCodes` `MERGE_NOT_LATEST`, `MERGE_ALREADY_UNDONE` | `same_person`, `new_number`, `duplicate_order`, `suggestion` |
| `customer.unmerged` | required | no | no | `wrong_merge`, `different_people` |
| `customer.merge_suggestion_dismissed` | optional | no | no | `different_people`, `shared_phone` |
| `customer.phone_added` | optional | no | no | `confirmed_by_customer` |
| `customer.flagged` | optional | no | no | `confirmed_fake`, `repeated_refusals`, `repeated_returns`, `abusive_contact`, `shared_blacklist`, `suggestion_applied` |
| `customer.unflagged` | required | no | no | `flag_mistaken`, `customer_settled`, `policy_review` |

`before` and `after` carry ids, `mergedIntoId`, flag kind and source, and counts only. The undo handler registers from `CustomersModule.onModuleInit` with owner `customers`; `AppModule` imports `CustomersModule`, so the api start check finds it.

### Value sourcing

| Action | Value | Source |
|---|---|---|
| `findOrCreate` | the normalized phone and its kind | the caller's `EgyptianPhone.parse` at its edge |
| `findOrCreate` | which customer | `customer_phones` by (`tenant_id`, `phone_e164`) and `customer_external_ids` by issuer, each resolved through `merged_into_id` once; rules (a) to (f) of AC-1 |
| `findOrCreate` | channel id issuer | `connectionId` of the Shopify store's connection (0015) or `channelId` for a partner reference |
| `findOrCreate` | new customer name | the input name (the order's `ship_to_name` or Shopify's customer name); written only when empty |
| `findOrCreate` | `last_seen_at` | input `seenAt` (the order's `placed_at` or the webhook's time) |
| merge | survivor default on screen | the older `customers.created_at`; the person may swap |
| merge | `repointed_ids` | customers with `merged_into_id = mergedId`, read under the locks |
| merge | correlation id | `AuditService.newCorrelationId()` |
| undo | allowed? | `customer_merges` rows of the merge and `customers.merged_into_id` of both, under the locks (undo rule above) |
| profile | canonical customer and `resolvedFrom` | `canonicalOf(id)` |
| profile | phones | `customer_phones` over `idsOf(canonical)`, primary first then `first_seen_at` |
| profile | channel id store label | the channels module's exported store lookup by `connection_id` (spec 0015), channel name by `channel_id` |
| profile | flag | the canonical row's flag, else the most severe flag on its ids (spec 0002 order); `set by` name through the identity module's `StaffDirectory.namesByIds` |
| profile | signal counts | spec 0013's orders read service over `idsOf(canonical)` since the operating day `windowDays` ago (the install time zone through `localDate` in `apps/api/src/platform/settings.service.ts`) |
| profile | signal thresholds | setting `customer_risk_signal` (requested from feature 9, below) |
| profile | order count (merge compare) | spec 0013's orders read service |
| search | phone match | `EgyptianPhone.parse(body.phone).e164` against the unique phone key |
| search | name match | `name ILIKE '%' || nameContains || '%'` on the trigram index, canonical rows only |
| timeline | entries and cursor | the sources above; order (`at` desc, source key, id desc) |
| timeline | which kinds and fields | the viewer's `Access` against `CUSTOMER_TIMELINE_KINDS` |
| flag set | `risk_flag_source`, `set_at`, `set_by` | `manual`, `now()`, the session person |
| flag import | source | `blacklist_import`, `set_by` null, `set_at` the import's time |
| suggestion | pair | the two canonical ids, ordered low then high |
| any route | permission | the API table; `HAT_PERMISSIONS` in `packages/contracts/src/access.ts` |

### Key invariants

- A normalized phone belongs to one customer per tenant (unique key, spec 0002); `findOrCreate` never moves a phone or a channel id between customers, and nothing in this module ever does.
- A customer id written on another module's row is never rewritten; every read resolves it through one hop of `merged_into_id`.
- Chains stay one hop: no customer points at a customer that itself points elsewhere.
- An undo restores exactly the pointers its merge changed, at most once, and only in reverse order of merges.
- A pair of customers has at most one suggestion row, ever.
- A flag always has a source and a set time; a `manual` flag names its person; an import never replaces a `manual` flag.
- The customers module reads orders only through spec 0013's exported read service and writes no table it does not own.

### Security model

Staff audience only; the permissions are spec 0008's `customers.view` and `customers.merge` (support, operations, manager), `orders.view` for order entries, `audit.read` and `audit.undo` for the audit side, and one new permission requested from feature 8: `customers.flag` (personal data, support, operations, manager; owner decision Q-14.3). Warehouse, media buyer, and partner users reach no customer route. Personal data under Law 151 (names, phones, channel ids, flag notes) stays in the mutable customer tables, never in `customer_merges`, the suggestion table, or audit entries; it never reaches logs (AC-17). Phones show in full to holders of `customers.view`, who call customers for a living; nothing here is public, so the portal's masking does not apply.

### Configuration required

No environment variable. One setting, registered in the settings registry of spec 0009 by this feature's build:
- `customer_risk_signal`: `{ windowDays: 180, refusalsToSuggest: 2, returnsToSuggest: 2 }` (each a whole number, window 30 to 730, thresholds 1 to 20), bundle `core`, group Policies, `whoMayChange: manager`, reason optional, exposure `staff`, not `sqlRead`.

### Critical test scenarios

- Happy path: a Shopify order with `01001234567` creates a customer; a second store's order with `+201001234567` and another Shopify customer id lands on the same customer with two channel ids; search by `٠١٠٠١٢٣٤٥٦٧` finds her, verifies **AC-1**, **AC-3**, **AC-4**, **AC-5**.
- Rules (d) and (f): a Shopify id known on customer A with a phone known on B returns B and one suggestion; repeating it opens none; no phone and an unknown id returns null and writes nothing, verifies **AC-1**, **AC-9**.
- Concurrency: twenty parallel `findOrCreate` for one new phone give one customer and one answer; twenty parallel merges of the same pair give one merge and nineteen 409s, verifies **AC-2**, **AC-6**.
- Chains (spec 0002 AC-28, feature 14 part): merge B into C, then C into A: lookups by B's and C's phones land on A, `idsOf(A)` has three ids; undo the second restores C and B's pointer to C; undoing the first while the second is live answers `MERGE_NOT_LATEST`; no `orders` or `credit_entries` row changed, verifies **AC-6**, **AC-8**.
- Undo twice from the customer screen, then from the audit screen: 409 `MERGE_ALREADY_UNDONE` and 409 `UNDO_NOT_POSSIBLE` with `undoCode` `MERGE_ALREADY_UNDONE`; a fresh merge undone from the audit screen writes `customer.merged_undone` on the merged record, verifies **AC-8**.
- Second phone: `addPhone` with a phone held by another customer answers `held_by_other`, moves nothing, opens one suggestion; a dismissed pair is never suggested again, verifies **AC-9**, **AC-10**.
- Flag: set `refuser` with a note, then clear with `flag_mistaken`; a stale `expectedUpdatedAt` gives 409; an import flag never replaces a manual one; a flag on a merged id shows on the survivor until cleared, verifies **AC-11**, **AC-12**.
- Signal: with orders refused twice in 180 days and no flag, the header suggests `refuser`; one tap writes a manual flag with `suggestion_applied` and the counts; with the setting raised to 3 the suggestion disappears, verifies **AC-13**.
- Timeline: 60 entries across orders, merges, and phones page by 25 with no gap or repeat, including two entries at the same instant from two sources, verifies **AC-14**.
- Lens: a built `Access` with `customers.view` only gets no order entry; support sees Undo but no audit link; manager sees both; warehouse, media buyer, and partner get 403 on every customers route, verifies **AC-15**, **AC-16**.
- Privacy: a sentinel phone and name through every route and service leave no trace in logs, errors, or audit entries; the search URL never holds them, verifies **AC-3**, **AC-17**.
- Screens: search, profile, merge, and suggestions in both languages, keyboard only, axe clean, verifies **AC-7**, **AC-18**.

## Build plan

Tracer Bullet: milestone 1 runs one real thread through every layer (database, service, api, contract, screen): a phone in any form finds or creates one customer and shows her profile. It also hands specs 0013 and 0015 the `findOrCreate` they link through. Each later milestone thickens one segment end to end: merge and undo, then the flag, then the timeline with its lenses once the orders read service exists. Each milestone is one commit.

**Milestone 1: One phone, one customer, end to end**

1. [ ] Schema: `risk_flag_set_at`, `risk_flag_set_by` with their checks and indexes, the trigram index on `name`, and `customer_merge_suggestions` with its enums, checks, and indexes (into the baseline while ADR 0003 allows, else one forward migration); table ownership; enum parity for the new enums; the flag check's case in `packages/db` e2e, satisfies **AC-9**, **AC-11**, **AC-19**
2. [ ] `CustomersModule` and `CustomersService.findOrCreate`, `canonicalOf`, `idsOf`, `briefs`, `lockCustomers`, the lock constants, rules (a) to (f) with the suggestion insert, module README, the `customers` row in the module registry of spec 0009 when it exists, satisfies **AC-1**, **AC-2**, **AC-19**
3. [ ] Contracts: the enums, `CustomerBrief`, `CustomerProfile`, `CustomerSearchRequest` (the one of three rule) and response, reason code lists; `nameContains` in `PERSONAL_DATA_KEYS` with the key test, satisfies **AC-3**, **AC-5**, **AC-17**
4. [ ] `POST /api/customers/search` (phone and name) and `GET /api/customers/:id` with `resolvedFrom`; `INVALID_PHONE` without echo; access sweep `FIXTURES` for both, satisfies **AC-3**, **AC-4**, **AC-5**, **AC-16**
5. [ ] Web: nav group and entry, `/customers` search with results table, `/customers/[id]` header (phones, channel ids, merged notice) in English and Arabic; `NoAccessState` without the permission, satisfies **AC-4**, **AC-18**
6. [ ] Tests: `apps/api/test/customers.e2e-spec.ts` (rules a to f, twenty parallel calls, every phone form, the log sentinel), `apps/web/e2e/customers.spec.ts` (search to profile, both languages, axe), satisfies **AC-1**, **AC-2**, **AC-3**, **AC-17**, **AC-18**

**Done when** `pnpm test` passes, `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/customers.e2e-spec.ts test/access-sweep.e2e-spec.ts` passes, `pnpm --filter @ssdashboard/db test:e2e` passes, and `pnpm --filter @ssdashboard/web test:e2e -- e2e/customers.spec.ts --project=desktop` passes.

**Milestone 2: Merge and undo as daily work**

7. [ ] Merge and undo in the service under the customer locks, `MergeNotLatest` and `MergeAlreadyUndone`, the suggestion closing rule; `addPhone`, satisfies **AC-6**, **AC-8**, **AC-10**
8. [ ] Audit codes `customer.merged`, `customer.unmerged`, `customer.merge_suggestion_dismissed`, `customer.phone_added` with labels in both languages; the handler `customers.merge_undo` registered from `onModuleInit`, satisfies **AC-6**, **AC-8**, **AC-10**, **AC-19**
9. [ ] Routes: merges, undo, suggestions list and dismiss, with `FIXTURES`, satisfies **AC-6**, **AC-8**, **AC-9**, **AC-16**
10. [ ] Web: `/customers/merge` compare and merge (prefilled from `?a=&b=`), the "To review" tab with one tap merge and dismiss, the toast with Undo, merges listed on the profile with Undo, satisfies **AC-7**, **AC-9**
11. [ ] Tests: `apps/api/test/customers-merge.e2e-spec.ts` (the chain scenario, twenty parallel merges, undo from both screens, other modules' rows untouched) and `apps/api/test/customers-audit.e2e-spec.ts` (every new code writes its entry, the proof file); web e2e for merge and undo by keyboard, satisfies **AC-6**, **AC-7**, **AC-8**, **AC-9**, **AC-10**

**Done when** milestone 1's commands pass with these files added, and an undo from `/audit` of a merge made on `/customers/merge` restores both records.

**Milestone 3: The flag**

12. [ ] `customers.flag` in `packages/contracts/src/access.ts` on support, operations, and manager, marked personal (after spec 0008 is amended by its owner), satisfies **AC-11**, **AC-16**
13. [ ] Flag set and clear in the service and routes, `setFlagFromImport`, codes `customer.flagged` and `customer.unflagged`, the flagged list in search, satisfies **AC-11**, **AC-12**, **AC-5**
14. [ ] Setting `customer_risk_signal` in the spec 0009 registry with both labels, satisfies **AC-13**
15. [ ] Web: flag dialog (kind, note, reason code), the flag on the header and on search rows, the flagged filter, satisfies **AC-11**, **AC-18**
16. [ ] Tests: flag cases in `customers.e2e-spec.ts` and `customers-audit.e2e-spec.ts`, the import precedence, the web flag flow, satisfies **AC-11**, **AC-12**

**Done when** milestone 1's commands pass with the flag cases, and `registry.spec.ts` of spec 0009 passes with the new key.

**Milestone 4: One timeline through each lens** (needs spec 0013's orders read service)

17. [ ] `CUSTOMER_TIMELINE_KINDS` and the entry union in contracts, with the unit test over built `Access` sets, satisfies **AC-15**
18. [ ] `CustomerProfileModule` (leaf, imported only by `AppModule`): the timeline service with the merged keyset, own sources, the order source through spec 0013's read service; move the profile route into it and add `signal` and the order count, satisfies **AC-13**, **AC-14**, **AC-15**
19. [ ] Route `GET /api/customers/:id/timeline` with `FIXTURES`; the module wall stays green with no orders table named, satisfies **AC-14**, **AC-16**
20. [ ] Web: the timeline on `/customers/[id]` (entry kinds, load more, empty and error states), the suggested flag with one tap apply, the order count on the merge compare, satisfies **AC-7**, **AC-13**, **AC-14**, **AC-18**
21. [ ] Tests: `apps/api/test/customers-timeline.e2e-spec.ts` (paging across sources, lens per hat, signal thresholds from the setting) and the web timeline flow, satisfies **AC-13**, **AC-14**, **AC-15**, **AC-16**

**Done when** all the commands above pass with `customers-timeline.e2e-spec.ts` added, and `pnpm lint && pnpm typecheck && pnpm format:check` are clean.

## Consequences

**Positive**:
- Orders, Shopify, imports, and the confirmation queue link customers through one call with one set of rules, so a household's orders from two stores land on one record from the first webhook.
- A wrong merge costs one tap, from the toast, the profile, or the audit screen, and never touches an order or a credit entry.
- The lens table makes every later entry kind (credit, exchanges, tasks, messages) gated by permission from its first line, with a test.

**Negative / tradeoffs**:
- The phone wins every conflict: a Shopify account shared by two people with two phones stays as two customers with a suggestion, and a person decides.
- An undo restores pointers, not phones: a phone attached to the survivor after the merge stays on the survivor.
- Undo from the customer screen writes `customer.unmerged`, so the original `customer.merged` entry on `/audit` still offers Undo and answers `MERGE_ALREADY_UNDONE` when clicked.
- The returner signal is computed on each profile read and is not stored, so no list can filter "suggested but not flagged" in this feature.
- Milestone 4 waits on spec 0013's read service, and milestone 3 on spec 0008's amendment for `customers.flag`.

**Neutral**:
- One new table and two columns, additive only; the trigram index on names grows with customers.
- The leaf module pattern of `AuditUndoModule` is reused for `CustomerProfileModule`.

## Follow-up

- [ ] Spec 0008 (its owner): add `customers.flag` (personal, support, operations, manager) to the permission matrix and the route mapping (owner decision Q-14.3); needed before milestone 3.
- [ ] Spec 0009 (its owner, after feature 9 lands): list `customer_risk_signal` under *Policy knobs* with "Registered by 14".
- [ ] Spec 0013: export from the orders module a read service with (1) a timeline page of orders for a list of customer ids after a cursor `(at, sourceKey, id)` with the fields of the `order` entry, (2) counts of orders refused at the door and returned after delivery for a list of customer ids since an operating day, (3) an order count per customer id set; and call `CustomersService.findOrCreate` on order create and on a phone fix (its draft of 2026-11-07 names `findOrCreateByPhone(tx, { phone, name })`; the name and the `channelCustomer` and `seenAt` fields here are the contract, and `ChannelOrderInput` needs the channel customer id for 0015 to pass through); use `findByPhone` and `idsOf` for its search box.
- [ ] Spec 0015: export a store label lookup by `connection_id` from the channels module; call `findOrCreate` for Shopify orders and for `customers/create` and `customers/update` webhooks.
- [ ] Feature 15: blacklist rows call `setFlagFromImport` with the kind mapped from the brand's categories (spec 0002 brand question 7).
- [ ] Feature 17: an open suggestion count in My work for `customers.merge` holders; a task type for orders with a phone that did not parse, if the confirmation queue does not cover older orders.
- [ ] Feature 18: the confirmation outcome `fake` sets the flag through `CustomersService` with reason code `confirmed_fake`; the second phone joins through `addPhone`.
- [ ] Later: edit a customer's name, change the primary phone, and detach a phone attached by mistake (each a new audited action); an automatic flag rule (`rule` source) and automatic merges (`customer.merge_suggested_applied`) if the owner asks after the pilot.
- [ ] Spec 0010's actions table names `customer.merge_suggested_applied` as built by feature 14; it is not built here (Q-14.4); its owner may mark it later.
