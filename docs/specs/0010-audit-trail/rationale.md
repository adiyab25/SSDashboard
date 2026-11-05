# 0010. Audit trail: decision record

Build spec: [index.md](index.md).

## Context

Scope feature 10 asks for agent accountability: who did what, when, and why, across edits, merges, overrides, confirmations, exports, and every automatic action, with entries nobody can edit or delete and a manager filter by person and record ([foundations scope](../../scope/foundations.md)).

Forces that shaped it:

- **The data model already points here.** The amendment of [spec 0002](../0002-core-data-model/index.md) says "writes an audit entry (feature 10)" for order edits, partial delivery splits, task changes, customer merge and unmerge, and policy row changes, and it already lists `audit_entries` as an append only table owned by an `audit` module ([tenancy child](../0002-core-data-model/0002-tenancy-platform.md), A4 and A5). The shape of that table is what this spec decides.
- **Modules may not read each other's tables** (root [AGENTS.md](../../../AGENTS.md)). An audit module that reached into orders to build a diff, or into customers to undo a merge, would break the walls. So callers hand over what changed, and an undo is run by the owner.
- **Automatic actions are a selling point** ([positioning 6.13](../../positioning/2026-11-05-egypt-order-operations-layer.md): every automatic action writes a snapshot and can be undone in one step; confirmations are revoked with a reason, never deleted; 6.12: mapping edits are audited and undoable). An automatic action without a visible, reversible record would be a risk, not a feature.
- **More kinds of actors than staff.** Spec 0005's amendment adds partner users to the people who sign in; connectors add carriers and imports; the portal adds customers acting through a signed link; the worker adds scheduled jobs. The log must say which, and a wrong shape must not fit.
- **Personal data (Law 151).** Orders and customers carry phones, names, and addresses, and the shared redaction list (`packages/config/src/redaction.ts`) already says which keys they are. Before and after values would copy those into a table that, by design, is never deleted. That is the sharpest tension in the feature.
- **Scale.** The design size is 150,000 orders over about three years (spec 0007 section 11). With several entries per order, a few million rows is normal and years of history must stay fast to filter.
- **Exports are audited too.** Spec 0007 section 4 records who marked an export run imported and when; that is also an audited action.

Not deciding means each feature invents its own log, and "who did this" has a different answer in every screen.

## Options considered

### Option 1: One audit table, written by an explicit `AuditService.record(tx, ...)` call in the writer's transaction (chosen)

Every module calls the exported service inside the transaction that makes the change. The service checks a registry of action codes, applies the reason policy, masks personal fields, and inserts. Undo is a handler registry that owners fill in.

**Pros**:
- Atomic: no change without its entry, no entry for a rolled back change.
- Simple to read and test; the failure of a missing call is visible in the owning module's tests.
- No new infrastructure; the same pattern as the ledger `within` callback ([spec 0006](../0006-core-stock-loop/index.md)).
- One query answers any "who" question.

**Cons**:
- A developer can forget the call; only tests and the registry's `proof` rule catch it.
- Every module depends on the audit module (a leaf with no dependencies of its own, so no cycle).

### Option 2: Past tense domain events, handled by an audit subscriber

Modules emit `OrderEdited`, `CustomerMerged`, and so on; the audit module subscribes and writes.

**Pros**:
- Modules do not import the audit service.
- Fits the event rule spec 0002 A6 uses for projections.

**Cons**:
- Each event must carry the full before and after, so the event becomes the audit entry in disguise.
- A missing handler or a handler error fails silently or, if run in the publisher's transaction, behaves exactly like Option 1 with more indirection.
- `DomainEvents` is not built until feature 16, so this would add a dependency on a later feature.
- Events are for facts other modules react to; audit is a record, not a reaction.

### Option 3: Option 1 plus a hash chain over entries

Each entry stores the hash of the previous one, so owner level tampering can be detected.

**Pros**:
- Detects an owner or superuser changing or deleting rows.

**Cons**:
- Writers must serialize on the chain head (a lock or a sequence), which turns every audited transaction into a queue; this fights the ledger's own locking and the throughput of imports.
- Solves a threat (a hostile database administrator) that the append only privileges and the two role rule already narrow, and the pilot has no such client.
- Can be added later without changing the entry shape (a column and a verification job).

### Option 4: A log table inside each module, no shared audit table

Orders keep an order audit table, customers keep theirs, and the manager screen unions them.

**Pros**:
- Each module owns its own history; no shared contract.

