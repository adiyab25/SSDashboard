# 0013. Orders and their state machines: rationale

Decision record for [index.md](index.md). `/develop` builds from the index; this file explains why. Mode: FEATURE (scope feature 16, GA). References level: `sources`. Written in batch mode without the owner in the loop: every choice the repository answers is inferred here, and the three choices only the owner can make are decided with the recommended answer and marked Q-16.1 to Q-16.3 in the index.

## Context

The order is the centre of cash on delivery. A brand behind Shopify and Bosta loses money in the gap between what the customer ordered, what the agent confirmed, what the courier was told to collect, what the courier collected, and what Bosta remitted (final plan sections 6.1, 7.1, 7.2). Feature 4 already built the model for that: the `orders`, `order_lines`, and `order_events` tables with their checks, and the pure rules in `packages/contracts/src/orders/` (`nextState`, `replayStates`, `firstCashState`, `deriveOrderOutcome`, `splitLine`, `allocatePayments`, `codExpected`, `codDue`). Spec 0002 names feature 16 as the owner of the services that apply those rules inside transactions and write `order_events` (`0002-orders.md`, "Built here versus later"), and of the platform `DomainEvents` service that the first projection needs (spec 0002 A6 and its Follow-up).

The forces:

- **Many writers, one order.** In slice 1a alone, five features change an order: Shopify intake and edits (13), confirmation (18), the Bosta mirror (19), delivery failures (21), and settlement (22); feature 34 adds exchanges in 1b. Each arrives with its own transaction (a webhook job, a queue action, a settlement import). AGENTS.md forbids a module reading or writing another's tables (`apps/api/src/module-boundary.spec.ts` enforces it). If each feature writes the order its own way, the state machines, the money, and the outcome drift apart, and `order_events` stops replaying to the stored state.
- **Facts are not requests.** A carrier report is a fact and is never refused (spec 0002 transition table); a person's request is refused when the table says so. The same move (`shipped`) is a fact from Bosta and a mistake from a person.
- **Edits are where the money goes wrong.** An address or size fixed at confirmation reaches the courier only if Shopify gets it before the Bosta app creates the delivery (spec 0007 section 1, "What mirror mode cannot do"; domain review B2 and n1). Every edit must be audited (scope feature 16 done when; spec 0010 lists `order.edited`), and personal data must never reach the audit trail or the logs (Law 151; `packages/config/src/redaction.ts`).
- **Carried requirements.** B1 (order number unique per tenant and store, the store beside every number), B2 (outbound sync state on the order; an order with an unsynced confirmation edit cannot be packed), and the domain review's build re read: D2 (prepayment and the shipping deposit, owned by features 18 and 21, to leave room for), D3 (a whole order cancellation's effect on lines and on `codDue`, left undecided), and the spec 0002 Follow-up that replay is tested with two events in one transaction.
- **Pilot clock.** Slice 1a must land before mid March 2027 (scope index, planning notes). Feature 16 is built in parallel with features 11, 12, 13, and 14, whose specs (0011, 0012, 0014, 0015) are being written at the same time.
- **Scale.** 150,000 orders in the scale seed (about three years at 120 orders a day), list pages under 150 ms at p95 (spec 0007 section 11).
- **Team.** One to three developers plus agents; every new table, endpoint, and screen multiplies across 65 features.

Not deciding means feature 13 writes orders in its connector, feature 19 writes states in its sync, and the first partial delivery whose cash and lines disagree is found by the accountant a month later.

## Options considered

### Option 1: one orders module as the single writer, named moves called inside the caller's transaction, events through an in transaction `DomainEvents` (chosen)

The orders module owns one internal writer (`writer/order-writer.ts`) that locks the order row, applies a planned change, writes event rows, recomputes money and outcome, and publishes domain events. Other modules call named, exported methods (`createFromChannel`, `edit`, `confirm`, `cancel`, `recordShipmentFact`, `recordPartialDelivery`, `recordCollection`, `recordSettlement`, and the rest) with their own `Transaction`. The orders module tells the rest of the app what happened through past tense events that run inside the same transaction.

**Pros**:

