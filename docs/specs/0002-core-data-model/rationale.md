# 0002. Core data model: rationale

Back to the build spec: [index.md](index.md).

> Amended 2026-11-05: the sections below are the record of the original decision. Feature numbers in them refer to the scope before 2026-11-05. The amendment's reasoning is in `## Amendment 2026-11-05` at the end of this file.

## Context

SSDashboard runs stock, purchasing, sales, and production for an ecommerce business with thousands to 100,000+ SKUs across warehouses and showrooms, and later for more clients from one shared core. Each client has its own install and database, so no table needs a tenant column. The books live in a separate accounting app, which means this system must keep exact cost and price on every transaction and be able to prove any stock value it exports.

> Amended 2026-11-05: "no table needs a tenant column" is replaced: every row carries a tenant id (spec 0007 section 7, Amendment A1), and the catalog target is 10,000 SKUs designed and 50,000 tested, not 100,000+ (A15).

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

> Amended 2026-11-05: the read speed argument now applies at 50,000 SKUs (A15); the reasoning is unchanged.

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

## Amendment 2026-11-05

### Context

On 2026-11-05 the product became the order operations and warehouse back office for Egyptian clothing brands behind Shopify, Bosta cash on delivery, and consignment showroom partners (private `docs/positioning/2026-11-05-egypt-order-operations-layer.md`). The owner kept the built code and asked each foundation spec to be amended (spec 0007, Shape A). Scope feature 4 lists what the model must now hold, and spec 0007 binds several answers: a tenant id on every row defaulting from a database setting (section 7), order number unique per store and carrier accounts with an optional store binding (sections 1 and 7, from domain review B1), a sync state on every linked record (B2), a location owner type read through one policy service (section 8), one operating day function (section 10), 10,000 SKUs designed and 50,000 tested (section 11), and a list of append only tables. Two forces sharpen every choice. First, no install runs the current migrations yet (confirmed by Igris for spec 0007 open question 1), so breaking changes cost one rebuild now and a migration path per client later. Second, the reference brand's own console (reference brand notes, section 7) shows what goes wrong without these rules: four phone formats for one customer, return rates that counted cancellations, costs "pending" for months, and numbers that contradicted each other until read models were rewritten.

### Options considered, per load bearing decision

**1. Migrations: one new baseline, or forward migrations from `0009`.**
- *Baseline (chosen)*: delete `0000` to `0008`, generate one migration from the amended schema. Pros: no expand and contract dance for changes that touch every table (tenant id, unique keys, location type, parties); a readable starting point for every future install. Cons: every developer recreates a dev database; the history of how the schema grew leaves the migration folder (it stays in git).
- *Forward migrations*: Pros: no reset, the usual rule. Cons: adding a not null `tenant_id` to every table and rebuilding every unique key and enum in place is a large, risky migration written for zero installs.
- Why: spec 0007 made the reset conditional on no install existing, and Igris confirmed that. Runner up: forward migrations, which is what to do if an install had existed.