**Cons**:
- "Filter by person" becomes a union over a dozen tables, and the append only guard and the personal data rule must be repeated in each.
- A new module is easy to ship without a log at all.
- The scope asks for one filter by person and record.

## Rationale

Option 1 is the smallest design that meets the scope's three promises: every action writes an entry (a registry plus proof tests), managers can filter it (one table, indexes for the filters), and nothing can change it (privileges plus a trigger). It follows the pattern the project already uses for the stock ledger: one writer service, append only, same transaction.

**Why masked personal fields, not stored ones.** Three choices were weighed: store everything and restrict reading, store an encrypted copy and shred the key at retention end, or store only the fact of change. The first puts personal data into a log that never shrinks and that gets exported to spreadsheets. The second adds key management and a second retention clock for little gain, since managers mostly need "who changed the address, when, and why", and the owning record holds the current value (and its own history, where the owner decides how long). The third keeps the log free of personal data, so there is nothing to erase for a data subject request, and retention can be "forever" without a legal tension. The shared redaction list is reused so there is one definition of personal data for logs, errors, and the audit trail; a field added to the list is protected in all three. The cost is that an old address cannot be recovered from the audit trail; the owner is asked (question 1) and the default is the safe one.

**Why undo through handlers.** "Undo in one step" needs the owner's knowledge (a merge restores pointers, a mapping restores a code). Running that in the audit module would mean it reads and writes other modules' tables. A registry of owner handlers keeps the walls, gives one undo code path per action (the customer screen and the audit screen call the same method), and lets the owner refuse a stale undo with its own typed reason (spec 0002's `MergeNotLatest`).

**Why not partition now.** The scale target gives low millions of rows, far below the size where partitioning pays off, and it complicates the primary key and the keyset order. Keyset paging on a descending (`recorded_at`, `id`) btree plus a small BRIN on the operating day keeps the budgets. The trigger to revisit is written into the spec.

**One entry per changed record.** A merge touches two customers; writing one entry per record keeps every filter by record a plain index lookup and lets a correlation id group them. A single entry holding two record ids would need an array index and break "the history of this record".

**What "automatic action" means.** A carrier feed is not a decision; the order's event history already records it with the carrier as actor. Counting every feed as an audit action would write millions of rows that say nothing a manager can act on. The registry marks the system's decisions, and those are all undoable.

## References

**Project sources** (verifiable, in this repo):
- `AGENTS.md` (root): module walls, the two database roles, append only ledgers, personal data in logs, strict types, doc rules.
- `packages/config/src/redaction.ts`: `PERSONAL_DATA_KEYS`, `PERSONAL_DATA_PATHS`, `CONTACT_MARKER_KEYS`, `maskPhones`, `createRedactor`, `redact`.
- `docs/specs/0002-core-data-model/0002-tenancy-platform.md`: `tenant_id`, `ssd_reject_change()`, `ssd_stamp_operating_day()`, A3 operating day, A4 append only list (names `audit_entries`), A5 ownership map (module `audit`), A6 domain events.
- `docs/specs/0002-core-data-model/0002-orders.md`, `0002-customers-credit-tasks.md`: the places that say "writes an audit entry (feature 10)"; `order_events.actor_type`; `customer_merges` and `MergeNotLatest`.
- `docs/specs/0005-staff-sign-in/index.md` (amendment): partner users, the audience aware guard, the sign in events already logged.
- `docs/specs/0006-core-stock-loop/index.md`: the receipt void used as the tracer thread; the `within` transaction pattern; cost hidden from staff (AC-11).
- `docs/specs/0007-stack-architecture-operations-layer/index.md`: section 4 (export runs: marked imported, who and when), section 11 (scale), "Database roles and the append only ledgers".
- `docs/positioning/2026-11-05-egypt-order-operations-layer.md`: 6.12 (mapping edits audited and undoable), 6.13 (automatic actions write a snapshot and can be undone in one step; confirmations revoked with a reason, never deleted).
- `.claude/skills/postgresql-table-design/` (types, constraints, partitioning thresholds, BRIN for naturally ordered data).

**Practices and standards**:
- Append only audit logs written in the same transaction as the change.
- Keyset (seek) pagination over offset paging for large ordered lists.
- Data minimisation under Egypt's Personal Data Protection Law 151 of 2020 (the project's rule in AGENTS.md; no legal text was opened for this spec, so no article numbers are cited).
- Registry driven extension: a new action is data plus a call, not a schema change.

**Links**: none verified.
