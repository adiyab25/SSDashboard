# 0002. Core data model: rationale

Back to the build spec: [index.md](index.md).

## Context

SSDashboard runs stock, purchasing, sales, and production for an ecommerce business with thousands to 100,000+ SKUs across warehouses and showrooms, and later for more clients from one shared core. Each client has its own install and database, so no table needs a tenant column. The books live in a separate accounting app, which means this system must keep exact cost and price on every transaction and be able to prove any stock value it exports.

The data model is the most expensive thing to change later. Migrations here only move forward and follow expand and contract, and installs are pinned to versions, so a wrong choice in the stock tables means a slow, careful migration on every client. The model has to carry purchasing, sales, production, lots, serials, bins, and the accounting export before most of those features are designed.

The business works in one currency (EGP, 2 decimals), sells through Shopify style channels, and needs fast reads of stock on hand at full catalog size. Prices are usually shown with 14% VAT included. Staff sometimes enter paperwork days late, while the accountant needs closed months to stay closed. The team is 1 to 3 developers, so the design must be easy to reason about and hard to misuse.

Without a decision, every module would invent its own way to change stock, and balances would drift with no way to prove which number is right.

## Options considered

### Option 1: Append only ledger plus a maintained balance table

Movements are immutable rows. The ledger service updates a `stock_levels` row in the same transaction under a row lock. A nightly job rebuilds balances from movements and reports mismatches.

**Pros**:
- Instant reads of on hand, reserved, and value at any catalog size.
- Full history and traceability, with every balance provable from movements.
- Row locks give a simple, correct answer to concurrent sales of the same item.

**Cons**:
- Two representations of stock that must stay in step, so it needs a reconciliation job.
- Row locks serialize writes to one hot balance.

### Option 2: Append only ledger, balances summed on read

Only movements are stored. Every read sums the ledger, possibly through a view.

**Pros**:
- One source of truth, with nothing to drift.
- The simplest write path.

**Cons**:
- Reads slow down as movements grow into the millions, which hurts search, reorder, and channel sync.
- Concurrency still needs locks to block negative stock, so the simplicity is partly lost.

### Option 3: Ledger with periodic snapshots

Daily snapshots of balances, with movements after the snapshot added on read.

**Pros**:
- Fast reads without a balance row updated on every write.
- Snapshots double as month end records.

**Cons**:
- Reads still combine two sources, and the snapshot job becomes critical.
- Negative stock checks still need a lock on something, so you pay the complexity without the instant reads.

### Option 4: Mutable quantity per item and location (Shopify style)

Store only the current quantity per SKU and location and adjust it in place, keeping a light history log.

**Pros**:
- Fewest tables, very fast, and the same shape as Shopify's inventory levels.

**Cons**:
- No proof of a balance, no cost per movement, and no way to rebuild after a bug. This rules out reliable valuation and the accounting export.

## Rationale

Option 1 fits the two forces that matter most here: the accounting export needs every unit and every pound of cost to be provable, and 100,000+ SKUs need instant reads. Summing on read (Option 2) is correct but gets slower every day the system runs, and the lock it still needs for negative stock removes most of its simplicity. Snapshots (Option 3) add a critical job without removing the lock. The Shopify style mutable quantity (Option 4) is simplest, but it gives up the very history that costing and the accounting app depend on.

The other choices follow from the same forces. One row per place with signed quantities keeps every balance a simple sum. A group per posting carries the idempotency key, the source document, and the reversal link, so a transfer or a retried request is atomic and safe. Lots and bins sit on the movement and the balance, with composite foreign keys so the database itself rejects a lot of the wrong SKU or a bin of the wrong location. Whole number quantities and 2 decimal money follow Shopify, which you chose as the reference, with unit cost kept at 4 decimals because average cost drifts at 2. Backdating is allowed up to a lock date, which Shopify doesn't need because it has no month end close, but your accountant does.

The additions taken from Shopify's model (stock states through sellable bins, shipping data, variant price and compare at price, structured options, status and tags, a stocked, service, or bundle kind, and channel ID mappings) are cheap columns now and breaking migrations later, so they go in the target model now.

## Decisions made without a question

