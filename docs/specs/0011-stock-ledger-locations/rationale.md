# 0011. Stock ledger and locations: decision record

Why spec 0011 adds what it adds on top of the built ledger. The build spec is [index.md](index.md). Updated 2026-11-07 with the domain review (kept private) (accept with changes) and the lead's contract rulings shared with spec 0013.

## Context

Scope feature 11 asks for the single writer of stock movements and the locations it moves stock between, with an owner type and a sellable online flag, and four outcomes: every stock change is a new movement with quantity, unit cost, location, and source document; a correction is a new movement, never an edit; partner stock is never offered online; on hand per variant and location reads fast at 50,000 SKUs ([scope](../../scope/confirmation-to-cash.md)). Most of this is already built and reviewed. Spec 0002 built the append only ledger, its locking, costing, reconciliation, the owner type policy with its boundary and three way tests, and the 50,000 SKU scale suite; spec 0006 built receipts, voids, the Stock page, SKU history, and locations management. The code confirms it: `apps/api/src/inventory/ledger/ledger.service.ts` (`post`, `reverse`, `reserve`, `release`, `getAvailable`, `buildAvailabilitySql`), `apps/api/src/inventory/locations/location-policy.service.ts`, `packages/db/src/schema/locations.ts` and `inventory.ts`.

What is missing is what the neighbours in slice 1a need from stock, and what a brand needs to keep stock true before counts exist. The Shopify connector (spec 0015) must push stock from the ledger and never take stock from Shopify (spec 0007 section 1, carried finding m2), so it needs a quantity per variant that counts only stock the brand may sell online, and a way to learn which variants changed. Today `getAvailable` answers one SKU at a time and counts every sellable location, partner showrooms included; nothing reads `sellable_online`, and nothing stops several locations, or a shop, from carrying the flag. The orders module (spec 0013) holds stock from the moment an order exists (its Q-16.2), never refuses an order for a shortage (its AC-13), and books a shipment when the carrier reports it (its AC-15); today `reserve` holds one line in its own transaction and throws on a shortage, and `post` refuses an outbound line that would take on hand below what others hold.

The domain review added what the pilot's week looks like. Pieces go to and come back from showroom partners weekly during the pilot (the brand owner debate, the final plan section 1), but a partner location needs a party and parties came only with feature 41, and moves only with features 38 and 55. Turning the online flag on is the go live of the stock push and overwrites every variant in Shopify. A restocked piece would be pushed before the order already waiting for it is filled. A piece found damaged while an order holds it could not be written off, and a parcel already with the carrier could be refused by the ledger. Receipts, open to the warehouse with any typed cost, were a way around the manager only adjustments and the "nobody types a cost" rule; a returned parcel booked as "found" would be counted twice when its waybill is scanned.

Constraints: modules never read each other's tables (`apps/api/src/module-boundary.spec.ts`); no code outside `LocationPolicyService` may name an owner type value (`owner-type-boundary.spec.ts`, api and web alike); every writer of balances or reservations runs inside `ledgerTransaction` and takes `lockPairs` first; migrations move forward and the baseline freezes at the pilot brand's first import (ADR 0003); a backup restore and the exit package must leave a working install (spec 0007 sections 6 and 7). Orders imports inventory, so inventory cannot import orders or connectors. The `DomainEvents` service of spec 0002 A6 is designed by spec 0013 and not built yet.

## Options considered

### Option 1: Thin additions on the built ledger, with a time window change feed (chosen)

Add a read service for online stock that counts one database enforced and gated online location and subtracts waiting demand; a change feed on the `updated_at` timestamps the ledger already writes, read with a 5 minute lag window; reservations in the caller's stock transaction that keep their unfilled demand and are filled before anything is offered; a carrier shipment posting that is never refused for stock; a minimal partner record and a numbered send and return posting; manual adjustments with a request path, a receipt cost rule, and a discrepancy screen. Events go through `DomainEvents`; other modules plug checks into two registries.

**Pros**:

- No new infrastructure and one small new table; every piece reuses `buildAvailabilitySql`, `lockPairs`, `ledgerTransaction`, `within`, the receipt idempotency rules, numbering, and the audit writer.
- The feed survives a dump and restore unchanged, because it rests on timestamps, not on transaction numbers.
- The connector reads stock without any coupling to the ledger's transaction, so a slow connector never holds stock locks.

