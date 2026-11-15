# 0002 child: styles and cost, locations with an owner type, ledger changes, and scale

Part of the [2026-11-05 amendment of spec 0002](index.md#amendment-2026-11-05). Satisfies **AC-29** to **AC-32** and **AC-36**. Sources: final plan sections 6.5 and 6.10 (`docs/positioning/2026-11-05-egypt-order-operations-layer.md`); spec 0007 sections 8 and 11 and carried m4; reference brand notes section 2 item 10 (cost per style and season, rules with "not set"), and the reference repo's `supabase/migrations/20261015120000_style_costs_and_cost_rules.sql` (read only); the domain review `docs/reviews/domain-data-model.md` (B5) and the gate review's round 2 ruling on it.

## Summary

A product is a style: it carries a style code, a season, and a product group, and its variants are the sizes and colors. Cost is recorded per style and season with an effective date, a variant may override it, and records are only ever added, so history is never restated. Per order cost rules (COD fee, gateway fee, packaging, unrestockable returns) can be "not set", and that state is shown, never read as zero. A location has an owner type (own, consignment partner, wholesale customer) fixed for its life, and one policy table answers every question that differs by owner type.

**Built here versus later.** This feature migrates every table below and builds `CostService` (catalog), `CostRulesService` (platform), `LocationPolicyService` with its boundary test and the three way test (inventory), the ledger changes, and the scale suite. Screens are later: styles, seasons, and groups in feature 12, cost import in feature 15, location owner types in feature 11, rule editing in feature 9.

## Catalog: style, season, product group

**Catalog module.** Every table also has `tenant_id`.

| Table | Change | Constraints and indexes |
|---|---|---|
| ★ `product_groups` (new) | `id`, `code text`, `name jsonb`, `archived_at` | unique (`tenant_id`, `code`). Seeded: `MAIN`. Drives export codes (spec 0007 section 4) |
| ★ `seasons` (new) | `id`, `code text` (for example `SS27`), `name jsonb`, `starts_on date null`, `ends_on date null`, `archived_at` | unique (`tenant_id`, `code`); check `starts_on <= ends_on` when both set. Seeded: `CORE` (no dates), the season for carry over basics (owner answer 7) |
| ★ `products` (amended) | **a product is a style**: adds `style_code text not null`, `season_id fk null` (the season of the style's current run), `product_group_id fk not null` (default the seeded `MAIN` when the brand has one line) | unique (`tenant_id`, `style_code`); index (`product_group_id`), (`season_id`); GIN trigram index on `(coalesce(name->>'en', '') \|\| ' ' \|\| coalesce(name->>'ar', '') \|\| ' ' \|\| style_code)` (feature 12 replaces it with its Arabic normalization function) |
| ★ `product_variants` (amended) | unchanged columns | unique (`tenant_id`, `sku`) replaces unique `sku`; new unique (`id`, `product_id`) as the target of the cost record composite key; GIN trigram index on `sku` |
| ★ `barcodes`, `uoms` (amended) | unchanged columns | unique (`tenant_id`, `code`) |
| ★ `cost_records` (new, append only) | `id`, `product_id fk` (the style), `variant_id null`, `season_id fk not null`, `cost_basis` enum (`factory_invoice`, `production_run`, `purchase_landed`, `estimate`), `unit_cost numeric(14,4) >= 0` (EGP per base unit, landed cost included, frozen at the rate on the day materials were paid, final plan 6.10), `effective_from date`, `source text` (an invoice number or import batch), `recorded_at default now()`, `recorded_by fk users null` | composite fk (`variant_id`, `product_id`) to `product_variants (id, product_id)` (an override always belongs to its style); index (`product_id`, `effective_from desc`, `recorded_at desc`); partial index (`variant_id`, `effective_from desc`, `recorded_at desc`) where `variant_id` is not null |

> Amended 2026-11-07 by spec 0012: the trigram expression index on `products` and the trigram index on `sku` are replaced by one normalized `product_variants.search_text` column (kept by triggers) and its trigram index, so `product_variants` and `barcodes` gain columns and `seasons` and `product_groups` gain timestamps ([spec 0012](../0012-catalog-styles-variants/index.md), Data model sketch).

**Cost lookup**, `CostService.costFor(variantId, onDate)` in the catalog module: among the cost records for that variant (`variant_id = variantId`) and for its style (`product_id = style, variant_id IS NULL`) with `effective_from <= onDate`, take the latest `effective_from`; on a tie, a variant override beats a style record; then the latest `recorded_at`; then the greatest `id` (uuidv7, so two records written in one transaction still order the same way every time). It returns the unit cost with its `cost_basis`, so a margin built on an `estimate` is labelled "estimate". No record gives `NotSet` (the type `{ status: 'not_set' }`), never 0. So a new season's style cost supersedes last season's override from its effective date, and a corrected record (same `effective_from`, later `recorded_at`) replaces a mistyped one without editing it. Cost entered at receipt is frozen on the movement (`stock_movements.unit_cost`); a later record never changes a past movement.

**Style versus a separate styles table.** One product per style matches the reference brand's schema (`style_costs.style` references `products(style)`). A brand that lists one style as several Shopify products (one per color) maps those Shopify products to variants of one canonical product through `connection_external_ids` (feature 13), so cost stays per style. See [rationale](rationale.md#amendment-2026-11-05).

> Amended 2026-11-07 by spec 0012: one Shopify product is one style; several Shopify products are not grouped into one style (owner decision Q-12.4, recommended), matching the reference brand, whose style already carries one color. Shopify upserts go through `CatalogChannelSync` ([spec 0012](../0012-catalog-styles-variants/index.md), AC-14).

## Per order cost rules

**Platform module.**

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `order_cost_rules` (append only) | `id`, `kind` enum (`cod_fee_percent`, `gateway_fee_percent`, `packaging_per_order`, `rto_unrestocked_percent`), `status` enum (`set`, `not_set`), `value numeric(14,4) null`, `effective_from date`, `recorded_at default now()`, `recorded_by fk users null` | check (`status = 'set'`) = (`value IS NOT NULL`); check `value >= 0`; check `kind = 'packaging_per_order' OR value <= 100` (percent as 0 to 100, never a fraction); index (`kind`, `effective_from desc`, `recorded_at desc`). Seeded by `migrate` right after the `install` row: one `not_set` row per kind, `effective_from` = the install's operating day |

*Backdating (decided at the build, 2026-11-06, security-data-model-m4 (kept private) m7):* a rule may be recorded with a past `effective_from`, because a brand sets its fees for the season it is already in; margins computed at read time then follow the latest rule, and the rule editing screen (feature 9) shows when a rule was recorded beside when it applies. `onDay` must be a calendar date. `CostRulesService.ruleFor(kind, onDay)` returns `{ status: 'set', value }` or `{ status: 'not_set' }`, choosing the latest `effective_from <= onDay`, then the latest `recorded_at`; a day before the first row is `not_set`. Every screen, report, and export that shows margin shows "not set" (in the reader's language) for a missing rule or cost, never a silent zero (final plan 6.10). The rules are per brand, not per store, in version one (owner question).

## Locations and the owner type policy

**Inventory module.** Replaces the original `locations.type` (`warehouse`, `showroom`, `transit`, `virtual`).

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `locations` (amended) | `id`, `code`, `name jsonb`, `kind` enum (`warehouse`, `shop`, `transit`, `virtual`), **`owner_type`** enum (`own`, `consignment_partner`, `wholesale_customer`), **`party_id fk parties null`** (the owner when not own), `is_sellable bool default true` (stock here may be reserved or sold at all; kept from the original), **`sellable_online bool default false`** (only these feed the portal and Shopify), `allow_negative`, timestamps, `archived_at` | unique (`tenant_id`, `code`); index (`party_id`); check (`owner_type = 'own'`) = (`party_id IS NULL`); trigger `locations_owner_fixed` rejects any `UPDATE` that changes `owner_type` or `party_id` (`OwnerTypeFixed`). Seeded: `TRANSIT` (kind `transit`, own) and `SCRAP` (kind `virtual`, own, not sellable) |
| ★ `location_owner_policies` (new) | `owner_type` enum, `stock_owned_by_brand bool`, `handover_is_sale bool`, `sale_recorded_at` enum (`at_shipment`, `at_sell_through`, `at_handover`), `end_customer_refund_by` enum (`brand`, `location_owner`), `defective_piece_refund_by` enum (`brand`, `location_owner`), `tax_document` enum (`b2c_electronic_receipt`, `b2b_electronic_invoice_at_settlement`, `b2b_electronic_invoice_at_handover`), `settlement_owner_type` (the settlement owner type enum) null, `can_sell_online bool`, `updated_at`, `updated_by` | primary key (`tenant_id`, `owner_type`); seeded with the three rows below; feature 9 owns editing it as a setting |
| ★ `parties` (amended, partners module) | drops `is_customer` (end customers are `customers` now); adds `is_consignment_partner bool`, `is_wholesale_customer bool`; keeps `is_supplier`, `is_factory` | unique (`tenant_id`, `code`); check at least one role is true |

Seeded policy rows (final plan 6.5):

| `owner_type` | stock owned by brand | handover is sale | sale recorded | end customer refund | defective piece refund | tax document | settlement owner type | can sell online |
|---|---|---|---|---|---|---|---|---|
| `own` | true | false | `at_shipment` | `brand` | `brand` | `b2c_electronic_receipt` | null | true |
| `consignment_partner` | true | false | `at_sell_through` | `location_owner` | `brand` | `b2b_electronic_invoice_at_settlement` | `consignment_partner` | false |
| `wholesale_customer` | false | true | `at_handover` | `location_owner` | `location_owner` | `b2b_electronic_invoice_at_handover` | null | false |

- **One code path.** `LocationPolicyService` (`apps/api/src/inventory/locations/location-policy.service.ts`) is the only reader of the policy table and the only code that may name an owner type value. It answers `policyFor(locationId)` with the row above. Orders, refunds, settlement, tax documents, and channel feeds ask it; none of them compares owner types. The inventory locations service refuses `sellable_online = true` where `can_sell_online` is false (`NotSellableOnline`) and a party whose roles do not match the owner type (`PartyRoleMismatch`). Spec 0006's location endpoints and receipt check move from `type` (`warehouse`, `showroom`) to `kind` (`warehouse`, `shop`) with `owner_type` defaulting to `own`; a receipt still accepts only `warehouse` and `shop` locations. Creating partner and wholesale locations (with their party) is feature 11's screen.
- **Boundary test** (`apps/api/src/inventory/locations/owner-type-boundary.spec.ts`): fails when the strings `own`, `consignment_partner`, or `wholesale_customer` appear as a comparison operand, a `case` label, or a map key in any `apps/api/src` or `apps/web/src` file other than the policy service, its tests, the Drizzle enum, and the contracts enum.
- **Owner type is fixed for a location's life** (decides carried m4). A showroom that closes, or a partner that becomes a wholesale customer, gets a new location; the old one is archived. Archiving a location is refused while any balance there has `on_hand <> 0` or an active reservation exists (the existing spec 0006 rule, 409 `STOCK_ON_HAND`), so remaining stock moves out first by a transfer (or, to a wholesale location, a handover that is a sale). Movements and settlement lines recorded at a location therefore always join to the owner type they were recorded under, without date logic. See [rationale](rationale.md#amendment-2026-11-05) for effective dating, the runner up.
- **The three way test** (`apps/api/test/location-owner-types.e2e-spec.ts`) runs one scenario three times, once per seeded owner type, changing only which location it uses: hand over 5 pieces (a transfer, or a sale when `handover_is_sale`), record one sale at the moment `sale_recorded_at` names, ask who refunds a normal and a defective piece, which tax document applies, and which settlement owner type the sale settles through, and assert the answers equal the seeded row. Then it tries to archive the location with stock left (refused), moves the stock out, and archives it. The test body branches only on policy attributes, never on the owner type. The full order to refund to settlement run of spec 0007 section 8 is carried to features 35 and 43, which build refunds and partner settlement.
- **Online availability** for the portal and Shopify (feature 11 and 13) counts only locations with `sellable_online`; `ledger.getAvailable` keeps its original meaning (sellable locations).
  > Amended 2026-11-07 by spec 0011: at most one active location has `sellable_online`, and it must be a sellable warehouse (check `locations_online_needs_warehouse`, partial unique index `locations_one_online`); archiving it turns the flag off; online stock is read only through `OnlineStockService`, which counts that one location ([spec 0011](../0011-stock-ledger-locations/index.md) AC-1 to AC-4).

## Stock ledger changes

- **`tenant_id`** on every ledger table; `movement_groups.idempotency_key` unique per tenant; `stock_receipts.number` unique per tenant.
- **Source types** (replaces the original `source_type` list): `opening_balance` (also the onboarding stock snapshot, feature 15), `stock_receipt`, `purchase_receipt`, `purchase_return`, `order_shipment`, `returned_to_origin_restock`, `customer_return_restock`, `exchange_return_restock`, `consignment_sale`, `write_off`, `transfer_out`, `transfer_in`, `adjustment`, `count`, `production_consume`, `production_output`. Removed: `sales_shipment`, `sales_return` (no code posts them today; the baseline makes removing an enum value free). A gifted order ships through `order_shipment`; its cost is classed as marketing by the order's type, not by a separate source type.
- **`operating_day`** on `movement_groups` and `stock_movements`, stamped from `effective_at`.
- **Opening stock always carries a cost** (domain review B5; gate review round 2; owner answer 6: "opening stock needs a cost record; an owner estimate is allowed and labelled estimate"). The ledger keeps its original rule: every inbound line needs a `unitCost` (`InvalidCost` otherwise), and `cost_unknown` stays only for the existing edge (an outbound from a balance that never had stock). The onboarding import (feature 15) takes each line's cost from `CostService.costFor`; a style with no factory invoice or landed cost gets an owner entered `cost_records` row with `cost_basis = 'estimate'`; the import refuses to post while any style is uncosted and lists those styles for the owner to price. Every margin view labels margin that rests on an `estimate` record "estimate" in the reader's language. Tracking units of unknown cost on a balance (so uncosted stock could be posted and flagged on the way out) is carried to feature 59; this feature changes neither `costing.ts` nor the average.
- **Restocks post at the shipment's cost.** A returned to origin restock, a customer return restock, and an exchange return restock post each unit at the frozen `unit_cost` of the order line it came back from, which is the shipment movement's own unit cost, never 0 and never the balance's current average (feature 21 and 34 post them). In the rare case where that shipment movement itself was `cost_unknown`, the restock posts at that same `unit_cost` (0) and the margin view shows the piece as "not set"; carrying the flag onto the inbound movement is part of the feature 59 carry.
- **Lots and serials** stay in the schema, dormant: clothing variants are `tracking = 'none'`.
- The rest of the original ledger (Key invariants, locking, costing, reconciliation) is unchanged.

## Scale suite (replaces the original AC-14 load)

The existing `apps/api/test/scale.e2e-spec.ts` and `scale-seed.ts` change to spec 0007 section 11's shape: 5,000 styles with 50,000 variants (10 per style), 500,000 movements, 150,000 orders over 1,095 operating days with about 210,000 lines and 450,000 order events, 120,000 customers with 150,000 phones, 300,000 settlement lines with one match row each, 150,000 tasks (5,000 open), and 20,000 credit entries, all seeded with `COPY` or `INSERT ... SELECT generate_series` inside the test database.

**It runs as its own CI job, never in the default e2e job** (gate review fix 6): seeding this load would push the e2e job well past its current length, so `.github/workflows/ci.yml` gets a `scale` job that runs on a nightly schedule and on pull requests carrying a `scale` label, and the default `test:e2e` excludes `test/scale.e2e-spec.ts`. The audit trail's 5,000,000 entry check (spec 0010 AC-17) lives in the same file and runs in the same job.

Budgets, p95 over at least 50 runs on the dev Postgres, **Assumed** and reset from the first measured run (spec 0007 section 11). *Measured 2026-11-06 ([verify](verify.md)): every read is far under its budget, so the budgets are kept as written; each read's plan is asserted to use the index named here, except the SKU name branch (no index yet, carried to feature 12).*

> Amended 2026-11-07 by spec 0012: the SKU search row relies on `product_variants_search_trgm_idx`, `product_variants_sku_c_idx`, and `barcodes_code_unique`, asserted by the scale suite ([spec 0012](../0012-catalog-styles-variants/index.md) AC-5).

| Read or write | Budget | Index it relies on |
|---|---|---|
| SKU search by code or name fragment | 150 ms | trigram on `sku`, trigram expression on products |
| stock on hand and available for one SKU | 50 ms | `stock_levels (variant_id, ...)` (original) |
| single line `ledger.post` | 50 ms | original ledger indexes |
| order by store and number | 20 ms | unique (`tenant_id`, `store_id`, `order_number`) |
| customer by phone | 20 ms | unique (`tenant_id`, `phone_e164`) |
| one customer's credit balance (canonical, 3 ids) | 20 ms | `credit_entries (customer_id, recorded_at)` |
| confirmation queue page (oldest `new`, 50 rows) | 150 ms | partial `orders (placed_at, id) where fulfillment_state = 'new'` |
| orders list page by store, keyset | 150 ms | `orders (store_id, placed_at desc, id desc)` |
| orders of one operating day per store (report) | 150 ms | `orders (operating_day, store_id)` |
| My work page for a person and for a hat | 150 ms | the two partial `tasks` indexes |
| unmatched settlement lines of one statement | 150 ms | `settlement_lines (statement_id)`, `settlement_line_matches (line_id, recorded_at desc)` |
| one order's event timeline | 50 ms | `order_events (order_id, recorded_at)` |

Every foreign key column above has its own index or leads one (PostgreSQL does not index foreign keys by itself); the schema test checks it.

## Value sourcing

| Action | Value | Source |
|---|---|---|
| receipt or import | default inbound `unitCost` | `CostService.costFor(variant, receipt operating day)` |
| onboarding import | cost per line | `CostService.costFor`; a style without a record stops the import with the list of uncosted styles |
| restock of a returned piece | `unitCost` | the order line's frozen `unit_cost` (the shipment movement's) |
| margin view | an `estimate` cost | the label "estimate" in the reader's language |
| margin view | per order cost | `CostRulesService.ruleFor(kind, order operating_day)` |
| margin view | missing rule or cost | the string "not set" in the reader's language, never 0 |
| create location | `owner_type`, `party_id` | input, then fixed by trigger |
| create location | `sellable_online` allowed? | `location_owner_policies.can_sell_online` |
| any owner type question | answer | `LocationPolicyService.policyFor(locationId)` |
| archive location | allowed? | no balance with `on_hand <> 0` and no active reservation there (spec 0006's `usage`) |

> Amended 2026-11-07 by spec 0011: `sellable_online` is allowed only when the policy allows it, the location is a sellable warehouse, and no other active location has it, and it is set only through the gated make online action (stock confirmed counted, registered checks passed); archiving a location sets it to false ([spec 0011](../0011-stock-ledger-locations/index.md) AC-1, AC-19).

## Critical test scenarios

- Style code unique per tenant; a variant override of another style fails the composite key; a product without a group fails, verifies **AC-30**.
- Cost lookup: style record SS26 at 120.0000 from 2026-03-01, variant override at 130.0000 from 2026-04-01, style record SS27 at 140.0000 from 2027-03-01; the variant costs 120 on 2026-03-15, 130 on 2026-05-01, 140 on 2027-03-02; a correction with the same date and a later `recorded_at` wins; a style with no record gives `NotSet`; a receipt then a new record leaves the receipt's movement cost unchanged, verifies **AC-30**.
- An `opening_balance` line without cost raises `InvalidCost`, as every inbound line does; a restock of a returned piece shipped at 120.0000 posts at 120.0000 into a balance whose average is now 140.0000; an `estimate` record is returned by `CostService` with its basis so margin views can label it, verifies **AC-30**, **AC-31**.
- Cost rules: a fresh install reads all four `not_set`; setting COD fee 2.5 from a date reads `set` from that day and `not_set` the day before; a percent above 100 fails, verifies **AC-32**.
- Locations: changing `owner_type` fails with `OwnerTypeFixed`; a partner location flagged `sellable_online` raises `NotSellableOnline`; the boundary test fails on a planted `=== 'consignment_partner'` outside the policy file; the three way test passes for all three types, verifies **AC-29**.
- Scale: every budget in the table holds, verifies **AC-36**.