- **Primary keys**: UUIDv7, chosen by you. Runner up: bigint identity, smaller but guessable and needing the database to issue IDs during imports.
- **Rounding**: half away from zero, the common rule on Egyptian invoices and in most accounting apps. Runner up: half to even (banker's rounding), which accountants rarely expect on invoices.
- **Idempotency stored on the posting group**, with a request hash to catch a reused key with different content. Runner up: a separate idempotency table, one more table with no extra benefit.
- **Fixed lock order** (variant, location, bin, lot) to prevent deadlocks. Runner up: retry on deadlock, which works but hides contention.
- **Average cost on each balance row** for now, because outbound cost needs a value today. Feature 34 owns the final costing scope. Runner up: per SKU average, which is simpler but wrong for stock held at different costs in different locations.
- **Discrepancies in a table** until the alerts feature exists. Runner up: log lines only, which nobody reads.
- **Transfers go through a transit location**, which shows stock while it's on the road. Runner up: a transfer status with no stock location, which hides in transit stock from balances.
- **Party names**: plain text plus an optional Arabic name, because supplier and customer names are proper names rather than translated text. Runner up: bilingual JSONB, which suits product text better than names.

## Decisions added after the cross check

An independent review on another model found 12 places where the builder would have had to guess. You chose to apply every recommended fix:

- **Stock value is the authority.** Outbound cost is a share of the balance's value, and the outbound that empties a balance takes all of what is left, so rounding never leaves value behind. The average cost is kept when a balance empties, so selling into negative stock still has a cost.
- **Reversals** mirror the original lines exactly, keep the source fields, return the same serials, and never reactivate reservations.
- **Reservations have no bin and no counter on the balance.** They sit per SKU, location, and lot, with an open quantity reduced in place. Unreserved outbound lines may not eat reserved stock.
- **Idempotency** hashes the operation and its sorted lines, not the key, user, or a defaulted date. A replay returns the stored movements and checks nothing again.
- **Locking** sorts lines first and upserts and locks each balance in one statement, with one retry on a deadlock as a safety net.
- **Two database roles**, so the append only rule holds even for a bug that tries to update a movement.
- **Dates** are compared in Cairo time, and costs follow recorded order.
- **Reconciliation** runs in one snapshot and also checks reservations and serial counts, with at most one open discrepancy per balance.
- **Inputs**: cost is per base unit and given only on inbound lines. (Merging duplicate balance lines was dropped on 2026-11-02, see below.)
- **Serials** arrive as strings and are created or returned in the posting.
- **Numbering** is the last step of a document save, with counters created per year and full numbers stored.
- **Archived** SKUs, locations, and bins cannot be posted or reserved.
- **No partitioning** of movements for now; revisit at about 50 million rows. Runner up: partition by year now, which adds migration and query complexity before it pays off.

## Inbound cost into negative stock (fixed 2026-11-02)

The first version set a balance's value directly when a receipt landed on a negative balance (`new on_hand × unit_cost`, or 0), while the movement recorded the full receipt price. Those two disagreed whenever the units shipped into negative stock had been costed at a different average, so AC-1 (value equals the sum of movement costs) and AC-12 (an empty balance holds 0.00) could not both hold, and the nightly reconcile would have flagged a false mismatch.

You chose:

- **Close the shortfall at its own value.** An inbound line into a negative balance mirrors the outbound rule: the units that fill the shortfall take its value (proportionally, or exactly the rest when the line reaches zero), and only the units beyond zero cost at the receipt price. The balance value then changes only by the movement's `total_cost`, always. Runner up: a separate zero quantity revaluation movement, which reads well for accounting but breaks the non zero quantity check, the serial count rules, and AC-3, and needs a new source type.
- **Store the variance on the movement** as `cost_variance` (receipt price minus ledger value), so the accounting export sums one column instead of repeating a formula. Runner up: derive it on read, which is leaner but easy to get wrong in every report.

Side effect: the average after an inbound is always `round(total_value / on_hand, 4)`, the same formula a rebuild uses, so right after a receipt the average matches a rebuild. A receipt of 10 at 3.3333 now shows an average of 3.3330 (value 33.33 is the authority). After a shipment the kept average can differ from a rebuild by rounding (ship 4 of those 10: the kept 3.3330 against a rebuilt 3.3333). That is accepted: value is the authority, reconcile compares only on hand and value, and the average only prices shipments into negative stock.

### Fixes from the second cross check (2026-11-02)

An independent review on another model then checked the arithmetic and found that the old reversal rule (remove the original `total_cost`, plus a residue rule) could give a balance a value of the wrong sign (3 on hand at −22.00), and could leave an empty balance holding value after reversing a shipment. It also found smaller gaps a builder would have to invent. You chose to apply every recommended fix:

- **Reversals are costed by the normal rules for their direction**, at the original unit cost, and the gap to the original cost goes to `cost_variance`. Values always keep the sign of their on hand, and the residue special case is gone. Tradeoff: a reversal no longer restores the original value exactly unless it empties the balance, and the difference is visible as variance. Runner up: keep the residue rule and add clamps, which patches each bad sequence separately and is harder to prove correct.
- **Lines are never merged.** Each balance is locked once, and its lines are applied one by one as their own movements. Merging lost each line's `source_line_id` and needed a cost rule for mixed directions or mixed prices.
- **Inbound `unit_cost` is always the price paid**, even when `total_cost` differs.
- **`cost_unknown` is its own column**, so the caller's `reason_code` is never overwritten.
- **A `CHECK` constraint** enforces that `total_cost` is 0 or has the sign of the quantity.
- **Shares are computed in exact `numeric`** and rounded once.
- **A receipt at cost 0** follows the same rules, with a negative variance when it fills a shortfall.

## Comparison with Shopify's model

Kept from Shopify: products with variants, ordered options, whole number quantities per location, price and compare at price on the variant, product status, tags, brand and type, the tracked or not tracked idea (here a kind of stocked, service, or bundle), weight, HS code, and country of origin, and custom fields with definitions (Shopify calls them metafields).

Beyond Shopify: an append only ledger with cost per movement, bins, lots with expiry, serials, units of measure, parties with supplier, factory, and customer roles, reservations tied to order lines, a lock date, gap free document numbers, and native bilingual text.

Shopify's named quantity states (available, committed, incoming, damaged, quality control, safety stock) map as follows: committed is the open quantity of active reservations, damaged and quality control are stock in non sellable bins or locations, and incoming is worked out from open purchase orders (feature 21). Safety stock belongs to reorder suggestions (feature 24).
