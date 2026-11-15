# 0002. Build the core data model around an append only stock ledger with maintained balances

**Date**: 2026-11-02 (amended 2026-11-05)
**Status**: Accepted and built (amendment of 2026-11-05 for scope feature 4, built and closed 2026-11-06; the original decision was accepted and built)

## Summary

This spec fixes the data model every module builds on: products and their SKUs, locations and bins, parties (suppliers, factories, customers), and the stock ledger. Stock is never edited. Every change is a new movement row with its quantity, cost, and source document, and a balance table kept in the same transaction makes stock on hand instant to read at 100,000+ SKUs. This feature migrates the shared core and builds the inventory ledger service (the only code allowed to move stock). It adds no screens; feature 7 adds the first ones on top.

> Amended 2026-11-05: "100,000+ SKUs" is now 10,000 designed and 50,000 tested (Amendment A15); customers are no longer parties (A8); "feature 7" is the old scope's numbering (see the note under Requirements).

**Amendment 2026-11-05.** The product is now the back office behind Egyptian clothing brands on Shopify, Bosta cash on delivery, and consignment partners, so the model around the ledger grows. Every row gets a tenant id, migrations restart from one baseline, and the database stamps the Cairo operating day. Orders get a store, a channel, a source, a type, a parcel state machine, a money state machine, and one derived outcome; customers become a normalized phone; customer credit and settlement become append only records like stock; tasks, styles with seasonal cost, and locations with an owner type join the model. The ledger's locking, costing, and reconciliation rules do not change; it gains new source types, and opening stock always arrives with a cost (an owner estimate is allowed and labelled).

## Amendment 2026-11-05

### Why it changes

The product changed on 2026-11-05: it is now the order operations and warehouse back office for Egyptian clothing brands behind Shopify, Bosta cash on delivery, and consignment partners (final plan (kept private) sections 6 and 7). The owner chose to keep and amend the built code (spec 0007, Shape A). The ledger core above stays exactly as built and reviewed. What the original model lacks is everything around it that cash on delivery needs from the first migration: a tenant id on every row, stores and channels, orders with a fulfillment and a cash state machine, customers by phone, a customer credit ledger, one settlement primitive, one task primitive, styles with seasons and cost records, locations with an owner type, and the Cairo operating day. Spec 0007 names each of these for feature 4 (sections 1, 7, 8, 10, 11, *Database roles and the append only ledgers*, and carried B1, B2, m4).

### Design delta

Each item says what it adds or which original part it replaces. The detail lives in the child specs listed under `## Structure`.

