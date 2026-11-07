# 0006. Build the core stock loop as a numbered stock receipt posted through the ledger in one transaction

**Date**: 2026-11-04
**Status**: In Progress

## Summary

This is the walking skeleton (the first thin path through every layer): a signed in person creates a SKU and a warehouse, records a stock receipt, and sees stock on hand, read from the stock ledger, in English and Arabic. A receipt is a small numbered document (`SR-2026-000001`) with many lines, each with a quantity and a required unit cost. Saving it writes the receipt, its number, and its ledger movements together in one database transaction, so stock never moves without a receipt. An admin can void a receipt, which posts a reversal. Cost and stock value are shown to admins only.

## Requirements

**User stories**:
- As a staff member, I want to add a SKU and record a delivery against a warehouse, so that stock on hand is right the moment goods arrive.
- As a staff member, I want to see on hand per SKU and location, and each SKU's movement history, so that I can answer "how many do we have, and where did they come from".
- As an admin, I want to manage warehouses and showrooms, retire records safely, and void a wrong receipt, so that mistakes are fixable without editing history.
- As an owner, I want unit cost and stock value hidden from staff, so that margins stay private until finer permissions exist (feature 13).

**Acceptance criteria**:
- **AC-1**: Any signed in person can create a SKU: a name (English and/or Arabic, at least one), a SKU code, and an optional price (0 or more, 2 decimals). The code is trimmed and uppercased, then must match `^[A-Z0-9._-]{1,64}$`. It creates one active product with one variant of kind `stocked`, tracking `none`, base unit `pc`. A code already in use answers 409 `SKU_TAKEN`.
  > Amended 2026-11-07 by spec 0012: `POST /api/products` also takes an optional style code, season, and product group, and further variants are added to a style through `POST /api/styles/:id/variants` ([spec 0012](../0012-catalog-styles-variants/index.md) AC-10).
- **AC-2**: Any signed in person can edit a SKU's name and price. Only an admin can change a SKU's code, and only while no stock balance row exists for it (it has never been posted); after that the api answers 409 `CODE_LOCKED` and the field is read only with a hint. An edit sent with an `updatedAt` other than the stored one answers 409 `STALE_RECORD` and changes nothing.
- **AC-3**: Only an admin can archive, unarchive, or delete a SKU. Archive fails with 409 `STOCK_ON_HAND` while any balance of that SKU has on hand other than 0 or any active reservation is open, and a receipt posting at the same moment either lands before the archive (which then fails) or fails with `ARCHIVED`, never both succeeding. An archived SKU leaves search, pickers, and the default list, and shows under an Archived filter; its history stays. Delete works only for a SKU nothing references (409 `IN_USE` otherwise) and removes its product too.
  > Amended 2026-11-07 by spec 0012: archiving a SKU archives its style (product) only when no other active SKU of that style remains, and unarchiving a SKU unarchives its style ([spec 0012](../0012-catalog-styles-variants/index.md) AC-11).
