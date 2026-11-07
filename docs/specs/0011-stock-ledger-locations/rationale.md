# 0011. Stock ledger and locations: decision record

Why spec 0011 adds what it adds on top of the built ledger. The build spec is [index.md](index.md).

## Context

Scope feature 11 asks for the single writer of stock movements and the locations it moves stock between, with an owner type and a sellable online flag, and four outcomes: every stock change is a new movement with quantity, unit cost, location, and source document; a correction is a new movement, never an edit; partner stock is never offered online; on hand per variant and location reads fast at 50,000 SKUs ([scope](../../scope/confirmation-to-cash.md)). Most of this is already built and reviewed. Spec 0002 built the append only ledger, its locking, costing, reconciliation, the owner type policy with its boundary and three way tests, and the 50,000 SKU scale suite; spec 0006 built receipts, voids, the Stock page, SKU history, and locations management. The code confirms it: `apps/api/src/inventory/ledger/ledger.service.ts` (`post`, `reverse`, `reserve`, `release`, `getAvailable`, `buildAvailabilitySql`), `apps/api/src/inventory/locations/location-policy.service.ts`, `packages/db/src/schema/locations.ts` and `inventory.ts`.

What is missing is what the neighbours in slice 1a need from stock, and what a brand needs to keep stock true before counts exist. The Shopify connector (spec 0015) must push stock from the ledger and never take stock from Shopify (spec 0007 section 1, carried finding m2), so it needs a quantity per variant that counts only stock the brand may sell online, and a way to learn which variants changed. Today `getAvailable` answers one SKU at a time and counts every sellable location, partner showrooms included, because `is_sellable` is true there; nothing reads `sellable_online`, and nothing stops several locations, or a shop, from carrying the flag. The orders module (spec 0013) must hold stock for an order's lines; today `reserve` holds one line per call in its own transaction, so a three line order can end half reserved, and an order edit cannot swap a size atomically.

The pilot runs from mid March 2027 with a team of about four (scope planning notes). Full counts (feature 54) and transfers (features 38 and 55) come in later slices, yet pieces will be found, lost, and damaged from the first week. The nightly reconciliation already records drift into `stock_level_discrepancies`, but no screen shows it and no action dismisses one (spec 0002 follow up, `apps/api/src/inventory/AGENTS.md`). The location screens of spec 0006 still create only the brand's own locations, although the api already accepts an owner type and a party.

Constraints: modules never read each other's tables (`apps/api/src/module-boundary.spec.ts`); no code outside `LocationPolicyService` may name an owner type value (`owner-type-boundary.spec.ts`, api and web alike); every writer of balances or reservations runs inside `ledgerTransaction` and takes `lockPairs` first; migrations move forward and the baseline freezes at the pilot brand's first import (ADR 0003); a backup restore and the exit package must leave a working install (spec 0007 sections 6 and 7). The `DomainEvents` service of spec 0002 A6 does not exist yet and is built by orders (feature 16).

## Options considered

### Option 1: Thin additions on the built ledger, with a time window change feed (chosen)

Add a read service for online stock that counts one database enforced online location, a change feed built on the `updated_at` timestamps the ledger already writes (plus one new `reservations.updated_at`), read with a 5 minute lag window; add `reserveLines`, `releaseLines`, `releaseSource`, and `reservationsFor` to `LedgerService`, run inside a stock transaction the caller opens with the ledger's runner; add manual adjustments and a discrepancy screen as thin controllers over the existing ledger and reconciliation services; finish the location screens.

**Pros**:

- No new table, no new infrastructure, no new pattern: every piece reuses `buildAvailabilitySql`, `lockPairs`, `within`, the receipt idempotency rules, and the audit writer.
- The feed survives a dump and restore unchanged, because it rests on timestamps, not on transaction numbers.
- The connector reads stock without any coupling to the ledger's transaction, so a slow connector never holds stock locks.

**Cons**:

- The feed repeats each change for about 5 minutes and assumes no ledger transaction stays open that long; the consumer must push only on a changed value.
- Latency of a push is the connector's polling interval, not instant.

### Option 2: A change mark table ordered by transaction id

The ledger upserts one row per changed variant into a new `stock_change_marks` table in every posting, stamped with `pg_current_xact_id()`; the reader returns marks with an id below the snapshot's `xmin` (`pg_snapshot_xmin(pg_current_snapshot())`), which PostgreSQL defines as the lowest transaction still active, so a late commit can never be skipped.

**Pros**:

- Exact: no lag window, no repeated rows, no assumption about transaction length.
- Cheap to read: one indexed scan of a small table.

**Cons**:

- A new hot write in every posting, on a row that concurrent postings of the same variant contend for.
- Transaction ids belong to the database cluster, so a restore into a new cluster (the exit package, a backup restore) starts them low again; stored marks and every consumer's cursor then sit in the future, and the feed silently stops until someone resets it.
- Subtle to explain and to test; the team must understand snapshot visibility to change it.

### Option 3: In transaction domain events to the connector

The ledger emits `StockMoved` through the platform `DomainEvents` service (spec 0002 A6) and the connector's handler writes its own outbound stock command in the same transaction.

**Pros**:

- Instant and exact: the push command commits with the movement.
- Matches the project's stated pattern for projections.

**Cons**:

- `DomainEvents` does not exist yet; feature 11 would build it ahead of feature 16 or wait for it, in a wave where both are designed in parallel.
- Connector code would run inside the ledger's locked transaction, holding stock locks longer and coupling a Core posting to an outbound integration that a Warehouse licence switches (spec 0009 capability `connectors.shopify.stock_push`).
- Every reservation change, not only movements, would need an event too.

### Option 4: Leave online stock to the connector

Change nothing in inventory beyond the screens: the connector calls `getAvailable` per variant and filters locations itself, polling every variant on a schedule.

**Pros**:

- The smallest change to inventory.

**Cons**:

- Every caller (connector, portal, confirmation queue) would decide which locations count online, so "partner stock is never offered online" would rest on each of them remembering a filter; the connector would also have to read location flags, which means reading inventory's table or a new service anyway.
- One query per SKU at 50,000 SKUs every run.
- Orders would still have no way to reserve a whole order atomically.

## Rationale

Option 1 answers each scope outcome with the least new machinery, which matters most for a GA feature that two other slice 1a features build on and that must land well before mid March 2027. The one rule that protects the brand's money, partner stock never offered online, moves from "every caller filters correctly" into the database (a check and a partial unique index) and into one read that counts one location. That is the same move spec 0002 made for owner types: one place answers, a test fails anywhere else.

The feed is the real choice between Options 1 and 2. Option 2 is exact, but its failure mode is silent and lands on exactly the paths this product promises to keep working: a restore and the exit package (spec 0007 sections 6 and 7, carried m1). Option 1's failure mode is visible and bounded: a repeated row costs one comparison in the connector, and the 5 minute window is about sixty times longer than a ledger transaction can wait on any single lock (5 seconds, `LOCK_TIMEOUT_MS` in `ledger/locks.ts`). The connector also keeps its own full sweep with `list` (spec 0007: "webhooks are hints; the sweep is the truth"), so even a broken assumption heals at the next sweep. Option 3 is the right long term shape for in process projections and stays a follow up once spec 0013 builds `DomainEvents`; it is the wrong path for an outbound integration, which must never hold stock locks.

`reserveLines` reuses the ledger's locking order instead of inventing one: master rows `FOR SHARE`, pair locks in ascending key order, then reservation rows. It runs in the caller's transaction because spec 0013 writes an order and holds its stock as one change (its AC-13, and an edit that swaps M for L must never free M if L fails); the caller opens that transaction with the ledger's own runner, so the lock cap and the single deadlock retry still hold, which a plain transaction would lose. A shortage answers "short" rather than throwing, because Shopify already sold the piece when the order arrives (spec 0013 Q-16.2): refusing the order would hide a real sale, while a short line shows the problem and the push already says 0. `refuse` stays as a mode for a future caller that needs all or nothing (a transfer, a handover). A repeat call tops a short line up and never lowers it, so the same call is both the replay and the "stock arrived" path. The old `reserve` (own transaction, one line, throws) stays for compatibility; spec 0006's `within` remains the pattern for postings.