**Cons**:

- The feed repeats each change for about 5 minutes and assumes no ledger transaction stays open that long.
- The ledger gains two deliberate exceptions to its reserved stock rule and an automatic fill step, which make the posting harder to explain.

### Option 2: A change mark table ordered by transaction id

The ledger upserts one row per changed variant into a new `stock_change_marks` table in every posting, stamped with `pg_current_xact_id()`; the reader returns marks with an id below the snapshot's `xmin` (`pg_snapshot_xmin(pg_current_snapshot())`), the lowest transaction still active, so a late commit can never be skipped.

**Pros**:

- Exact: no lag window, no repeated rows, no assumption about transaction length.
- Cheap to read: one indexed scan of a small table.

**Cons**:

- A new hot write in every posting, on a row that concurrent postings of the same variant contend for.
- Transaction ids belong to the database cluster, so a restore into a new cluster (the exit package, a backup restore) starts them low again; stored marks and every consumer's cursor then sit in the future, and the feed silently stops.
- Subtle to explain and to test.

### Option 3: In transaction domain events to the connector

The ledger emits `StockMoved` through `DomainEvents` and the connector's handler writes its own outbound stock command in the same transaction.

**Pros**:

- Instant and exact: the push command commits with the movement.
- Matches the project's stated pattern for projections.

**Cons**:

- Connector code would run inside the ledger's locked transaction, holding stock locks longer and coupling a Core posting to an outbound integration that a Warehouse licence switches (spec 0009 capability `connectors.shopify.stock_push`).
- Every reservation change and fill would need an event too, and a failed handler would refuse a stock movement.

### Option 4: Leave online stock to the connector

Change nothing in inventory beyond the screens: the connector calls `getAvailable` per variant and filters locations itself.

**Pros**:

- The smallest change to inventory.

**Cons**:

- Every caller would decide which locations count online, so "partner stock is never offered online" would rest on each of them remembering a filter, and waiting demand would not be counted anywhere.
- One query per SKU at 50,000 SKUs every run.
- Orders would still have no way to reserve in their own transaction or to book a carrier fact.

## Rationale

Option 1 answers each scope outcome with the least new machinery, which matters most for a GA feature that two other slice 1a features build on and that must land well before mid March 2027. The rule that protects the brand's money, partner stock never offered online, is held in three places: the database (one online location, a sellable warehouse, changed only through the gate), the read (one location, minus waiting demand), and the books (pieces sent to a partner leave the warehouse). The fourth place, Shopify's own other locations, is outside the ledger, so it is a named requirement on spec 0015 rather than a promise this spec cannot keep.

The feed is the real choice between Options 1 and 2. Option 2 is exact, but its failure mode is silent and lands on exactly the paths this product promises to keep working: a restore and the exit package (spec 0007 sections 6 and 7, carried m1). Option 1's failure mode is visible and bounded: a repeated row costs one comparison in the connector, and the 5 minute window is about sixty times longer than a ledger transaction can wait on any single lock (5 seconds, `LOCK_TIMEOUT_MS` in `ledger/locks.ts`). The connector also keeps its full sweep with `list` (spec 0007: "webhooks are hints; the sweep is the truth"). Option 3 stays right for in process projections, and this spec does use `DomainEvents` for the events orders and tasks consume; it is the wrong path for an outbound integration, which must never hold stock locks.

Reservations run in the caller's transaction because spec 0013 writes an order and holds its stock as one change, and an edit that swaps M for L must never free M if L fails. The caller opens that transaction with the ledger's own runner, so the lock cap and the single deadlock retry still hold. A shortage answers "short" rather than throwing, because Shopify already sold the piece when the order arrives; refusing would hide a real sale. The lead ruled, for both specs, that the shortfall is stored as unfilled demand on the reservation and filled first by the next freed piece: otherwise the push offers a returned piece to a new buyer while the first buyer still waits (review M3), which is the oversell the product exists to stop. Filling runs inside the write that frees the piece, under the same pair lock, so nothing can read the piece as free in between.

The two exceptions to the reserved stock rule follow the physical world. The parcel the carrier took is gone whatever the books say (review M5), so its shipment is always booked, may go below zero, and raises a task to count; a damaged or missing piece is gone too (review M4, Q-11.8), so its removal goes through. In both cases the newest reservation loses the piece, because the oldest order has waited longest, and the event tells support at once. Every other outbound posting keeps spec 0002's rule.

