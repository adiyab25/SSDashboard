# 0002. Build the core data model around an append only stock ledger with maintained balances

**Date**: 2026-11-02
**Status**: In Progress

## Summary

This spec fixes the data model every module builds on: products and their SKUs, locations and bins, parties (suppliers, factories, customers), and the stock ledger. Stock is never edited. Every change is a new movement row with its quantity, cost, and source document, and a balance table kept in the same transaction makes stock on hand instant to read at 100,000+ SKUs. This feature migrates the shared core and builds the inventory ledger service (the only code allowed to move stock). It adds no screens; feature 7 adds the first ones on top.

## Requirements

**User stories**:
- As a warehouse manager, I want stock on hand per SKU, location, bin, and lot to always match the recorded movements, so I can trust the numbers.
- As an accountant, I want every stock movement to carry its cost, effective date, and source document, so the accounting export and stock valuation are exact.
- As a developer on any module, I want one ledger service that enforces every stock rule, so no module can corrupt stock by writing tables directly.
- As an owner, I want closed months to stay closed and document numbers to have no gaps, so audits and the accounting app line up.

**Acceptance criteria**:
- **AC-1**: For every (SKU, location, bin, lot), `stock_levels.on_hand` equals the sum of `stock_movements.quantity`, and `stock_levels.total_value` equals the sum of `total_cost`. A rebuild from movements reproduces both exactly.
- **AC-2**: The application's database role can never update, delete, or truncate a movement row: it holds only INSERT and SELECT on the ledger history tables, and a trigger rejects the same statements as a second guard. A correction is a reversal posting that writes new rows with opposite quantities and links back to the original group. Each reversal row is costed by the ledger's normal rules for its direction at the original unit cost, and any gap to the original cost is stored as `cost_variance`, so a balance's value never takes the wrong sign.
- **AC-3**: Every movement carries a non zero signed whole number quantity in the SKU's base unit, a unit cost (4 decimals), a total cost (2 decimals, EGP), an effective date, a recorded time, a source type and source id (and source line id when the source has lines), and the user who posted it (when signed in users exist).
- **AC-4**: An outbound posting that would take a balance below zero is rejected, unless the location has `allow_negative` on. An outbound line that fulfils no reservation may not take on hand (summed over bins for that SKU, location, and lot) below the active reserved quantity. Two postings on the same balance at the same moment are applied one after the other, never losing an update, and postings touching the same balances in opposite orders never deadlock.
- **AC-5**: Posting twice with the same idempotency key moves stock once and returns the first posting's result, rebuilt from the stored group and movements, without checking stock or the lock date again. The same key with different content (or used for a reversal and a posting) is rejected.
- **AC-6**: A posting's effective date may be in the past but not in the future (beyond a 5 minute clock tolerance), and its date in the `timezone` setting (Cairo) must be after the inventory lock date. When none is given, it defaults to now. A reversal follows the same rule, so reversing a movement from a locked month means passing a current date.
- **AC-7**: A posting with several lines (for example a transfer: out of one location, into another) is atomic. Either every line and balance change lands, or none does.
- **AC-8**: For a lot tracked SKU every movement names a lot of that same SKU. For a serial tracked SKU every movement lists exactly as many serials as the absolute quantity; a serial must be in stock at that location (and bin) to leave it, and must not be in stock anywhere to arrive (a new serial is created, a returned one flips back to in stock). Service and bundle SKUs, and archived SKUs, locations, and bins, cannot be posted or reserved.
- **AC-9**: Available stock per SKU, location, and lot equals on hand (summed over sellable bins, in a sellable location) minus active reservations. A reservation larger than available is rejected (unless the location allows negative stock). Partial release or fulfilment reduces the reservation's open quantity in place; it closes when that reaches zero.
- **AC-10**: Document numbers are issued per document type and year with the install's prefix (for example `PO-2026-000123`, at least 6 digits), with no gaps and no duplicates, even under concurrent requests and rolled back transactions. The full number is stored, so a later prefix change never rewrites an old one.
- **AC-11**: The nightly reconciliation compares every balance with its movements in one consistent snapshot (on hand and value), compares reservation totals, and for serial SKUs compares in stock serial counts with on hand. It records each mismatch with expected and actual values, at most one open record per balance. An admin approved rebuild recomputes that balance and is recorded with who and when. Movements are never touched.
- **AC-12**: Line amounts follow one rule everywhere: totals in EGP at 2 decimals rounded half away from zero, unit cost at 4 decimals. A balance's stock value is exact: an outbound takes `round(total_value × qty / on_hand, 2)`, and the outbound that empties a balance takes exactly the remaining value, so an empty balance always holds 0.00 and a value never has the opposite sign to its on hand. Shares are computed in exact `numeric` and rounded once. An inbound into a negative balance mirrors this: the units that fill the shortfall take its own value (proportionally, or exactly the rest when the line reaches zero), only the units beyond zero cost at the receipt price, and the difference from the receipt price is stored on the movement as `cost_variance`. With VAT inclusive prices, net = gross / (1 + rate), rounded, and tax = gross minus net. With VAT exclusive prices, tax = net times rate, rounded, and gross = net plus tax.
- **AC-13**: A product, SKU, location, bin, or party that any other row references cannot be deleted, only archived. An unreferenced one can be deleted.
- **AC-14**: With 100,000 SKUs and 1,000,000 movements loaded, reading on hand and available for one SKU across all locations takes under 50 ms at the 95th percentile, and posting a single line takes under 50 ms at the 95th percentile, on the dev Postgres.