The ledger's direct `FOR SHARE` and `FOR UPDATE` reads of `product_variants` are the last inventory breach of the module wall. Spec 0012 offered the catalog locking methods to this spec or the next catalog change; this spec takes them, because the reservation work already touches `loadMaster`, the same code, and the races of spec 0006 must be retested once either way.

The pushable figure is available, not on hand, because a reserved piece is already promised to an order; pushing on hand would sell it twice. It is floored at 0 because a channel is told how many pieces a buyer may order, and a figure below 0 means nothing to a buyer, while `available` stays signed for screens that must show a shortfall.

Adjustments and the discrepancy screen are in scope because the scope's own outcome, "a correction is a new movement, never an edit", has no user facing correction today except voiding a receipt, and the pilot cannot wait for slice 4 counts. Both are thin: an adjustment is one ledger posting plus one audit entry, with no document table, because nothing downstream needs an adjustment number; a discrepancy action calls the existing `rebuildLevel` or a new one line `dismiss`. Their costs are listed as owner decisions Q-11.1, Q-11.3, and Q-11.5 so the owner can trim them.

The locations screen work is small because the api already accepts owner type and party; the only design point is that the web must never name an owner type value, so the dialog is fed by two lists the api returns, built from the policy service and the partners module.

## References

**Project sources**:

- `docs/scope/confirmation-to-cash.md` feature 11; `docs/scope/index.md` planning notes (pilot window, 10,000 SKUs designed and 50,000 tested, team of about four).
- Spec 0002 `index.md` (AC-1 to AC-14, Key invariants, Value sourcing) and `0002-catalog-locations.md` (A13 owner type policy, A14 source types, A15 scale); `0002-tenancy-platform.md` (A6 domain events).
- Spec 0006 `index.md` (`within`, receipt idempotency, `lockForArchive`, the accepted rebuild after archive edge).
- Spec 0007 section 1 (echo suppression, who owns stock), sections 6 and 7 (restore and exit package), section 8 (owner type policy), section 11 (scale), carried m2 and m4; `docs/reviews/domain-stack.md` m2, m4.
- Spec 0008 permission matrix (`stock.view`, `stock.correct`, `catalog.manage`, `cost.view`); spec 0009 module registry (capabilities `inventory.counts`, `inventory.transfers`, `connectors.shopify.stock_push`) and AC-24 (owner policy editing); spec 0010 Actions table (`stock.adjusted_manually`) and AC-11.
- Code: `apps/api/src/inventory/ledger/ledger.service.ts`, `ledger/locks.ts`, `ledger/reconciliation.service.ts`, `locations/locations.service.ts`, `locations/location-policy.service.ts`, `packages/db/src/schema/inventory.ts`, `packages/db/src/schema/locations.ts`, `packages/contracts/src/locations.ts`, `apps/api/src/partners/partner-accounts.service.ts`, `apps/api/src/module-boundary.spec.ts`.
- Installed skill `postgresql-table-design` (partial unique indexes, indexes on the access paths actually queried).

**Practices & standards**:

- Transactional consistency for reservations: all or nothing per document, one lock order everywhere.
- Polling a change feed with a lag window, and a full sweep as the source of truth.
- Idempotency keys for operations that move stock.
- PostgreSQL transaction id and snapshot functions (`pg_current_xact_id`, `pg_snapshot_xmin`; the `xid8` type increases monotonically within one database cluster), from the PostgreSQL documentation, sections "System Information Functions and Operators" and "Object Identifier Types", read on 2026-11-07 for Option 2.
