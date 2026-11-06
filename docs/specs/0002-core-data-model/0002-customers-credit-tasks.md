# 0002 child: customers by phone, the customer credit ledger, and tasks

Part of the [2026-11-05 amendment of spec 0002](index.md#amendment-2026-11-05). Satisfies **AC-24**, **AC-26**, **AC-27**, **AC-28**. Sources: final plan sections 6.2, 6.3, 6.4, 6.7, 6.9, 7.3 (`docs/positioning/2026-11-05-egypt-order-operations-layer.md`); reference brand notes sections 2 and 7 (customers split by store in four phone formats, cases built as tasks by hand); the domain review `docs/reviews/domain-data-model.md` (B1, M2, M9, m5, m8, m10) and the owner's answers of 2026-11-05 (cashability, customer debt, spending kept credit).

## Summary

A customer is a normalized Egyptian phone number. One customer holds many phones and many channel ids, and merging two customers is a routine, audited, reversible step that never rewrites another module's rows. Customer credit is an append only ledger like stock: a return credits what the customer actually paid, an exchange spends it, and what is left is refunded the way she paid or kept. Every credit entry says where its value came from, so a bonus or goodwill credit can be spent but never paid out as cash. A task is one small record (type, linked record, owner, due time, outcome code) that every process creates as it moves.

**Built here versus later.** This feature migrates the customer tables, `credit_entries`, and `tasks` with every check and trigger below, and builds two pure pieces in `packages/contracts`: `EgyptianPhone` and the credit arithmetic (`credit/credit-amounts.ts`: the return credit share, the exchange consumption, the leftover). The services that apply the rules are the contract for their own features: `CustomersService` lookup, canonical resolution, merge, and undo (feature 14), `CreditService` with its locks and balance checks (feature 28), `TasksService` and the type registry (feature 17). Test scenarios tagged with a feature number are proven by that feature's tests; untagged ones by this feature's.

## Customers

**Customers module.** Every table also has `tenant_id`.

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `customers` | `id`, `name text null` (a proper name, not translated; personal data), `merged_into_id fk null` (self), `risk_flag` enum null (`returner`, `refuser`, `fake`, `abusive`; the scope's repeat returner flag is `returner`), `risk_flag_source` enum null (`blacklist_import`, `manual`, `rule`), `risk_flag_note text null` (free text: personal data, redacted), timestamps | index partial (`merged_into_id`) where not null; check `merged_into_id <> id`; check (`risk_flag IS NULL`) = (`risk_flag_source IS NULL`) |
| ★ `customer_phones` | `id`, `customer_id fk`, `phone_e164 text` (normalized, for example `+201001234567`), `kind` enum (`mobile`, `landline`, `foreign`), `is_primary bool default false`, `first_seen_at`, `last_seen_at` | **unique (`tenant_id`, `phone_e164`)** (spec 0007 section 7: a phone belongs to one customer); index (`customer_id`); partial unique (`customer_id`) where `is_primary`; check `phone_e164 ~ '^\+[1-9][0-9]{7,14}$'` |
| ★ `customer_external_ids` | `id`, `customer_id fk`, `kind` enum (`shopify_customer`, `partner_reference`, `whatsapp_contact`), `connection_id fk null` (an id issued by a connected account, for example one Shopify store), `channel_id fk null` (an id issued by a channel without a connection, for example a partner's own customer reference), `external_id text` | check exactly one of `connection_id`, `channel_id` is set; unique (`tenant_id`, `kind`, `connection_id`, `channel_id`, `external_id`) `NULLS NOT DISTINCT`; index (`customer_id`) |
| ★ `customer_merges` (append only) | `id`, `action` enum (`merge`, `undo`), `survivor_id fk`, `merged_id fk`, `repointed_ids uuid[]` (customers whose `merged_into_id` pointed at `merged_id` and were moved to `survivor_id`, so an undo can move them back), `undoes_merge_id fk null` (self), `reason text null` (free text: redacted), `actor_id fk users`, `recorded_at` | unique (`undoes_merge_id`) (a merge is undone at most once); check `action = 'undo'` exactly when `undoes_merge_id IS NOT NULL`; index (`survivor_id`), (`merged_id`) |

### Phone normalization at the edge

One value object, `EgyptianPhone.parse(raw: string)` in `packages/contracts/src/customers/egyptian-phone.ts`, used by every input edge (Shopify import, portal lookup, confirmation queue, imports, staff forms). It returns `{ e164, kind }` or throws `InvalidPhone`. Steps, in order:

1. Replace Arabic Indic digits (U+0660 to U+0669) and Eastern Arabic Indic digits (U+06F0 to U+06F9) with ASCII `0` to `9`.
2. Remove spaces, non breaking spaces, `-`, `.`, `(`, `)`, `/`, and the direction and zero width marks (U+200B to U+200F, U+202A to U+202E, U+2066 to U+2069, U+FEFF, and, added at the build, U+061C, U+2060, U+00AD, which Arabic keyboards and copied text carry). Keep one leading `+` if present. Any other character left means `InvalidPhone`.
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
| `+20` then 8 or 9 digits starting `[2-9]`, the national landline without its zero (added at the build, 2026-11-06, so a normalized landline parses again: Shopify sends E.164) | landline already normalized | as is, kind `landline` |
| `+` then a country code other than `20`, 8 to 15 digits in all | foreign number | as is, kind `foreign` |
| anything else | | `InvalidPhone` |

5. An Egyptian mobile result must match `^\+201[0125][0-9]{8}$` (the four mobile prefixes 010, 011, 012, 015), else `InvalidPhone`.

The doubled zero row looks like the North American country code `+1`, but a North American number always has 11 digits after the `+`, so a 10 digit form never collides with one. The rows are tried top to bottom and the first match wins. The raw input is never stored on the customer. The order keeps the normalized `ship_to_phone` and `ship_to_phone_alt` (the second number Egyptian COD forms carry, used by the confirmation agent and the courier); an order whose phone does not parse imports with `customer_id` null, the raw text in `orders.contact_phone_raw` (personal data, redacted, cleared when a person fixes it), and a data quality task (feature 14 owns the queue). Only the main phone creates or finds the customer; the second phone is added to the customer's phones when the agent confirms it.

### Merge and undo

- **Merge never touches another module's rows.** Orders, credit entries, tasks, and messages keep the `customer_id` they were written with. Merging B into A sets `B.merged_into_id = A`, moves any customer that pointed at B to A (recorded in `repointed_ids`, so chains stay one hop deep), and writes a `customer_merges` row and an audit entry. Phones and external ids stay on their rows.
- **Reads resolve the canonical customer.** `CustomersService.canonicalOf(id)` follows `merged_into_id` once; `CustomersService.idsOf(canonicalId)` returns the canonical id plus every id merged into it. A phone or external id lookup lands on its row's customer and resolves to the canonical one. Other modules query their own tables with `customer_id = ANY(:ids)` for a timeline, a credit balance, or a risk check.
- **Canonical values**: the canonical customer's phones are the union over its ids; the risk flag is the canonical row's, or else any flag found on its ids (`fake` before `abusive` before `refuser` before `returner`); the name is the canonical row's. One phone, one customer (decided default 10) means a flag covers everyone ordering on that phone, which is what a brand's blacklist does today.
- **Undo** is a new `customer_merges` row (`action = 'undo'`, `undoes_merge_id`) that clears `merged_id.merged_into_id` and moves the `repointed_ids` back to `merged_id`. Undoing a merge whose survivor has since been merged into a third customer is refused with `MergeNotLatest` (undo the later merge first), so pointers are always restored exactly.
- **The database guards the undo** (added at the build, 2026-11-06): an insert trigger refuses an undo row whose `undoes_merge_id` is not a `merge` row with the same `survivor_id` and `merged_id`, so an append only row can never point at the wrong merge.
- **Locking**: a merge and an undo take the transaction advisory lock of each affected customer id (ascending), in namespace `customer`, the same lock credit writes take below, so a credit consumption never runs against a half merged customer.

## Customer credit ledger

**Credit module.** The single engine for exchanges, refunds, store credit, and retention bonuses (final plan 6.2), append only like stock. Every entry records where its value came from (its **funding**), so credit that was never cash can never leave as cash, and a refund by "the original method" is defined for a pooled balance (domain review B1).

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `credit_entries` (append only) | `id`, `posting_id uuid` (groups the entries one action posts, like a movement group), `customer_id fk`, `kind` enum (below), `funding` enum (`cod_cash`, `gateway`, `instapay_or_transfer`, `credit_only`), `amount numeric(14,2)` (signed: positive is owed to the customer, negative is spent, paid out, or owed back), `payout_method` enum null (`carrier_cash_refund`, `gateway_refund`, `instapay_or_transfer`), `order_id fk null`, `order_line_id fk null`, `quantity int null` (return credits: units credited by this posting, repeated on each of its entries), `exchange_id uuid null` (key added by feature 34), `refund_id uuid null` (key added by feature 35), `reverses_entry_id fk null` (self), `reason_code text not null`, `actor_type` enum (`person`, `rule`, `system_job`, `import`), `actor_id fk users null`, `idempotency_key text` (one per posting), `effective_at timestamptz`, `recorded_at default now()`, `operating_day date` (stamped from `effective_at`) | unique (`tenant_id`, `idempotency_key`, `funding`) (a posting holds at most one entry per funding); unique (`reverses_entry_id`); index (`customer_id`, `funding`, `recorded_at`); index (`posting_id`); index (`order_id`); index (`order_line_id`); index (`exchange_id`); check `amount <> 0`; check the sign by kind (below), **inverted when `reverses_entry_id` is set** (domain review M2); check (`kind = 'refund_payout'`) = (`payout_method IS NOT NULL`); check `kind <> 'refund_payout' OR funding <> 'credit_only'`; check `kind not in ('retention_bonus', 'goodwill') OR funding = 'credit_only'`; check `order_line_id` and `quantity > 0` set when `kind = 'return_credit'`; check `order_id` set when `kind in ('order_consumption', 'consumption_release')`; check `exchange_id` set when `kind = 'return_not_collected'` |
| ○ `refunds` (feature 35) | the refund document: method, amount, states `requested`, `approved`, `in_transit_or_sent`, `confirmed`, provider reference | |

| `kind` | Sign | Funding | Posted when |
|---|---|---|---|
| `return_credit` | + | the tender of the part of the line it credits (rule below) | a returned line is credited (timing is the brand's policy, feature 31: at approval for clean swaps, after inspection for the rest) |
| `shipping_credit` | + | the tender of the order's shipping share | the original shipping is credited (owner answer 3: only for the brand's fault, damaged or wrong item, as a rule per return reason in feature 31) |
| `order_consumption` | − | the bucket it draws from (rule below) | an order consumes credit: an exchange replacement, or any order an agent creates and applies the customer's kept credit to |
| `refund_payout` | − | the bucket it draws from, never `credit_only` | a refund by the original method is approved; a failed or cancelled refund is reversed |
| `retention_bonus` | + | `credit_only` | a retention step converts a refund to store credit with a bonus (feature 36) |
| `goodwill` | + | `credit_only` | a manager grants credit with a reason |
| `opening_balance` | + | set by the import, default `credit_only` | store credit the brand already owed on the day it goes live (feature 15; domain review M9) |
| `inspection_reversal` | − | the funding of the return credit it reverses | inspection rejects a piece already credited; may take the balance below zero ("customer owes") |
| `return_not_collected` | − | the funding of the exchange's return credit | the new piece was delivered and the old piece never came back within the brand's policy days; may take the balance below zero; requires `exchange_id` (domain review M2) |
| `consumption_release` | + | the funding of the `order_consumption` entry it releases | the credit share of lines that never reached the customer comes back to her balance: lines returned to origin or lost, or a replacement order refused, returned to origin, or lost; the amount is those lines' `credit_applied_amount` (plus the shipping share when nothing was delivered); requires `order_id`; never counted in `returned_credit_amount` (domain re-review n3) |
| `debt_payment` | + | the funding of the negative balance it settles | the customer pays what she owes, by InstaPay or transfer; it may only bring negative fundings back toward zero, never above (a payment above the debt is refused), so it never creates cashable credit |
| `adjustment` | + or − | set by the admin | an admin correction with a written reason |

A reversal has the original's `kind` and `funding`, the negated amount, and `reverses_entry_id`; a reversal cannot itself be reversed (trigger, like movement groups).

**Tenders.** An order's tender maps to a funding: `cod` to `cod_cash`; `gateway` to `gateway`; `instapay`, `bank_transfer`, and `wallet` to `instapay_or_transfer`. An order whose `prepaid_amount` was paid by another tender than the rest (a deposit by InstaPay before a COD order ships) records it in `orders.prepaid_method` (same enum as `payment_method`, set exactly when `prepaid_amount > 0`).

**Rules, checked by the credit service (feature 28) under the customer lock** (a transaction advisory lock per affected customer id, ascending, namespace `customer`; the canonical customer's whole id set is locked, because its balance spans them):

- **Balance** = sum of `amount` over the canonical customer's ids; **balance by funding** = the same sum per `funding`. Summed on read: at this volume (thousands of entries a year) an indexed sum is cheap and cannot drift, so there is no balance table.
- **Return credit** for `k` units of a line with `quantity = n` and `gross_amount = g` (the price actually paid after every discount, VAT inclusive): the total is `round(g × k / n, 2)`, except that the posting which brings the line's credited units to `n` takes exactly `g` minus what the line already received, so a line is never credited more than it was paid. Units already credited come from the line's `return_credit` postings (one `quantity` per posting) net of reversals; crediting more than `n` units raises `CreditExceedsLine`. **The total splits by funding** using the line's allocated shares ([orders child](0002-orders.md#money-on-the-order-allocation-expected-and-due)), each share by the same `k / n` rule with the last units taking the rest: the credit part (`order_lines.credit_applied_amount`) returns to the fundings the order's own `order_consumption` entries drew, in the same proportion (the last funding in the consumption order takes the rest); the prepaid part (`order_lines.prepaid_amount`) takes the funding of `prepaid_method`; the remainder takes the funding of `payment_method`. One posting, one entry per funding that is not zero.
- **Consumption** for an order that spends credit (an exchange replacement, or an order an agent creates for a customer with kept credit) = `max(0, min(balance, order total_amount − prepaid_amount))`, or less when the agent applies less (a customer who owes gets no consumption, domain review m5); the order's `credit_applied_amount` equals it and, for an exchange replacement, its `cod_expected_amount` is the **balance due** the courier collects. Consumption spends `credit_only` first, then `cod_cash`, then `instapay_or_transfer`, then `gateway` (so money that can go back to its source stays refundable longest), one entry per funding drawn, each never taking its funding below zero.
- **Leftover** (balance after consumption, greater than 0) is either refunded by the original payment method or kept as store credit (no entry; it stays on the balance). The customer's choice is recorded on the exchange (feature 34).
- **A `refund_payout` names its `payout_method` and draws only from a matching funding** (decided, owner question 13: "refunded the same way they paid"): `gateway` funding goes back through `gateway_refund` only (card money goes back to the card or gateway); `cod_cash` and `instapay_or_transfer` funding may be paid as `carrier_cash_refund` (a Bosta return pickup with cash) or `instapay_or_transfer`, since both are cash to the customer. **`credit_only` balance is never paid out.** A payout larger than the matching funding's balance raises `InsufficientCredit`.
- `order_consumption` and `refund_payout` may never take the balance, or their funding's balance, below zero (`InsufficientCredit`). Only `inspection_reversal`, `return_not_collected`, and `adjustment` may; a negative balance is "customer owes" and shows on the customer and in the confirmation queue (decided default 5: flagged, never blocked). A debt is never added to her next order's COD (owner answer, 2026-11-05): it is chased separately by InstaPay or transfer, stays a negative balance with the flag until paid, and a payment against it is a `debt_payment` entry.
- **Imports** (feature 15) post a brand's history as ordinary entries with `actor_type = 'import'`: a historically refunded order gets a `return_credit` and a `refund_payout` posting pair, so its outcome derives `refunded`; credit owed on the go live day is an `opening_balance` entry.
- Every posting has a reason, an actor (a person, a named rule, a system job, or an import), and an idempotency key; a replay with the same key and content returns the stored entries, the same key with other content raises `IdempotencyConflict` (the ledger's rule).
- Store credit does not expire in version one (decided default 4).
- **Spending kept credit**: an agent applies it on an order they create (the consumption rule above). A Shopify gift card or discount code issued for kept credit is a later toggle (owner answer, 2026-11-05), carried to features 28 and 37, not built in slice 1.
- **Two tenders on one order** (a deposit by InstaPay before a COD order ships) are carried by `prepaid_method` beside `payment_method`, so funding can already split them; building the deposit flow is carried to feature 18.

## Tasks

**Tasks module.** One primitive; each process is a small state machine in its own module that opens and closes tasks (final plan 6.3).

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `tasks` | `id`, `type text` (from a code registry, for example `confirmation.call`, `sync.write_back_failed`, `delivery.stalled`), `linked_type` enum (`order`, `customer`, `exchange`, `refund`, `shipment`, `settlement_line`, `settlement_statement`, `settlement_period`, `outbound_command`, `party`, `location`), `linked_id uuid`, `owner_user_id fk users null`, `owner_hat text null` (the hat whose queue holds it when nobody is assigned), `due_at timestamptz null`, `status` enum (`open`, `done`, `cancelled`), `outcome_code text null`, `note text null` (free text: personal data, redacted), `dedupe_key text null`, `created_by_type` enum (`person`, `system_job`), `created_by fk users null`, `closed_at null`, `closed_by fk users null`, `created_at`, `updated_at`, `operating_day date` (stamped from `created_at`) | check `owner_hat IS NULL OR owner_hat in ('support', 'operations', 'warehouse', 'manager')` (external hats never own a task, spec 0008 AC-17); check `outcome_code` set exactly when `status = 'done'`; partial unique (`tenant_id`, `dedupe_key`) where `status = 'open'` (one open task per cause); partial index (`owner_user_id`, `due_at`) where `status = 'open'`; partial index (`owner_hat`, `due_at`) where `status = 'open' and owner_user_id is null`; index (`linked_type`, `linked_id`); index (`operating_day`) |

- **The type registry** lives in code (`apps/api/src/tasks/task-types.ts`): each type names its default owner hat (an `InternalHat` from `packages/contracts`, spec 0008), its default due offset, and its allowed outcome codes. `type` is `text`, not a database enum, because nearly every later feature adds types; the tasks service rejects an unregistered type or an outcome code its type does not allow (`InvalidOutcome`). There is no workflow designer.
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
| blacklist import (feature 15) | `risk_flag`, source | the imported row's kind; source `blacklist_import` |
| return credit | total | `round(g × k / n, 2)`, or the line's remaining paid amount for the last units |
| return credit | split by funding | the line's credit share (back to the fundings its order's consumption drew), prepaid share (`prepaid_method`), and the rest (`payment_method`) |
| exchange | consumption | `max(0, min(balance, replacement total − prepaid))`, drawn `credit_only` first |
| exchange | balance due | replacement `cod_expected_amount` |
| exchange | leftover | balance after consumption; payout or kept by the customer's choice |
| refund payout | funding drawn | `payout_method`: `gateway_refund` from `gateway` only; `carrier_cash_refund` or `instapay_or_transfer` from `cod_cash` or `instapay_or_transfer` |
| debt payment | funding | the negative fundings it settles, oldest debt first |
| any credit entry | balance check | sum over the canonical customer's ids, in total and per funding, under the customer locks |
| open task | owner hat, due | the type registry, unless the caller passes them |
| close task | allowed outcome codes | the type registry |

## Critical test scenarios

- Normalization: `01001234567`, `٠١٠٠١٢٣٤٥٦٧` (Arabic Indic), `۰۱۰۰۱۲۳۴۵۶۷` (Eastern), `+20 100 123 4567`, `00201001234567`, `+2001001234567`, `201001234567`, `1001234567`, and `0010 0123 4567` with a right to left mark all give `+201001234567`; `0131234567` and `abc` raise `InvalidPhone`; `+971501234567` is `foreign`; `0223456789` is `landline`; `parse(parse(x).e164)` equals `parse(x)` for every row (round trip), verifies **AC-27**.
- The same phone on two Shopify stores' customers resolves to one customer with two external ids; a second customer with an existing phone fails the unique key; a risk flag without a source fails its check, verifies **AC-27**.
- Merges: `UPDATE` and `DELETE` on `customer_merges` fail; a second undo of one merge fails the unique key; an undo row without `undoes_merge_id` fails its check; `merged_into_id = id` fails, verifies **AC-28**, **AC-33**.
- (feature 14) Merge B into A, then C (with B already merged into it) into A: lookups by B's and C's phones land on A, A's id set has three ids; undo the second merge restores C and B's pointer to C; undoing the first while the second is live raises `MergeNotLatest`; no `orders` or `credit_entries` row changed, verifies **AC-28**.
- Credit arithmetic: a line of 2 at 999.99 credits 1 unit (500.00) then the other (499.99); a third unit raises `CreditExceedsLine`. A 500 credit and an 800 replacement give consumption 500 and balance due 300; an 800 credit and a 500 replacement give a leftover of 300; a balance of −200 gives consumption 0. A 1,200.00 COD line on an order that also used 300.00 of `credit_only` credit (line share 300.00) splits its return credit into 300.00 `credit_only` and 900.00 `cod_cash`. Consumption of 700 against 200 `credit_only` and 900 `cod_cash` draws 200 then 500. A customer at −300 `cod_cash` who pays 300 by InstaPay gets a 300 `debt_payment` funded `cod_cash`; a payment of 400 is refused, verifies **AC-24**.
- Table checks: a `return_credit` without a line fails; a negative `return_credit`, a positive `order_consumption`, a `goodwill` funded `cod_cash`, a `refund_payout` funded `credit_only`, and a `refund_payout` without a method each fail; a reversal of a `return_credit` with a negative amount passes (inverted sign); `UPDATE` fails; a reversal of a reversal fails, verifies **AC-24**, **AC-33**.
- (feature 28) The retention case: a 1,000 refund converted to 1,200 store credit (1,000 `cod_cash` return credit plus 200 `credit_only` bonus), a 1,200 order paid by that credit, then its return: a payout by InstaPay is capped at 1,000 and the 200 stays as credit; a payout of `gateway` funded credit by InstaPay is refused. Twenty parallel consumptions against a balance of 500 never take it below zero; an inspection reversal may take it to −500; a replayed key returns the stored entries, verifies **AC-24**.
- Tasks table: closing without an outcome fails the check; `owner_hat = 'partner'` fails the check; a second open task with one dedupe key fails the partial unique; a closed one does not block a new open one, verifies **AC-26**.
- (feature 17) An outcome not allowed for the type raises `InvalidOutcome`; opening twice with one dedupe key returns one task; My work for a person and for a hat reads through its partial index, verifies **AC-26**.
