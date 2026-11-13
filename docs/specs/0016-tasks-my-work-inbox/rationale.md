# 0016. Tasks and My work: decision record

Back to the [build spec](index.md).

## Context

Every process in slice 1a produces moments where a person must act: a Shopify write back failed and the courier may get the wrong address (spec 0007 section 1, "When an outbound command fails", domain review B2), a Shopify order could not be read, the carrier reported a fact the order's state contradicts, a phone did not parse, a customer asked to be called back at five. Today the real brand keeps these in heads, chat, and spreadsheets (reference brand notes, section 7: cases built as tasks by hand). The scope's feature 17 asks for one primitive and one inbox, with no workflow designer.

The pieces already exist in part. The `tasks` table was migrated by the feature 4 baseline from spec 0002 (`packages/db/src/schema/tasks.ts`) with its checks and partial indexes, but nothing writes it. Hats and the `tasks.work` and `tasks.assign` permissions exist (`packages/contracts/src/access.ts`). Several modules already publish events that name feature 17 as their listener: `OutboundCommandFailed` and its three siblings and `InboundEventFailed` (`apps/api/src/connectors/connectors.events.ts`), `OrderAttentionRaised` with fourteen kinds (`apps/api/src/orders/orders.events.ts`, `packages/contracts/src/orders/order-attention.ts`), and the platform's manager task port (`apps/api/src/platform/modules/capability-hooks.ts`), which drops every request until the tasks module registers.

The forces: a four person team (owner, one or two support agents, warehouse) on phones as much as desktops; English and Arabic; Cairo time with daylight saving; Law 151 (no personal data in logs); modules talk only through exported services and past tense events, and a module never reads another's tables; and feature 18 is being designed in parallel and must be able to build against this without waiting. Not deciding means each feature invents its own "needs attention" list, the shell count of B2 has nothing to count, and the manager task port keeps dropping requests.

The independent audit of 2026-11-11 (section 4) adds two requests: support cases (item 7) and a manual refund record with a "refunds owed" figure (item 8).

## Options considered

### Option 1: each module keeps its own attention list; My work aggregates through providers

Every module keeps a list of what needs a person (a failed reads tab, a hold filter, a callback column on orders), and My work asks each registered provider for "rows for this person".

**Pros**:

- No shared table; each list sits next to its data.
- Some lists already exist (the connection screen's failed reads tab, the order list's hold filter).

**Cons**:

- Due time, assignment, overdue, and outcome codes get reimplemented per module, differently.
- Sorting one inbox by due time across providers means merging pages from many queries.
- "Three no answers" needs a counter column on orders, which can drift.
- The spec 0002 table, already migrated and reviewed, would stay unused.

### Option 2: one tasks module, a code registry in contracts, a typed transactional service, listeners, and link resolvers (chosen)

The `tasks` module is the only writer of `tasks` and `task_notes`. A type is one entry of `TASK_TYPES` in `packages/contracts`. Producers that already publish events are handled by listeners in the tasks module inside the publisher's transaction; new processes (feature 18) call `TasksService` directly. Each module that owns a linked type registers a resolver that gives a non personal label and a path.

**Pros**:

- One sort, one overdue rule, one assignment model, one count for the shell.
- Builds on the table as migrated, with a small additive delta.
- No import cycle: `tasks` imports only platform, audit, and identity's public files; producers either publish events (no import) or import `tasks`.
- The registry is checked at build time (hat holds the permission, labels in both languages), like `AUDIT_ACTIONS`.

**Cons**:

- A listener bug can roll back the publisher's change (deliberate: no failure without its task).
- The registry is a code change per type (the scope wants exactly that).

### Option 3: a generic workflow or rules engine

States, transitions, and routing rules configured per brand in tables or a designer screen.

**Pros**:

- A brand could add a step without a release.

**Cons**:

- The scope says "there is no workflow designer"; a four person brand does not configure workflows.
- Every process is already a small state machine in its own module (spec 0002, final plan 6.3); an engine would duplicate them.
- Much larger to build and to review before a mid March pilot.

### Option 4: Option 2, but tasks scheduled as pg-boss jobs that fire at the due time

Each task with a due time sends a delayed job that marks it overdue or notifies someone.

**Pros**:

- A natural hook for push notifications later.

**Cons**:

- Overdue is a comparison at read time (`due_at < now`); a job per task adds a queue, retries, and cancellation on every reschedule for nothing the screen needs.
- Notifications are not in slice 1a (owner question 6).

## Rationale

Option 2 is the only one that gives the scope's three promises (one primitive, one inbox sorted by due time, overdue that stands out) without new machinery, and it fits the module rules: events are already in place with feature 17 named as the listener, and the in transaction event bus (spec 0013 AC-18) guarantees that a failed write back and its task commit together, which is exactly B2's requirement that a failure is never invisible. Moving the registry into `packages/contracts` costs nothing and lets the web render the close dialog's outcomes and the registry spec check labels in both languages.

