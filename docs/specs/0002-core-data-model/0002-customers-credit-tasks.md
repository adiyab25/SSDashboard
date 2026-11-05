# 0002 child: customers by phone, the customer credit ledger, and tasks

Part of the [2026-11-05 amendment of spec 0002](index.md#amendment-2026-11-05). Satisfies **AC-24**, **AC-26**, **AC-27**, **AC-28**. Sources: final plan sections 6.2, 6.3, 6.4, 7.3 (`docs/positioning/2026-11-05-egypt-order-operations-layer.md`); reference brand notes sections 2 and 7 (customers split by store in four phone formats, cases built as tasks by hand).

## Summary

A customer is a normalized Egyptian phone number. One customer holds many phones and many channel ids, and merging two customers is a routine, audited, reversible step that never rewrites another module's rows. Customer credit is an append only ledger like stock: a return credits what the customer actually paid, an exchange spends it, and what is left is refunded or kept. A task is one small record (type, linked record, owner, due time, outcome code) that every process creates as it moves.

**Built here versus later.** This feature migrates the customer tables, `credit_entries`, and `tasks` with every check and trigger below, and builds two pure pieces in `packages/contracts`: `EgyptianPhone` and the credit arithmetic (`credit/credit-amounts.ts`: the return credit share, the exchange consumption, the leftover). The services that apply the rules are the contract for their own features: `CustomersService` lookup, canonical resolution, merge, and undo (feature 14), `CreditService` with its locks and balance checks (feature 28), `TasksService` and the type registry (feature 17). Test scenarios tagged with a feature number are proven by that feature's tests; untagged ones by this feature's.

## Customers

**Customers module.** Every table also has `tenant_id`.

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `customers` | `id`, `name text null` (a proper name, not translated; personal data), `merged_into_id fk null` (self), `repeat_returner bool not null default false`, `repeat_returner_source` enum null (`blacklist_import`, `manual`, `rule`), `repeat_returner_note text null`, timestamps | index partial (`merged_into_id`) where not null; check `merged_into_id <> id`; check `repeat_returner_source` set exactly when `repeat_returner` |
| ★ `customer_phones` | `id`, `customer_id fk`, `phone_e164 text` (normalized, for example `+201001234567`), `kind` enum (`mobile`, `landline`, `foreign`), `is_primary bool default false`, `first_seen_at`, `last_seen_at` | **unique (`tenant_id`, `phone_e164`)** (spec 0007 section 7: a phone belongs to one customer); index (`customer_id`); partial unique (`customer_id`) where `is_primary`; check `phone_e164 ~ '^\+[1-9][0-9]{7,14}$'` |
| ★ `customer_external_ids` | `id`, `customer_id fk`, `kind` enum (`shopify_customer`, `partner_reference`, `whatsapp_contact`), `connection_id fk null` (an id issued by a connected account, for example one Shopify store), `channel_id fk null` (an id issued by a channel without a connection, for example a partner's own customer reference), `external_id text` | check exactly one of `connection_id`, `channel_id` is set; unique (`tenant_id`, `kind`, `connection_id`, `channel_id`, `external_id`) `NULLS NOT DISTINCT`; index (`customer_id`) |
| ★ `customer_merges` (append only) | `id`, `action` enum (`merge`, `undo`), `survivor_id fk`, `merged_id fk`, `repointed_ids uuid[]` (customers whose `merged_into_id` pointed at `merged_id` and were moved to `survivor_id`, so an undo can move them back), `undoes_merge_id fk null` (self), `reason text null`, `actor_id fk users`, `recorded_at` | unique (`undoes_merge_id`) (a merge is undone at most once); check `action = 'undo'` exactly when `undoes_merge_id IS NOT NULL`; index (`survivor_id`), (`merged_id`) |

### Phone normalization at the edge

One value object, `EgyptianPhone.parse(raw: string)` in `packages/contracts/src/customers/egyptian-phone.ts`, used by every input edge (Shopify import, portal lookup, confirmation queue, imports, staff forms). It returns `{ e164, kind }` or throws `InvalidPhone`. Steps, in order:

1. Replace Arabic Indic digits (U+0660 to U+0669) and Eastern Arabic Indic digits (U+06F0 to U+06F9) with ASCII `0` to `9`.
2. Remove spaces, non breaking spaces, `-`, `.`, `(`, `)`, `/`, and the direction and zero width marks (U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069, U+FEFF). Keep one leading `+` if present. Any other character left means `InvalidPhone`.
3. Turn an international prefix into `+`: a leading `00` becomes `+`.
4. Apply the Egyptian rules to what is left:

| Input after steps 1 to 3 | Rule | Result |
|---|---|---|
| `01XXXXXXXXX` (11 digits) | national mobile | `+201XXXXXXXXX` |
| `1XXXXXXXXX` (10 digits starting `1`) | the leading zero a spreadsheet dropped | `+201XXXXXXXXX` |
| `+2001XXXXXXXXX` | country code written with the national zero | `+201XXXXXXXXX` |
| `201XXXXXXXXX` (12 digits) | country code without `+` | `+201XXXXXXXXX` |
| `+201XXXXXXXXX` | already normalized | as is |
| `+` then exactly 10 digits matching `1[0125]` plus 8 digits (came from `0010...`, `0011...`, `0012...`, `0015...`: the national number with its zero doubled) | doubled zero, **Assumed** reading of the final plan's "0010" form | `+20` then those 10 digits |
| `0[2-9]X...` (9 or 10 digits, not starting `01`) | national landline | `+20` without the zero, kind `landline` |
| `+` then a country code other than `20`, 8 to 15 digits in all | foreign number | as is, kind `foreign` |
| anything else | | `InvalidPhone` |

5. An Egyptian mobile result must match `^\+201[0125][0-9]{8}$` (the four mobile prefixes 010, 011, 012, 015), else `InvalidPhone`.

The doubled zero row looks like the North American country code `+1`, but a North American number always has 11 digits after the `+`, so a 10 digit form never collides with one. The rows are tried top to bottom and the first match wins. The raw input is never stored on the customer; the order keeps only the normalized `ship_to_phone`. An order whose phone does not parse imports with `customer_id` null and a data quality task (feature 14 owns the queue).

### Merge and undo

- **Merge never touches another module's rows.** Orders, credit entries, tasks, and messages keep the `customer_id` they were written with. Merging B into A sets `B.merged_into_id = A`, moves any customer that pointed at B to A (recorded in `repointed_ids`, so chains stay one hop deep), and writes a `customer_merges` row and an audit entry. Phones and external ids stay on their rows.
- **Reads resolve the canonical customer.** `CustomersService.canonicalOf(id)` follows `merged_into_id` once; `CustomersService.idsOf(canonicalId)` returns the canonical id plus every id merged into it. A phone or external id lookup lands on its row's customer and resolves to the canonical one. Other modules query their own tables with `customer_id = ANY(:ids)` for a timeline, a credit balance, or a repeat returner check.
- **Canonical values**: the canonical customer's phones are the union over its ids; `repeat_returner` is true if any of its ids is flagged; the name is the canonical row's.
- **Undo** is a new `customer_merges` row (`action = 'undo'`, `undoes_merge_id`) that clears `merged_id.merged_into_id` and moves the `repointed_ids` back to `merged_id`. Undoing a merge whose survivor has since been merged into a third customer is refused with `MergeNotLatest` (undo the later merge first), so pointers are always restored exactly.
- **Locking**: a merge and an undo take the transaction advisory lock of each affected customer id (ascending), in namespace `customer`, the same lock credit writes take below, so a credit consumption never runs against a half merged customer.

## Customer credit ledger

**Credit module.** The single engine for exchanges, refunds, store credit, and retention bonuses (final plan 6.2), append only like stock.

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `credit_entries` (append only) | `id`, `customer_id fk`, `kind` enum (below), `amount numeric(14,2)` (signed: positive is owed to the customer, negative is spent, paid out, or owed back), `order_id fk null`, `order_line_id fk null`, `quantity int null` (return credits: units credited), `exchange_id uuid null` (key added by feature 34), `refund_id uuid null` (key added by feature 35), `reverses_entry_id fk null` (self), `reason_code text not null`, `actor_type` enum (`person`, `rule`, `system`), `actor_id fk users null`, `idempotency_key text`, `effective_at timestamptz`, `recorded_at default now()`, `operating_day date` (stamped from `effective_at`) | unique (`tenant_id`, `idempotency_key`); unique (`reverses_entry_id`); index (`customer_id`, `recorded_at`); index (`order_id`); index (`order_line_id`); index (`exchange_id`); check `amount <> 0`; check sign by kind (below); check `order_line_id` and `quantity > 0` set when `kind = 'return_credit'` |
| ○ `refunds` (feature 35) | the refund document: method, amount, states `requested`, `approved`, `in_transit_or_sent`, `confirmed`, provider reference | |

| `kind` | Sign | Posted when |
|---|---|---|
| `return_credit` | + | a returned line is credited (timing is the brand's policy, feature 31: at approval for clean swaps, after inspection for the rest) |
| `shipping_credit` | + | the original shipping is credited (owner question: only for brand fault reasons by default) |
| `exchange_consumption` | − | a replacement order consumes credit |
| `refund_payout` | − | a refund by the original method is approved; a failed or cancelled refund is reversed |
| `retention_bonus` | + | a retention step converts a refund to store credit with a bonus (feature 36) |
| `goodwill` | + | a manager grants credit with a reason |
| `inspection_reversal` | − | inspection rejects a piece already credited; may take the balance below zero ("customer owes") |
| `adjustment` | + or − | an admin correction with a written reason |

A reversal has the original's `kind`, the negated amount, and `reverses_entry_id`; a reversal cannot itself be reversed (trigger, like movement groups).

**Rules, checked by the credit service (feature 28) under the customer lock** (a transaction advisory lock per affected customer id, ascending, namespace `customer`; the canonical customer's whole id set is locked, because its balance spans them):

- **Balance** = sum of `amount` over the canonical customer's ids. Summed on read: at this volume (thousands of entries a year) an indexed sum is cheap and cannot drift, so there is no balance table.
- **Return credit** for `k` units of a line with `quantity = n` and `gross_amount = g` (the price actually paid after every discount, VAT inclusive): `round(g × k / n, 2)`, except that the credit which brings the line's credited units to `n` takes exactly `g` minus what the line already received, so a line is never credited more than it was paid. Units already credited on the line come from its own `return_credit` entries net of reversals; crediting more than `n` units raises `CreditExceedsLine`.
- **Exchange consumption** for a replacement order = `min(balance, replacement total_amount − prepaid_amount)`; the replacement's `credit_applied_amount` equals it and `cod_expected_amount` is the **balance due** the courier collects.
- **Leftover** (balance after consumption, greater than 0) is either refunded by the original payment method (a `refund_payout` linked to the refund) or kept as store credit (no entry; it stays on the balance). The customer's choice is recorded on the exchange (feature 34).
- `exchange_consumption` and `refund_payout` may never take the balance below zero (`InsufficientCredit`). Only `inspection_reversal` and `adjustment` may; a negative balance is "customer owes" and shows on the customer.
- Every entry has a reason, an actor (a person, a named rule, or the system), and an idempotency key; a replay with the same key and content returns the stored entry, the same key with other content raises `IdempotencyConflict` (the ledger's rule).
- Store credit does not expire in version one (owner question).

## Tasks

**Tasks module.** One primitive; each process is a small state machine in its own module that opens and closes tasks (final plan 6.3).

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `tasks` | `id`, `type text` (from a code registry, for example `confirmation.call`, `sync.write_back_failed`, `delivery.stalled`), `linked_type` enum (`order`, `customer`, `exchange`, `refund`, `shipment`, `settlement_line`, `outbound_command`), `linked_id uuid`, `owner_user_id fk users null`, `owner_hat text` (the hat whose queue holds it when nobody is assigned; hat names are feature 8 detail), `due_at timestamptz null`, `status` enum (`open`, `done`, `cancelled`), `outcome_code text null`, `note text null`, `dedupe_key text null`, `created_by_type` enum (`person`, `system`), `created_by fk users null`, `closed_at null`, `closed_by fk users null`, `created_at`, `updated_at`, `operating_day date` (stamped from `created_at`) | check `outcome_code` set exactly when `status = 'done'`; partial unique (`tenant_id`, `dedupe_key`) where `status = 'open'` (one open task per cause); partial index (`owner_user_id`, `due_at`) where `status = 'open'`; partial index (`owner_hat`, `due_at`) where `status = 'open' and owner_user_id is null`; index (`linked_type`, `linked_id`); index (`operating_day`) |

- **The type registry** lives in code (`apps/api/src/tasks/task-types.ts`): each type names its default owner hat, its default due offset, and its allowed outcome codes. `type` is `text`, not a database enum, because nearly every later feature adds types; the tasks service rejects an unregistered type or an outcome code its type does not allow (`InvalidOutcome`). There is no workflow designer.
- **Linked record** is polymorphic (`linked_type`, `linked_id`) with no foreign key, because tasks point at records of many modules; the tasks service checks existence through the owning module's service when it opens one.
- **Idempotent creation**: `TasksService.open` with a `dedupe_key` (for example `outbound_command_failed:<command id>`) returns the open task with that key instead of opening a second.
- **Counting attempts** ("three no answers closes", final plan 7.1) is the number of tasks of that type on the record closed with that outcome; no counter column.
- Tasks are mutable (assign, reschedule, close); each change writes an audit entry (feature 10).

## Value sourcing

| Action | Value | Source |
|---|---|---|
| any phone input | `phone_e164`, `kind` | `EgyptianPhone.parse` |
| order import | customer | `findOrCreateByPhone`: the phone row's customer, resolved to canonical; else a new customer with that phone |
| Shopify import | external id | (`connection_id`, Shopify customer id), kind `shopify_customer` |
| merge | `repointed_ids` | customers with `merged_into_id = merged_id`, read under the customer locks |
| any read | canonical customer | `merged_into_id`, one hop |
| blacklist import (feature 15) | `repeat_returner`, source | the imported row; source `blacklist_import` |
| return credit | amount | `round(g × k / n, 2)`, or the line's remaining paid amount for the last units |
| exchange | consumption | `min(balance, replacement total − prepaid)` |
| exchange | balance due | replacement `cod_expected_amount` |
| exchange | leftover | balance after consumption; payout or kept by the customer's choice |
| any credit entry | balance check | sum over the canonical customer's ids, under the customer locks |
| open task | owner hat, due | the type registry, unless the caller passes them |
| close task | allowed outcome codes | the type registry |

## Critical test scenarios

- Normalization: `01001234567`, `٠١٠٠١٢٣٤٥٦٧` (Arabic Indic), `۰۱۰۰۱۲۳۴۵۶۷` (Eastern), `+20 100 123 4567`, `00201001234567`, `+2001001234567`, `201001234567`, `1001234567`, and `0010 0123 4567` with a right to left mark all give `+201001234567`; `0131234567` and `abc` raise `InvalidPhone`; `+971501234567` is `foreign`; `0223456789` is `landline`, verifies **AC-27**.
- The same phone on two Shopify stores' customers resolves to one customer with two external ids; a second customer with an existing phone fails the unique key, verifies **AC-27**.
- Merges: `UPDATE` and `DELETE` on `customer_merges` fail; a second undo of one merge fails the unique key; an undo row without `undoes_merge_id` fails its check; `merged_into_id = id` fails, verifies **AC-28**, **AC-33**.
- (feature 14) Merge B into A, then C (with B already merged into it) into A: lookups by B's and C's phones land on A, A's id set has three ids; undo the second merge restores C and B's pointer to C; undoing the first while the second is live raises `MergeNotLatest`; no `orders` or `credit_entries` row changed, verifies **AC-28**.
- Credit arithmetic: a line of 2 at 999.99 credits 1 unit (500.00) then the other (499.99); a third unit raises `CreditExceedsLine`. A 500 credit and an 800 replacement give consumption 500 and balance due 300; an 800 credit and a 500 replacement give a leftover of 300. Table checks: a `return_credit` without a line fails; a negative `return_credit` and a positive `exchange_consumption` fail the sign check; `UPDATE` fails; a reversal of a reversal fails, verifies **AC-24**, **AC-33**.
- (feature 28) Twenty parallel consumptions against a balance of 500 never take it below zero; an inspection reversal may take it to −500; a replayed key returns the stored entry, verifies **AC-24**.
- Tasks table: closing without an outcome fails the check; a second open task with one dedupe key fails the partial unique; a closed one does not block a new open one, verifies **AC-26**.
- (feature 17) An outcome not allowed for the type raises `InvalidOutcome`; opening twice with one dedupe key returns one task; My work for a person and for a hat reads through its partial index, verifies **AC-26**.
