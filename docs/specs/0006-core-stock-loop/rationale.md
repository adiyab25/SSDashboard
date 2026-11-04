# 0006. Core stock loop: decision record

Build spec: [index.md](index.md).

## Context

Scope feature 7 (Slice 1, Tracer Bullet) is the walking skeleton. A signed in user adds one SKU and one warehouse, records a stock receipt, and sees the correct on hand quantity, read from the stock ledger, in both languages. Spec 0002 built the ledger engine (`LedgerService`: `post`, `reverse`, reads, reservations) with no HTTP surface. Spec 0005 built staff sign in with two roles, `admin` and `staff`. This feature is the first one to put screens and endpoints on that engine. It spans `apps/api` (inventory and a new catalog module), `packages/contracts`, `packages/db`, and `apps/web`.

Forces that shaped it:
- **Every posting needs a source document.** `movement_groups.source_id` is a required UUID, and the scope rule says every movement carries cost. A receipt must therefore be something with an id, and it must commit atomically with its movements and its gap free number (AC-10 of spec 0002).
- **`ledger.post` opens its own transaction** (`ledgerTransaction`: READ COMMITTED, 5 second lock cap, one deadlock retry). A caller cannot write its own rows in that transaction today.
- **Idempotency is hashed on content.** The ledger's `request_hash` includes `sourceId` and every line's `sourceLineId`, so any id a retry regenerates breaks replay.
- **Module boundaries.** Modules talk only through exported services; inventory may not read catalog tables or the reverse. SKU archive needs stock state, and stock lists need SKU names, so the dependency direction matters.
- **Later features extend this.** Feature 8 adds variants per product, feature 9 real search, feature 13 cost permissions, and feature 22 purchase receipts. Contracts set here should grow without breaking.
- **Small team (1 to 3 developers), English and Arabic from day one, 100,000+ SKUs.**

## Options considered

### Option 1: Inventory owned stock receipt, posted through a ledger transaction callback (chosen)

A `stock_receipts` document with lines, a gap free `SR` number, and a `voided` state, written inside `ledger.post` through a new `within(tx, result)` callback.

**Pros**: atomic receipt, number, and stock; real receipt history and numbering exercised end to end; the callback becomes the pattern for every later document; the ledger keeps sole ownership of transaction rules.
**Cons**: adds a hook to `LedgerService`, and caller code runs while stock locks are held; two new tables in Slice 1.

### Option 2: Post straight to the ledger, no document

`opening_balance` postings with a generated `source_id`; history is the movement list.

**Pros**: no new tables, no ledger change, fastest to build.
**Cons**: no receipt number or list, nothing to void as a unit, receipts indistinguishable from the import's opening stock in the accounting export; feature 22 later invents the document pattern anyway.

### Option 3: Ledger accepts a caller's transaction (`postIn(tx, input)`)

The receipts service opens `ledgerTransaction` itself and calls the ledger inside it.

**Pros**: flexible; any caller can compose several ledger calls in one transaction.
**Cons**: every caller must remember the lock cap, the retry, and the replay rules; one forgotten detail breaks the AC-4 guarantees of spec 0002.

### Option 4: Start feature 22's purchase receipt now

**Pros**: no rework when purchasing arrives.
**Cons**: pulls suppliers and purchase order matching into the walking skeleton, which is supposed to stay thin.

## Rationale

Option 1 is the only one that keeps the receipt, its number, and its movements in one transaction without spreading transaction rules across modules. Option 2 meets the scope's "done when" wording but leaves nothing to void and no document pattern, so the next feature pays for it. Option 3 gives the same atomicity but moves the lock cap and retry contract onto every caller, which is how invariants decay in a small team. The callback keeps those rules inside `ledgerTransaction`, where they are tested once.

Design calls I made myself (runner up in brackets):
- **The `Idempotency-Key` UUID is the receipt id** [store a separate key column]. A retry regenerates nothing, so the ledger's content hash matches and replay works. Line ids are UUID v5 from receipt id and position for the same reason. The cost is random rather than time ordered ids.
- **The receipt keeps its own `request_hash`** [rely on the ledger's hash]. The ledger hashes only the posting (SKUs, locations, quantities, costs), not `reference`, `note`, or who posted, so on its own it would accept the same key with a different note as a replay. The document layer hashes the whole body and compares it before posting and after a ledger replay.
- **Void needs no idempotency header** [header as on posting]. A receipt is voided at most once, so `stock_receipt_void:<receipt id>` is a natural key. The status check runs on the receipt row under `FOR UPDATE`, because the ledger's replay would otherwise report a second void as a success. This refines the "header on void too" answer: the same retry safety with one less moving part.
- **Stock dependent SKU actions live in inventory** [a `STOCK_USAGE` port declared by catalog and provided by inventory]. The port needs a global provider or a dynamic module to resolve in NestJS without an import cycle. Putting archive, unarchive, and code change in an inventory `sku-lifecycle` service keeps imports one way and puts the archive locks next to the ledger locks they must coordinate with. The cost is SKU routes split across two modules. Code changes become admin only as a result, consistent with "admins the rest".
- **Archive and posting exclude each other with row locks** [accept the race]. Without locks, an archive could pass its on hand check while a receipt is in flight, leaving stock on an archived SKU nobody can move. `FOR UPDATE` on archive and `FOR SHARE` in the ledger's master read close it with one line each.
- **The Stock page orders by last movement** [sort by SKU code with a join]. Sorting by code needs catalog's table inside an inventory query, which the module rule forbids. Recent movement first is also what a warehouse checks after a delivery, and the SKU filter covers lookup. One row per balance row keeps it on an index; grouping bins waits for feature 10.
- **A backdated receipt is dated 12:00 that day in Cairo, computed in SQL** [end of day, or a JS date library]. Noon sits clear of day boundaries across daylight saving changes, the lock date rule only looks at the calendar day, and Postgres already knows the time zone rules.
- **`updatedAt` round trips as a microsecond string** [a version column]. Postgres keeps microseconds and JS `Date` drops them, so a plain timestamp comparison would almost never match. The ledger already formats times this way, so no new column is needed.
- **Void value follows the average cost rule** [restore the receipt's exact value]. Spec 0002 costs every outbound, reversals included, at the balance's average, which keeps balances consistent. AC-8 promises quantity, and value as the ledger computes it.
- **New source type `stock_receipt`** (engineer's pick) keeps manual receipts apart from the import's `opening_balance` and feature 22's `purchase_receipt` in the accounting export.
- **TanStack Query and React Hook Form** (engineer's picks) replace hand rolled loading and form state now, before the pattern spreads across many screens. TanStack Table waits until feature 9 needs client side table features.