The link resolver registry is the piece that keeps the module wall intact: tasks never reads `orders` to show "#1001 (Store A)", and the label shape forbids personal data, so a support case linked to a customer still shows nothing more than "Customer" until the person opens the customer page, which applies its own permission. Fallback to the hat queue at read time (an assignee who lost the hat or was disabled) avoids listening to identity's after commit events and writing tasks when hats change.

Support cases (audit item 7) are the same primitive opened by a person, so taking them in is a handful of registry rows, one route, and a notes table. The refund record (audit item 8) is not: it is money with states and a method, which spec 0002 already gives to the credit module's `refunds` document; tasks only says who pays it by when. Putting it in settlement would tie InstaPay and bank refunds, which never touch a carrier, to the carrier settlement.

**After the domain review.** The [domain review](../../reviews/domain-tasks-my-work.md) kept Option 2, the registry, and the data model, and found where per hat queues break in a four person team: a queue whose hat nobody wears hides its tasks (B1). The read time fallback already used for a disabled assignee extends naturally to an empty hat (to the manager), and the unsynced count moves from "my queues" to "everyone who can confirm orders", because it is a count without personal data. Working hours became one platform setting rather than one per feature (M3), and the refund stop gap keeps money owed as an open task, never an outcome on a closed one (M5), so the daily report never sums notes. The full list is in the build spec's *Domain review applied*.

## Evidence

- Table as built: `packages/db/src/schema/tasks.ts` (checks `tasks_owner_hat_internal`, `tasks_has_owner`, `tasks_outcome_when_done`, the open dedupe partial unique, `tasks_open_owner_user_idx`, `tasks_open_owner_hat_idx`); contract enums `packages/contracts/src/tasks/task-enums.ts`; ownership `packages/db/src/table-ownership.ts` (`tasks: 'tasks'`); the table test `packages/db/test/tasks.e2e-spec.ts` names feature 17's `TasksService` as the owner of type, outcome, and idempotency rules.
- Events naming feature 17: `apps/api/src/connectors/connectors.events.ts` (`OutboundCommandFailed`, `InboundEventFailed`), `apps/api/src/orders/orders.events.ts` (`OrderAttentionRaised`), `packages/contracts/src/orders/order-attention.ts` (the kinds), `apps/api/src/platform/modules/capability-hooks.ts` (`ManagerTaskPort`, `PlatformTaskKind`); `apps/api/src/platform/license/license-events.ts` (`WindDownEnded`).
- Outbound linked types `order`, `customer`, `variant`, `exchange`, `refund`, `connection`: `packages/contracts/src/connectors/connector-enums.ts`; the failure contract and "this feature opens no task itself": spec 0015, *Outbound commands*.
- Event delivery in the publisher's transaction: `apps/api/src/platform/events/domain-events.ts`.
- Permissions and hats: `packages/contracts/src/access.ts` (`tasks.work` personal, held by all four internal hats; `tasks.assign` by operations and manager); spec 0008 line on task queues (`access.hats` filtered to `InternalHat`) and the reserved teams and routing note.
- Time zone: the `timezone` setting, default `Africa/Cairo` (`packages/contracts/src/settings/brand-settings.ts`), and `localDate` (`apps/api/src/platform/settings/settings.service.ts`); the one minute polling precedent `apps/web/src/shell/connection-freshness-line.tsx`.
- Audit codes already named: spec 0010 Actions table row `task.assigned`, `task.rescheduled`, `task.closed`, `task.reopened`; not yet in `packages/contracts/src/audit/audit-actions.ts`.
- Redaction covers a column named `note`: `packages/config/src/redaction.ts`.
- The refund document is reserved for feature 35 in the credit module: spec 0002 customers, credit, and tasks child (`refunds`, `credit_entries.refund_id`, `refund_payout`); feature 25 promises "exchanges and refunds owed" (`docs/scope/confirmation-to-cash.md`, feature 25).
- The independent audit of 2026-11-11, section 4, items 7 and 8 (an uncommitted review file outside this worktree, cited by name only).

## References

**Project sources**: `AGENTS.md` (module rules, single writers, Law 151, UI rules); [spec 0002 customers, credit, and tasks child](../0002-core-data-model/0002-customers-credit-tasks.md); [spec 0007](../0007-stack-architecture-operations-layer/index.md) section 1 and *Carried from the domain review* row B2; [domain review of the stack](../../reviews/domain-stack.md) (B2, n1, n3); [spec 0008](../0008-roles-as-hats/index.md); [spec 0009](../0009-settings-toggles-bundles/index.md); [spec 0010](../0010-audit-trail/index.md); [spec 0013](../0013-orders-state-machines/index.md) (AC-12, AC-18); [spec 0015](../0015-shopify-connector/index.md); the installed `postgresql-table-design` skill.

**Practices and standards**: idempotent creation by a natural key with `ON CONFLICT DO NOTHING`; optimistic concurrency by `expectedUpdatedAt`; WCAG 2.2 AA (2.5.8 target size, 1.4.1 use of color); the transactional outbox principle that a fact and its consequence commit together.