The gate (Q-11.7) exists because going online overwrites every variant in Shopify, and it is the last point where a wrong figure can be stopped. It reads only inventory's own fact (the location's stock confirmed counted) and asks the other modules through a registry, the pattern the audit undo already uses, so inventory never imports orders or connectors.

The minimal partner record and the numbered send and return posting (Q-11.6, Q-11.4 (b)) pull a thin slice of features 38 and 41 into slice 1a, because the pilot moves pieces to showrooms weekly and every alternative breaks something: adjusting pieces out pollutes shrinkage and loses partner stock; creating the showroom as an own shop fixes the wrong owner type for life. The posting is one ledger group (spec 0002's transfer shape without the transit leg), numbered like receipts so the team can quote a note. The in line takes the source average read just before the posting, because the ledger's costing runs lines in key order and cannot hand an outbound cost to an inbound line of the same group; the gap is rounding cents, accepted and stated.

Adjustments, the request path, the found check, and the receipt cost rule close the side doors the review found (M6 to M8, m1, m2): posting stays with the manager because a removal can hide theft; the warehouse asks in the app; a returned parcel is sent to the restock by scan the slice's acceptance counts; and no person without `cost.view` sets a cost anywhere, receipts included. Damaged pieces post as `write_off` so the accountant sees one loss under one code.

## References

**Project sources**:

- `docs/scope/confirmation-to-cash.md` feature 11; `docs/scope/index.md` planning notes (pilot window, 10,000 SKUs designed and 50,000 tested, team of about four); `docs/scope/exchange-loop.md` feature 38 and `docs/scope/consignment-and-accounting.md` feature 41 (the slices pulled forward).
- `docs/reviews/domain-stock-ledger.md` (B1, M1 to M8, m1 to m8, Q-11.6 to Q-11.8, brand questions 1 to 7).
- Spec 0002 `index.md` (AC-1 to AC-14, Key invariants, Value sourcing) and `0002-catalog-locations.md` (A13 owner type policy, A14 source types, A15 scale); `0002-tenancy-platform.md` (A6 domain events).
- Spec 0006 `index.md` (`within`, receipt idempotency, `lockForArchive`, the accepted rebuild after archive edge).
- Spec 0007 section 1 (echo suppression, who owns stock), sections 6 and 7 (restore and exit package), section 8 (owner type policy), section 11 (scale), carried m2 and m4; `docs/reviews/domain-stack.md` m2, m4.
- Spec 0008 permission matrix (`stock.view`, `stock.receive`, `stock.correct`, `catalog.manage`, `partners.manage`, `cost.view`); spec 0009 module registry and AC-24; spec 0010 Actions table and AC-11; spec 0013 Q-16.2, AC-13, AC-15, AC-18 (`DomainEvents`), and its contract table.
- Code: `apps/api/src/inventory/ledger/ledger.service.ts`, `ledger/locks.ts`, `ledger/costing.ts`, `ledger/reconciliation.service.ts`, `locations/locations.service.ts`, `locations/location-policy.service.ts`, `packages/db/src/schema/inventory.ts`, `packages/db/src/schema/locations.ts`, `packages/db/src/schema/parties.ts`, `packages/contracts/src/locations.ts`, `packages/contracts/src/stock-receipts.ts`, `apps/api/src/partners/partner-accounts.service.ts`, `apps/api/src/audit/` (`AuditUndoRegistry`, the registry pattern), `apps/api/src/module-boundary.spec.ts`.
- Installed skill `postgresql-table-design` (partial unique indexes, indexes on the access paths actually queried, foreign key indexes).

**Practices & standards**:

- Transactional consistency for reservations: one lock order everywhere, the caller's rows and the stock change in one transaction.
- Books follow the physical world: a shipped parcel and a lost piece are booked, then reconciled by a count.
- Polling a change feed with a lag window, and a full sweep as the source of truth.
- Idempotency keys for operations that move stock.
- PostgreSQL transaction id and snapshot functions (`pg_current_xact_id`, `pg_snapshot_xmin`; `xid8` increases monotonically within one database cluster), from the PostgreSQL documentation, sections "System Information Functions and Operators" and "Object Identifier Types", read on 2026-11-07 for Option 2.