## Decision

**Chosen option**: Option 1: append only ledger plus a balance table maintained in the same transaction.

Stock truth lives in immutable `stock_movements` (one signed row per place, grouped per posting). `stock_levels` holds the running balance per (SKU, location, bin, lot), updated under a row lock by the inventory ledger service, the only writer of both tables. A nightly job proves balances match movements.

**Implementation skills**: `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Conventions every table follows

- **Primary keys**: `uuid` defaulting to `uuidv7()` (PostgreSQL 18 built in, ordered by time so big indexes stay fast).
- **Money**: one currency per install, EGP, stored as a setting. No currency columns. Amounts are `numeric(14,2)`, unit costs `numeric(14,4)`, tax rates `numeric(5,2)` (14.00 means 14%).
- **Quantity**: `integer`, whole units in the SKU's base unit, signed on movements. This matches Shopify, which stores whole number quantities.
- **Bilingual text**: `jsonb` shaped `{ "en": string, "ar": string }`. At least one language is required, enforced by the Zod contract. A third language is a new key, not a migration.
- **Custom fields**: `custom_fields jsonb not null default '{}'` on products, variants, and parties, checked against `custom_field_definitions` (validation is built by feature 46; this feature only adds the columns and the table).
- **Timestamps**: `created_at` and `updated_at` as `timestamptz` on every mutable table. Master data gets `archived_at timestamptz null`. Foreign keys are `ON DELETE RESTRICT` (this is what blocks deleting referenced rows, AC-13).
- **Users**: `created_by` / `posted_by` are `uuid null` without a foreign key until feature 6 adds the users table, then a migration adds the key.
- **Enums**: PostgreSQL enums (adding a value later is a safe, forward only migration).

### Data model sketch

★ = migrated in this feature. ○ = designed here, built by the named feature without a breaking change.

**Platform**

| Table | Fields | Constraints |
|---|---|---|
| ★ `settings` | `key text pk`, `value jsonb`, `updated_at`, `updated_by` | Seeded: `currency = "EGP"`, `timezone = "Africa/Cairo"`, `prices_include_vat = true`, `inventory_lock_date = null`, `document_prefixes = {"PO": "PO", ...}` |
| ★ `document_counters` | `doc_type text`, `year int`, `last_value int not null` | pk (`doc_type`, `year`); a row is created on the first number of a year |
| ★ `custom_field_definitions` | `id`, `entity text` (product, variant, party), `key text`, `type` (text, number, boolean, date, select), `label jsonb`, `required bool`, `options jsonb null`, `archived_at` | unique (`entity`, `key`) |
| ○ `channel_mappings` (feature 29) | `id`, `entity text`, `local_id uuid`, `channel text`, `external_id text`, `synced_at` | unique (`channel`, `entity`, `external_id`), unique (`channel`, `entity`, `local_id`) |

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

**Locations and parties**

| Table | Fields | Constraints |
|---|---|---|
| ★ `locations` | `id`, `code text`, `name jsonb`, `type` (warehouse, showroom, transit, virtual), `is_sellable bool default true`, `allow_negative bool default false`, timestamps, `archived_at` | unique `code`. Seeded: one `transit` location and one `virtual` scrap location |
| ★ `bins` | `id`, `location_id fk`, `parent_id fk null` (self), `level` (zone, aisle, shelf, bin), `code text`, `is_sellable bool default true`, timestamps, `archived_at` | unique (`location_id`, `code`); unique (`id`, `location_id`) for the composite key below |
| ★ `parties` | `id`, `code text`, `name text`, `name_ar text null`, `tax_id text null`, `is_supplier`, `is_customer`, `is_factory bool`, `contact jsonb` (phone, email), `custom_fields`, timestamps, `archived_at` | unique `code`; check: at least one role is true |
| ○ `party_addresses`, `party_contacts` (feature 20) | | N:1 party |

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

**Documents** (○, each built by its own module): purchase orders and receipts (21, 22), sales orders and shipments (26, 27), returns (28), transfers (12), adjustments and counts (11), BOMs and production orders (39, 40), price lists (49). Each document gets a `number text unique` from `document_counters`. Every line uses one money shape: `quantity int`, `uom_id`, `unit_price numeric(14,2)`, `discount_amount`, `net_amount`, `tax_rate numeric(5,2)`, `tax_amount`, `gross_amount numeric(14,2)`, and `unit_cost numeric(14,4)` where cost applies. Lines are converted to base units (quantity times factor) before they reach the ledger.

`source_type` values: `opening_balance`, `purchase_receipt`, `purchase_return`, `sales_shipment`, `sales_return`, `transfer_out`, `transfer_in`, `adjustment`, `count`, `production_consume`, `production_output`.

### State transitions

- **Movement group**: posted (final). The only follow up is one reversal group, which is itself final.
- **Serial**: created as `in_stock` on its first inbound movement → `out` on an outbound movement → `in_stock` again on a later inbound one (a return). A move between bins or locations updates its place in the same transaction.
- **Reservation**: `active` (open quantity reduced in place by partial release or fulfilment) → `released` when released to zero, or `fulfilled` when consumed to zero by shipments. Both are final; reversing a shipment never reactivates a reservation.
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
| `post` | `effective_at` | input, else now; its date in setting `timezone` must be after setting `inventory_lock_date`; at most now plus 5 minutes |
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

### Configuration required

- `LEDGER_RECONCILE_CRON`: when the nightly reconciliation runs, optional, default `0 2 * * *` (2am, in the `timezone` setting).
- `MIGRATION_DATABASE_URL`: the owner role's connection, used only by the `migrate` entry point. `DATABASE_URL` becomes the application role's connection. The owner must be able to create a role and a schema owned by it: a superuser (the Compose `postgres` user is one), or on a managed database a role with `CREATEROLE` that is a member of `ssdashboard_app`.
- `APP_DB_PASSWORD`: the application role's password. `migrate` sets the login from it, and Compose builds every app service's `DATABASE_URL` from it, refusing to start when it is missing. In `env.ts` it stays optional: an install outside Compose that leaves it unset gets no app role login from `migrate`, and creates it itself. An install whose `.env` predates it adds a long random value by hand (documented in `deploy/.env.example`).
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
- Permission: a module other than inventory importing ledger tables fails the boundary test, verifies **AC-2**.

## Build plan

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

## Follow-up

- [ ] Feature 7 (core stock loop) builds the first SKU, location, and receipt screens and endpoints on top of `ledger.post`.
- [ ] Feature 13: hide unit cost and stock value from roles without cost permission.
- [ ] Feature 25: admin screen for open discrepancies and the rebuild action, plus a dismiss action: reservation and serial discrepancies cannot be rebuilt, and no function sets the `dismissed` resolution yet.
- [ ] Feature 7: map `LockTimeout` to a retryable HTTP error (503 with a retry hint) when the ledger gets endpoints.
- [ ] `/develop data model`: `rebuildLevel` runs its own transaction, so it neither maps PostgreSQL code 55P03 to `LockTimeout` nor gets the single 40P01/40001 retry the Key invariants require. Route it through the same retry and error mapping as `LedgerService`, with a test.
- [ ] Feature 23: alert on newly opened discrepancies, not on the nightly count, which stays above zero while reservation or serial discrepancies wait for the feature 25 dismiss action.
- [ ] Feature 34: confirm the average cost scope (per balance row, per location, or per SKU) or switch to FIFO `cost_layers`.
- [ ] Feature 46: validate `custom_fields` against `custom_field_definitions` and add the admin screens.
- [ ] Feature 23: move discrepancy alerts from the table into real notifications.
- [ ] Feature 22: record any difference between the invoiced total and the ledger's stock value as a price variance, and post `stock_movements.cost_variance` (receipts into negative stock) to cost of goods sold.