**2. The app role's name: a database setting read by the migration, a shared group role, or fixed names.**
- *Setting (chosen)*: grants run in `DO` blocks naming `current_setting('ssd.app_role', true)`, default `ssdashboard_app`. Pros: per client role names on a shared server (spec 0007) need no change to any migration; dev and tests keep today's name. Cons: grants become dynamic SQL, slightly harder to read.
- *Shared group role* (`ssdashboard_app` without login, each client's login a member): Pros: static SQL. Cons: every client's login is a member of one role that holds table privileges in every client database; safety then rests entirely on `CONNECT` being revoked, a single point of failure spec 0007 set out to remove.
- *Fixed names*: rejected by spec 0007 (roles are global to a server).

**3. The operating day: stamped by trigger, set by writers, a generated column, or computed on read.**
- *Trigger stamp (chosen)*: Pros: writers cannot forget it; it is indexable; the day a row was booked never changes when settings change. Cons: logic in a trigger, less visible than code.
- *Generated column or expression index*: impossible, because the function reads the zone setting and so is `STABLE`, not `IMMUTABLE`.
- *Writers set it*: Pros: visible in code. Cons: every writer of six tables must remember; one forgotten path gives wrong reports silently.
- *Computed on read*: Pros: nothing stored. Cons: no index for "yesterday's orders" at 150,000 orders, and every report repeats the conversion.

**4. Order states: stored states plus append only events, pure event sourcing, or a derived view.**
- *Stored plus events (chosen)*: the current states are columns, every change appends an `order_events` row in the same transaction, and `replayStates` proves they agree. Pros: indexed queues (the confirmation queue reads `new` orders directly), full history, simple reads. Cons: two representations that must change together, the same tradeoff the stock ledger already accepts.
- *Pure event sourcing*: Pros: one truth. Cons: every list and queue needs a projection anyway; more machinery than 1 to 3 developers need.
- *Derived view* (the reference brand's COD truth view): Pros: nothing to keep in step. Cons: the brand's own notes call storing it as events "the upgrade"; a view cannot record who moved an order or why.

**5. Partial delivery: split the row, close a parent and add two children, or a separate outcome table.**
- *Split (chosen)*: the original row keeps the delivered units, one new row holds the returned ones. Pros: sums over lines stay plain sums; Shopify's line id stays on the delivered part. Cons: the original row's quantity changes (recorded in the audit trail).
- *Parent and two children*: Pros: no row changes quantity. Cons: every sum must exclude closed parents, a filter every report would have to remember.
- *Outcome table per line*: Pros: lines never change. Cons: every amount by state becomes a join and a per unit allocation.

**6. The outcome: one function stored on the order, a SQL view, or computed by reports.**
- *One function, stored (chosen)*: Pros: one definition (final plan 6.14), indexable by outcome and day. Cons: must be recomputed whenever an input changes, which the orders service and the domain event rule (A6) guarantee.
- *SQL view*: Pros: always current. Cons: its inputs live in other modules' tables, which the module rule forbids reading.
- *Reports compute it*: Cons: exactly how the reference brand's numbers came to contradict each other.

**7. Customer merge: a pointer with no row moves, moving child rows by events, or an identity table.**
- *Pointer (chosen)*: `merged_into_id`, chains kept one hop deep, undo restores recorded pointers. Pros: no other module's row changes, so undo is exact and cheap. Cons: every per customer read asks for the id set (`idsOf`) and queries `customer_id = ANY(ids)`.
- *Move child rows*: Pros: reads stay simple. Cons: each module must move its own rows on an event and remember them for undo; an append only credit ledger could not move at all.
- *Separate identity table* (person to customers): Pros: flexible. Cons: one more level for a problem the pointer already solves.

**8. Credit balance: summed on read under a lock, or a maintained balance table.**
- *Summed (chosen)*: Pros: cannot drift; at thousands of entries a year an indexed sum is cheap. Cons: needs an advisory lock per customer to stop two spends overdrawing.
- *Balance table* (the stock ledger's shape): Pros: instant at any size. Cons: a second representation and a reconciliation job for a volume that does not need it.

**9. Settlement matching: append only match rows, or a state column on lines.**
- *Match rows (chosen)*: Pros: lines stay pure third party facts; the history of matching and unmatching is kept, which period close and revoke need. Cons: a line's state is "the latest row", one more join.
- *State column*: Pros: simple reads. Cons: lines stop being append only, and who unmatched what is lost.

**10. Product and style: one product per style, or a separate styles table.**
- *Product is the style (chosen)*: Pros: one less level; matches the reference brand (`style_costs.style` references `products(style)`); a brand that lists colors as separate Shopify products maps them to variants of one product through the connector's external ids. Cons: the canonical catalog may not mirror Shopify's product list one to one.
- *Separate styles*: Pros: Shopify products map one to one. Cons: cost, season, and group would sit on styles while options and variants sit on products, two places to look for every catalog question.

**11. Cost lookup: newest effective date wins, or an override always wins.**
- *Newest wins, override breaks ties (chosen)*: Pros: a new season's style cost replaces last season's variant override without anyone remembering to retire it. Cons: an override meant to last must be re entered when the style cost changes.
- *Override always wins*: Cons: a stale override silently outlives every later style cost.

**12. Location owner type over time (carried m4): fixed for life, or effective dated.**
- *Fixed (chosen)*: a change of owner type is a new location; the old one is archived after its stock moves out. Pros: every movement and settlement line joins to the owner type it was recorded under with no date logic; the policy service answers from the location alone; the change is a visible business event (a stock move, or a sale to a new wholesale customer). Cons: a showroom that becomes a wholesale customer gets a new location code and its history is split across two locations.
- *Effective dated*: Pros: one location keeps its whole history. Cons: every policy question becomes "owner type at this date", every report joins a date range, and a backdated movement near the change date can be read under either type, exactly the reinterpretation spec 0007 forbids.

**13. The owner type policy: a database table, or a constant in code.**
- *Table (chosen)*: Pros: scope feature 9 asks for owner types as a setting; the same image can serve a brand whose partner terms differ. Cons: a change to a policy row is a data change, which needs the audit trail (feature 10).
- *Constant*: Pros: reviewed in code. Cons: every brand difference is a release.

**14. Opening stock without a cost: record it as cost unknown, reject it, or block go live.**

> Amended 2026-11-05 (fix pass): reversed. Opening stock now needs a cost record (an owner estimate is allowed); see *Fix pass of 2026-11-05*, B5. The text below is the record of the first call.

- *Cost unknown (chosen)*: Pros: a brand can go live with partial costs, as the reference brand had to; "not set" stays visible; it reuses the ledger's existing `cost_unknown` rule, so no costing rule changes. Cons: those pieces stay at cost 0 in the ledger until feature 59 decides on revaluation. Owner question 6.
- *Reject*: Pros: every piece has a cost. Cons: a brand with uncosted styles cannot import its stock.

**15. Task types: text checked against a code registry, a PostgreSQL enum, or a lookup table.**
- *Text with a registry (chosen)*: Pros: each feature adds its types in code beside its process, with outcome codes and default owners. Cons: the database does not stop a bad type; the service does.
- *Enum*: Cons: a migration for every new task type across some twenty features.
- *Lookup table*: Cons: the first step toward a workflow designer the final plan rules out.

**16. Write back state on the order: a projection, or always ask the connectors module.**
- *Projection plus a check at packing (chosen)*: Pros: the queue and the pick list filter by index (carried n1); packing still asks the truth. Cons: a projection to keep in step (A6).
- *Always ask*: Cons: a list of 50 orders makes 50 cross module calls, or a cross module join the module rule forbids.

**17. Added states.** `cancelled` in fulfillment, and `prepaid` and `nothing_to_collect` in cash, are not in the final plan's lists. Without them a cancelled order, a gateway paid order, and a gift would sit forever in a non final state, which the license wind down (spec 0007, final cash state) and the confirmation queue cannot accept. Runner up: encode them as reason codes on `new` and `unpaid`, which makes every "open orders" query wrong.

### Fix pass of 2026-11-05: the five blockers

The domain review (private `docs/reviews/domain-data-model.md`) found five places where money moves in a shape the tables did not expect; the gate review accepted it in full, with round 2 rulings on B1 and B5, and the owner answered three brand questions. Each decision below names the options weighed.

**B1. Where credit came from.**
- *A funding on every entry, allocation of prepayment and credit to lines, payout only from a matching funding (chosen; decided, owner question 13)*. Pros: credit that was never cash (a retention bonus, goodwill) can be spent but never leave as cash; "refund the way they paid" is defined for a pooled balance; card money goes back to the card; the arithmetic stays exact because shares follow the discount allocation rule. Cons: one return can post several entries (one per funding), grouped by `posting_id`; the credit service must sum per funding.
- *One pooled balance with a payout cap per order*: Pros: one number per customer. Cons: the retention case in the review (1,000 paid, 1,200 paid out) still happens once credit crosses orders.
- *Never pay credit out as cash*: Pros: simplest. Cons: contradicts final plan 6.2 and the owner's rule that a COD refund is cash back by Bosta.
- Consumption spends `credit_only` first, so cash stays refundable longest. Runner up: spend cash first, which strands bonus credit and pays out more cash.

**B2. What the courier should collect after a partial delivery.**
- *Keep `cod_expected_amount` as what the courier was told, add `cod_due_amount` for what the customer owes (chosen)*. Pros: both facts kept; reconciliation compares like with like, so a real shortfall is visible among partial deliveries. Cons: two amounts to explain on screen.
- *Recompute `cod_expected_amount` after delivery*: Cons: loses what the delivery was created with, which the carrier check of feature 19 needs.
- Shipping is charged in full on any partial delivery (owner answer). Cancelled lines leave `lines_gross_amount`, so a piece removed at confirmation leaves the COD.

**B3. Which period a settlement line belongs to.**
- *Derive it from `occurred_on` and the account's periods (chosen)*. Pros: an append only line never needs a later update; lines imported before their period exists join it; the exclusion constraint already makes the period unique. Cons: every period read is a date range query (indexed).
- *Store `period_id` and allow updating it*: Cons: breaks append only on the one table where history matters most.
- *Refuse to import a line until its period exists*: Cons: the daily carrier sweep would stall until the accountant creates the month.

**B4. Lines that have no order.**
- *A terminal `accounted` result with an account code, and the refund or payment document when there is one (chosen)*. Pros: a partner period can close on its payment (final plan 7.4); the close evidence sums matched plus accounted. Cons: an account code list to grow per feature.
- *Treat them as `cleared`*: Cons: hides payments from the evidence total and mixes them with superseded lines.

**B5. Opening stock without a cost.**
- *Require a cost record for every style before the opening import posts, with an owner estimate allowed and labelled "estimate" (chosen by the gate review, round 2, and the owner's answer to question 6)*. Pros: the reviewed GA ledger and its average stay untouched during foundations; an estimate is as honest as "not set" and keeps the arithmetic intact; the import lists what the owner still has to price. Cons: go live waits for a cost list, even a rough one.
- *Track units of unknown cost on each balance and change `costOutbound`* (the first fix pass instruction, reversed in round 2): Pros: uncosted stock could post at once and be flagged on the way out. Cons: changes the costing rules and the average blending of the GA ledger for no pilot value; carried to feature 59.
- *Keep the first amendment's rule (post at 0 with `cost_unknown`)*: rejected, because the built `costOutbound` ships from a positive balance at its share of 0 without the flag and blends zeros into later receipts (`apps/api/src/inventory/ledger/costing.ts`), the silent zero final plan 6.10 forbids.
- Restocks post at the order line's frozen shipment cost, never 0 and never the current average.

### Other fix pass calls

- **A lost parcel is a fulfillment state, not a reason on `returned_to_origin`** (M3): otherwise the warehouse waits for a piece and the returned to origin rate rises. No stock posting: the stock already left at `order_shipment`.
- **The edit lock is "a carrier delivery exists"**, not "pickup created" (M5): in mirror mode the carrier's own app creates the delivery, and an edit after that ships the old COD.
- **The settlement dedupe key is per statement** (M8): a corrected partner file numbers its lines again; duplicates across statements are found by content within overlapping coverage.
- **`order_consumption` replaces `exchange_consumption`**: the owner wants agents to apply kept credit on any order they create, not only on exchange replacements.
- **Actor names follow spec 0010** (`system_job`, `import`), so the order event log, the credit ledger, and the audit trail name the same actors the same way.

### Decisions made without a question (amendment)

These are engineering calls, made by recommendation; the business rules are in index.md, `## Questions for the owner`.
- **Unique keys lead with `tenant_id`; plain indexes do not.** Runner up: lead every index with it, which only widens them while one database holds one tenant.
- **Phone rules as a table in one value object**, with the doubled zero form read as an Egyptian mobile only when exactly 10 digits follow the `+`. Runner up: a phone library, which would not know the doubled zero and spreadsheet forms the brand's data carries.
- **`btree_gist` for the period overlap constraint.** Runner up: a trigger that checks overlap, which is easy to get wrong under concurrency.
- **Store and channel are separate.** A store numbers and prices orders; a channel says how they arrived and keys the export rules. Runner up: one "channel" concept, which cannot express two Shopify stores sharing one channel code mapping, or one internal store taking landing page and WhatsApp orders.
- **Source as columns on the order**, not a side table. Runner up: a one to one table, which every insert would have to remember.

### References (amendment)

**Project sources**:
- private `docs/positioning/2026-11-05-egypt-order-operations-layer.md` sections 6.1 to 6.5, 6.10, 6.13 to 6.15, 7.1 to 7.5, 12, 13
- private `docs/positioning/2026-11-05-reference-brand-notes.md` sections 2, 3, 7
- Spec 0007 sections 1, 7, 8, 10, 11, *Database roles and the append only ledgers*, *Carried from the domain review*
- private `docs/reviews/domain-stack.md` (B1, B2, m4, n1)
- `docs/scope/foundations.md` feature 4; `docs/scope/confirmation-to-cash.md` and `docs/scope/exchange-loop.md` for the features that build on this model
- `packages/db/src/schema/*`, `packages/db/migrations/0001_core_data_model.sql`, `packages/db/AGENTS.md`, `apps/api/src/inventory/AGENTS.md`
- The reference brand's `supabase/migrations/20261015120000_style_costs_and_cost_rules.sql` and `src/lib/format.ts` (`normalizePhoneEG`), read only
- Installed skills `postgresql-table-design` (NULLS NOT DISTINCT, index foreign keys, enums only for stable sets) and `drizzle-orm-patterns`

**Practices & standards**:
- Append only ledgers corrected by new entries (the original spec's own rule, extended)
- Expand and contract migrations, suspended once for a baseline with no installs
- Idempotency keys on every money writing operation
- Exclusion constraints for non overlapping ranges
- E.164 phone numbers