- **AC-4**: Only an admin can create, edit, archive, unarchive, or delete locations. A location has a code (trimmed, uppercased, `^[A-Z0-9._-]{1,16}$`, unique, 409 `LOCATION_CODE_TAKEN`), a name (at least one language), and a type of warehouse or showroom. Code edits, stale edits, archive, and delete follow the same rules as AC-2 and AC-3 (a location with bins cannot be deleted). The seeded transit and virtual locations never appear in these screens or pickers, and their ids answer 404 on location management endpoints.
  > Amended 2026-11-05: a location now has a `kind` (`warehouse`, `shop`, `transit`, `virtual`) and an `owner_type` defaulting to `own`, not a `type` of warehouse or showroom; a showroom becomes `shop` (spec 0002, Amendment A13, [catalog child](../0002-core-data-model/0002-catalog-locations.md#locations-and-the-owner-type-policy)).
- **AC-5**: Any signed in person can post a stock receipt: one active warehouse or showroom location, a receipt date (defaults to now; may be an earlier day; never in the future), an optional reference (up to 64 characters) and note (up to 500), and 1 to 200 lines. Each line names a different SKU, a whole quantity from 1 to 1,000,000, and a required unit cost from 0 to 9,999,999,999.9999 with at most 4 decimals, and quantity times unit cost may not exceed 9,999,999,999.99 (422 `LINE_TOTAL_TOO_LARGE`). One transaction writes the receipt, its lines, its number (`SR-YYYY-NNNNNN`, year taken from the receipt date in the install time zone), and one ledger group of source type `stock_receipt` with one inbound movement per line at that line's unit cost, linked by `source_line_id`, posted by the session user. If any part fails, nothing is stored and no number is used.
  > Amended 2026-11-07 by spec 0011 (domain review M6): a line's unit cost is no longer required; when a line sends none it defaults to `CostService.costFor(variant, the receipt's operating day)` (`COST_NOT_SET` when there is none), and a line that sends 0 or any cost other than that default needs `cost.view` (422 `INVALID_LINES` with `COST_NEEDS_PERMISSION`) ([spec 0011](../0011-stock-ledger-locations/index.md) AC-26).
- **AC-6**: A receipt post requires an `Idempotency-Key` header holding a UUID, which becomes the receipt's id. The same key with the same body answers 200 with the same receipt and moves stock once. The same key with any field different (location, date, reference, note, or lines) answers 409 `IDEMPOTENCY_CONFLICT`. A missing or malformed key answers 400 `IDEMPOTENCY_KEY_REQUIRED`.
  > Amended 2026-11-06 (spec 0008 security review M1): the replay answers 200 only to the person who posted the receipt; anyone else gets 409 `IDEMPOTENCY_CONFLICT` whatever the body, so a replay cannot confirm a guessed cost.
- **AC-7**: A receipt with an unknown, archived, or not stockable SKU, a SKU listed twice, an unknown, archived, or system location, a future date, or a date on or before the inventory lock date is rejected with a stable code and posts nothing. Line faults are all reported at once, each with its line index.
- **AC-8**: Only an admin can void a posted receipt, giving a reason (1 to 500 characters). The void posts a ledger reversal dated now, sets the receipt to `voided` with who, when, why, and the reversal group, and takes each line's quantity back out of on hand. The value removed follows the ledger's average cost rules (spec 0002), so it equals the receipt's value only when no other stock of that SKU moved at that location in between. Lines never change. Voiding a voided receipt answers 409 `ALREADY_VOIDED`, including the loser of two voids sent at the same moment. If the stock has already left so the reversal would take a balance below zero (in a location that does not allow negative stock), it answers 409 `INSUFFICIENT_STOCK` naming the SKUs, and nothing changes.
- **AC-9**: The Stock page lists on hand per SKU and location from the ledger balances, showing SKU code, name, location, and on hand (plus average unit cost and stock value for admins). By default it lists rows with on hand other than 0, negative ones flagged; a Show zero toggle adds rows that went back to 0. It filters by the shell's current location (or all locations) and optionally one SKU, orders by most recent movement first, and pages 50 rows at a time.
- **AC-10**: A SKU's detail page shows its on hand per location (non zero rows and a total) and its movement history newest first, 50 per page with load more: date, location, signed quantity, source document number linking to the receipt (a void's row reads "Void of SR-…"), and who posted it (unit cost and line value for admins).
- **AC-11**: Unit cost, line totals, receipt reference value, average unit cost, and stock value are returned only to admins. For staff the api leaves those fields out of every response, replays included, and the screens hide those columns. Staff still enter unit cost on receipts.
  > Amended 2026-11-06 (spec 0008, AC-6): "admins" reads "people holding the `cost.view` grant". The api strips the fields per caller through `access.has('cost.view')`, and an idempotent replay answers only the person who posted the receipt, so a replay can never confirm a guessed cost.
  > Amended 2026-11-05: cost and value are returned only to people holding the `cost.view` grant, not to admins ([spec 0008](../0008-roles-as-hats/index.md) AC-6).
  > Amended 2026-11-07 by spec 0011: "Staff still enter unit cost on receipts" no longer holds: a person without `cost.view` sends no cost and the style cost is used ([spec 0011](../0011-stock-ledger-locations/index.md) AC-26).
- **AC-12**: The receipt list shows receipts newest first with number, date, location, reference, line count, status (voided ones badged), and who posted. It filters by the shell's current location (or all) and a search box matching number or reference (contains, ignoring case), and pages 50 at a time.
- **AC-13**: SKU search (`q`) matches a SKU code starting with `q` (uppercased) or an English or Arabic name containing `q` (ignoring case). The receipt line picker shows up to 20 active SKUs; the SKU list pages 50 at a time and can show archived ones.
  > Amended 2026-11-07 by spec 0012: search matches an exact barcode, a code prefix, or every word of the normalized query inside the variant's `search_text` (style names, codes, option values, Arabic normalized), and filters by season, group, and style ([spec 0012](../0012-catalog-styles-variants/index.md) AC-3, AC-4).
- **AC-14**: When a post or void hits the ledger's lock cap, the api answers 503 `BUSY` with `Retry-After: 2`. The web retries once with the same request after that delay, then shows a busy message with a Retry button and keeps the form filled.
- **AC-15**: Every endpoint needs a signed in session (401 otherwise). An admin only action called by staff answers 403 `FORBIDDEN`. The Locations page is in the navigation for admins only.
  > Amended 2026-11-07 ([spec 0008](../0008-roles-as-hats/index.md) AC-5, AC-11): "admin only" reads "needs the route's permission" (`catalog.manage` for SKU code changes, archive, delete and location writes, `stock.correct` for a receipt void); a person without it gets 403 `FORBIDDEN`, and a page opened by its address shows the no access state. The Locations item is in the navigation for people holding `catalog.manage`.
- **AC-16**: Every new screen works in English and Arabic (right to left) with no hard coded text. Codes and numbers show in `LtrText`, amounts, quantities, and dates go through `useFormat()`, stored names through `localizedText()`. Each page has exactly one `<h1>`, has loading, empty, and error states, and is fully usable by keyboard, the SKU picker included (WCAG 2.2 AA).
- **AC-17**: End to end: a signed in staff member creates SKU `TEE-BLK-M`, an admin creates warehouse `WH-CAI`, the staff member posts a receipt of 10 at 5.0000, and on hand 10 shows on the Stock page and the SKU's page in both languages (the admin also sees value 50.00). After the admin voids it, both show 0. A reconciliation run then records no discrepancy.
- **AC-18**: With the scale seed loaded (100,000 SKUs, 1,000,000 movements), on the dev Postgres at the 95th percentile: the Stock page's first page and a SKU's stock per location under 200 ms, SKU code prefix search under 100 ms, name contains search under 500 ms, and posting a 200 line receipt under 2 s.

## Decision

**Chosen option**: Option 1: an inventory owned stock receipt document, posted through `ledger.post` with a transaction callback.

A new `stock_receipts` document is written inside the ledger's own posting transaction through a new `within` callback, so the receipt, its gap free number, and its movements commit or roll back together. A new `catalog` module owns products and SKUs; the SKU actions that depend on stock state live in inventory. The web adds TanStack Query for server state and React Hook Form validated by the shared Zod contracts.

**Implementation skills**: `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `tanstack-query` (`tanstack-skills/tanstack-skills`, `.claude/skills/tanstack-query/`) · `react-hook-form-zod` (`secondsky/claude-skills`, `.claude/skills/react-hook-form-zod/`) · `shadcn` (`.claude/skills/shadcn/`) · `nextjs-app-router-patterns` (`wshobson/agents`, `.claude/skills/nextjs-app-router-patterns/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Modules and ownership

- **`apps/api/src/catalog/`** (new module): `products` and `product_variants`. Exports `CatalogService` (lookups by ids, search, `checkStockable(ids)`, `setArchived`, `setCode`, `deleteSku`). Controllers: `POST /api/products`, `GET /api/skus`, `GET /api/skus/:id`, `PATCH /api/skus/:id` (name, price), `DELETE /api/skus/:id`. Catalog imports nothing from inventory.
- **`apps/api/src/inventory/`** imports `CatalogModule` (one way, no cycle):
  - `locations/`: extended to full management.
  - `receipts/`: `stock_receipts`, `stock_receipt_lines`, the receipt controller.
  - `stock/`: `GET /api/stock`, `GET /api/skus/:id/stock`, `GET /api/skus/:id/movements` (inventory controllers on `/skus` paths, since they need ledger reads).
  - `sku-lifecycle/`: `SkuLifecycleService` and controller for the SKU actions that need stock state: `POST /api/skus/:id/archive`, `/unarchive`, `PATCH /api/skus/:id/code`. It checks and locks stock state here, then calls `CatalogService` for the write, in one transaction.
  - `ledger/`: extended (`within` callback, `FOR SHARE` master reads, `listStock`, `getMovements`, `usage`, `lockForArchive`).
- **Boundary**: only the ledger reads catalog tables from inside inventory (its existing `loadMaster` does). Every other inventory file gets SKU data through `CatalogService`. The receipts service never writes ledger tables; it writes only its own two tables, inside `within`, and moves stock only through `ledger.post` and `ledger.reverse`. The receipts controller imports only HTTP contracts, never the ledger's `PostingInput` (`controller-contracts.spec.ts`).
- **Web** (`apps/web/src/`): `catalog/` (SKU list, detail, dialogs), `inventory/` (stock page, receipts, locations). Routes: `/stock`, `/stock-receipts`, `/stock-receipts/new`, `/stock-receipts/[id]`, `/skus`, `/skus/[id]`, `/locations`. A new nav group `inventory` holds Stock, Receipts, SKUs, and Locations (`adminOnly`).
  > Amended 2026-11-06 (spec 0008, AC-11): nav items declare `needs` (Locations needs `catalog.manage`), not `adminOnly`.

### Data model sketch

Reused from [spec 0002](../0002-core-data-model/index.md) with no column changes: `products` (`name`, `status = active`, `archived_at`), `product_variants` (`sku`, `price`, `kind = stocked`, `tracking = none`, `base_uom_id = pc`, `archived_at`, `updated_at`), `locations` (`code`, `name`, `type`, `is_sellable = true`, `allow_negative = false`, `archived_at`, `updated_at`), `bins` (blocks location delete), `users` (spec 0005).

> Amended 2026-11-05: no longer true once the spec 0002 amendment is built: every table gains `tenant_id`, `products` gains the style columns, and `locations.type` and `is_sellable` give way to `kind`, `owner_type`, `party_id`, `is_sellable`, and `sellable_online` (spec 0002, Amendment A1, A12, A13).

One migration (`0008_*`, generated with `pnpm db:generate` so drizzle kit writes the journal and snapshot, then hand edited for the SQL drizzle kit cannot express) adds:

| Change | Detail |
|---|---|
| enum value | `ALTER TYPE movement_source_type ADD VALUE 'stock_receipt'`; the Zod `LedgerSourceType` enum in `packages/contracts/src/inventory.ts` gains it in the same change |
| enum | `stock_receipt_status` (`posted`, `voided`) |
| setting | `UPDATE settings SET value = value \|\| '{"stock_receipt": "SR"}' WHERE key = 'document_prefixes'` (merged, other keys kept) |
| index | `product_variants (sku COLLATE "C")` (required: the existing unique index uses the default collation and does not serve `LIKE 'X%'`) |
| index | `stock_levels (updated_at desc, id desc)` for the Stock page order |
| index | `stock_movements (variant_id, recorded_at desc, id desc)` for SKU history |
| grants | the app role's default privileges from migration 0001 include UPDATE and DELETE, so the migration runs `REVOKE UPDATE, DELETE ON stock_receipt_lines` and `REVOKE DELETE ON stock_receipts FROM ssdashboard_app` |

| Table | Fields | Constraints |
|---|---|---|
| `stock_receipts` | `id uuid pk` (the client's idempotency key), `request_hash text not null`, `number text not null`, `location_id uuid not null`, `effective_at timestamptz not null`, `reference text null` (≤ 64), `note text null` (≤ 500), `status stock_receipt_status not null default 'posted'`, `movement_group_id uuid not null`, `posted_by uuid not null`, `voided_at timestamptz null`, `voided_by uuid null`, `void_reason text null` (1 to 500), `void_group_id uuid null`, `created_at`, `updated_at` | unique `number`; fk `location_id → locations` RESTRICT; fk `movement_group_id → movement_groups`, unique; fk `void_group_id → movement_groups`, unique; fk `posted_by`, `voided_by → users`; check: `status = 'voided'` exactly when `voided_at`, `voided_by`, `void_reason`, `void_group_id` are all not null; index (`effective_at desc`, `id desc`); index (`location_id`, `effective_at desc`, `id desc`) |
| `stock_receipt_lines` | `id uuid pk` (derived, see Value sourcing), `receipt_id uuid not null`, `position int not null` (1 to 200), `variant_id uuid not null`, `uom_id uuid not null`, `quantity int not null` (1 to 1,000,000), `unit_cost numeric(14,4) not null` (≥ 0), `line_total numeric(14,2) not null` | fk `receipt_id → stock_receipts` RESTRICT; fk `variant_id → product_variants` RESTRICT; fk `uom_id → uoms`; unique (`receipt_id`, `variant_id`); unique (`receipt_id`, `position`); index (`variant_id`) |

Relationships: location 1:N receipts; receipt 1:N lines; receipt 1:1 posting group; receipt 0..1:1 void group; line 1:1 movement in the posting group, plus one in the void group after a void (both carry `source_line_id = line.id`; tell them apart by `group_id`); product 1:1 variant for now (1:N from feature 8).

> Amended 2026-11-07 by spec 0012: a product (style) has 1 to N variants ([spec 0012](../0012-catalog-styles-variants/index.md) AC-10).

After the revoke the application role holds INSERT and SELECT on `stock_receipt_lines` (write once, like movements) and INSERT, SELECT, UPDATE on `stock_receipts` (the void columns).

### State transitions

- **Stock receipt**: `posted` (created, numbered, stock moved, one transaction) → `voided` (admin, reason, reversal posted). `voided` is final. There is no draft.
- **SKU and location**: active ⇄ archived (admin). Delete only while unreferenced.

### API surface

All paths are under `/api`, behind the session guard. Bodies and queries are Zod schemas in `packages/contracts` (`catalog.ts`, `locations.ts`, `stock-receipts.ts`, `stock.ts`), each with its `limit` maximum. Lists use the keyset cursor convention (`cursor`, `limit`, `nextCursor`). `updatedAt` travels as the microsecond string described in Value sourcing.

| Endpoint | Owner | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|---|
| `/products` | catalog | POST | `name {en?, ar?}` (req, one language at least), `variants: [{ sku: string, price?: MoneyString }]` (req, exactly 1) | product id, its SKU (`SkuDetail`) | signed in | 400 `INVALID_INPUT`, 409 `SKU_TAKEN` |
| `/skus` | catalog | GET | `q?`, `status?` (`active` default, `archived`), `cursor?`, `limit?` (≤ 50, picker sends 20) | `items: SkuSummary[]` (id, code, name, price, archived), `nextCursor` | signed in | 400 `INVALID_QUERY` |
| `/skus/:id` | catalog | GET | id | `SkuDetail` (code, name, price, status, `updatedAt`) | signed in | 404 `NOT_FOUND` |
| `/skus/:id` | catalog | PATCH | `updatedAt` (req), `name?`, `price?` (nullable) | `SkuDetail` | signed in | 409 `STALE_RECORD`; 404 |
| `/skus/:id/code` | inventory | PATCH | `updatedAt` (req), `sku` (req) | `SkuDetail` | admin | 409 `STALE_RECORD`, `CODE_LOCKED`, `SKU_TAKEN`, `STYLE_CODE_TAKEN` (the new code is another product's style code, spec 0002 amendment); 403; 404 |
| `/skus/:id/archive` · `/unarchive` | inventory | POST | id | `SkuDetail` | admin | 409 `STOCK_ON_HAND` (archive); 403; 404; 503 `BUSY` |
| `/skus/:id` | catalog | DELETE | id | 204 | admin | 409 `IN_USE`; 403; 404 |
| `/skus/:id/usage` | inventory | GET | id | `{ codeLocked, canArchive }` (drives the read only code field and the archive button) | signed in | 404 |
| `/skus/:id/stock` | inventory | GET | id | `locations: [{ location, onHand, avgUnitCost?, totalValue? }]`, `totalOnHand`, `totalValue?` | signed in | 404 |
| `/skus/:id/movements` | inventory | GET | `cursor?`, `limit?` (≤ 50) | `items: [{ effectiveAt, recordedAt, location, quantity, sourceType, isReversal, source: { id, number } \| null, postedBy: { id, name } \| null, unitCost?, totalCost? }]`, `nextCursor` | signed in | 404, 400 |
| `/locations` | inventory | GET | existing switcher query (code keyset cursor kept), plus `status?` (`archived` is admin only) | existing `LocationSummary` list, plus `updatedAt`, `codeLocked`, `archived` | signed in (archived: admin) | 403, 400 `INVALID_QUERY` |
| `/locations` | inventory | POST | `code`, `name`, `type` (`warehouse` \| `showroom`) | `LocationDetail` | admin | 409 `LOCATION_CODE_TAKEN`; 403 |
| `/locations/:id` | inventory | PATCH | `updatedAt` (req), `name?`, `type?`, `code?` | `LocationDetail` | admin | 409 `STALE_RECORD`, `CODE_LOCKED`, `LOCATION_CODE_TAKEN`; 404 |
| `/locations/:id/archive` · `/unarchive` | inventory | POST | id | `LocationDetail` | admin | 409 `STOCK_ON_HAND`; 403; 404; 503 `BUSY` |
| `/locations/:id` | inventory | DELETE | id | 204 | admin | 409 `IN_USE` (receipts, movements, balances, or bins); 403; 404 |
| `/stock-receipts` | inventory | POST | header `Idempotency-Key: uuid` (req); `locationId` (req), `receiptDate?: YYYY-MM-DD`, `reference?`, `note?`, `lines: [{ skuId, quantity: int, unitCost: UnitCostString }]` (1 to 200) | 201 (200 on replay) `StockReceiptDetail` | signed in | 400 `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_INPUT`; 409 `IDEMPOTENCY_CONFLICT`, `LOCK_DATE_UNREADABLE`, `DOCUMENT_PREFIXES_UNREADABLE`; 422 `INVALID_LINES` (with `lineErrors: [{ index, code }]`, codes `UNKNOWN_SKU`, `ARCHIVED`, `NOT_STOCKABLE`, `DUPLICATE_SKU`, `LINE_TOTAL_TOO_LARGE`), `INVALID_LOCATION`, `FUTURE_DATE`, `PERIOD_LOCKED`, `ARCHIVED`, `AMOUNT_TOO_LARGE`; 503 `BUSY` |
| `/stock-receipts` | inventory | GET | `locationId?`, `q?`, `cursor?`, `limit?` (≤ 50) | `items: StockReceiptSummary[]`, `nextCursor` | signed in | 400 |
| `/stock-receipts/:id` | inventory | GET | id | `StockReceiptDetail` (number, status, location, effectiveAt, reference, note, postedBy, lines with SKU code and name, quantity, `unitCost?`, `lineTotal?`, `totalQuantity`, `referenceValue?`, void block) | signed in | 404 |
| `/stock-receipts/:id/void` | inventory | POST | `reason` (req, 1 to 500) | `StockReceiptDetail` | admin | 409 `ALREADY_VOIDED`, `INSUFFICIENT_STOCK` (with `skuIds`), `LOCK_DATE_UNREADABLE`; 422 `REASON_REQUIRED` (missing or blank reason, spec 0010 AC-5, amended 2026-11-06); 400 `INVALID_INPUT` (reason over 500 characters); 403; 404; 503 `BUSY` |
| `/stock` | inventory | GET | `locationId?`, `skuId?`, `includeZero?` (default false), `cursor?`, `limit?` (≤ 50) | `items: [{ sku, location, onHand, negative, avgUnitCost?, totalValue?, lastMovedAt }]`, `nextCursor` | signed in | 400 |

> Amended 2026-11-05: the `POST /locations` and `PATCH /locations/:id` rows take `kind` (`warehouse` | `shop`) and an `owner_type` defaulting to `own` instead of `type` (`warehouse` | `showroom`) (spec 0002, Amendment A13; build plan milestone 2).

> Amended 2026-11-07 by spec 0011: `POST` and `PATCH /locations` no longer take `sellableOnline`; the online location changes only through the gated `POST /locations/:id/make-online` and `POST /locations/online/stop` (one online location, a sellable warehouse); archive turns `sellable_online` off; `GET /locations` items add `partyId`, `partyName`, `online`, and `stockVerifiedAt` ([spec 0011](../0011-stock-ledger-locations/index.md) AC-1, AC-12, AC-19).

**Error mapping** (one function, `inventory/ledger-http.ts`, used by every inventory controller; it also sets the `Retry-After` header):

| Thrown | HTTP |
|---|---|
| `LedgerError` `InvalidInput` · `InvalidCost` | 400 `INVALID_INPUT` · 422 `INVALID_INPUT` |
| `UnknownReference` · `Archived` · `NotStockable` · `TrackingMismatch` | 422 `UNKNOWN_REFERENCE` · `ARCHIVED` · `NOT_STOCKABLE` · `NOT_STOCKABLE` (after the receipts pre check these only happen on a race; no line index) |
| `FutureDate` · `PeriodLocked` | 422 `FUTURE_DATE` · `PERIOD_LOCKED` |
| `NumberingError` `DocumentPrefixesUnreadable` | 409 `DOCUMENT_PREFIXES_UNREADABLE` (the stored `document_prefixes` fails its schema, so no numbered document is issued until it is set again; spec 0009 AC-2, amended 2026-11-07) |
| `LockDateUnreadable` | 409 `LOCK_DATE_UNREADABLE` (the stored `inventory_lock_date` fails its schema, so every posting is refused until it is set again; spec 0009 AC-2, amended 2026-11-07) |
| `InsufficientStock` | 409 `INSUFFICIENT_STOCK` |
| `IdempotencyConflict` | 409 `IDEMPOTENCY_CONFLICT` |
| `AlreadyReversed` | 409 `ALREADY_VOIDED` (only reachable if a reversal of the group was ever posted under another key) |
| `LockTimeout` (any 55P03 inside `ledgerTransaction`: advisory, row, idempotency, or the numbering counter row) | 503 `BUSY`, `Retry-After: 2` |
| `InvalidAmountError` (from `Money` or `UnitCost`, an amount past `numeric(14,2)`, e.g. a balance's total value) | 422 `AMOUNT_TOO_LARGE` |
| `InvalidCursorError` | 400 `INVALID_QUERY` |
| `NumberingError` (missing prefix setting), any other ledger code | 500, logged (a configuration or code bug) |

**Internal additions to `LedgerService`** (spec 0002 rules unchanged):

| Function | Inputs | Outputs | Notes |
|---|---|---|---|
| `post(input, options?)`, `reverse(input, options?)` | `options.within?: (tx, result) => Promise<void>` | as today, plus `replayed: boolean` | `within` runs after `write()`, inside the same transaction and lock cap. On the single deadlock retry the whole transaction reruns, `within` included; any state the callback keeps is created inside it, so each attempt starts clean. It does not run on a replay (`replayed: true`). A throw rolls everything back. |
| `loadMaster` (changed) | | | Reads the variants and locations it checks with `FOR SHARE`, so an archive (which takes `FOR UPDATE`) waits for an in flight posting, and the reverse. |
| `lockForArchive` | `variantId` or `locationId`, a transaction | the locked row (or null) | Takes `FOR UPDATE` on that one SKU or location row and nothing else: **no `lockPairs`, no advisory locks, no scan of balance or reservation rows**, so the lock count does not grow with the number of balances. Used inside the archive, unarchive, and code change transactions before `usage` or the `hasBalance` check. See Key invariants for why the row lock is enough. |
| `listStock` | `locationId?`, `variantId?`, `includeZero`, `cursor?`, `limit` | one row per balance row: `variant_id`, `location_id`, `on_hand`, `total_value`, `updated_at` | Excludes transit and virtual locations. Keyset on (`updated_at desc`, `id desc`), served by the new index. In this slice a balance row is one SKU at one location (no bins or lots); grouping several bins or lots into one row comes with feature 10. |
| `getMovements` | `variantId`, `cursor?`, `limit` | movements newest first with group `source_type`, `source_id`, `reverses_group_id`, `posted_by` | Keyset on (`recorded_at desc`, `id desc`), served by the new index. |
| `usage` | `variantIds?` or `locationIds?`, optional transaction | per id: `hasBalance`, `onHandNonZero`, `activeReserved` | Read only. Inside the archive or code change transaction it runs after `lockForArchive`; under READ COMMITTED each statement sees everything committed by then, so the answer is settled. |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| create SKU | product and variant ids | database `uuidv7()` defaults |
| create SKU | `sku`, location `code` | input, trimmed and uppercased in the Zod contract before the pattern check |
| create SKU | `kind`, `tracking`, `base_uom_id`, product `status` | fixed: `stocked`, `none`, the `uoms` row with code `pc`, `active` |
| create SKU | `price` | input (`MoneyString`, 2 decimals) or null |
| any read | `updatedAt` | `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` (microseconds, the ledger's `ISO_UTC` format), never a JS `Date` |
| edit SKU or location | stale check | `UPDATE ... SET ..., updated_at = now() WHERE id = $1 AND to_char(updated_at ...) = $updatedAt`; 0 rows updated and the row exists → `STALE_RECORD`. Every write (edit, code change, archive, unarchive) sets `updated_at = now()` explicitly (there is no trigger). For a SKU the check is on the variant row; the product row is updated in the same transaction |
| SKU code change | `codeLocked` | derived: `ledger.usage(variantId).hasBalance` (every posting creates a balance row, so this covers receipts and movements), read inside a transaction that first took `ledger.lockForArchive` (row `FOR UPDATE`) on the variant, so a posting in flight is waited for and its balance row is visible |
| location code change | `codeLocked` | derived: `ledger.usage(locationId).hasBalance` or any `stock_receipts` row for it; computed by the locations service inside a transaction that first took `ledger.lockForArchive` (row `FOR UPDATE`) on the location |
| archive SKU or location | allowed? | inside one transaction: `ledger.lockForArchive` (row `FOR UPDATE` only), then `usage().onHandNonZero` and `activeReserved` both false, then the archive update. Unarchive needs only `lockForArchive` (the row lock) and the update; it reads no usage |
| delete SKU or location | allowed? | the `DELETE` succeeds; a foreign key violation (23503, from receipt lines, movements, balances, lots, serials, barcodes, or bins) answers a generic `IN_USE`. A SKU delete removes the variant then the product in one transaction |
| post receipt | receipt `id` | header `Idempotency-Key` (a UUID, made by the web with `crypto.randomUUID()` when the form opens, kept across retries) |
| post receipt | `request_hash` | derived: SHA-256 of canonical JSON of `locationId`, `receiptDate` (as sent, or null), `reference`, `note`, and the lines in input order with `unitCost` normalized to 4 decimals |
| post receipt | replay or conflict | step 1, before the ledger: a receipt with this id exists → same `request_hash` gives 200 with it, else 409. Step 2, on a ledger replay (`replayed: true`, a concurrent first request won): load the receipt by id and apply the same comparison (amended 2026-11-06: the 200 goes only to the person who posted the receipt; anyone else gets 409) |
| post receipt | 201 or 200 | `replayed` from the ledger result: false → 201 |
| post receipt | line faults | the receipts service checks every line before posting (`CatalogService.checkStockable`: exists, not archived, `stocked`, tracking `none`; duplicates; `quantity × unitCost ≤ 9,999,999,999.99`) and returns all faults with indexes in one 422 `INVALID_LINES` |
| post receipt | location check | the receipts service: exists, not archived, type `warehouse` or `showroom`, else 422 `INVALID_LOCATION` (the ledger alone would accept transit and scrap) |
| post receipt | ledger `idempotencyKey` | derived: `stock_receipt:<receipt id>` |
| post receipt | ledger `sourceType`, `sourceId` | fixed `stock_receipt`; the receipt id |
| post receipt | `effective_at` | input `receiptDate`: absent → omitted (ledger defaults to now); equal to today in setting `timezone` → omitted; an earlier day → `(receiptDate + time '12:00') AT TIME ZONE <timezone>` computed in SQL (Cairo daylight saving handled by Postgres); a later day → `FUTURE_DATE` before posting. The ledger then applies its lock date rule |
| post receipt | web `receiptDate` | sent only when the user changed the date field; otherwise omitted, so a retry after midnight keeps the same body and hash |
| post receipt | `number` | `numbering.next(tx, 'stock_receipt', new Date(result.effectiveAt))`, called last inside `within` |
| post receipt | prefix | setting `document_prefixes.stock_receipt` (seeded `SR`) |
| post receipt | `posted_by` | session user id (`current-staff`) |
| post receipt | line `uom_id` | the SKU's `base_uom_id` (factor 1; feature 8 adds conversion) |
| post receipt | line `position` | input order, from 1 |
| post receipt | line `id` | derived, never random: UUID v5 of `<receipt id>:<position>` under a fixed namespace constant in `receipts/line-id.ts`. It is sent as `sourceLineId` and inserted with that id. It must be deterministic because the ledger's request hash includes `sourceLineId`: random ids would make an honest retry hash differently and fail |
| post receipt | movement `unitCost`, `quantity` | the line's `unit_cost` and `quantity` (inbound, positive) |
| post receipt | `line_total` | derived: `round(quantity × unit_cost, 2)` half away from zero (`LineAmounts` rules of spec 0002). It is the reference cost; the movement's ledger `total_cost` can differ when stock was negative, and the ledger value is the authority |
| receipt detail | `referenceValue` (admin) | derived: sum of `line_total`, labelled "reference value" in the UI |
| receipt replay | response fields | the stored receipt, passed through the caller's role serializer (a staff caller never gets cost, whoever posted it) |
| void | already voided? | the receipt row read `FOR UPDATE` first: `voided` → 409 `ALREADY_VOIDED`. A concurrent loser waits on that row lock, then sees `voided` → 409 |
| void | ledger `idempotencyKey` | derived: `stock_receipt_void:<receipt id>` (a receipt is voided at most once, so no header is needed) |
| void | `effectiveAt` | omitted (now) |
| void | ledger `reasonCode` | fixed `stock_receipt_void`; the free text goes to `void_reason` |
| void | `voided_by`, `voided_at`, `void_group_id` | session user, `now()`, the reversal's group id, written inside `within` |
| void | value removed | the ledger's outbound rule at the balance's current average (spec 0002 Value sourcing, `reverse`) |
| stock page | `onHand`, `negative` | `ledger.listStock` row's `on_hand`; `negative` = `on_hand < 0` |
| stock page | `avgUnitCost` (admin) | derived: `round(totalValue / onHand, 4)` when `onHand > 0`, else null |
| stock page | `totalValue` (admin) | the row's `total_value` |
| stock page | `lastMovedAt` | the row's `updated_at` |
| stock page | SKU code and name | `CatalogService.getSkus(ids)` for the page's variant ids (one query per page) |
| stock page | location filter default | the web's `useCurrentLocation()`; "All locations" sends no `locationId` |
| SKU stock | per location rows | `ledger.getLevels({ variantId })` summed per location in the service |
| SKU history | source number | for `source_type = stock_receipt`, `stock_receipts.number` by `source_id` (same module); other types show the type label with no link |
| SKU history | `isReversal` | group `reverses_group_id` is not null; the UI reads "Void of SR-…" |
| SKU history | posted by name | a new `StaffService.namesByIds(ids)` exported by the staff module; a null `posted_by` (a system job) shows "System" |
| any response | cost fields present? | session role is `admin`, applied by one serializer per response type |
| SKU search | match | `sku COLLATE "C" LIKE upper(q) || '%'` (the same expression as the new index) OR `name->>'en' ILIKE '%' || q || '%'` OR `name->>'ar' ILIKE '%' || q || '%'`, with `%`, `_`, and `\` in `q` escaped. Codes are always stored uppercased, so an uppercased prefix finds every code |
| receipt list | search | `number ILIKE '%q%'` OR `reference ILIKE '%q%'`, escaped |
| busy retry | delay | response header `Retry-After` (2 seconds), set by `ledger-http.ts` |

> Amended 2026-11-05: the receipt location check reads `kind` `warehouse` or `shop` instead of `type` `warehouse` or `showroom` (spec 0002, Amendment A13).

> Amended 2026-11-07 by spec 0012: the SKU search row above is replaced by spec 0012's three branch search over `product_variants.search_text` ([spec 0012](../0012-catalog-styles-variants/index.md), Search).

### Key invariants

- A receipt exists exactly when its ledger posting group exists: both are written in one transaction, so a crash leaves neither. A voided receipt always has its reversal group, and the reverse.
- Each line has exactly one movement in the receipt's posting group (`movement_group_id`), with the line's quantity and unit cost, and after a void exactly one more in the void group. Joins from a line to "its" movement always filter by `group_id`. Lines never change after insert.
- Receipt numbers are gap free per year because `numbering.next` runs in the same transaction, last. The counter row lock is held until commit, so receipts are serialized for the tail of each transaction, which is fine at this volume.
- Only `LedgerService` writes ledger tables, and inside inventory only the ledger reads catalog tables. The receipts service writes only its own two tables, and only inside `within`.
- Catalog never imports inventory. Stock dependent SKU actions live in inventory and call catalog for the write.
- Archive and posting exclude each other through the SKU and location rows alone, with no per pair locks. `post`, `reverse` (it runs `apply`), and `reserve` all call `loadMaster`, which reads the SKU and location rows `FOR SHARE` in id order, before `lockPairs`, and holds them until commit. `lockForArchive` takes `FOR UPDATE` on the one row, which conflicts with `FOR SHARE`: it waits for every in flight posting or reservation on that SKU or location, and blocks new ones. Under READ COMMITTED a posting that waited re-reads the row after the archive commits, sees `archived_at` set, and fails `ARCHIVED`. `usage` (and the code change `hasBalance` check) runs after the row lock is held, so it sees every committed posting and none in flight: a settled state. Archive, unarchive, SKU code change, and location code change all follow "row `FOR UPDATE`, then the check". The archive never locks balance or reservation rows, so a location with 10,000 historic balance rows takes the same one lock as an empty one (the earlier per pair design exhausted Postgres's shared lock table, `max_locks_per_transaction` times `max_connections`, with "out of shared memory").
- Every writer of balances or reservations is covered. `post`, `reverse`, `reserve`, and `rebuildLevel` read the SKU and location rows `FOR SHARE` (in id order, before `lockPairs`) and hold them until commit; `rebuildLevel` takes them from the discrepancy's `variant_id` and `location_id`, so a rebuild held before commit makes an archive wait, and an archive holding the row makes a rebuild wait. `release` takes no master lock and is safe for "nothing on hand and nothing reserved": it only lowers `open_quantity` or closes a reservation, so it can never add a reservation; racing an archive it can at worst make the archive see a reservation still active and refuse (409), never accept wrongly.
- Accepted edge (rebuild after archive): `rebuildLevel` waits for an archive (the `FOR SHARE` on the master rows) but does not re-check `archived`. "Archived means nothing on hand" is true *according to the balance at archive time*. If a balance had drifted to 0 while an open discrepancy said otherwise, the archive succeeds, and a later rebuild that corrects the drift restores on hand (for example 2) on the archived SKU or location. The data then matches the movements, and postings on that record fail `ARCHIVED` until an admin unarchives it. The stock stays visible on the Stock page and is fixed by unarchive. This is kept on purpose: a rebuild must repair the ledger truth, not refuse to. `apps/api/test/master-data.e2e-spec.ts` asserts it ("a SKU archive in flight first: the rebuild waits until the archive commits").
- Cost fields are removed in the api by one serializer per response type, based on the caller's role, never only hidden in the UI.
- Codes are always stored uppercased (here and, per the follow up, in the import).

### Security model

- Every endpoint is behind the existing session guard; admin only routes use `@Roles('admin')` (403 `FORBIDDEN`).
  > Amended 2026-11-07 ([spec 0008](../0008-roles-as-hats/index.md) AC-4, AC-5): `@Roles` is deleted. Every handler declares `@Permission(...)` (the "Staff" list below is `stock.view`, `stock.receive` and `catalog.edit`; the "Admin" list is `catalog.manage` and `stock.correct`), and cost follows the `cost.view` grant (AC-11 note).
- Staff: create SKUs and edit their name and price; post receipts; read SKUs, locations, receipts, stock, movements (without cost fields).
- Admin: everything staff can do, plus SKU code changes, archive, unarchive, delete; all location writes and the archived location list; receipt void.
- Cost and stock value are commercially sensitive: removed from staff responses, replays included (AC-11). Feature 13 replaces the role check with a cost permission.
- The client chooses the receipt id (its idempotency key). A guessed key that matches another person's receipt with the same body returns that receipt, which every signed in person can already read, through the caller's own serializer; a different body gets 409. No data leaks.
- Audit: receipts record `posted_by` and `voided_by`, `voided_at`, `void_reason`; movements are the stock audit record. Master data change history is feature 14.
- No personal data, payments, or regulated data. No public endpoint, so no new rate limits.
- Log lines (NestJS `Logger`, info): `stock_receipt.posted` and `stock_receipt.voided` with receipt id, number, location id, line count, user id; warn on each `BUSY`; error on each mapped 500. Never log cost values.

### Configuration required

None. The `SR` prefix is a seeded setting, not an environment variable.

### Critical test scenarios

- Happy path: staff creates `TEE-BLK-M`, admin creates `WH-CAI`, staff posts a receipt of 10 at 5.0000; the receipt is `SR-<year>-000001`, the Stock page and SKU detail show 10 (admin sees 50.00), one movement in the posting group links to the line; Playwright runs it in English and Arabic, verifies **AC-1**, **AC-4**, **AC-5**, **AC-9**, **AC-10**, **AC-16**, **AC-17**
- Atomicity: make the callback's line insert fail (a test hook) after the movements are written; no receipt, no movement, no balance change, and the next receipt takes the same number, verifies **AC-5**
- Callback retry: force a deadlock on the first attempt; the transaction reruns, the callback runs twice, and exactly one receipt and one number result, verifies **AC-5**
- Idempotency: post the same key and body twice in parallel; one receipt, stock moved once, one 201 and one 200 with the same id; a retry from a fresh api process also answers 200 (line ids are deterministic); the same key with only the note changed gives 409, and with a changed quantity gives 409, verifies **AC-6**
- Validation: one receipt with a duplicate SKU, an archived SKU on line 3, and a line over the total cap answers one 422 listing indexes 1, 2, and the cap line; a system location, tomorrow's date, and a date before the lock date each post nothing, verifies **AC-5**, **AC-7**
- Backdate: a receipt dated yesterday is numbered in yesterday's year and its movement `effective_at` is 12:00 Cairo yesterday, also across a daylight saving change; on 1 January a receipt dated 31 December takes last year's sequence, verifies **AC-5**
- Void: void returns on hand to 0 and the status to `voided`; voiding again gives 409 `ALREADY_VOIDED`; two voids in parallel give one success and one 409; after another posting takes the stock out, a void gives 409 `INSUFFICIENT_STOCK` and changes nothing; staff calling void get 403, verifies **AC-8**, **AC-15**
- Void value: receive 10 at 5.0000 (receipt A), then 10 at 7.0000 (receipt B); void A: on hand 10, and value removed is 60.00 at the 6.0000 average, not A's 50.00, with the balance matching a rebuild, verifies **AC-8**
- Archive race: start a receipt posting and hold it before commit; an archive of the same SKU waits, then fails `STOCK_ON_HAND`; in the reverse order the posting fails `ARCHIVED`; the same two orders for a `reserve`, and for a location archive, verifies **AC-3**
- Archive at scale (Critical): archive a location that has 10,000 balance rows, all with on hand 0 (and some released reservations), in one transaction; it succeeds (no "out of shared memory", no 500), and the archive transaction holds no advisory locks and a lock count that does not grow with the 10,000 rows (the test reads `pg_locks` for its backend), verifies **AC-3**, **AC-4**
- Rebuild race: hold a `rebuildLevel` before commit; an archive of that SKU (and of that location) waits; in the reverse order, with an archive holding the row, the rebuild waits, verifies **AC-3**, **AC-17**
- Code change race: hold a posting of a SKU (and of a location) before commit; the code change waits on the row lock, then answers `CODE_LOCKED` because the posting's balance row is now visible, verifies **AC-2**
- Archive and code rules: archiving a SKU with on hand 10 gives 409 `STOCK_ON_HAND`; after a void it archives and leaves the picker; changing the code of a posted SKU gives `CODE_LOCKED`; deleting an unposted SKU works, a posted one gives `IN_USE`; a location with a bin cannot be deleted; two edits from the same `updatedAt` give one success and one `STALE_RECORD`, and an edit with the value just read always succeeds (microsecond round trip), verifies **AC-2**, **AC-3**, **AC-4**
- Cost hiding: as staff, every receipt (replays included), stock, SKU stock, and movement response has no cost or value field, and the columns are absent; as admin they are present, verifies **AC-11**
  > Amended 2026-11-06: "as staff" and "as admin" read "without `cost.view`" and "with `cost.view`" (spec 0008).
- Busy: hold the balance's advisory lock in another transaction; the post answers 503 `BUSY` with `Retry-After: 2`; the web retries once, then shows the busy message with the form kept, verifies **AC-14**
- Lists and search: receipt search by reference, location filter, voided badge; SKU search by code prefix, Arabic name fragment, and with `%` in `q`; Stock page hides zero rows until toggled and shows a negative row flagged; SKU history shows the void row as "Void of SR-…", verifies **AC-9**, **AC-10**, **AC-12**, **AC-13**
- Auth: every endpoint without a cookie answers 401; staff do not see Locations in the nav and get 403 on its endpoints and on the SKU code change, verifies **AC-2**, **AC-15**
- Accessibility: axe checks on every new page in both languages; the receipt form, including the SKU combobox and adding and removing lines, works by keyboard alone, verifies **AC-16**
- Scale: with the scale seed, the latency targets hold, using the new indexes, verifies **AC-18**
- Reconciliation: after the happy path and a void, the test calls `ReconciliationService.reconcile()` directly and no discrepancy is recorded, verifies **AC-17**

## Build plan

Tracer Bullet: Milestone 1 is the whole scope "done when" thread, thin but real through every layer (one SKU, one location, one receipt, stock on hand, both languages). Later milestones thicken each segment end to end.

**Milestone 1: The thin thread**
1. [x] Migration `0008`: `stock_receipt` source type (and the Zod `LedgerSourceType`), `stock_receipt_status`, `stock_receipts` with `request_hash`, `stock_receipt_lines`, the three indexes, the revokes, and the `SR` prefix merged into `document_prefixes`, satisfies **AC-5**, **AC-13**
2. [x] `LedgerService` `within` callback and `replayed` flag on `post` and `reverse`, with tests for commit, rollback on throw, rerun on the deadlock retry, and no run on replay, satisfies **AC-5**, **AC-6**
3. [x] `catalog` module and contracts: `POST /products`, `GET /skus/:id`, and `GET /skus?q` (code prefix and name contains, active only, for the line picker), satisfies **AC-1**, **AC-13**
4. [x] Location create (`POST /locations`, admin) on the existing locations service, satisfies **AC-4**
5. [x] `POST /stock-receipts`: idempotency (id pre check, `request_hash`, replay comparison), line and location pre checks with all faults, the line total cap, deterministic line ids, numbering inside `within`, `ledger-http.ts` with the full error table and `Retry-After`; `GET /stock-receipts/:id`, satisfies **AC-5**, **AC-6**, **AC-7**, **AC-14**
6. [x] `ledger.listStock` and `GET /stock`, plus `GET /skus/:id/stock`, with the role based cost serializers, satisfies **AC-9**, **AC-10**, **AC-11**
7. [x] Web: add TanStack Query (provider in `providers.tsx`) and React Hook Form with the Zod resolver; the inventory nav group; minimal New SKU dialog, New location dialog, receipt form (SKU combobox, lines), receipt detail, and Stock page, all strings in English and Arabic, satisfies **AC-1**, **AC-4**, **AC-5**, **AC-9**, **AC-16**
8. [x] Playwright thread test in both languages and a direct reconciliation check, satisfies **AC-17**

**Milestone 2: Receipts in full**
9. [x] Receipt list with location filter, search, and paging (api and web), satisfies **AC-12**
10. [x] Void: `POST /stock-receipts/:id/void` (row lock, status check, `ledger.reverse` with `within`), admin only, the void dialog with reason, and the void value test, satisfies **AC-8**, **AC-15**
11. [x] Web busy handling: one automatic retry after `Retry-After`, then the busy message with Retry, satisfies **AC-14**
12. [x] Backdating with `receiptDate` (date field sent only when changed, the SQL noon rule, future and lock date errors on the field), satisfies **AC-5**, **AC-7**

**Milestone 3: Master data in full**
13. [x] `GET /skus` paging and the archived filter, `%`, `_`, and `\` escaping, and the SKU list page, satisfies **AC-13**
14. [x] SKU edit (catalog, microsecond `updatedAt`, `STALE_RECORD`); `sku-lifecycle/` in inventory: `PATCH /skus/:id/code` with `CODE_LOCKED`, archive and unarchive with `ledger.lockForArchive` (row lock only, see 14a) and `usage`, `GET /skus/:id/usage`; `FOR SHARE` in `loadMaster`; delete with `IN_USE`; the archive race test, satisfies **AC-2**, **AC-3**
15. [x] Locations page (admin): list with archived filter, edit, archive (same locking), unarchive, delete, system locations hidden and 404, satisfies **AC-4**, **AC-15**
16. [x] SKU detail: stock per location and movement history with `ledger.getMovements`, `isReversal`, `StaffService.namesByIds`, and load more, satisfies **AC-10**, **AC-11**
- 14a. [x] Fix: `lockForArchive` takes `FOR UPDATE` on the SKU or location row only (remove the `stock_levels`/`reservations` pair scan and `lockPairs`); archive, unarchive, SKU code change, and location code change each run "row `FOR UPDATE`, then `usage`/`hasBalance`" in one transaction; update the `lockForArchive` doc comment (the locking text in `apps/api/src/inventory/AGENTS.md` is handled by the `/sync` follow-up below, not here); `rebuildLevel` (`reconciliation.service.ts`) reads the SKU and location rows `FOR SHARE` in id order before its `lockPairs`; add the "Archive at scale", "Code change race", and "Rebuild race" tests, satisfies **AC-2**, **AC-3**, **AC-4**

**Milestone 4: Hardening**
17. [x] Stock page polish: Show zero toggle, negative flag, SKU filter, empty and error states; axe and keyboard checks on every new page in both languages, satisfies **AC-9**, **AC-16**
18. [x] Scale checks added to `test/scale.e2e-spec.ts` (stock page, SKU stock, both searches, a 200 line receipt), satisfies **AC-18**

## Consequences

**Positive**:
- The whole pipe (browser, contract, controller, ledger, Postgres, and back) is proven before any module goes deep.
- The `within` callback is the one pattern every later document (purchase receipts, shipments, transfers, adjustments) uses to commit its document, number, and stock together.
- The products in, SKUs out API shape lets feature 8 add variants without breaking a contract.
- TanStack Query and React Hook Form, set up once here, carry every later screen.

**Negative / tradeoffs**:
- `LedgerService` grows a callback hook: caller code now runs inside the ledger's locked transaction, so a slow callback holds stock locks longer. Callbacks must only write their own rows and issue the number.
- SKU endpoints are split across two modules (catalog for data, inventory for stock dependent actions), so a developer looks in two places.
- `FOR SHARE` on master rows during every posting adds a little lock traffic; an archive waits behind in flight postings.
- Decision (amended 2026-11-04): `lockForArchive` no longer takes per pair advisory locks. They exhausted the shared lock table on a location with about 10,000 balance rows and added nothing, because the row `FOR UPDATE` already excludes every posting and reservation (see Key invariants). `rebuildLevel` now reads the SKU and location rows `FOR SHARE` first, so it joins the same exclusion.
- SKU name search is a plain scan; at full catalog size it is near the 500 ms budget until feature 9 adds real search.
  > Amended 2026-11-07 by spec 0012: no longer true once spec 0012 milestone 1 is built: name search uses a trigram index.
- The Stock page orders by last movement, not by SKU code, because inventory may not join catalog tables. Users find a SKU with the SKU filter.
- A void removes value at the current average, not the receipt's own value, so a void after other movements shifts the remaining average. This is the ledger's costing model, not a bug, but users may ask.
- Hiding cost by role is coarse: a warehouse lead who should see cost must be made an admin until feature 13.
- No drafts: a long delivery must be entered in one sitting.
- Two new web dependencies to keep current.
- The client chooses receipt ids (as UUIDs), so ids are random UUIDs rather than time ordered `uuidv7`, which spreads index inserts slightly.

**Neutral**:
- `stock_receipt` becomes a ledger source type the accounting export (feature 50) must map.
- Feature 22's purchase receipts are a separate document; stock receipts stay for receipts with no purchase order.
- Lists sort codes with `COLLATE "C"`, per the api's list convention.

## Follow-up

- [ ] Root `AGENTS.md` `## Rules` (or `apps/web/AGENTS.md`): record that business data loads through TanStack Query and forms use React Hook Form with the contract's Zod schema; add `tanstack-query` and `react-hook-form-zod` to `apps/web/AGENTS.md` `## Agent skills` (web only scope). `/sync` owns the edit.
- [ ] `apps/api/src/inventory/AGENTS.md`: document the `within` callback rule (callbacks write only their own rows, issue the number last, keep no state across attempts), the archive locking (`lockForArchive` = row `FOR UPDATE` only, no pair locks; `FOR SHARE` in `loadMaster`), and that the ledger is the one inventory reader of catalog tables. `/sync` owns the edit.
- [ ] `apps/api/AGENTS.md`: add the new `src/catalog/` module and `src/inventory/sku-lifecycle/` to Key files. `/sync` owns the edit.
- [x] Decided (2026-11-04): `rebuildLevel` reads the SKU and location rows `FOR SHARE` first (id order, as `loadMaster`), before `lockPairs`, so it joins the archive exclusion. Built in 14a.
- [ ] Feature 25 (discrepancy UI): warn before rebuilding a discrepancy onto an archived SKU or location, since the rebuild can restore on hand there (see Key invariants, accepted edge). Offer unarchive as the fix.
  > Amended 2026-11-07 by spec 0011: owned by [spec 0011](../0011-stock-ledger-locations/index.md) AC-14 (the warning is part of its rebuild dialog).
- [ ] Feature 8: lift the one variant limit on `POST /products`, add unit conversion on receipt lines (`uom_id` and factor).
  > Amended 2026-11-07 by spec 0012: variants are added through `POST /api/styles/:id/variants` (AC-10); unit conversion stays open.
- [ ] Feature 9: replace the name contains scan with indexed search; revisit Stock page ordering by SKU code.
  > Amended 2026-11-07 by spec 0012: indexed search is taken by spec 0012 milestone 1; Stock page ordering stays open.
- [ ] Feature 10: group several bins (and lots, feature 18) into one Stock page row per SKU and location without losing the 200 ms budget.
- [ ] Feature 13: replace the admin check for cost fields with a cost permission.
- [ ] Feature 14: master data change history for SKUs and locations.
- [ ] Feature 15: the import must uppercase SKU and location codes, like the forms.
- [ ] Feature 50: map the `stock_receipt` source type in the accounting export.
- [ ] Consider receipt drafts with feature 22 if long deliveries need them.
- [ ] MCP servers for TanStack Query and React Hook Form: none credible found (only early community wrappers); revisit if an official one appears.