- One place enforces the transition table, the service guards `nextState` leaves out, the money recompute, and the outcome; the replay invariant has one writer to test.
- A Shopify webhook job, a Bosta sync job, and a settlement import each keep their own transaction, so their inbox status and the order change commit together (spec 0007 section 1, Processing).
- Named methods document the contract for each later feature; their specs reference a method, not a table.
- Matches the existing single writer pattern of the stock ledger (`apps/api/src/inventory/ledger/ledger.service.ts`).

**Cons**:

- The orders module grows a wide public surface (about fifteen methods) that must stay stable while features 18 to 22 build on it.
- Every caller shares the order row lock.
- Synchronous in transaction listeners can slow or fail the publisher's transaction; a bad listener in another module rolls back an order change.

### Option 2: an event sourced order (the order row rebuilt from `order_events`)

Every change, edits included, becomes an event; the order and line rows are projections rebuilt from the event stream.

**Pros**:

- History is complete by construction; replay is the only write path.
- Corrections are new events, like the ledger.

**Cons**:

- The built `order_events` holds state moves only (`machine`, `from_state`, `to_state`, `amount`); edits, splits, and money would need a new event table and a rewrite of the built rules, against the "amend, don't redesign" brief and a baseline already shipped (ADR 0003 freezes the baseline at the pilot's first import).
- Projections that lag or fail give the confirmation queue a stale order; making them transactional brings back Option 1's single writer anyway.
- Much more code for a team of one to three before mid March.

### Option 3: a shared order helper that each feature calls from its own module to write the columns it needs

A small library (for example in `packages/contracts` or a platform service) exposes "apply transition" and "recompute amounts"; features 13, 18, 19, and 22 write the order tables through it from their own modules.

**Pros**:

- No wide service surface; each feature writes what it needs.
- Fewer cross module calls.

**Cons**:

- Breaks the module wall (AGENTS.md: modules never touch another module's tables; `module-boundary.spec.ts` would need a permanent exception for every caller).
- Nothing stops a feature from writing a column without the helper; the replay and outcome invariants then depend on discipline across five teams of agents.
- The audit entry, the reservation, and the outbound command would each be remembered (or forgotten) by every caller.

### Option 4: state moves as queued jobs (callers enqueue a request; an orders worker applies it later)

Callers send `OrderMoveRequested` jobs through pg-boss; one orders worker applies them in order.

**Pros**:

- Callers never wait on the order lock; the orders worker serializes moves per order.
- A failing move retries without failing the caller.

**Cons**:

- The order lags what the carrier or the agent just did; the confirmation agent who presses Confirm sees `new` until the worker runs.
- The caller's inbox status (processed) and the order change no longer commit together, so a crash between them loses or doubles a move, which is exactly what spec 0007's processing rule avoids.
- Errors (an invalid transition) come back asynchronously, so a person gets no 409 at the moment of the mistake.

## Rationale

Option 1 is the only one that keeps both of spec 0002's integrity promises (every move has exactly one event; the outcome is only ever `deriveOrderOutcome`) while respecting the module wall and spec 0007's rule that an inbound event's status and its domain change commit together. The forces "many writers, one order" and "facts are not requests" are answered by named methods whose actor decides which rows of the transition table apply, so Bosta's `shipped` is accepted and a person's is refused by the same table. The cost, a wide surface, is the price of documenting the contract once instead of five times, and the ledger already runs this way. Option 2 fails the pilot clock and the brief; Option 3 fails the module wall; Option 4 fails the transactional rule and gives people late errors.

The cost of in transaction listeners is accepted deliberately and bounded: spec 0002 A6 already decided that projections run with the publisher's transaction, and work that leaves the process (a task for a person, a Meta event, a write back call) is a pg-boss job enqueued in that transaction, so a listener only writes rows.

### Sub decisions

**`DomainEvents` as a small registry, not `@nestjs/event-emitter`.** The app already uses `EventEmitter2` (`apps/api/src/app.module.ts`, identity's auth audit), but its handlers run after the fact and are not tied to a transaction. The registry here is about fifty lines: `on(eventClass, handler, owner)` at module init, `publish(tx, event)` awaiting each handler in registration order with the publisher's transaction, a throw propagating to roll back. Runner up: `EventEmitter2.emitAsync` with the transaction in the payload, rejected because it hides ordering and swallows nothing explicitly, so a forgotten `await` loses a projection silently.

**The idempotency key lives on the order (`channel_order_ref`).** The brief asks for an idempotent create by store and channel order id. Feature 13 maps external ids in its own `connection_external_ids`, which the orders module may not read. Keeping the channel's id on the order, unique per store when set, lets `createFromChannel` answer a repeat by itself and gives the manual form the same protection (its `clientRef`). Runner up: rely on (`store_id`, `order_number`) alone, rejected because it gives no protection to manual orders (the number is issued by us) and cannot tell a repeat from a genuine clash of numbers.

**One edit endpoint with a list of operations.** An agent fixes the address and changes a size in one call to the customer; one transaction, one audit entry, one `OrderEdited` event, and one outbound command follow. Runner up: one route per edit kind, rejected because it writes several audit entries and several Shopify commands for one conversation, and lets the second call fail after the first committed.

**A line is never changed in place.** Spec 0002 already says a variant change is cancel plus add (carried m3 and domain review m2), so the metric dictionary can tell an edit removal from a cancellation. Extending it to quantity and price keeps one rule and keeps the line money shape the split and the credit ledger rely on. Runner up: in place quantity edits, rejected because a quantity drop would then be invisible to the return rate classification of final plan 6.14.

**A whole order cancellation keeps its lines `open` and `codDue` returns 0 for `cancelled`.** This is the domain review's own recommendation for D3. Cancelling every line instead would drop `lines_gross_amount` and `total_amount` to the shipping alone, and every confirmation cancellation would show 50.00 in the order header and in "cancelled value per agent". Runner up: cancel every line, rejected for that reason.

**Shipping posting as a job enqueued with the `shipped` move.** A carrier fact must never fail (spec 0002), but a stock posting can (a short balance, an unmapped line, a locked period). Posting in the same transaction would make the stock rule refuse a carrier fact. The job is enqueued in the move's transaction, retries, and opens an attention if it cannot post. Runner up: post inside the move's transaction, rejected because one unmapped line would block every later state of that order.

**Edits refuse a change of payment class.** Moving `cod_expected_amount` between zero and above zero changes the first cash state class, which the cash table has no row for before shipping (`prepaid` to `unpaid` does not exist). Adding those rows is a model change that belongs with the deposit and payment work of feature 18 (domain review D2). Runner up: add the rows now, rejected to leave D2's design to its owner.

**Manual prepayment only 0 or the full total.** Leaves room for D2: a deposit is exactly the case D2 says the gross share allocation gets wrong, so the manual path does not create one until feature 18 decides `prepaid_purpose`. Channel orders keep whatever the channel reports, as today.

**Reservations never refuse an order.** A Shopify order is a fact; a manual order for a piece the warehouse cannot find is still a customer wanting it. The line is marked short and the confirmation agent sees it. Spec 0011 keeps the missing part as `reservations.unfilled_quantity` and fills it oldest first on every write that frees stock (its AC-21, the lead's ruling); the orders module keeps only a copy (`order_lines.short_quantity`) so the list can flag and filter short lines without reading inventory's tables, and refuses to pack a short line (Q-16.5).

**Owner decisions, why each is the owner's.** Q-16.1 (where WhatsApp orders are entered) changes the brand's daily process and, in mirror mode, who creates the Bosta delivery. Q-16.2 (when stock is held) changes what available stock means to the brand's staff. Q-16.3 (editing Shopify orders with write back off) trades agent speed against the silent wrong parcel of review B2. Q-16.4 (cancel after the delivery exists) decides whether the agent or the Bosta dashboard closes a fake order. Q-16.5 (packing a short line) trades warehouse speed against a refusal at the door. Q-16.6 (linked orders) decides how a reopened or replacement order counts for the campaign and the return rate. Each has a recommended answer the rest of the design is built on.

### Sub decisions from the domain reviews of 2026-11-07

The orders review (kept private) accepted the design with one blocker and seven majors; the lead added rulings from the reviews of spec 0011 and spec 0015. Each change and why:

**Two locks instead of one (X1, Q-16.4).** The first draft locked edits and cancels at `carrier_delivery_created_at`. The reference brand's own Bosta sync retires deliveries that "never leave Pickup requested", so deliveries exist for orders that never ship, and with the lock a fake order stayed `new` for good, holding stock and cash expected. The money freeze stays at the delivery (the courier was told an amount); the cancel lock moves to pickup, which is what the transition table's from states already say. A carrier row to `cancelled` covers a delivery the carrier terminated before pickup. Runner up: keep the lock and cancel only in Bosta, rejected because the agent who knows the order is fake is in the app, not in Bosta.

**One transaction entry point for every orders write.** Spec 0011 lets reservations run only inside `LedgerService.transaction`, whose deadlock retry reruns the caller's whole unit. Two choices: mark the few methods that touch stock and let the others take any transaction, or route every orders write through one runner. One runner wins: a caller cannot pick the wrong one, the rule is one sentence for features 13, 18, 19, 21, and 22, and the cost (the rerun discipline) applies to every unit of work anyway once any step in it may reserve. Orders owns the runner (`OrderTransactions.run`) so callers never import inventory. Runner up: callers open `LedgerService.transaction` themselves, rejected because it spreads inventory's type across five modules.

**A channel edit waits while the app's own edit is unsynced (M2).** Without it, a Shopify update arriving between the agent's edit and its write back undoes the edit, and the echo of a synced edit duplicates the line the app added (it has no channel id yet). Applying nothing while a command is open, matching id less lines by variant, quantity, and price, and recording the channel's ids when the command syncs (`recordChannelLineIds`) close both. Runner up: merge the snapshot field by field against the open command's payload, rejected as too much logic for slice 1a.

**Unknown carrier facts apply nothing (M3).** A carrier report is a fact and the table cannot foresee every one (the reference brand reships after a return to origin). Throwing rolls back the carrier sync forever; applying nothing with an attention keeps the sync moving and puts a person on the contradiction.

**Shopify cancels after the parcel came back are expected (M4).** The reference brand cancels returned orders in Shopify as bookkeeping; a task for each would be about 26 a day of noise for a team of four.

**Overpaid edits are refused (M5).** The built `codExpected` throws on a total below what was prepaid; a stable code and a rule beat a server error, and the refund belongs to feature 18's D2 work.

**Linked orders now (M7, Q-16.6, and the Shopify review's Q-13.5).** `related_order_id` and `exchange_replacement` exist in the model; without a way to create them in slice 1a, reopened orders lose their campaign and size refusals count as failures. `goodwill_for` is a new enum value because a gift cannot carry `original_order_id` (that column means an exchange replacement by check).

**Carrier shipments never wait on stock (the lead's ruling with spec 0011).** `postCarrierShipment` books what the carrier took even when the books disagree, and the disagreement becomes a task. The shipment stays a job after the move commits, so a slow posting never holds the carrier sync's transaction.

**A carrier `shipped` always enqueues the posting job (owner ruling, 2026-11-21).** AC-15 first said a carrier `shipped` enqueues nothing new when a Shopify fulfillment had already recorded the stock out request. That left a gap: the Shopify fulfillment records the request, the order is cancelled before `orders.post_shipment` runs (the job skips a cancelled order), and a late carrier `shipped` arrives; the pieces left with the courier and were never posted. Now every carrier `shipped` enqueues the post job for the order's current stock out generation, while the request itself is still recorded once. The job reads `ledger.postingFor(key)` first, so it never posts twice, and the ledger's idempotency key backs that up under a race. Rejected: (a) re-enqueue only on `cancelled` to `shipped`, because the same gap exists whenever the first job run was skipped or lost for any reason and the job is already idempotent, so a narrower trigger buys nothing and adds a branch; (b) raise an attention for a person to post by hand, because the courier's pickup is the truth and a person adds delay and error to a fact the system already knows; (c) accept the gap, because stock would stay on the books for pieces that left the building.

**Three small calls for the Shopify connector.** A go live import enters old orders as `confirmed` without a fake confirmation path (Q-13.7); `linkChannelLineVariant` maps a line that arrived before its product without counting an edit (its M8); `rederivePaymentMethod` fixes a payment method a gateway mapping got wrong while nothing has moved (its M6), which needs three new cash rows limited to one reason.

### Evidence: what is built and what this spec uses

| Built piece | Path | Used for |
|---|---|---|
| Order tables, checks, indexes | `packages/db/src/schema/orders.ts` | the write paths; three columns, six indexes, and one enum value added |
| `nextState`, `firstCashState`, `replayStates`, `OrderTaskKind` | `packages/contracts/src/orders/order-states.ts` | every move; the cancel row until pickup (person, `system_job`, `carrier`) and the `payment_method_rederived` cash rows |
| `allocatePayments`, `codExpected`, `codDue` | `packages/contracts/src/orders/order-amounts.ts` | recompute; `codDue` reads the fulfillment state |
| `splitLine` | `packages/contracts/src/orders/line-split.ts` | partial delivery |
| `deriveOrderOutcome`, `deliveredAmountOf` | `packages/contracts/src/orders/order-outcome.ts` | outcome |
| `LineAmounts.compute` | `packages/contracts/src/money.ts` | line and shipping money |
| `NumberingService.next` and the seeded `SO` prefix | `apps/api/src/platform/numbering.service.ts`, `packages/db/migrations/0002_baseline_rules.sql` | internal store numbers |
| `orders.*`, `fulfillment.work`, `cost.view`, `audit.read` | `packages/contracts/src/access.ts` | route permissions (none new) |
| `AuditService.record`, the `order` record type (reason as a code) | `apps/api/src/audit/`, `packages/contracts/src/audit/audit-record-types.ts` | the five audit codes |
| Ship to keys in the redaction list | `packages/config/src/redaction.ts` | audit and log privacy |
| `outbound_commands` and its open index | `packages/db/src/schema/connectors.ts` | the packed guard and the hold, through feature 13's service |
| Keyset cursor | `apps/api/src/platform/keyset-cursor.ts` | the list |

## References

**Project sources**

- `AGENTS.md` (domain driven modules, the module wall, one schema per shape, errors with stable codes, Law 151, the UI rules), `apps/api/AGENTS.md` (audit in the caller's transaction, keyset lists, the route sweep), `packages/db/AGENTS.md` (tenant keys, trigger stamped columns, expand and contract), `packages/contracts/AGENTS.md` (`deriveOrderOutcome` only, reason codes, money as text).
- [Spec 0002](../0002-core-data-model/index.md) and its [orders child](../0002-core-data-model/0002-orders.md), [customers child](../0002-core-data-model/0002-customers-credit-tasks.md), and [tenancy child](../0002-core-data-model/0002-tenancy-platform.md) (A6).
- [Spec 0007](../0007-stack-architecture-operations-layer/index.md): section 1 (outbound commands, the blocking rule, edit netting, mirror mode), section 7 (order number per store), section 10 (operating day), section 11 (scale), *Carried from the domain review* (B1, B2, m3).
- [Spec 0008](../0008-roles-as-hats/index.md) (the permission matrix), [spec 0009](../0009-settings-toggles-bundles/index.md) (settings registry, module registry, executing steps, job registry), [spec 0010](../0010-audit-trail/index.md) (actions, reason codes, privacy).
- [Spec 0011](../0011-stock-ledger-locations/index.md) (the stock transaction, reservations with `unfilled_quantity`, `postCarrierShipment`, the events, `OnlineStockGate`), [spec 0014](../0014-customers-by-phone/index.md) (the `CustomersService` contract), [spec 0015](../0015-shopify-connector/index.md) (the build order, `ChannelsService`, `ConnectorsService`).
- Domain review of this spec (kept private) (X1, M1 to M7, m1 to m9, the eight brand questions), domain review of spec 0015 (kept private) (M6, M8, m2, Q-13.5, Q-13.7), and the lead's rulings from the domain review of spec 0011 (kept private).
- Domain review of the data model (kept private) (B2, M5, m1 to m3, build re read D2 to D4) and domain review of the stack (kept private) (B2, n1).
- [Scope, slice 1a](../../scope/confirmation-to-cash.md) (features 13, 16, 18, 19, 21, 22, 24) and the final plan private `docs/positioning/2026-11-05-egypt-order-operations-layer.md` sections 6.1, 6.14, 7.1, 7.2.
- Installed skills: `postgresql-table-design` (partial unique index, index per access path), `nestjs-best-practices`, `drizzle-orm-patterns`, `pg-boss-v12`.

**Practices & standards**

- Single writer for a ledger like record; corrections as new rows.
- Idempotency keys on every create that a retry can repeat.
- Optimistic concurrency with a version token (`updated_at`) on edits by people.
- Transactional outbox: work that leaves the process is enqueued in the same transaction.
- Keyset pagination for every list.
- Egyptian Personal Data Protection Law 151 of 2020: no personal data in logs or audit entries.