- **A1 Tenant id on every row** (adds; amends every table and every unique key in the original sketch). `tenant_id` defaulting to `current_setting('ssd.tenant_id')::uuid`, an `install` row, unique business keys led by `tenant_id`, and a schema test. [Tenancy child](0002-tenancy-platform.md).
- **A2 One migration baseline** (replaces migrations `0000` to `0008` and the original build plan's single migration). Reset once as three files (hand written extensions, generated tables, hand written rules) so Drizzle never regenerates hand written SQL; recorded as ADR 0003, which freezes the baseline the day the pilot brand's first import runs; grants name the app role from `ssd.app_role`, so per client role names (spec 0007) need no migration change. [Tenancy child](0002-tenancy-platform.md#migration-baseline-and-the-app-role-name-a2).
- **A3 The operating day** (adds). `ssd_operating_day(timestamptz)` and a trigger that stamps `operating_day` on orders, order events, tasks, credit entries, ledger groups and movements, and audit entries. [Tenancy child](0002-tenancy-platform.md#the-operating-day-a3).
- **A4 The append only list** (extends the original *Key invariants* and *Security model*). Every table whose history must never change, with revokes and the shared trigger. [Tenancy child](0002-tenancy-platform.md#append-only-tables-a4).
- **A5 Table ownership** (extends the original module boundary rule from the ledger to every module). A table to module map and one boundary test. [Tenancy child](0002-tenancy-platform.md#module-ownership-of-tables-a5).
- **A6 Projections through in transaction domain events** (adds a rule; built by feature 16). [Tenancy child](0002-tenancy-platform.md#projections-and-domain-events-a6-decided-here-built-by-the-first-feature-that-needs-it).
- **A7 Stores, channels, connections, orders, two state machines, partial delivery, the outcome, order types, and sync state** (adds; replaces the original *Documents* paragraph's sales orders, shipments, and returns, and the `channel_mappings` sketch). Includes the amount the customer owes after a partial delivery (`cod_due_amount`), the allocation of prepayment and credit to lines, `lost`, and refusal reasons. [Orders child](0002-orders.md).
- **A8 Customers by normalized phone, many phones and channel ids, reversible merge** (adds; replaces the `is_customer` role on `parties`). [Customers child](0002-customers-credit-tasks.md#customers).
- **A9 The customer credit ledger** (adds). Every entry carries its funding, so credit that was never cash is never paid out and a refund goes back the way the customer paid. [Customers child](0002-customers-credit-tasks.md#customer-credit-ledger).
- **A10 The task primitive** (adds). [Customers child](0002-customers-credit-tasks.md#tasks).
- **A11 The settlement primitive** (adds). A line's period comes from its date; lines with no order are accounted to an account code; partner lines carry returns and retail figures. [Settlement child](0002-settlement.md).
- **A12 Style, season, product group, cost records, per order cost rules** (adds columns to `products`; adds tables). [Catalog child](0002-catalog-locations.md#catalog-style-season-product-group).
- **A13 Location owner type, fixed for life, and the policy table** (replaces `locations.type`; decides carried m4). [Catalog child](0002-catalog-locations.md#locations-and-the-owner-type-policy).
- **A14 Ledger changes** (replaces the original `source_type` list; keeps every costing rule, so opening stock needs a cost and restocks post at the shipment's cost). [Catalog child](0002-catalog-locations.md#stock-ledger-changes).
- **A15 Scale at 50,000 SKUs** (replaces AC-14's 100,000 SKU load and its test). [Catalog child](0002-catalog-locations.md#scale-suite-replaces-the-original-ac-14-load).

**Fix pass of 2026-11-05.** The domain review (`docs/reviews/domain-data-model.md`: 5 blockers, 10 majors, 12 minors), the gate review's six fixes and its round 2 rulings, and the owner's answers are applied in the children; `rationale.md` records the blocker decisions and the review map below says where each finding landed.

### What this feature builds, and what it leaves to the owning feature

This feature migrates every ★ table in the children with all its checks, indexes, and triggers; builds the pure rules other features reuse (`EgyptianPhone`, the two transition tables with `nextState` and `replayStates`, `deriveOrderOutcome`, the line split, the order amounts (allocation and `codDue`), the credit arithmetic, `lineMatchState`, `settlementPeriodStatus`, all in `packages/contracts`); and builds the few services that are the model's own integrity: `ssd_operating_day`, `CostService`, `CostRulesService`, `LocationPolicyService`, the ledger changes, the boundary tests, and the scale suite. The services that apply the other rules are the contract for their own features: orders 16, customers 14, tasks 17, credit 28, settlement 22, 23, and 43, connectors 13 and 19. No screens. Features 8 (roles as hats), 9 (settings, toggles, bundles), and 10 (audit trail) get their own specs: this spec names their tables only for foreign keys and the append only list (`audit_entries` is append only); detail in feature 8, 9, and 10.

### New requirements

**User stories**:
- As an operations agent, I want every order to show its store, channel, source, and both its parcel state and its money state, so I know what to do next without opening Shopify or Bosta.
- As an owner, I want one outcome per order computed the same way everywhere, so return rates and margins never contradict each other.
- As a support agent, I want one customer per person however her phone was typed, with merges I can undo, so I see her whole history.
- As an accountant, I want customer credit, carrier cash, and partner sell through as append only records matched line by line, so every pound can be traced and nothing is silently changed.
- As a manager, I want cost per style and season and the per order costs, with "not set" shown where they are missing, so margin is honest.
- As a developer, I want the tenant id, the operating day, and the append only rule enforced by the database, so no writer can forget them.

**Acceptance criteria** (continuing the original numbering):
- **AC-15**: Every table outside the `pgboss` and `drizzle` schemas (except the one row `install` table, whose id is the tenant id) has `tenant_id uuid not null` defaulting to `current_setting('ssd.tenant_id')::uuid`; an insert that omits it gets the install's id, and an insert in a session without the setting fails. Every primary key, unique constraint, or unique index containing a non uuid column includes `tenant_id`. A schema test fails on a table or key that breaks either rule.
- **AC-16**: An empty database reaches the full model through one baseline of three migrations (hand written extensions, generated tables, hand written rules). The first `migrate` sets `ssd.tenant_id` (from `TENANT_ID`, else a generated id) and `ssd.app_role` (from `APP_DB_ROLE`, default `ssdashboard_app`) on the database and writes the `install` row; a rerun changes nothing; a `TENANT_ID` different from the install row stops `migrate` with `TenantMismatch`. Every suite that passed before the reset passes after it with no change in behavior.
- **AC-17**: `ssd_operating_day(t)` returns the local date of `t` in the `timezone` setting, shifted back by `operating_day_cutoff_hour`; every `operating_day` column is set by trigger from its source time and never by a writer; the result is right one second before, at, and after each Cairo offset change of the current year found in the database's own time zone data, and at local midnight.
- **AC-18**: Order number is unique per (`tenant_id`, `store_id`), so two stores may both hold `#1001`; every order has a store, a channel, a type, its discount code when the channel gives one, and source columns (`source_captured_from = 'none'` when nothing is known); a Shopify connection belongs to exactly one store and a store has at most one Shopify connection; a carrier connection has zero or one store binding (B1); `connections.provider` already has `gateway`.
- **AC-19**: Fulfillment moves only along the transition table in the orders child (with `cancelled` and `lost` added); `nextState` raises `InvalidTransition` for any other pair; a refusal carries a reason code; carrier reports are facts that are always accepted (opening a task where they skip or contradict a step, or arrive while a write back is open); `confirmed` to `packed` is refused while a write back is open; edits lock once a carrier delivery exists; `replayStates` over an order's events reproduces its states.
- **AC-20**: Cash moves only along its transition table (`unpaid`, `collected_by_carrier`, `remitted`, `reconciled`, plus `prepaid` and `nothing_to_collect`); a collected amount below the expected amount is allowed (partial), and a person may record it from the courier's note with a reason; `remitted` needs deposit evidence; corrections step back only with a reason; the carrier's COD fee and shipping fee are never netted into the order's cash amounts but are settlement lines of their own.
- **AC-21**: A partial delivery of `d` of a line's `q` units keeps the original row at `d` delivered and inserts one `returned_to_origin` row of `r = q − d` with `split_from_line_id` and the same frozen unit cost; gross, net, discount, prepaid share, and credit share on the new row are each `round(original × r / q, 2)` and its tax is gross minus net; the original keeps the rest, `lines_gross_amount` and `total_amount` do not change, and a line of one unit cannot split. `cod_due_amount` (open, delivered, and returned lines net of their prepaid and credit shares, plus the whole net shipping while any such line remains, never below 0) drops by the returned row, and reconciliation compares collected cash with it, never with `cod_expected_amount`. Cancelled lines are not in `lines_gross_amount`. Prepayment and credit are allocated to lines and shipping by gross share, shipping taking the rest; at the cent boundary no share leaves its row's room ([orders child](0002-orders.md#money-on-the-order-allocation-expected-and-due)).
- **AC-22**: `deriveOrderOutcome` is the only computation of the outcome; given the fulfillment state, the delivered amount (gross of `delivered` and `returned` lines), and the refunded amount (`returned_credit_amount − exchange_consumed_amount`, not below 0) it returns `kept`, `cancelled_before_shipping`, `failed_delivery`, `refunded`, `partially_refunded`, or `open` exactly as the orders child's table says; a refund only return after delivery leaves the fulfillment state `delivered`; `orders.outcome` is never written except from it.
- **AC-23**: An order's type is `sale`, `exchange_replacement` (which requires `original_order_id`), or `gifted` (which requires a gift reason and `total_amount = 0`, so no COD can be asked even for shipping, and starts `nothing_to_collect`); a gifted line may keep its retail price with an equal discount; gifted orders are identifiable by type, so revenue and return rates exclude them and their shipment cost and carrier fees class as marketing cost.
- **AC-24**: `credit_entries` is append only, with a signed amount whose sign matches its kind (inverted on a reversal), a funding (`cod_cash`, `gateway`, `instapay_or_transfer`, `credit_only`), a reason, an actor, and an idempotency key per posting; a reversal points at its original once and cannot itself be reversed. Retention bonus and goodwill are `credit_only`; a payout names its method and draws only from a matching funding (`gateway` back to the gateway only; `cod_cash` and `instapay_or_transfer` as Bosta cash, InstaPay, or transfer); `credit_only` is never paid out. The credit arithmetic gives a return credit of `round(g × k / n, 2)` of the price actually paid, the last units taking exactly the rest, split by funding from the line's prepaid and credit shares; the consumption `max(0, min(balance, order total − prepaid))`, spending `credit_only` first; the balance due as the replacement's COD amount; and the leftover. A customer's debt is a negative balance paid by a `debt_payment`, never added to a COD. Credit applied to lines that never reach the customer comes back as a `consumption_release`, which never counts as refunded. (Feature 28 proves the locked balance rules: no consumption or payout below zero, safe under concurrency.)
- **AC-25**: A settlement account has one owner type (`carrier`, `consignment_partner`, `gateway`) and the matching owner reference; one account's periods never overlap and a closed period's dates cannot change; a line's period is derived from its `occurred_on`, never stored; statements (with their covered days), lines, match rows, and period events are append only; a line's external reference is unique within its statement; a line with no order or variant reaches a terminal `accounted` result with an account code; an unmatched match row requires a reason; a line's state is the head of its match chain and a period's status is its latest event, which the stored `status` always follows (pure functions rebuild both); revoking a close requires a reason; nothing is deleted.
- **AC-26**: A task has a type, a linked record, an owner (a person, or one of the four internal hats, enforced by a check), an optional due time, a status, and an outcome code that is set exactly when it is done; at most one open task exists per dedupe key; open tasks are found by person and by hat through partial indexes.
- **AC-27**: `EgyptianPhone.parse` turns Arabic Indic and Eastern Arabic Indic digits, spaces, punctuation, and direction marks, and the forms `010…`, `10…`, `0020…`, `+20…`, `+2001…`, `20…`, and the doubled zero `0010…` into one `+201…` value, accepts landlines and foreign numbers with their kind, and rejects anything else with `InvalidPhone`; a normalized phone belongs to one customer per tenant; a customer holds many phones, many external ids (each unique within its connection or channel), and at most one risk flag with its kind and source; an order keeps a second phone and, when the phone does not parse, the raw text; customer names, phones, ship to fields, and free text notes are on the redaction list.
- **AC-28**: A merge is an append only `customer_merges` row; it sets the merged customer's `merged_into_id` and moves any chain pointing at it, recording what it moved, so an undo row restores exactly the prior pointers and undoes a merge at most once; no other module's rows change. (Feature 14 proves resolution, chains, and `MergeNotLatest`.)
- **AC-29**: A location has an `owner_type` (`own`, `consignment_partner`, `wholesale_customer`), a party exactly when not own, `is_sellable`, and `sellable_online`; owner type and party never change after creation; `sellable_online` is refused where the policy forbids it; archiving a location with stock or an active reservation is refused; every owner type question is answered by `LocationPolicyService` from `location_owner_policies`; a boundary test fails on an owner type comparison anywhere else; the three way test passes for all three types with only the location changed.
- **AC-30**: A product is a style with a style code unique per tenant, an optional season, and a required product group; a `CORE` season is seeded; `cost_records` are append only and require a season; `CostService.costFor(variant, day)` takes the record with the latest effective date on or before the day, a variant override winning a tie, then the latest recorded, returns its cost basis so an `estimate` is labelled "estimate", and returns `NotSet` when none exists; a later record never changes a cost already on a movement.
- **AC-31**: Opening stock always carries a cost: every inbound ledger line still needs a `unitCost` (the original AC-3, unchanged), and the onboarding import refuses to post while any style lacks a cost record, listing those styles; an owner `estimate` record is accepted. A restock of a returned piece posts at the order line's frozen shipment unit cost, never 0 and never the current average.
- **AC-32**: `order_cost_rules` holds the COD fee percent, gateway fee percent, packaging per order, and unrestockable returned to origin percent, each `set` with a value or `not_set` without one, effective dated and append only, seeded `not_set` on a new install; `CostRulesService.ruleFor` returns `not_set`, never 0, when no rule is set.
- **AC-33**: For every table in the append only list (tenancy child, A4, including `licenses` and `license_checks` from spec 0009 and `audit_entries` from spec 0010) the app role's `UPDATE`, `DELETE`, and `TRUNCATE` fail with permission denied, and the owner's fail with "append only".
- **AC-34**: Every table is in the ownership map; a file in one api module that names another module's table, or an extension that names a core table, fails the boundary test.
- **AC-35**: `outbound_commands` holds each write back's `sync_state` (`waiting`, `synced`, `failed`, `resolved`) with its linked record, failure reason, and resolution, as the single truth; `orders.write_back_state` is the orders module's projection of it, indexed for the confirmation queue and the pick list (B2).
- **AC-36**: With 50,000 variants, 500,000 movements, 150,000 orders, and the related customers, events, settlement lines, tasks, and credit entries loaded, every budget in the catalog child's scale table holds at the 95th percentile on the dev Postgres, and every foreign key column has an index (replaces AC-14). The suite runs as its own CI job (nightly and on a `scale` label), never in the default e2e job. Amended 2026-11-08: the nightly schedule was dropped (GitHub Actions billing; CI moved to a self-hosted runner); the scale suite runs by hand (workflow_dispatch) and on PRs labelled `scale`.

### Security model (amendment)

- **Personal data grows**: customer names, phones, external ids, order ship to fields, and the free text fields where agents type phones and addresses are personal data under Law 151. The build adds `name`, `phone_e164`, `ship_to_name`, `ship_to_phone`, `ship_to_phone_alt`, `contact_phone_raw`, `ship_to_address`, `courier_note`, `note`, `risk_flag_note`, `reason` (on `customer_merges`), and `payload` (on `outbound_commands`) to the redaction list in `packages/config/src/redaction.ts`, and the redaction test covers them with the tables' real row shapes, bare and nested (AGENTS.md, personal data rule; domain review m9). *Built 2026-11-06:* a bare `name`, `reason`, or `payload` is not a global key, because products, staff, and operational log lines (lockout and void reasons) carry them; instead a key only one table's row has marks the row (for example `mergedIntoId` or `riskFlagSource` a customer, `survivorId` or `undoesMergeId` a merge, `idempotencyKey` with `linkedType` an outbound command), and the marked row's `name`, `reason`, `payload`, or `failureReason` is redacted (security-data-model-m3 (kept private) MJ1). Milestone 4 adds `partner_text` and `payment_reference` (settlement lines and match rows) as keys and a period event row marker for its `reason` (security-data-model-m4 (kept private) m6).
- **Cost stays private**: `cost_records`, `order_cost_rules`, `order_lines.unit_cost`, and margin are hidden without the `cost.view` grant (spec 0008 AC-6); the media buyer hat never reads customer tables (feature 8).
- **Partner scoping**: partner reads (feature 41) filter settlement accounts and locations by the session's party, never by a request parameter (spec 0007 section 2).
- **Roles**: the append only revokes and the grants follow the role named by `ssd.app_role` (A2).
- **Free text on append only rows (gate ruling, security S4)**: `customer_merges.reason` and `settlement_period_events.reason` hold codes only; a written note goes in the spec 0010 audit entry `reason`, which is trimmed, capped at 500 characters, and phone masked ([spec 0010](../0010-audit-trail/index.md) AC-5). `settlement_lines.partner_text` and `settlement_line_matches.payment_reference` are third party evidence kept by contract, and are on the redaction list for logs (`packages/config/src/redaction.ts`). Both are capped at 500 characters by database checks and the contracts.
  > Amended 2026-11-07 (spec 0010 security review AS13, gate ruling): the written note no longer goes in the audit entry `reason` for customer facing record types (`customer`, `order`, `exchange`, `outbound_command`); those entries keep a reason code only, and a typed explanation lives in the owning module's own note row, which can be edited and erased. See [spec 0010](../0010-audit-trail/index.md) AC-5.

### Configuration (amendment)

- `TENANT_ID` (from spec 0007) and `APP_DB_ROLE` (new, default `ssdashboard_app`): read by `migrate` only. See the [tenancy child](0002-tenancy-platform.md#configuration).
- Reserved setting (feature 9 owns its screen): `operating_day_cutoff_hour` (default 0). The `location_owner_policies` rows and the `order_cost_rules` rows are data, seeded by the baseline and by `migrate`.

### Domain review map (fix pass of 2026-11-05)

Where each finding of `docs/reviews/domain-data-model.md` landed. "Carried" means a named requirement of a later feature, listed again under `## Follow-up`.

| Finding | Where it is fixed or carried |
|---|---|
| B1 credit funding | [Credit ledger](0002-customers-credit-tasks.md#customer-credit-ledger): `funding` on every entry, payout matching, `credit_only` never paid out, consumption `credit_only` first; allocation of prepaid and credit to lines and shipping in the [orders child](0002-orders.md#money-on-the-order-allocation-expected-and-due); owner question 13 (decided) |
| B2 COD after a partial delivery | [Orders child](0002-orders.md#money-on-the-order-allocation-expected-and-due): `cod_due_amount`, cancelled lines out of `lines_gross_amount`, reconciliation against the due amount |
| B3 `period_id` on append only lines | [Settlement child](0002-settlement.md#rules): the column is gone from lines and statements; the period comes from `occurred_on` |
| B4 lines with no order | [Settlement child](0002-settlement.md#rules): terminal `accounted` result with an account code; `cleared` only for superseded statements |
| B5 opening stock at cost 0 | [Catalog child](0002-catalog-locations.md#stock-ledger-changes): opening stock needs a cost record (owner estimate allowed, labelled), the import stops on uncosted styles, restocks post at the shipment's cost; unknown cost units carried to feature 59 (gate review round 2 reversed the earlier ledger change) |
| M1 delivered amount | [Orders child](0002-orders.md#the-derived-outcome): `delivered` plus `returned` lines |
| M2 old piece never collected, reversal sign | [Credit ledger](0002-customers-credit-tasks.md#customer-credit-ledger): kind `return_not_collected`; sign check inverted on reversals |
| M3 lost parcel | [Orders child](0002-orders.md#fulfillment-state-machine): state `lost`, outcome `failed_delivery`; settlement kind `compensation`; Bosta's mapping carried to feature 19, compensation terms to features 19 and 22 |
| M4 refusal with a size request | [Orders child](0002-orders.md#fulfillment-state-machine): `refused_reason_code`, the replacement linked like any exchange; counting it as an exchange carried to feature 24 |
| M5 mirror mode edit lock | [Orders child](0002-orders.md#edits-until-the-carrier-delivery-exists-and-outbound-sync-b2): edits lock at `carrier_delivery_created_at`; a task on a carrier delivery while a write back is open; the delivery COD check (against `cod_expected_amount`, re-review n1) carried to feature 19 |
| M6 partner returns and retail figures | [Settlement child](0002-settlement.md#tables): `consignment_return` and the partner columns; the debt basis (consignment price or commission) carried to features 41 and 43 |
| M7 statement and count | [Settlement child](0002-settlement.md#rules): a count is evidence, payable only when the partner reports nothing; built by features 42 and 43 |
| M8 corrected files and coverage | [Settlement child](0002-settlement.md#tables): dedupe per statement, `covers_from` and `covers_to`; cross statement duplicates by content carried to features 22 and 42 |
| M9 imported refunds, opening credit | [Credit ledger](0002-customers-credit-tasks.md#customer-credit-ledger): import actor and kind `opening_balance`; carried to feature 15 |
| M10 missing question, question 6 | `## Questions for the owner`: question 13 added and decided; question 6 answered by the owner |
| m1, m2, m3, m4, m6, m7, m10, m11 | [Orders child](0002-orders.md#tables): `related_order_id`, line `cancel_reason_code`, split copies `unit_cost`, a person may record a collection, gifted gross 0 with retail price kept, `shipping_tax_amount`, `contact_phone_raw`, `ship_to_area_list` |
| m5, m8 | [Customers child](0002-customers-credit-tasks.md): consumption clamped at 0 and the inspection timing rule; risk flag with a kind |
| m9 | *Security model (amendment)*: free text fields on the redaction list |
| n1 to n4 (re-review) | n1: the feature 19 COD check compares with `cod_expected_amount` ([orders child](0002-orders.md#edits-until-the-carrier-delivery-exists-and-outbound-sync-b2)); n2: a closed period's dates are fixed by trigger ([settlement child](0002-settlement.md#tables)); n3: credit kind `consumption_release` ([credit ledger](0002-customers-credit-tasks.md#customer-credit-ledger)); n4: the stale feature 59 Follow-up line voided |
| m12 | [Settlement child](0002-settlement.md#rules): `occurred_on` defined, deposit evidence for `remitted`, `opening_package_fee` and `other_fee`; task links to periods, statements, parties, and locations |

## Structure

The amendment's detail, one child spec per area. Each is complete enough to build from; the cross child contract is the AC list above and the ownership map in the tenancy child.

- [0002-tenancy-platform.md](0002-tenancy-platform.md): tenant id, the migration baseline and the app role name, the operating day, the append only list, table ownership, and the domain event rule (A1 to A6; AC-15 to AC-17, AC-33, AC-34).
- [0002-orders.md](0002-orders.md): stores, channels, connections, outbound sync state, orders and lines, both state machines, partial delivery, the outcome, order types (A7; AC-18 to AC-23, AC-35).
- [0002-customers-credit-tasks.md](0002-customers-credit-tasks.md): customers by phone and merge, the customer credit ledger, tasks (A8 to A10; AC-24, AC-26 to AC-28).
- [0002-settlement.md](0002-settlement.md): settlement accounts, periods, statements, lines, matching, and period close (A11; AC-25).
- [0002-catalog-locations.md](0002-catalog-locations.md): style, season, product group, cost records, per order cost rules, location owner type and policy, ledger changes, and the scale suite (A12 to A15; AC-29 to AC-32, AC-36).

## Questions for the owner

Every question is now answered by the owner or decided. "Decided" means the gate review (Fable, 2026-11-05) kept the recommended default and the owner can change it later; the "if changed" line says what moves then. Source: the wave 4 data model notes, "Fable reply", "Owner answers", and "Fable reply, round 2".

1. **Outcome of a partial delivery.** *Decided:* `kept`; the returned rows show in the returned to origin rate by line, and the metric dictionary (feature 24) counts partial returns at line level, never from the outcome alone. If changed: an outcome value such as `partially_delivered`, and feature 24 changes.
2. **Outcome of an exchange.** *Decided:* an exchange for something of equal or higher price is `kept`; one for something cheaper (difference refunded or kept as credit) is `partially_refunded`, by "returned credit minus credit spent on the replacement". Feature 24 separates cash refunded from store credit outstanding (a liability, not a refund). If changed: an `exchanged` outcome or another rule.
3. **Shipping on a return.** *Answered by the owner:* shipping is credited only when the reason is the brand's fault (damaged, wrong item), never for a change of mind, as a separate `shipping_credit`; feature 31 makes it a rule per return reason with that default, so a brand can change it without code. Whether Law 181 of 2018 requires refunding delivery cost for a change of mind is for counsel (feature 30).
4. **Store credit expiry.** *Decided:* no expiry in version one; adding `expires_at` later is a forward migration. If changed: an expiry date per entry, an expiry kind, a job, and a line in the return terms (feature 30).
5. **Customer owes.** *Decided:* flagged on the customer header and the confirmation queue row, never blocked. *Owner answer on collecting it:* the debt is chased separately by InstaPay or transfer, never added to the next order's COD; it stays a negative balance with the flag, and a payment against it is a `debt_payment` credit entry with a cash funding. If blocking is wanted: a hold state and an override permission in feature 18.
6. **Opening stock without cost.** *Answered by the owner (2026-11-05, round 2):* opening stock needs a cost record; an owner estimate is allowed and labelled "estimate". The onboarding import stops with the list of uncosted styles until each has a factory, landed, or estimate record. Tracking unknown cost units on the balance is carried to feature 59.
7. **Season on a cost record.** *Answered by the owner:* a season is required on every cost record, with a seeded `CORE` season for carry over basics.
8. **Who may create a gifted order.** *Decided:* the manager hat only (spec 0008); a media buyer asks the manager. If changed: a gift permission on other hats.
9. **Prepaid orders before gateway settlement exists.** *Decided:* a gateway paid order is final at `prepaid` for slice 1; reports show it as paid, not reconciled. If changed: gateway settlement moves into slice 1.
10. **One phone, one customer.** *Decided:* yes; the phone is the unit of trust and credit, the order keeps its own `ship_to_name`, and a risk flag covers the household on that phone. If changed: phones stop being unique per tenant (reversing spec 0007 section 7).
11. **When the operating day ends.** *Decided:* midnight Cairo time, so campaign profit lines up with Meta and Shopify calendar days. If changed: set `operating_day_cutoff_hour`; no code change.
12. **Per order cost rules per store.** *Decided:* one set per brand (Bosta and gateway fees are per account, not per store). If changed: a per account or per store key on `order_cost_rules`.
13. **Is store credit ever paid out as cash, and by which method?** *Decided (the owner's recorded rule, "refunded the same way they paid"; gate review round 2):* every credit entry carries a funding; retention bonus and goodwill are `credit_only` and never paid out; `gateway` funding goes back to the gateway only; `cod_cash` and `instapay_or_transfer` funding may be paid as a Bosta cash refund, InstaPay, or bank transfer; spending credit uses `credit_only` first. If changed: the payout matching table in the [credit ledger](0002-customers-credit-tasks.md#customer-credit-ledger) changes; the columns stay.

Owner answers to the reviewer's real brand questions, applied: full shipping is charged on any partial delivery (`cod_due_amount` keeps the whole shipping); kept credit is spent on orders an agent creates now, and a Shopify gift card or discount code for it is a later toggle (Follow-up, features 28 and 37); debt as in question 5; a second phone is stored on the order (`ship_to_phone_alt`).


## Requirements

> Amended 2026-11-05: feature numbers in the original text below (for example features 6, 7, 8, 13, 14, 20, 22, 25, 26, 29, 34, 46) refer to the scope before 2026-11-05 and no longer match `docs/scope`; the amendment uses the current numbers. AC-14 is replaced by AC-36, and AC-15 onward are in the amendment above.

**User stories**:
- As a warehouse manager, I want stock on hand per SKU, location, bin, and lot to always match the recorded movements, so I can trust the numbers.
- As an accountant, I want every stock movement to carry its cost, effective date, and source document, so the accounting export and stock valuation are exact.
- As a developer on any module, I want one ledger service that enforces every stock rule, so no module can corrupt stock by writing tables directly.
- As an owner, I want closed months to stay closed and document numbers to have no gaps, so audits and the accounting app line up.

**Acceptance criteria**:
- **AC-1**: For every (SKU, location, bin, lot), `stock_levels.on_hand` equals the sum of `stock_movements.quantity`, and `stock_levels.total_value` equals the sum of `total_cost`. A rebuild from movements reproduces both exactly.
- **AC-2**: The application's database role can never update, delete, or truncate a movement row: it holds only INSERT and SELECT on the ledger history tables, and a trigger rejects the same statements as a second guard. A correction is a reversal posting that writes new rows with opposite quantities and links back to the original group. Each reversal row is costed by the ledger's normal rules for its direction at the original unit cost, and any gap to the original cost is stored as `cost_variance`, so a balance's value never takes the wrong sign.
- **AC-3**: Every movement carries a non zero signed whole number quantity in the SKU's base unit, a unit cost (4 decimals), a total cost (2 decimals, EGP), an effective date, a recorded time, a source type and source id (and source line id when the source has lines), and the user who posted it (when signed in users exist).
  > Amended 2026-11-05: unchanged; opening stock also needs a cost (AC-31).
- **AC-4**: An outbound posting that would take a balance below zero is rejected, unless the location has `allow_negative` on. An outbound line that fulfils no reservation may not take on hand (summed over bins for that SKU, location, and lot) below the active reserved quantity. Two postings on the same balance at the same moment are applied one after the other, never losing an update, and postings touching the same balances in opposite orders never deadlock.
  > Amended 2026-11-07 by spec 0011: two named exceptions to the reserved stock rule: a carrier fact shipment (`postCarrierShipment`) is never refused for stock and may go below zero, and a `damaged` or `missing` adjustment may take on hand below reserved; after either, the newest reservations are shortened and announced ([spec 0011](../0011-stock-ledger-locations/index.md) AC-22, AC-23).
- **AC-5**: Posting twice with the same idempotency key moves stock once and returns the first posting's result, rebuilt from the stored group and movements, without checking stock or the lock date again. The same key with different content (or used for a reversal and a posting) is rejected.
- **AC-6**: A posting's effective date may be in the past but not in the future (beyond a 5 minute clock tolerance), and its operating day (stamped by `ssd_operating_day`, so the cutoff hour counts) must be after the inventory lock date (gate ruling 2026-11-06, review R5). When none is given, it defaults to now. A reversal follows the same rule, so reversing a movement from a locked month means passing a current date.
- **AC-7**: A posting with several lines (for example a transfer: out of one location, into another) is atomic. Either every line and balance change lands, or none does.
- **AC-8**: For a lot tracked SKU every movement names a lot of that same SKU. For a serial tracked SKU every movement lists exactly as many serials as the absolute quantity; a serial must be in stock at that location (and bin) to leave it, and must not be in stock anywhere to arrive (a new serial is created, a returned one flips back to in stock). Service and bundle SKUs, and archived SKUs, locations, and bins, cannot be posted or reserved.
- **AC-9**: Available stock per SKU, location, and lot equals on hand (summed over sellable bins, in a sellable location) minus active reservations. A reservation larger than available is rejected (unless the location allows negative stock). Partial release or fulfilment reduces the reservation's open quantity in place; it closes when that reaches zero.
- **AC-10**: Document numbers are issued per document type and year with the install's prefix (for example `PO-2026-000123`, at least 6 digits), with no gaps and no duplicates, even under concurrent requests and rolled back transactions. The full number is stored, so a later prefix change never rewrites an old one.
- **AC-11**: The nightly reconciliation compares every balance with its movements in one consistent snapshot (on hand and value), compares reservation totals, and for serial SKUs compares in stock serial counts with on hand. It records each mismatch with expected and actual values, at most one open record per balance. An admin approved rebuild recomputes that balance and is recorded with who and when. Movements are never touched.
- **AC-12**: Line amounts follow one rule everywhere: totals in EGP at 2 decimals rounded half away from zero, unit cost at 4 decimals. A balance's stock value is exact: an outbound takes `round(total_value × qty / on_hand, 2)`, and the outbound that empties a balance takes exactly the remaining value, so an empty balance always holds 0.00 and a value never has the opposite sign to its on hand. Shares are computed in exact `numeric` and rounded once. An inbound into a negative balance mirrors this: the units that fill the shortfall take its own value (proportionally, or exactly the rest when the line reaches zero), only the units beyond zero cost at the receipt price, and the difference from the receipt price is stored on the movement as `cost_variance`. With VAT inclusive prices, net = gross / (1 + rate), rounded, and tax = gross minus net. With VAT exclusive prices, tax = net times rate, rounded, and gross = net plus tax.
- **AC-13**: A product, SKU, location, bin, or party that any other row references cannot be deleted, only archived. An unreferenced one can be deleted.
- **AC-14**: With 100,000 SKUs and 1,000,000 movements loaded, reading on hand and available for one SKU across all locations takes under 50 ms at the 95th percentile, and posting a single line takes under 50 ms at the 95th percentile, on the dev Postgres.
  > Amended 2026-11-05: replaced by AC-36 (50,000 SKUs, spec 0007 section 11).

## Decision

**Chosen option**: Option 1: append only ledger plus a balance table maintained in the same transaction.

Stock truth lives in immutable `stock_movements` (one signed row per place, grouped per posting). `stock_levels` holds the running balance per (SKU, location, bin, lot), updated under a row lock by the inventory ledger service, the only writer of both tables. A nightly job proves balances match movements.

**Amendment 2026-11-05**: this decision stands unchanged; the amendment adds the model around the ledger (see `## Amendment 2026-11-05`).

**Implementation skills**: `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Conventions every table follows

> Amended 2026-11-05: every table also carries `tenant_id` and every unique business key includes it (Amendment A1), and every table has one owning module (A5).

- **Primary keys**: `uuid` defaulting to `uuidv7()` (PostgreSQL 18 built in, ordered by time so big indexes stay fast).
- **Money**: one currency per install, EGP, stored as a setting. No currency columns. Amounts are `numeric(14,2)`, unit costs `numeric(14,4)`, tax rates `numeric(5,2)` (14.00 means 14%).
- **Quantity**: `integer`, whole units in the SKU's base unit, signed on movements. This matches Shopify, which stores whole number quantities.
- **Bilingual text**: `jsonb` shaped `{ "en": string, "ar": string }`. At least one language is required, enforced by the Zod contract. A third language is a new key, not a migration.
- **Custom fields**: `custom_fields jsonb not null default '{}'` on products, variants, and parties, checked against `custom_field_definitions` (validation is built by feature 46; this feature only adds the columns and the table).
- **Timestamps**: `created_at` and `updated_at` as `timestamptz` on every mutable table. Master data gets `archived_at timestamptz null`. Foreign keys are `ON DELETE RESTRICT` (this is what blocks deleting referenced rows, AC-13).
- **Users**: `created_by` / `posted_by` are `uuid null` without a foreign key until feature 6 adds the users table, then a migration adds the key.
  > Amended 2026-11-05: already out of date before the amendment; `posted_by` got its key to `users` in migration `0007_ledger_posted_by_user_fk` (spec 0005), and the baseline (A2) keeps it.
- **Enums**: PostgreSQL enums (adding a value later is a safe, forward only migration).

### Data model sketch

★ = migrated in this feature. ○ = designed here, built by the named feature without a breaking change.

> Amended 2026-11-05: every table below gains `tenant_id`, and each unique key listed is now led by it (A1). Rows changed beyond that carry a note under their table; the new tables are in the child specs (`## Structure`).

**Platform**

| Table | Fields | Constraints |
|---|---|---|
| ★ `settings` | `key text pk`, `value jsonb`, `updated_at`, `updated_by` | Seeded: `currency = "EGP"`, `timezone = "Africa/Cairo"`, `prices_include_vat = true`, `inventory_lock_date = null`, `document_prefixes = {"PO": "PO", ...}` |
| ★ `document_counters` | `doc_type text`, `year int`, `last_value int not null` | pk (`doc_type`, `year`); a row is created on the first number of a year |
| ★ `custom_field_definitions` | `id`, `entity text` (product, variant, party), `key text`, `type` (text, number, boolean, date, select), `label jsonb`, `required bool`, `options jsonb null`, `archived_at` | unique (`entity`, `key`) |
| ○ `channel_mappings` (feature 29) | `id`, `entity text`, `local_id uuid`, `channel text`, `external_id text`, `synced_at` | unique (`channel`, `entity`, `external_id`), unique (`channel`, `entity`, `local_id`) |

> Amended 2026-11-05: `channel_mappings` is replaced by `channel_codes` (feature 40) and `connection_external_ids` (feature 13), see the [orders child](0002-orders.md); `settings` and `document_counters` keys include `tenant_id`; `install` and `order_cost_rules` are new ([tenancy child](0002-tenancy-platform.md), [catalog child](0002-catalog-locations.md#per-order-cost-rules)).

**Catalog**

| Table | Fields | Constraints |
|---|---|---|
| ★ `uoms` | `id`, `code text` (pc, box, kg), `name jsonb` | unique `code` |
| ★ `products` | `id`, `name jsonb`, `description jsonb null`, `status` (draft, active, archived), `brand text null`, `product_type text null`, `tags text[] default '{}'`, `custom_fields`, timestamps, `archived_at` | GIN index on `tags` |
| ★ `product_options` | `id`, `product_id fk`, `name jsonb` (Size), `position int`, `values jsonb` (ordered list of `{en, ar}`) | unique (`product_id`, `position`) |
| ★ `product_variants` (the SKU) | `id`, `product_id fk`, `sku text`, `option_values jsonb` (option position to value index), `kind` (stocked, service, bundle), `tracking` (none, lot, serial), `base_uom_id fk`, `price numeric(14,2) null`, `compare_at_price numeric(14,2) null`, `weight_grams int null`, `length_mm`, `width_mm`, `height_mm int null`, `hs_code text null`, `country_of_origin char(2) null`, `requires_shipping bool default true`, `custom_fields`, timestamps, `archived_at` | unique `sku`; check: `tracking = 'none'` unless `kind = 'stocked'` |
| ★ `variant_uom_conversions` | `variant_id fk`, `uom_id fk`, `factor int` (base units per one of this unit, > 1) | pk (`variant_id`, `uom_id`) |
| ★ `barcodes` | `id`, `variant_id fk`, `uom_id fk` (which pack it scans as), `code text` | unique `code` |
| ○ `categories`, `product_images` (feature 8) | category tree, ordered images per product with an optional variant | |

> Amended 2026-11-05: a product is a style and gains `style_code`, `season_id`, and `product_group_id`; `sku` and barcode `code` are unique per tenant; `seasons`, `product_groups`, and `cost_records` are new (A12, [catalog child](0002-catalog-locations.md#catalog-style-season-product-group)).

**Locations and parties**

| Table | Fields | Constraints |
|---|---|---|
| ★ `locations` | `id`, `code text`, `name jsonb`, `type` (warehouse, showroom, transit, virtual), `is_sellable bool default true`, `allow_negative bool default false`, timestamps, `archived_at` | unique `code`. Seeded: one `transit` location and one `virtual` scrap location |
| ★ `bins` | `id`, `location_id fk`, `parent_id fk null` (self), `level` (zone, aisle, shelf, bin), `code text`, `is_sellable bool default true`, timestamps, `archived_at` | unique (`location_id`, `code`); unique (`id`, `location_id`) for the composite key below |
| ★ `parties` | `id`, `code text`, `name text`, `name_ar text null`, `tax_id text null`, `is_supplier`, `is_customer`, `is_factory bool`, `contact jsonb` (phone, email), `custom_fields`, timestamps, `archived_at` | unique `code`; check: at least one role is true |
| ○ `party_addresses`, `party_contacts` (feature 20) | | N:1 party |

> Amended 2026-11-05: `locations.type` and its values are replaced by `kind`, `owner_type`, `party_id`, and `sellable_online`, and the seeds are `TRANSIT` (kind `transit`) and `SCRAP` (kind `virtual`), both own (A13); `parties.is_customer` is replaced by the customer tables (A8), and parties gain the consignment partner and wholesale customer roles; `party_addresses` and `party_contacts` wait for suppliers in slice 4.

**Stock ledger**

| Table | Fields | Constraints |
|---|---|---|
| ★ `lots` | `id`, `variant_id fk`, `code text`, `expires_on date null`, `created_at` | unique (`variant_id`, `code`); unique (`id`, `variant_id`) |
| ★ `serials` | `id`, `variant_id fk`, `serial text`, `lot_id null`, `status` (in_stock, out), `location_id fk null`, `bin_id null`, `updated_at` | unique (`variant_id`, `serial`); check: `location_id` is set exactly when `status = 'in_stock'` |
| ★ `movement_groups` (one per posting) | `id`, `idempotency_key text`, `request_hash text`, `source_type` enum, `source_id uuid`, `reverses_group_id fk null` (self), `effective_at timestamptz`, `recorded_at timestamptz default now()`, `posted_by uuid null` | unique `idempotency_key`; unique `reverses_group_id` (a group is reversed at most once); a reversal group cannot itself be reversed; append only like movements |
| ★ `stock_movements` (append only) | `id`, `group_id fk`, `variant_id fk`, `location_id fk`, `bin_id null`, `lot_id null`, `quantity int`, `unit_cost numeric(14,4)`, `total_cost numeric(14,2)` (signed, same sign as quantity, or 0), `cost_variance numeric(14,2) not null default 0` (reference cost minus ledger value, see Value sourcing), `cost_unknown bool not null default false`, `source_line_id uuid null`, `reason_code text null` (the caller's reason only), `effective_at`, `recorded_at` (copied from the group for fast range queries) | check `quantity <> 0`; check `total_cost = 0 OR sign(total_cost) = sign(quantity)`; composite fk (`bin_id`, `location_id`) to `bins (id, location_id)`; composite fk (`lot_id`, `variant_id`) to `lots (id, variant_id)`; index (`variant_id`, `location_id`, `effective_at`); index (`group_id`); BRIN on `recorded_at`; trigger rejects every UPDATE, DELETE, and TRUNCATE |
| ★ `movement_serials` | `movement_id fk`, `serial_id fk` | pk (`movement_id`, `serial_id`); append only trigger |
| ★ `stock_levels` | `id`, `variant_id fk`, `location_id fk`, `bin_id null`, `lot_id null`, `on_hand int default 0`, `avg_unit_cost numeric(14,4) default 0` (kept at its last value when on hand reaches 0), `total_value numeric(14,2) default 0`, `updated_at` | unique (`variant_id`, `location_id`, `bin_id`, `lot_id`) `NULLS NOT DISTINCT`; same composite fks; index (`location_id`, `variant_id`) |
| ★ `reservations` | `id`, `variant_id fk`, `location_id fk`, `lot_id null`, `quantity int` (original), `open_quantity int` (>= 0), `source_type text`, `source_id uuid`, `source_line_id uuid`, `status` (active, released, fulfilled), `created_at`, `closed_at null` | unique (`source_type`, `source_line_id`) where `status = 'active'`; index (`variant_id`, `location_id`, `lot_id`) where `status = 'active'`. Reservations hold no bin: picking chooses the bin |
| ★ `stock_level_discrepancies` | `id`, `stock_level_id fk null`, `variant_id`, `location_id`, `bin_id null`, `lot_id null`, `kind` (balance, reservation, serial), `expected` and `actual jsonb`, `found_at`, `resolved_at null`, `resolved_by uuid null`, `resolution` (rebuilt, dismissed) null | partial unique (`kind`, `variant_id`, `location_id`, `bin_id`, `lot_id`) `NULLS NOT DISTINCT` where `resolved_at is null` |
| ○ `cost_layers` (feature 34) | `id`, `movement_id fk`, `variant_id`, `location_id`, `remaining_qty`, `unit_cost` | for FIFO, if feature 34 picks it |

> Amended 2026-11-05: `movement_groups` and `stock_movements` gain `operating_day` (A3); `idempotency_key` is unique per tenant; `cost_layers` is now feature 59's decision.

> Amended 2026-11-07 by spec 0011: `reservations` gains `updated_at` and `unfilled_quantity` (waiting demand; `quantity` may then be 0 and the row stays `active` while open or unfilled quantity is above 0) and four indexes; `stock_levels` gains the index (`location_id`, `updated_at`); `locations` gains `stock_verified_at` and `stock_verified_by`; a new append only `stock_transfers` table numbers showroom moves; `LedgerService` gains `transaction`, `reserveLines`, `releaseLines`, `releaseSource`, `reservationsFor`, and `postCarrierShipment` ([spec 0011](../0011-stock-ledger-locations/index.md), Data model).

**Documents** (○, each built by its own module): purchase orders and receipts (21, 22), sales orders and shipments (26, 27), returns (28), transfers (12), adjustments and counts (11), BOMs and production orders (39, 40), price lists (49). Each document gets a `number text unique` from `document_counters`. Every line uses one money shape: `quantity int`, `uom_id`, `unit_price numeric(14,2)`, `discount_amount`, `net_amount`, `tax_rate numeric(5,2)`, `tax_amount`, `gross_amount numeric(14,2)`, and `unit_cost numeric(14,4)` where cost applies. Lines are converted to base units (quantity times factor) before they reach the ledger.

> Amended 2026-11-05: the document list is replaced. Orders, order lines, and order events are in the [orders child](0002-orders.md); returns, exchanges, and refunds are features 34 and 35; purchase orders and receiving are slice 4 (features 57, 58); production is slice 5 (feature 64). The line money shape above is kept for order lines.

`source_type` values: `opening_balance`, `purchase_receipt`, `purchase_return`, `sales_shipment`, `sales_return`, `transfer_out`, `transfer_in`, `adjustment`, `count`, `production_consume`, `production_output`.

> Amended 2026-11-05: replaced by the list in the [catalog child](0002-catalog-locations.md#stock-ledger-changes) (A14); `stock_receipt` was already added by spec 0006.

### State transitions

- **Movement group**: posted (final). The only follow up is one reversal group, which is itself final.
- **Serial**: created as `in_stock` on its first inbound movement → `out` on an outbound movement → `in_stock` again on a later inbound one (a return). A move between bins or locations updates its place in the same transaction.
- **Reservation**: `active` (open quantity reduced in place by partial release or fulfilment) → `released` when released to zero, or `fulfilled` when consumed to zero by shipments. Both are final; reversing a shipment never reactivates a reservation.
  > Amended 2026-11-07 by spec 0011: a reservation also carries waiting demand (`unfilled_quantity`); it stays `active` while open or unfilled quantity is above 0, a freed piece fills the oldest waiting demand first, and a carrier shipment or a damaged or missing removal can move held quantity back to unfilled ([spec 0011](../0011-stock-ledger-locations/index.md) AC-21 to AC-23).
- **Discrepancy**: open → `rebuilt` or `dismissed` by an admin.

### API surface

This feature adds no HTTP endpoints. It exposes an internal NestJS service from the inventory module (`apps/api/src/inventory/ledger/`). Other modules call it. Contracts are Zod schemas in `packages/contracts` so feature 7's endpoints reuse them.

| Function | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|
| `ledger.post` | `idempotencyKey: string` (req), `sourceType` (req), `sourceId: uuid` (req), `effectiveAt: Date` (opt, default now), `postedBy: uuid` (opt), `lines[]`: `variantId`, `locationId`, `binId?`, `lotId?`, `quantity: int` (signed, non zero), `unitCost?` (inbound only, per base unit, 4 decimals, >= 0; rejected on outbound), `sourceLineId?`, `serials?: string[]`, `reservationId?`, `reasonCode?` | `groupId`, movements with costs | caller module (internal) | `InvalidInput`, `UnknownReference`, `InsufficientStock`, `PeriodLocked`, `FutureDate`, `TrackingMismatch`, `NotStockable`, `Archived`, `InvalidCost`, `ReservationMismatch`, `IdempotencyConflict`, `LockTimeout` |
| `ledger.reverse` | `groupId` (req), `idempotencyKey` (req), `effectiveAt?` (default now), `postedBy?`, `reasonCode` (req) | new `groupId` | internal | `NotFound`, `AlreadyReversed`, `CannotReverseReversal`, `PeriodLocked`, `FutureDate`, `InsufficientStock`, `TrackingMismatch`, `Archived`, `NotStockable`, `UnknownReference`, `IdempotencyConflict`, `LockTimeout` |
| `ledger.getLevels` | `variantId?`, `locationId?`, `cursor?`, `limit` (max 200) | levels with `on_hand`, `avg_unit_cost`, `total_value`, plus `reserved` and `available` per SKU, location, and lot, `nextCursor` | internal | none |
| `ledger.getAvailable` | `variantId` (req), `locationId?` | available per sellable location and lot | internal | none |
| `ledger.reserve` | `variantId`, `locationId`, `lotId?`, `quantity`, `sourceType`, `sourceId`, `sourceLineId` | `reservationId` | internal | `UnknownReference`, `InsufficientStock`, `DuplicateReservation`, `TrackingMismatch`, `NotStockable`, `Archived`, `LockTimeout` |
| `ledger.release` | `reservationId`, `quantity?` (partial, default all open) | updated reservation | internal | `NotFound`, `ReservationClosed`, `QuantityTooLarge`, `LockTimeout` |
| `ledger.reconcile` | none (pg-boss job `ledger.reconcile`, nightly) | count of mismatches seen in this run, open ones from earlier runs included (not only newly recorded ones) | worker | none (a failed run is retried by pg-boss) |
| `ledger.rebuildLevel` | `discrepancyId`, `resolvedBy` | corrected level | internal (admin action wired in feature 25) | `NotFound`, `DiscrepancyClosed`, `NotRebuildable` (a reservation or serial discrepancy: rebuilding a balance does not fix it), `LockTimeout` |
| `numbering.next` | `docType` (req), `date` (req) | `PO-2026-000123` | internal | `UnknownDocType` |
| `LineAmounts.compute` | `quantity`, `unitPrice`, `discount`, `taxRate`, `pricesIncludeVat` | `net`, `tax`, `gross` | pure function | `InvalidAmount` |

Any function above also raises `InvalidInput` when its input fails the Zod contract.

Fulfilling a reservation happens inside `ledger.post`: an outbound line with `reservationId` must match that reservation's SKU, location, and lot, with absolute quantity no more than its open quantity, and reduces the open quantity in the same transaction (`ReservationMismatch` otherwise).

> Amended 2026-11-07 by spec 0011: `postCarrierShipment` is the exception: a line fulfils its reservation's open quantity, then its unfilled quantity, and posts the rest unreserved ([spec 0011](../0011-stock-ledger-locations/index.md) AC-22).

Callers convert document lines to base units before posting: quantity times the unit factor, and unit cost divided by the factor, rounded to 4 decimals (a box of 12 at 120.00 posts 12 units at 10.0000). Lines are never merged. When several lines in one posting hit the same balance key, the service locks that balance once and applies the lines to it one by one, in sorted order and then input order. Each line becomes its own movement with its own `source_line_id` and cost.

### Value sourcing

| Action | Value | Source |
|---|---|---|
| `post` (inbound) | `unit_cost` | input `unitCost`, per base unit (receipt price, opening balance cost). Always stored as given, even when `total_cost` differs from `quantity × unit_cost` (an inbound into a shortfall). A `unitCost` of 0 follows the same rules (the units filling a shortfall still take its value, so `cost_variance` comes out negative) |
| `post` (inbound, `on_hand` before 0 or above) | `total_cost` | derived: `round(quantity × unit_cost, 2)` |
| `post` (inbound, `on_hand` before below 0) | `total_cost` | derived, mirroring the outbound rule: if the line reaches or crosses zero, the first `abs(on_hand)` units take exactly `−total_value` and any units beyond take `round(extra × unit_cost, 2)`; otherwise `round(total_value × qty / on_hand, 2)` (positive, since `total_value` and `on_hand` are both negative). A shortfall costed at average 0 (`cost_unknown`) is closed at 0 |
| `post` (inbound) | `cost_variance` | derived: reference cost minus `total_cost`, where the reference cost is `round(quantity × unit_cost, 2)`; so 0 when `on_hand` before is 0 or above. Finance posts it to cost of goods sold (accounting export, feature 22) |
| `post` (outbound) | `cost_variance` | 0 |
| any share above | rounding | `total_value × qty / on_hand` is computed in exact `numeric` (no float, no intermediate rounding) and rounded once, half away from zero |
| `post` (inbound) | new `total_value` | derived: `total_value + total_cost`, always (this is what keeps AC-1 true) |
| `post` (inbound) | new `avg_unit_cost` | derived: `round(new total_value / new on_hand, 4)` when new on hand is above 0 (the same formula `rebuildLevel` uses); unchanged when new on hand is 0 or below |
| `post` (outbound, `on_hand` before above 0) | `total_cost` | derived: if the line empties the balance or crosses zero, the first `on_hand` units take exactly `−total_value` and any units beyond take `round(extra × avg_unit_cost, 2)`; otherwise `−round(total_value × qty / on_hand, 2)` |
| `post` (outbound, `on_hand` before 0 or below) | `total_cost` | derived: `−round(qty × avg_unit_cost, 2)` using the last kept average; if the balance never had stock (average 0), cost is 0 and the movement gets `cost_unknown = true` (the caller's `reason_code` is kept) |
| `post` (outbound) | `unit_cost` | derived: `round(abs(total_cost) / abs(qty), 4)` for display; `total_cost` is the authority |
| `post` (outbound) | new `avg_unit_cost` | unchanged (kept even when on hand reaches 0) |
| `reverse` | each line | the original movement with quantity negated, same SKU, location, bin, lot, `unit_cost`, and `source_line_id`; the group keeps the original `source_type` and `source_id` |
| `reverse` | `total_cost` | derived by the normal rules for the reversal row's direction on the balance as it is now: reversing an inbound uses the outbound rules, reversing an outbound uses the inbound rules with the original `unit_cost` as the price. No residue special case |
| `reverse` | `cost_variance` | derived: reference cost minus `total_cost`, where the reference cost is the original's `−(total_cost + cost_variance)` (its original value or price, negated). A reversal gives back the original value exactly only when it takes the balance back to empty; otherwise the gap shows here (reversing a receipt of 5 at 20.0000 into 5 units worth 50.00 removes 75.00 at the new average, with `cost_variance` −25.00) |
| `post` | `effective_at` | input, else now; its stamped `operating_day` must be after setting `inventory_lock_date`; at most now plus 5 minutes |
| `post` | `recorded_at` | database `now()` |
| `post` | negative stock allowed? | column `locations.allow_negative` |
| `post` | posted by | input `postedBy` (session user from feature 6; null for system jobs) |
| `post`, `reserve` | tracking rule | column `product_variants.tracking` and `kind`. A lot tracked SKU is posted and reserved by lot; any other SKU takes no lot (a reservation without a lot could never be fulfilled, because a shipment's lot must match it) |
| `post`, `reverse` | `request_hash` | derived: SHA-256 of canonical JSON of the operation name, `sourceType`, `sourceId`, `reverses_group_id`, an explicit `effectiveAt` if given, and the lines sorted by variant, location, bin, lot, `sourceLineId` (never the key, `postedBy`, or a defaulted date). Unit costs are normalized to 4 decimals first, so `10` and `10.0000` hash the same |
| `post` (replay) | result | the stored group and its movements, selected by `group_id` |
| `post` (serial inbound) | serial row | looked up by (`variant_id`, `serials[i]`): created as `in_stock` if new, flipped from `out` if returning; lot and place set from the line |
| `getAvailable` | available | derived per SKU, location, and lot: `on_hand` summed over rows whose location and bin (if any) are sellable, minus the sum of `open_quantity` of active reservations |
| `numbering.next` | year | derived from input `date` in setting `timezone` (Africa/Cairo) |
| `numbering.next` | prefix | setting `document_prefixes` for `docType`, read at issue time and stored inside the number |
| `numbering.next` | sequence | `INSERT INTO document_counters ... ON CONFLICT (doc_type, year) DO UPDATE SET last_value = last_value + 1 RETURNING last_value`, padded to at least 6 digits |
| `LineAmounts.compute` | VAT inclusive or not | input, read by callers from setting `prices_include_vat` |
| `reconcile` | expected values | derived: sums of `stock_movements` per balance key, active reservation sums, and in stock serial counts, all read in one `REPEATABLE READ` snapshot. Sums stay `bigint`, so a very large total never fails the job |
| `reconcile` (balance) | mismatch | `stock_levels.on_hand` or `total_value` differs from the movement sums for that SKU, location, bin, and lot (expected and actual record both) |
| `reconcile` (reservation) | mismatch | per SKU, location, and lot, in a location where `allow_negative` is false: the active `open_quantity` total is above `on_hand` summed over **all** bins (sellable or not), the same sum the AC-4 posting check uses. Locations that allow negative stock are skipped because `reserve` may legitimately reserve beyond on hand there, not because AC-4 exempts them (posting still enforces the reserved stock rule in every location). Recorded with `bin_id` null and `stock_level_id` null, expected `maxReserved` (the on hand) and actual `reserved`. Accepted tradeoff: this sums all bins while available (AC-9) counts sellable bins only, so stock moved into a non sellable bin can leave available below reserved without a discrepancy; revisit with sales orders (feature 26) |
| `reconcile` (serial) | mismatch | for serial tracked SKUs, per SKU, location, bin, and lot: the count of `in_stock` serials differs from `on_hand` |
| `rebuildLevel` | corrected values | derived: `on_hand` and `total_value` from movement sums; `avg_unit_cost = round(total_value / on_hand, 4)` when on hand is above 0, else kept. Only for a `balance` discrepancy; a reservation or serial one raises `NotRebuildable` and stays open. An open reservation or serial discrepancy persists (each later run counts it again but records nothing new) until feature 25 adds the dismiss action |
| `reconcile` | schedule | env `LEDGER_RECONCILE_CRON`, run in setting `timezone` |

> Amended 2026-11-07 by spec 0011: the dismiss action and the discrepancy screen named "feature 25" above are built by [spec 0011](../0011-stock-ledger-locations/index.md) (AC-14, `ReconciliationService.dismiss`).

### Key invariants

- Only the ledger service writes `movement_groups`, `stock_movements`, `movement_serials`, `stock_levels`, and `reservations`. No other module imports these tables.
- `movement_groups`, `stock_movements`, and `movement_serials` are append only: the application role has only INSERT and SELECT on them, and a trigger raises on UPDATE, DELETE, and TRUNCATE as a second guard.
- **The SKU and location lock.** Every writer of balances or reservations (`post`, `reverse`, `reserve`, `rebuildLevel`, and any future writer) takes, after its input and master data checks and before it reads or locks any balance or reservation row, a transaction advisory lock (a lock PostgreSQL holds until the transaction ends, on a number instead of a row) for each SKU and location it touches. The key is the first 8 bytes of SHA-256 of `variantId:locationId` as a signed 64 bit number; keys are taken in ascending order, in `apps/api/src/inventory/ledger/locks.ts`. Row locks alone are not enough: the AC-4 reserved stock check sums on hand over every bin of the SKU and location, and rows in other bins (or a reservation `reserve` is inserting) are not row locked, so two postings could each pass the check. The ascending order also means postings touching the same pairs in opposite orders queue instead of deadlocking. Two pairs whose keys collide only wait for each other more often; the result is never wrong. `release` takes no pair lock: it only lowers a reservation, under that reservation's row lock, which can only raise availability. A replay (an idempotency key that was already posted) returns before the pair lock and takes none.
- **Lock waits are capped.** Every write transaction (`post`, `reverse`, `reserve`, `release`, `rebuildLevel`) sets `lock_timeout` to 5 seconds for itself (`SET LOCAL`), as its first statement. The cap applies to each lock wait separately, fixed in code (`LOCK_TIMEOUT_MS` in `locks.ts`), not a setting. It covers the advisory, row, and idempotency waits, so a request waiting on a same key request still in flight can end in `LockTimeout` instead of a replay. A wait past the cap fails with `LockTimeout` (PostgreSQL code 55P03), which is not retried inside the service; the whole transaction rolled back, group row included, so the caller may retry with the same key safely. Each of the two attempts (see the deadlock retry below) gets its own cap. `reconcile`, `getLevels`, and `getAvailable` take no write locks and are not capped; the job's one hour expiry bounds `reconcile`.
- Inside one posting transaction (READ COMMITTED): (1) validate input, reject archived or non stocked records, and sort lines by variant, location, bin, lot (nulls first), keeping input order for lines on the same key; (2) `INSERT` the group `ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`. No row back means a repeat: compare `request_hash`, then return the stored result or raise `IdempotencyConflict`. A first request still in flight makes the second wait; if the first rolls back, the second proceeds as new; (3) take the SKU and location locks above, then in the sorted order upsert and lock each distinct balance row once, in one statement (`INSERT ... ON CONFLICT ... DO UPDATE SET updated_at = now() RETURNING *`), then lock the active reservation rows it needs, also in order; (4) check the rules on the locked rows; (5) insert movements and serial links, and update balances, serials, and reservations. On a deadlock or serialization failure (40P01, 40001) the service retries the whole transaction once.
- Costs are applied in the order postings are recorded, never recomputed. A backdated posting does not change costs already applied to later movements, so a valuation "as of" a date is exact by recorded time, not effective date.
- `on_hand` and `total_value` change only by the sum of the movements inserted in the same transaction. An empty balance always has `total_value = 0.00`, and `total_value` is never of the opposite sign to `on_hand`, after any posting or reversal.
- A bin always belongs to the movement's location, and a lot always belongs to the movement's SKU (composite foreign keys).
- For a serial SKU, the count of `in_stock` serials at a balance's place equals its `on_hand`. Serial place and status change only in the posting transaction.
- `numbering.next` runs as the last step of the caller's document transaction, so the counter row stays locked only briefly and a rollback returns the number.
- A transfer is two lines in one group: `transfer_out` from the source, `transfer_in` to the `transit` location, then a second group from transit to the destination on receipt (feature 12 owns the flow).

### Security model

No HTTP surface in this feature, so nothing is reachable from outside. Two database roles: the owner role runs migrations only, and the api and worker connect as an application role (`ssdashboard_app`) that has only INSERT and SELECT on the append only ledger tables and normal read and write elsewhere. The migration creates the role's grants and default privileges; the `migrate` entry point sets its login password from `APP_DB_PASSWORD`. The owner password reaches only the `postgres` and `migrate` containers: no Compose service (`api`, `worker`, `web`, `caddy` included) loads the whole `.env`, each gets an explicit list, so a compromised api or worker cannot read the owner secret from its environment. Inside the api, only the inventory module's ledger service can write ledger tables (a module boundary check in lint, plus a unit test that greps for imports). Roles and permissions arrive in feature 13, and staff identity in feature 6. Until then `posted_by` is optional. Stock movements are the audit record for stock (who, when, what, why, and the source document). The audit trail for master data changes is feature 14. Unit costs and stock values are commercially sensitive: later read endpoints must hide them from roles without cost permission (noted for feature 13). No personal data beyond party contacts. Nothing here falls under PCI or health rules.

> Amended 2026-11-05: "No personal data beyond party contacts" is no longer true: customers, phones, and order ship to fields are personal data (see *Security model (amendment)*); the app role is named by `ssd.app_role`, with `ssdashboard_app` only the fallback (A2).

### Configuration required

- `LEDGER_RECONCILE_CRON`: when the nightly reconciliation runs, optional, default `0 2 * * *` (2am, in the `timezone` setting).
- `MIGRATION_DATABASE_URL`: the owner role's connection, used only by the `migrate` entry point. `DATABASE_URL` becomes the application role's connection. The owner must be able to create a role and a schema owned by it: a superuser (the Compose `postgres` user is one). On a managed database, create `ssdashboard_app` ahead of time and grant it to the owner as [spec 0001](../0001-stack-architecture/index.md) (Configuration & secrets) describes.
- `APP_DB_PASSWORD`: the application role's password. `migrate` sets the login from it, and Compose builds every app service's `DATABASE_URL` from it, refusing to start when it is missing. In `env.ts` it stays optional: an install outside Compose that leaves it unset gets no app role login from `migrate`, and creates it itself. An install whose `.env` predates it adds a long random hex value by hand (documented in `deploy/.env.example`). It must be hex only, because Compose puts it into the URL without encoding it (spec 0001, Configuration & secrets).
All added to `apps/api/src/config/env.ts`, `.env.example`, and `deploy/` Compose files.

### Critical test scenarios

- Happy path: receive 10 units at 3.3333 (value 33.33), ship 4, ship 6, then receive again; the second shipment takes exactly the remaining value, the empty balance holds 0.00, and balances match movement sums and a full rebuild, verifies **AC-1**, **AC-3**, **AC-12**.
- Negative stock: in an `allow_negative` location with 3 on hand at 30.00, ship 5; the first 3 take 30.00, the other 2 cost 20.00 at the kept average (balance −2, −20.00). Receive 5 at 12.0000: the movement's `total_cost` is 56.00 (20.00 closes the shortfall, 36.00 for 3 units), `cost_variance` is 4.00, and the balance is 3 on hand, 36.00, average 12.0000. In a second run, receive 2 at 12.0000 instead: the balance is 0 on hand and exactly 0.00, with `cost_variance` 4.00. Receive 1 instead: the balance is −1, −10.00, average still 10.0000. In every run balances match movement sums and a full rebuild, verifies **AC-1**, **AC-4**, **AC-12**.
- Reversal: reverse a shipment of serial and lot stock; the same serials return to in stock at the same bin and lot; reversing again raises `AlreadyReversed`, reversing the reversal raises `CannotReverseReversal`, verifies **AC-2**, **AC-8**.
- Reversal costing: receive 5 at 10.0000 and 5 at 20.0000 (10, 150.00), ship 5 (5, 75.00), receive 3 at 1.0000 (8, 78.00), then reverse the 5 at 20.0000 receipt: the row costs −48.75 by the outbound rule (3, 29.25), with `cost_variance` −51.25, never a negative value on positive stock. In an `allow_negative` location, reverse a shipment into a balance that then reaches exactly 0 on hand: it holds 0.00. In every case balances match movement sums and a rebuild, verifies **AC-1**, **AC-2**, **AC-12**.
- Unmerged lines: one posting with +5 at 12.0000 and −3 on the same balance writes two movements with their own `source_line_id`, the balance locked once, verifies **AC-3**, **AC-7**.
- Immutability: an UPDATE, DELETE, or TRUNCATE on `stock_movements` through the application role fails on permissions, and through the owner role fails on the trigger, verifies **AC-2**.
- Concurrency: 20 parallel outbound postings of 1 unit against 10 on hand give exactly 10 successes and 10 `InsufficientStock`; two multi line postings touching the same balances in opposite input orders, run 100 times in parallel, finish with no deadlock error, verifies **AC-4**.
- Reserved stock: with 10 on hand and 8 reserved, an unreserved outbound of 3 fails, and an outbound of 3 that fulfils the reservation succeeds; with stock split over two bins, parallel unreserved shipments from both bins never take on hand below the reservation, verifies **AC-4**, **AC-9**.
- Lock timeout: while another transaction holds a balance's row lock, a posting on it fails with `LockTimeout` within seconds and changes nothing, verifies **AC-4**.
- Idempotency: the same key posted twice moves stock once and returns the same group; a retry without an explicit date still matches; the same key with a changed quantity raises `IdempotencyConflict`, verifies **AC-5**.
- Lock date: with the lock date set to yesterday, a posting dated 23:30 Cairo time yesterday fails with `PeriodLocked`, one dated 00:30 Cairo time today succeeds, and one dated tomorrow fails with `FutureDate`, verifies **AC-6**.
- Atomic transfer: the second line of a two line posting fails, and neither line nor any balance changes, verifies **AC-7**.
- Tracking: a lot SKU without a lot, a lot of another SKU, a serial count that doesn't match the quantity, a serial already in stock arriving again, a service SKU, and an archived SKU or bin are all rejected, verifies **AC-8**.
- Reservations: reserving more than available fails; stock in a non sellable bin isn't available; a partial release of 2 from 5 leaves 3 open; fulfilling with a different lot raises `ReservationMismatch`, verifies **AC-9**.
- Numbering: 50 concurrent requests, 5 of them rolled back, give 45 consecutive numbers with no gap; the first number of a new year starts at 000001; changing the prefix leaves stored numbers unchanged, verifies **AC-10**.
- Reconciliation: a balance changed through the owner role (test only) is found, recorded once even across two runs, and rebuilt, with the rebuild recorded; a serial count mismatch is also found, and rebuilding it raises `NotRebuildable` and leaves it open; postings running during the check cause no false mismatch, verifies **AC-11**.
- Amounts: inclusive 114.00 at 14% gives net 100.00 and tax 14.00; rounding of halves goes away from zero, verifies **AC-12**.
- Archive: deleting a SKU with movements fails; archiving it works; deleting an unused SKU works, verifies **AC-13**.
- Scale: the seed script with 100,000 SKUs and 1,000,000 movements meets the latency targets, verifies **AC-14**.
  > Amended 2026-11-05: replaced by the 50,000 SKU suite (AC-36).
- Permission: a module other than inventory importing ledger tables fails the boundary test, verifies **AC-2**.

## Build plan (original, built)

Tracer Bullet: first one real inbound posting through schema, service, and tests, then each rule is added around it, always tested against Postgres.

**Milestone 1: Schema and value objects**
1. `Money`, `UnitCost`, `Quantity`, and `LineAmounts` value objects in `packages/contracts` (Zod), with rounding tests, satisfies **AC-3**, **AC-12**
2. Drizzle schema files per module (`catalog`, `locations`, `parties`, `inventory`, `platform`) in `packages/db/src/schema/`, and one reviewed SQL migration with the append only triggers, composite keys, `NULLS NOT DISTINCT` uniques, the `ssdashboard_app` grants and default privileges, and seeds (settings, transit and scrap locations, base `pc` unit), satisfies **AC-2**, **AC-3**, **AC-13**
3. Split the database roles: `MIGRATION_DATABASE_URL` for `migrate`, `DATABASE_URL` as the application role, `APP_DB_PASSWORD` and the login creation in `deploy/` and the dev Compose file, satisfies **AC-2**

**Milestone 2: The thin thread, then the ledger rules**
4. `ledger.post` for one inbound line: input validation, group with idempotency and request hash, balance upsert and lock, inbound cost rules; database test proves AC-1 on that path, satisfies **AC-1**, **AC-3**, **AC-5**
5. Outbound lines with the exact value rules, inbound lines into a negative balance with `cost_variance`, line sorting with one lock per balance and one movement per line, the negative stock rule, multi line atomic postings, and the single deadlock retry, satisfies **AC-4**, **AC-7**, **AC-12**
6. Effective date and lock date checks in Cairo time, and `ledger.reverse` with its costing rules, satisfies **AC-2**, **AC-6**, **AC-12**
7. `ledger.getLevels` (cursor paged) and `ledger.getAvailable`, satisfies **AC-1**, **AC-9**

**Milestone 3: Tracking and reservations**
8. Lot and serial rules, serial creation and returns, `movement_serials`, serial place updates, and the archived and not stockable checks, satisfies **AC-8**
9. `ledger.reserve`, `ledger.release` (partial), fulfilment inside `post`, and the reserved stock check on unreserved outbound lines, satisfies **AC-4**, **AC-9**

**Milestone 4: Numbering, reconciliation, and scale**
10. `numbering.next` with gap free counters created per year, satisfies **AC-10**
11. The `worker` entry point with pg-boss, the `ledger.reconcile` job (balances, reservations, serials, one snapshot), `stock_level_discrepancies`, and `ledger.rebuildLevel`, plus `LEDGER_RECONCILE_CRON` in `env.ts`, satisfies **AC-11**
12. Module boundary test, a seed script for 100,000 SKUs and 1,000,000 movements, and the latency check in the e2e suite, satisfies **AC-2**, **AC-14**

## Build plan

The amendment only (Amendment 2026-11-05, with the fix pass of the same day). Tracer Bullet: milestone 1 proves the new foundation (one baseline, a tenant id on every row) through every layer the app already has, by running the existing receipt thread from the database to the Playwright test unchanged. Each later milestone adds one slice of the model end to end: tables, database guards, the pure rules in `packages/contracts`, and their tests. Inside this feature only the generated tables file of the baseline is regenerated at each milestone (nothing runs it yet; each milestone tells developers to recreate their dev database); the two hand written files are edited by hand, and all three freeze the day the pilot brand's first import runs (ADR 0003). One commit per milestone.

**Milestone 1: The new baseline with a tenant id, end to end**
1. [x] `tenantId()` column helper; `tenant_id` on every existing table (Better Auth tables included) and in every unique business key; the `install` table; `ledger_reject_change` renamed `ssd_reject_change`; grants, default privileges, and revokes through `DO` blocks reading `ssd.app_role`; delete migrations `0000` to `0008` and their `meta` snapshots and write the baseline as `0000_baseline_extensions.sql` (hand written), `0001_baseline_tables.sql` (generated only), and `0002_baseline_rules.sql` (hand written with `drizzle-kit generate --custom`), satisfies **AC-15**, **AC-16**, **AC-33**
2. [x] `migrate` first run and reruns: `TENANT_ID` and `APP_DB_ROLE` in `apps/api/src/config/env.ts` (migrate only), `.env.example`, and the Compose `migrate` env list; `ALTER DATABASE ... SET` plus `set_config` for both settings; the `install` row; `TenantMismatch`; `pnpm bootstrap` stops with the recreate instruction on a database migrated by the old history, satisfies **AC-16**
3. [x] `packages/db/test/tenant.e2e-spec.ts` (the column, default, and key rules, with planted failing cases) and the updated `migrate.e2e-spec.ts` and `schema.e2e-spec.ts`, satisfies **AC-15**, **AC-16**, **AC-33**
4. [x] ADR `docs/adr/0003-reset-migrations-to-one-baseline.md` (the three files, why hand written SQL never sits in a generated file, and the freeze on the pilot brand's first import), listed in `docs/adr/README.md` and linked from `packages/db/README.md`; the recreate step in the bootstrap README, satisfies **AC-16**
5. [x] Run every existing suite on the baseline with no behavior change: the ledger, receipt, sign in, and staff e2e suites and the Playwright receipt thread in both languages, satisfies **AC-16**

**Done when** `pnpm db:migrate` on an empty database prints `Migrations applied.` and a second run applies nothing; `pnpm --filter @ssdashboard/db test:e2e` passes including `tenant.e2e-spec.ts`; and `pnpm test:e2e` passes with every pre existing api and Playwright test unchanged.

**Milestone 2: Operating day, styles and cost, locations with an owner type, ledger changes**
6. [x] `ssd_operating_day`, `ssd_stamp_operating_day`, the `operating_day_cutoff_hour` setting seed, and `operating_day` on `movement_groups` and `stock_movements`; `packages/db/test/operating-day.e2e-spec.ts` with the transition dates found from the database's time zone data, satisfies **AC-17**
7. [x] `product_groups` (seeded `MAIN`), `seasons` (seeded `CORE`), the style columns on `products`, per tenant uniques on variants, barcodes, and units, the trigram indexes, `cost_records` (append only, season required) and `CostService.costFor` returning the cost basis; the spec 0006 SKU create path sets `style_code` to the SKU code and the group to `MAIN` for its one variant products, with its contract and e2e test updated, satisfies **AC-30**, **AC-33**
8. [x] `locations` with `kind`, `owner_type`, `party_id`, `sellable_online` (replacing `type`); the `locations_owner_fixed` trigger; `location_owner_policies` with its three seeded rows; `parties` reshaped; `LocationPolicyService`; `NotSellableOnline` and `PartyRoleMismatch`; spec 0006's location endpoints, contracts, screens, and receipt location check move from `type` to `kind` (`showroom` becomes `shop`) with `owner_type` defaulting to `own`, and its `STOCK_ON_HAND` archive rule is kept; `owner-type-boundary.spec.ts`; `test/location-owner-types.e2e-spec.ts` (the three way test with a closing location), satisfies **AC-29**
9. [x] The new `source_type` list in the Drizzle enum and the Zod `LedgerSourceType`, with ledger e2e cases that an `opening_balance` line without a cost still raises `InvalidCost` and that a restock posted at a line's frozen unit cost lands at that cost. No change to `costing.ts` or the average (gate review round 2), satisfies **AC-31**

**Done when** `pnpm test` passes (cost lookup, policy service, owner type boundary); `pnpm --filter @ssdashboard/db test:e2e` passes including `operating-day.e2e-spec.ts`; and `pnpm build && pnpm --filter @ssdashboard/api test:e2e` passes including `location-owner-types.e2e-spec.ts` and the amended `ledger.e2e-spec.ts`.

**Milestone 3: Stores, channels, customers, and orders**
10. [x] `stores` (seeded `MAIN`), `channels` (seeded `manual`), `connections` (key columns, `gateway` in the provider enum, the Shopify and carrier binding checks), and `outbound_commands` (sync state and its checks), satisfies **AC-18**, **AC-35**
11. [x] `customers` (risk flag with kind and source), `customer_phones`, `customer_external_ids`, and `customer_merges` (append only, undo once); `EgyptianPhone` in `packages/contracts/src/customers/` with one test per normalization row; the new personal data keys (names, phones, the second and raw phones, addresses, courier note, task notes, risk notes, merge reasons, command payloads) in `packages/config/src/redaction.ts` with the redaction test extended, satisfies **AC-27**, **AC-28**, **AC-33**
12. [x] `orders` (with `discount_code`, `prepaid_method`, `ship_to_phone_alt`, `contact_phone_raw`, `related_order_id`, `refused_reason_code`, `carrier_delivery_created_at`, the shipping and allocation amounts, and `cod_due_amount`), `order_lines` (allocation shares, `cancel_reason_code`, line states with `lost`), and `order_events` (append only) with every check, index, and the `operating_day` stamps; in `packages/contracts/src/orders/`: `order-states.ts` (`nextState`, `replayStates`, an exhaustive test over every state pair and actor), `order-outcome.ts` (`deriveOrderOutcome`, one test per table row plus the returned line, the two exchange cases, and the refund only return), `line-split.ts` (the worked example and a property test that the two rows always sum to the original), and `order-amounts.ts` (allocation and `codDue`, with the partial delivery and allocation examples of the orders child), satisfies **AC-18**, **AC-19**, **AC-20**, **AC-21**, **AC-22**, **AC-23**, **AC-35**
13. [x] Database cases: `#1001` in two stores and twice in one; the Shopify and carrier binding checks; the gifted (`total_amount = 0`) and exchange replacement checks; the `cod_expected_amount`, refusal reason, prepaid method, and allocation checks; `order_events` and `customer_merges` append only, satisfies **AC-18**, **AC-21**, **AC-23**, **AC-33**

**Done when** `pnpm test` passes including the phone, transition, outcome, split, amounts, and redaction tests; and `pnpm --filter @ssdashboard/db test:e2e` passes including the store, order, and customer constraint cases.

**Milestone 4: Credit, settlement, tasks, cost rules, and the module walls**
14. [x] `credit_entries` (append only, `posting_id`, `funding`, `payout_method`, the sign by kind check inverted on reversals, the funding checks for bonus, goodwill, and payouts, the reversal trigger) and `packages/contracts/src/credit/credit-amounts.ts` (return credit share and its split by funding, consumption with `credit_only` first, leftover, payout matching, debt payment) with the worked examples, satisfies **AC-24**, **AC-33**
15. [x] `settlement_accounts`, `settlement_periods` (the `btree_gist` exclusion), `settlement_period_events`, `settlement_statements` (with covered days), `settlement_lines` (no `period_id`, dedupe per statement, the new kinds and partner columns), and `settlement_line_matches` (with `accounted`), the four last append only; `lineMatchState` and `settlementPeriodStatus` in `packages/contracts/src/settlement/`, satisfies **AC-25**, **AC-33**
16. [x] `tasks` with its checks (internal hats only, outcome when done) and partial indexes, satisfies **AC-26**
17. [x] `order_cost_rules` (append only, seeded `not_set` by `migrate` after the `install` row) and `CostRulesService.ruleFor`, satisfies **AC-32**, **AC-33**
18. [x] `packages/db/src/table-ownership.ts` (including the identity hat tables of spec 0008 and the platform license tables of spec 0009) with its completeness test; `apps/api/src/module-boundary.spec.ts` replacing the inventory one, with a planted cross module import failing it; the append only cases for every table in A4 in `schema.e2e-spec.ts`, satisfies **AC-33**, **AC-34**

**Done when** `pnpm test` passes including the credit arithmetic, settlement state, ownership map, and module boundary tests; `pnpm --filter @ssdashboard/db test:e2e` passes with an append only case for every table in A4; and `pnpm lint` passes.

**Milestone 5: Scale at 50,000 SKUs, in its own CI job**
19. [x] `apps/api/test/scale-seed.ts` and `scale.e2e-spec.ts` reshaped to the catalog child's load (50,000 variants, 500,000 movements, 150,000 orders, and the related rows) with one p95 assertion per budget row; a foreign key index check in `schema.e2e-spec.ts`; the measured p95 values recorded in `verify.md` and the budgets reset from the first run where they were **Assumed**, satisfies **AC-36**
20. [x] A `scale` job in `.github/workflows/ci.yml` that runs the scale file on a nightly schedule and on pull requests labelled `scale`, and the default api `test:e2e` excluding `test/scale.e2e-spec.ts`; spec 0010's 5,000,000 audit entry check runs in the same file and job, satisfies **AC-36** Amended 2026-11-08: the nightly schedule was dropped (GitHub Actions billing; CI moved to a self-hosted runner); the scale suite runs by hand (workflow_dispatch) and on PRs labelled `scale`.

**Done when** `pnpm build && pnpm --filter @ssdashboard/api test:scale` passes with every p95 under its budget; `pnpm test:e2e` no longer runs the scale file; the `scale` job is green on a labelled pull request; and `pnpm --filter @ssdashboard/db test:e2e` passes including the foreign key index check.

## Consequences

**Positive**:
- Every balance can be rebuilt and every unit traced back to a document, which is the basis for costing, recalls, and the accounting export.
- Reads are instant at full catalog size, because they hit one indexed balance row instead of summing millions of movements.
- Later modules (purchasing, sales, production) only add tables and call one service, so no breaking migration should be needed.
- The Shopify sync maps cleanly: products, variants, options, prices, whole number quantities, and tracked or not tracked items line up.

**Negative / tradeoffs**:
- Two tables hold stock state, so a bug in the service could drift them apart. The nightly reconciliation catches it, but it is one more job to watch.
- The SKU and location lock serializes every posting and reservation for one SKU at one location, across all its bins and lots. That is fine at your volume, but a flash sale on one SKU queues briefly, and a posting that waits more than 5 seconds fails with `LockTimeout` for the caller to retry.
- Whole number quantities rule out selling by weight or length without a model change (a new unit like grams is the workaround).
- Average cost lives on each balance row (per location, bin, and lot). Feature 34 may move it to a per SKU average or FIFO layers, a planned change rather than a free one.
- A single currency with no currency columns means multi currency later needs a migration across document tables.
- Gap free numbering takes a row lock per document type, so document creation for one type is serialized (kept short by issuing the number last).
- Costs follow recorded order, so a backdated receipt does not recost sales already recorded after its effective date. Valuation as of a past date is exact by recorded time only.
- Two database roles add a little deploy setup and one more secret per install.
- `stock_movements` is not partitioned. Fine at millions of rows; revisit partitioning by year at about 50 million.

**Neutral**:
- The `worker` entry point lands now (the first scheduled job).
- Any difference between an invoice total and the ledger's stock value (for example 33.34 billed against 33.33 recorded) is handled as a price variance in feature 22; the ledger value is the authority for stock.
- `created_by` foreign keys are added by feature 6.
- Writing amounts as `numeric` means Drizzle returns strings; the value objects own parsing.

**Amendment 2026-11-05**:

*Positive*:
- The database itself enforces the tenant id, the operating day, and the append only history, so a forgotten line of code cannot break them.
- Customer credit and settlement follow the stock ledger's proven shape (append only, corrected by new rows), so one way of thinking covers all three.
- One outcome function and one owner type policy mean reports and refunds cannot each invent their own rule.
- Resetting to one baseline now costs a dev database rebuild; after the pilot it would cost a careful migration on every install.

*Negative / tradeoffs*:
- Many tables arrive before the services that use them; features 14, 16, 17, 22, 28, and 43 may find gaps and must amend this spec through `/architect`, not patch the schema quietly.
- Order columns that mirror other modules' facts (cash amounts, credit amounts, write back state) stay right only if every writer publishes its event in the same transaction (A6); a writer that skips it leaves a stale order.
- The operating day and owner type guards live in triggers, which are less visible than code; the tenancy child and the module READMEs must say so.
- A fixed owner type means a partner who becomes a wholesale customer needs a new location and a stock move, a deliberate step instead of a field edit.
- One phone, one customer merges people who share a phone.
- A brand must price every style before its opening stock posts (an owner estimate is enough, labelled "estimate"), so go live waits for a cost list; uncosted stock cannot be posted until feature 59 adds unknown cost units.
- Credit funding adds a column and a matching rule to every credit posting, and a return credit can split into several entries; the credit screens (feature 28) must show the balance by funding in plain words.
- `btree_gist` is a new extension every self hosted install needs (it ships in PostgreSQL's contrib set).
- Developers recreate their dev database at each milestone of this feature.

*Neutral*:
- `tenant_id` adds 16 bytes to every row and leads every business unique key; it is constant in a database until a shared install exists.
- Lots and serials stay in the schema, unused by clothing brands.

## Follow-up

- [ ] Feature 7 (core stock loop) builds the first SKU, location, and receipt screens and endpoints on top of `ledger.post`.
- [ ] Feature 13: hide unit cost and stock value from roles without cost permission.
- [ ] Feature 25: admin screen for open discrepancies and the rebuild action, plus a dismiss action: reservation and serial discrepancies cannot be rebuilt, and no function sets the `dismissed` resolution yet.
  > Amended 2026-11-07 by spec 0011: owned by [spec 0011](../0011-stock-ledger-locations/index.md) milestone 5 (AC-14).
- [ ] Feature 7: map `LockTimeout` to a retryable HTTP error (503 with a retry hint) when the ledger gets endpoints.
- [x] `/develop data model`: `rebuildLevel` runs its own transaction, so it neither maps PostgreSQL code 55P03 to `LockTimeout` nor gets the single 40P01/40001 retry the Key invariants require. Route it through the same retry and error mapping as `LedgerService`, with a test.
- [ ] Feature 23: alert on newly opened discrepancies, not on the nightly count, which stays above zero while reservation or serial discrepancies wait for the feature 25 dismiss action.
- [ ] Feature 34: confirm the average cost scope (per balance row, per location, or per SKU) or switch to FIFO `cost_layers`.
- [ ] Feature 46: validate `custom_fields` against `custom_field_definitions` and add the admin screens.
- [ ] Feature 23: move discrepancy alerts from the table into real notifications.
- [ ] Feature 22: record any difference between the invoiced total and the ledger's stock value as a price variance, and post `stock_movements.cost_variance` (receipts into negative stock) to cost of goods sold.

Amendment 2026-11-05 (current feature numbers):
- [x] Domain review of this amendment (`domain-reviewer`), required by scope feature 4's done when, before the build starts: domain review (kept private) approved on 2026-11-05; its build re-read of 2026-11-06 is in the same file.
- [ ] Feature 16: build the platform `DomainEvents` service (A6) with the first projection on `orders`.
- [x] Lost parcels have their own fulfillment state, `lost` (fix pass); feature 19 maps Bosta's lost states to it (below).
- [x] Done by spec 0012 milestone 1 (2026-11-08): `products_search_trgm_idx` and `product_variants_sku_trgm_idx` are dropped; `product_variants.search_text` (kept by triggers from `ssd_search_normalize`) and `product_variants_search_trgm_idx` serve the name branch, which the scale suite asserts. Was: Feature 12: replace the trigram expression index on products with the Arabic normalization function. The scale suite (milestone 5) found the SKU name branch of `buildSkuListSql` scanning `products` because its `ILIKE` on `name->>'en'` and `name->>'ar'` does not match the indexed expression; fast at 5,000 styles, so feature 12 makes the query and the index use one expression and asserts the trigram index in the scale plan.
  > Amended 2026-11-07 by spec 0012: taken by [spec 0012](../0012-catalog-styles-variants/index.md) AC-1 to AC-5 (one normalized `search_text` column per variant).
- [ ] Feature 26: set per client `APP_DB_ROLE` and `REVOKE CONNECT, TEMP ... FROM PUBLIC` in the host bootstrap; refuse an app role that already exists on a first run unless the host bootstrap made it; send the app role password pre hashed; run `migrate` after every restore (since the feature 4 close it re-asserts a missing `ssd.tenant_id` from the `install` row and `ssd.app_role` from the `pgboss` schema owner, `migrate.e2e-spec.ts`) and prove that run book step on a real restore (`docs/reviews/security-data-model-m1-m2.md`, M2, N1, N3, N5). Once the baseline exists, `migrate` refuses rather than defaulting `ssd.app_role` when neither the setting nor the `pgboss` owner names a role and `APP_DB_ROLE` is unset (security review S13).
- [ ] Feature 26: one baseline migration holds about 1,400 locks until it commits (measured 2026-11-06), so on the shared host PostgreSQL stagger client migrations or raise `max_locks_per_transaction`; the db e2e suite caps its workers at 3 for the same reason (`packages/db/vitest.config.e2e.ts`).
- [ ] Features 35 and 43: the full order to refund to settlement run per owner type (spec 0007 section 8), on top of this feature's three way policy test.
- [x] ~~Feature 59: decide whether opening stock booked with `cost_unknown` is revalued when its cost arrives.~~ Void after the fix pass: opening stock always carries a cost (B5); the current feature 59 carry is in the fix pass block below.
- [ ] Feature 8: the cost permission over `cost_records`, `order_cost_rules`, and `order_lines.unit_cost`; who may create gifted orders (Questions for the owner, 8).
- [ ] If the owner changes a decided question (`## Questions for the owner`), amend the named child spec.

Fix pass of 2026-11-05 (carried by name, current feature numbers):
- [ ] Feature 24 (metric dictionary), carried by the gate review: partial returns counted at line level in the real return rate, never from the outcome alone (question 1); cash refunded separated from store credit outstanding, a liability (question 2); gifted orders excluded by type; a size refusal linked to a replacement counted as an exchange, not a failed delivery (M4); lost parcels shown apart within failed delivery (M3).
- [ ] Feature 13: how a Shopify order becomes `gifted` (a tag or a discount code); the several Shopify products as one style mapping is a content sync risk (gate review); a customer note on orders (`note`) arrives with the connector.
- [ ] Feature 15: imported refund history as credit postings and `opening_balance` credit (M9); credit and exchanges in flight at go live (brand question 10); blacklist categories mapped to risk flag kinds (brand question 7, with feature 18); the opening import stops on uncosted styles (B5).
- [ ] Feature 18: a deposit before a COD order ships as a second tender (`prepaid_method`; brand question 5); blacklist actions by risk flag kind (brand question 7).
- [ ] Feature 19: map Bosta's lost states and labels to `lost` (M3); open a task when a delivery's own COD differs from the order's `cod_expected_amount`, never `cod_due_amount` (M5, re-review n1); Bosta lines with no tracking number and lost parcel compensation, with a real Bosta statement (brand question 8, with feature 22).
- [ ] Feature 21: the return of credit applied to lines that come back to origin or are lost, as `consumption_release` entries (`LinesReturnedToOrigin`); restocks posted at the line's frozen unit cost.
- [ ] Feature 22: account codes for carrier lines with no delivery; cross statement duplicates by content (M8).
- [ ] Features 28 and 37: a Shopify gift card or discount code for kept credit, as a later toggle (owner answer); not built in slice 1.
- [ ] Feature 34: the uncollected old piece (`return_not_collected` after the policy days, M2); replacement orders created after the credit posts when credit waits for inspection (m5).
- [ ] Features 41 and 43: the partner agreement (consignment price list or commission percent, missing piece charge basis) and the partner statement line shape, with the pilot's showroom statements in hand (M6, brand question 4).
- [ ] Features 42 and 43: day batches, "no sales" days and the coverage grid from statement coverage, and the count as evidence (M7, M8).
- [ ] Feature 59: units of unknown cost on a stock balance, so uncosted stock could be posted and flagged on the way out, and the flag on restocks of `cost_unknown` shipments (B5, gate review round 2).
Milestone 3 reviews of 2026-11-06 (carried by name; security-data-model-m3 (kept private)):
- [ ] Features 13 and 19: pass job handler errors through `loggableError` before pg-boss records them (a Drizzle error message carries query parameters such as ship to fields).
- [ ] Features 13 and 53: strip control and bidi characters from `contact_phone_raw` at the edge before storing it; keep only allow listed UTM parameters of `source_landing_page` and `source_referrer`; store WhatsApp contact phones in `customer_phones`, not as an external id, or redact that external id by path; log `outbound_commands.failure_reason` by provider error code, not provider text (m5).
- [ ] The module wall's `KNOWN_BREACHES` (`apps/api/src/module-boundary.spec.ts`, milestone 4): the ledger and reconciliation lock `product_variants` rows (spec 0006 allowed it; a catalog locking service, feature 11 or 12); `LocationPolicyService` reads `parties` (done 2026-11-07, spec 0008 milestone 3: it asks `PartnerAccounts.holdsRole`, and the entry is gone); `mail.worker.ts` reads `users` and `verifications` (the identity service, spec 0005 amendment milestone 1). The test fails when an entry stops occurring, so each fix removes its entry.
  > Amended 2026-11-07 by spec 0011: the catalog locking service for the ledger and reconciliation entries is taken by [spec 0011](../0011-stock-ledger-locations/index.md) AC-18 (`CatalogService.lockForShare`, `lockForUpdate`; moved to `CatalogLocks.lockForShare` and `lockForUpdate` in `apps/api/src/catalog/catalog-locks.service.ts` by spec 0013 milestone 4, 2026-11-12).
Milestone 4 reviews of 2026-11-06 (carried by name):
- [ ] Feature 28: refuse positive cashable value without a source (a `consumption_release` must release a consumption of the same funding; a positive non `credit_only` `adjustment` needs a person), and compare `request_hash` on replay (security-data-model-m4 (kept private) m1, m2).
- [ ] Feature 23: refuse settlement lines and match rows inside a closed period without an admin's written reason (m5).
- [ ] Feature 8: a parity test between `tasks_owner_hat_internal` and the `InternalHat` contract.
- [ ] Feature 16: replay reads `order_events` `ORDER BY recorded_at, id`; a test writes two events in one transaction and replays them.
- [ ] Feature 15: decide the cost lookup answer for an unknown variant (today `not_set`, from `CostService.costFor` in `apps/api/src/catalog/cost.service.ts`).
- [ ] Features 18 and 21: a `prepayment_release` credit kind (the prepaid share of lines returned to origin or lost, posted as a positive entry from the prepaid funding, kept out of `returned_credit_amount`), and a shipping deposit marker (for example `orders.prepaid_purpose`: `order` or `shipping_deposit`; a shipping deposit is allocated to shipping first and only its excess to lines, never spread onto pieces). The brand's refusal policy for a deposit (kept as the delivery fee, released, or kept as store credit) is an owner question (domain review, build re-read 2026-11-06 (kept private), D2).
- [ ] Feature 19: a refused parcel in transit moves no line in the built model, so `cod_due_amount` stays full until the carrier reports it back. Add the "refused, nothing to collect" step (`unpaid` to `nothing_to_collect` once `cod_due_amount` is 0), and decide what a whole order `cancelled` does to its open lines, since `codDue` counts `open` lines and the cancelled transition names no line effect (domain review, build re-read (kept private), D3).
  > Amended 2026-11-07 by spec 0013: the whole order `cancelled` part is decided in [spec 0013](../0013-orders-state-machines/index.md#state-machines) (lines stay `open`, totals unchanged, `codDue` returns 0 for `cancelled`); the refused part stays with feature 19.
- [ ] Feature 9: validate `operating_day_cutoff_hour` as an integer 0 to 23, and `timezone` as an IANA name that PostgreSQL also knows (`pg_timezone_names`), with database checks on `settings` (security review S5, security-data-model (kept private)).
- [ ] Features 9 and 45: a backdated per order cost rule never reaches before the inventory lock date (`inventory_lock_date`); spec 0009 task 26 carries it to feature 9 (domain review, build re-read (kept private), D5).
- [ ] Counsel and feature 30: whether Law 181 of 2018 requires refunding delivery cost on a change of mind return (brand question 11; spec 0007 owner question q10).
- [ ] Next catalog feature: `seasons` and `product_groups` have no `created_at` or `updated_at`, against the Timestamps convention; that feature adds them, or the convention names its exceptions (review (kept private) R15).
  > Amended 2026-11-07 by spec 0012: taken by [spec 0012](../0012-catalog-styles-variants/index.md) milestone 2 (both tables gain `created_at` and `updated_at`).
