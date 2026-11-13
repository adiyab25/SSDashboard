# 0016. Tasks and My work: one task primitive every process opens, and one inbox per person

**Date**: 2026-11-12
**Status**: In Progress (milestone 1 built on `feat/tasks-my-work`; ratified by the owner on 2026-11-13, [owner answers](../../reviews/owner-answers-2026-11-13.md): every owner question as recommended; written by the architect without the owner and revised the same day for the [domain review](../../reviews/domain-tasks-my-work.md), accept with changes, B1, M1 to M7, and m1 to m7 folded in with the lead's rulings, see *Domain review applied*; `/develop` advances the status as feature 17 is built)
**Feature**: [scope feature 17, Tasks & My work inbox](../../scope/confirmation-to-cash.md) (slice 1a, Core, Beta)
**Depends on**: the `tasks` table as migrated by the feature 4 baseline ([spec 0002 customers, credit, and tasks child](../0002-core-data-model/0002-customers-credit-tasks.md), `packages/db/src/schema/tasks.ts`); hats and permissions ([spec 0008](../0008-roles-as-hats/index.md), `packages/contracts/src/access.ts`: `tasks.work`, `tasks.assign`, `InternalHat`); the module registry, the settings registry, and the manager task port ([spec 0009](../0009-settings-toggles-bundles/index.md), `apps/api/src/platform/modules/capability-hooks.ts`); the audit trail ([spec 0010](../0010-audit-trail/index.md)); in transaction domain events (`apps/api/src/platform/events/domain-events.ts`, built by [spec 0013](../0013-orders-state-machines/index.md)); the outbound and inbox events of [spec 0015](../0015-shopify-connector/index.md) (`apps/api/src/connectors/connectors.events.ts`).
**Parallel seam**: scope feature 18 (confirmation queue, [spec 0017](../0017-confirmation-queue/index.md)) opens its callback and reconfirm tasks through *Interface for other modules* below and reads the working hours setting defined here. Feature 22 (settlement) is designed at the same time; see *Decision on audit item 8*.

## Summary

A task is one small row: what kind of work it is (its type), which record it is about, whose queue holds it, when it is due, and how it ended (an outcome code). Every process opens and closes tasks through one service, `TasksService`, and each task type is one row in a code registry in `packages/contracts`, so there is no workflow designer. Each person gets one screen, My work, that shows their own tasks and the unassigned tasks of their hats, sorted by due time, with overdue tasks standing out, and it works on a phone in English and Arabic. A queue with nobody in its hat falls to the manager, so no task is ever orphaned. The first real thread is the failed Shopify write back of spec 0007 (B2): it opens a task the same minute, every agent who can confirm orders sees the unsynced count, and the task closes itself when the write back lands. Due times follow one brand wide working hours setting. Support cases (wrong item, damaged or missing, late delivery, carrier ticket, reorder) are task types a person opens with a follow up time; the refund record itself is not a task and belongs to the credit module.

## Requirements

**User stories**:

- As a support agent, I open My work on my phone and see my callbacks, cases, and the support queue in due order, with what is overdue on top and a card for the orders waiting to confirm, so I never keep a spreadsheet of follow ups.
- As the agent who fixed an address at confirmation, I see my own failed or late Shopify write back as my task and in the shell count within a minute, open the order from it, and the task closes by itself once the write back lands, so a wrong address never reaches the courier unseen.
- As the owner (manager hat), I see every task whose hat has nobody in it, every escalated case, and every open task by hat and person, so nothing waits in a queue no one opens.
- As a support agent, I open a case on an order with a follow up time and notes, see first whether one is already open, escalate it to the owner when I cannot resolve it, and close it with an outcome that never drops money owed.
- As the developer of another module (feature 18 first), I open, reschedule, find, assign, and close tasks with one typed service inside my own transaction, and I add my task types as registry rows, so I never write my own queue table.

**Acceptance criteria**:

- **AC-1** (the registry): every task type is one entry of `TASK_TYPES` in `packages/contracts/src/tasks/task-types.ts` with its code, owning module, allowed linked types, default hat, required permission, due rule, outcome codes, who may close it, whether a person may snooze it, whether it may be opened by a person, whether its dedupe key holds forever, whether it is cancelled when its order ends, and its English and Arabic label keys. `task-types.spec.ts` fails when a code or outcome breaks the `ReasonCode` shape, a module is not in `MODULE_REGISTRY`, the default hat does not hold the required permission in `HAT_PERMISSIONS`, the required permission is not a `staff` permission, an outcome list is empty, an order attention kind has no type, or a label key is missing from either catalog. This amends spec 0002, which put the registry in `apps/api/src/tasks/task-types.ts` (*Decision*).
- **AC-2** (open): `TasksService.open(tx, input)` refuses an unregistered type (`UnknownTaskType`) and a linked type its entry does not allow (`TaskLinkNotAllowed`); it fills the hat and the due time from the registry when the caller passes none; it always stores `owner_hat`. With a `dedupeKey` it returns the open task with that key and `created: false` instead of opening a second, also when two transactions open at once (one row, both callers get it). For a type marked `once`, it returns the earlier task of that key whatever its status.
- **AC-3** (close and cancel): `close` sets `done`, the outcome, `closed_at`, and `closed_by`; an outcome its type does not allow raises `InvalidOutcome`; an outcome reserved for the system, or a type closed only by the system, refuses a person (`OutcomeNotForPerson`); an outcome that requires a note refuses a close without one (`NoteRequired`); closing a task that is not open raises `TaskNotOpen`. `closeByKey` closes the open task of a key and answers null when there is none. `cancel` and `cancelOpenFor` set `cancelled` with no outcome and a reason code in the audit entry. The tasks module cancels open tasks of types marked `cancelWhenOrderEnds` when `OrderStateChanged` moves the order's fulfillment to `cancelled` (domain review m4).
- **AC-4** (reschedule, assign, escalate): `reschedule` moves `due_at` to a time after now and at most 90 days ahead (`DueInvalid` otherwise); the person facing route refuses it on a type marked `snoozable: false` (domain review m1). `assign` sets an active person who holds the type's required permission (`TaskAssigneeNotEligible` otherwise; the person need not wear the task's hat, so the agent who made an edit can hold an operations task, domain review B1), or clears the person; it may move the task to another internal hat that holds the required permission. With `tasks.work` a person may: take an unassigned task of a queue they see; take an overdue task held by someone else in a hat they wear; release their own task; release all their own open tasks in one action; and **escalate** a task they see to the `manager` hat with a reason code (`customer_complaint`, `needs_approval`, `cannot_resolve`), which clears the assignee (domain review M4). Moving someone else's task otherwise, and releasing all of another person's tasks, needs `tasks.assign`.
- **AC-5** (My work and the queue rules): `GET /api/tasks?view=mine` answers the caller's open tasks: those assigned to them; the unassigned tasks whose `owner_hat` is one of their internal hats; tasks assigned to someone who is disabled or no longer holds the type's required permission (they fall back to the hat queue at read time); tasks assigned to someone else that are overdue, in a hat the caller wears, shown as "overdue, held by" that person with a Take action (domain review M4); and, for a `manager`, the unassigned tasks of any internal hat that has no active holder (domain review B1). Only types whose required permission the caller holds appear. Rows sort by due time, earliest first, tasks with no due time last, then by creation; keyset pages of 50. `view=team` (all open tasks, filters by hat, person, and type) needs `tasks.assign` (403 otherwise).
- **AC-6** (overdue and working hours in Cairo time): a task is overdue when it is open and `due_at` is before now, read from `PlatformClock`. The screen groups rows into Overdue, Due today, Later, and No due time, where "today" is the local date in the brand's `timezone` setting (default `Africa/Cairo`, daylight saving included), and shows every time in that zone, never the device's. Overdue rows carry a text label and an icon, not color alone. Every due rule is evaluated inside the brand's working hours, the platform setting `operations.working_hours` (*Working hours*): a task opened outside working hours is due at the next opening; `after_minutes` counts working minutes; `next_local_time` gives the next occurrence of that wall clock time inside working hours (domain review M3). A time a person picks (a case's follow up, a snooze) is kept as picked, with a warning in the dialog when it falls outside working hours.
- **AC-7** (the shell count, B2): `GET /api/tasks/summary` answers the caller's open, overdue, and due today counts for view `mine`, plus `unsyncedEdits` for any caller holding `orders.confirm`: every open `sync.write_back_failed` and `sync.write_back_late` task, whatever its queue or assignee (domain review B1, M1, M2). The back office navigation shows My work with the overdue count, and the unsynced count as its own badge linking to the order list's hold filter, read once a minute while the tab is visible.
- **AC-8** (failed and late write backs, B2): on `OutboundCommandFailed` the tasks module opens `sync.write_back_failed` on the command's linked record in the publisher's transaction, dedupe key `outbound_command_failed:<command id>`, `subject_key` `<kind>:<failure code>`, due at once (inside working hours), owner hat `operations`, assigned to the person who queued the command when the event names one and that person holds `orders.confirm` (domain review B1). On `OutboundCommandOverdue` (a new spec 0015 event, *Follow-up*) it opens `sync.write_back_late` the same way, dedupe `outbound_command_late:<command id>` (domain review M1). On `OutboundCommandSynced` or `OutboundCommandResolved` it closes both with outcome `synced` or `resolved`; on `OutboundCommandFailed` it closes the late task with `became_failed`. A person can never close or snooze either. When the failure code is `MODULE_OFF` or `STEP_OFF` it opens, in addition, one `sync.commands_stopped` task per command kind and code for the manager (spec 0009: one manager task per capability), which shows how many orders are affected and closes only by the system once no `sync.write_back_failed` with that `subject_key` is open (domain review M2).
- **AC-9** (the other producers): the tasks module turns `OrderAttentionRaised` into one task per kind and order (`order.<kind>`, dedupe `order_attention:<kind>:<order id>`), `InboundEventFailed` into one task per Shopify order (`connector.inbound_failed`), and the manager task port requests of spec 0009 into `platform.wind_down_ended` and `platform.stock_out_source_missing` (`once`). Events that later features add (`StockOverdrawn` of spec 0011, `ChannelProductNeedsAttention` of spec 0015) get their listener and registry row in the change that builds the event.
- **AC-10** (support cases, audit item 7): a person with `tasks.work` and `orders.view` opens a case on an order (or, for a reorder or other, on a customer) through `POST /api/tasks` with one of `case.wrong_item`, `case.damaged_or_missing`, `case.late_delivery`, `case.carrier_ticket`, `case.reorder`, `case.other`, a required follow up time, an optional contact channel code, an optional note, and on `case.carrier_ticket` an optional carrier ticket reference (domain review m2, m3). Before it opens, the dialog lists the open tasks on that record (for a customer, on her orders too); a second open case of the same type on the same record answers 409 `CASE_ALREADY_OPEN` unless the request says `confirmDuplicate: true` (domain review M7). A case closes only with one of its type's outcomes; no outcome hands work to a record that cannot be made in the same step (domain review M5, *Cases and money owed*).
- **AC-11** (notes): a person who can see a task adds a note (1 to 1,000 characters) through `POST /api/tasks/:id/notes`; notes are append only (`task_notes`, the app role has no `UPDATE` or `DELETE`), shown newest first with author and time. Note text is personal data: never logged, never in an audit diff, never in an error.
- **AC-12** (links without personal data): each row shows a label and a link for its record, given by the owning module's link resolver (`TaskLinks.register`), batched per page. A label never holds a phone, a name, an address, or a note (an order shows its number and store, spec 0007 section 7); a customer shows the number and store of her latest order ("Customer of #1042, Store A", domain review M7). A linked type with no resolver shows its kind only. A task the caller cannot see answers 404 `TASK_NOT_FOUND`, the same as a missing one. The customer page lists her open tasks through `TaskQueries.openFor` (domain review M7).
- **AC-13** (audit, spec 0010 AC-11): a person opening a task, and every assign, take, release, escalate, reschedule, close (by a person or by the system), and cancel writes one audit entry on record type `task` in the same transaction, with ids, codes, hats, and times only; "release all" writes one entry per task with one correlation id. A system open writes none (the row records `created_by_type`).
- **AC-14** (the screen): My work at `/my-work` in the `(backoffice)` group, one `<h1>`, tabs Mine and Team (only with `tasks.assign`); each row shows the type label, the record label and link, the due time and its group, the owner, and its actions (Close with an outcome, Snooze with reason and presets, Take or Release, Escalate, Assign, Add note, and on order linked support rows Call and WhatsApp that fetch the phone only on tap, domain review m5). Support sees a "orders waiting to confirm" card at the top, linking to the confirmation queue. At 360 CSS pixels wide rows stack as cards with every action reachable, touch targets at least 24 by 24 CSS pixels (WCAG 2.2 AA 2.5.8). English and Arabic from the catalogs, logical properties only, keyboard and focus support per `packages/ui/DESIGN.md`.
- **AC-15** (no workflow designer): no screen, setting, or table lets a brand define a type, an outcome, or a routing rule; adding one is a code change to the registry. The working hours setting is the brand's clock, not a routing rule.

## Decision

**Chosen option**: Option 2, one `tasks` module with a code registry in `packages/contracts`, a typed transactional service, listeners for events that already exist, and a link resolver registry (options in [rationale.md](rationale.md)).

The `tasks` core module owns `tasks` and the new `task_notes`, is the only writer of both, and is loaded in the api and the worker (outbound and inbox events are published in the worker). Other modules open and close tasks only through `TasksService` inside their own transaction, or by publishing a past tense event the tasks module listens to. A type is a row of `TASK_TYPES`; there is no runtime registration of types. My work is one screen that polls once a minute; there are no per task notifications in slice 1a, with one exception carried to feature 25 (owner question 6). The `platform` module owns the brand wide working hours setting this spec defines.

**Implementation skills**: `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) for the delta; `nestjs-best-practices` and `drizzle-orm-patterns` (installed skills dirs) for the service and queries; `shadcn` and `tanstack-query` for the screen.

### Amendments to spec 0002 (customers, credit, and tasks child)

1. The registry moves from `apps/api/src/tasks/task-types.ts` to `packages/contracts/src/tasks/task-types.ts`, because the web needs the outcome lists and labels for the close dialog and the parity test of `@ssdashboard/i18n` must see the label keys (the same reason `AUDIT_ACTIONS` lives there).
2. The service no longer checks that a linked record exists by calling the owning module's service: the owning module is the caller and passes its own record inside its own transaction. A person opening a case goes through the link resolver's `exists`. Calling the owners would make `tasks` import `orders`, while `orders` (and feature 18) import `tasks`.
3. `owner_hat` is always set (a new check). Assigning a person keeps the hat, so releasing a task, or a person losing the permission, puts it back in a queue without a write.
4. `linked_type` gains `connection`, `inbound_event`, `variant`, and `install`; the table gains `subject_key`, `contact_channel`, and `external_ref`; notes become a separate append only table (*Data model delta*).
5. Counting attempts by closed tasks ("three no answers closes", spec 0002) does not hold for confirmation: spec 0017 counts its own `confirmation_attempts` log, because one callback task per order is rescheduled after each try (domain review m6).

### Decision on audit item 7: support cases are taken into feature 17

The independent audit of 2026-11-11, section 4, item 7 finds that the support agent's day outside confirmation (wrong item, late delivery, a carrier ticket, a reorder) has no scope line. It fits the task primitive exactly: a record, an owner, a follow up time, a few notes, and an outcome. So feature 17 ships six person opened case types (AC-10, with `case.damaged_or_missing` from domain review m3), append only notes (AC-11), escalation to the owner (AC-4, domain review M4), a duplicate check (AC-10, domain review M7), and nothing else: no case table, no case statuses beyond the task's own, no customer messaging. Owner question 1 confirms it.

### Decision on audit item 8: the refund record belongs to the credit module, not to tasks or settlement

The independent audit of 2026-11-11, section 4, item 8 asks for a manual refund record and a "refunds owed" figure in slice 1a, because the daily report (feature 25) promises "exchanges and refunds owed", and suggests moving it from feature 35 into 17 or 22.

- **Not in 17.** A refund owed is money: an amount, a method, an order, and states from requested to confirmed. A task carries no amount and no money state by design. Tasks may say *who must pay it by when*, never *how much is owed*.
- **Not in 22.** Feature 22 is the carrier settlement: Bosta's remittance lines matched to orders, where a refund appears as a negative line. That line is evidence that a cash refund went out through the carrier; it is matched against a refund record, it is not the record. A refund by InstaPay or bank transfer never touches a carrier settlement at all.
- **Where it belongs.** The credit module: spec 0002 reserves `refunds` (requested, approved, in transit or sent, confirmed) and `credit_entries.refund_id` and `refund_payout` for feature 35. The recommendation (owner question 2) is a thin slice of feature 35 in slice 1a, owned by `credit`, specified by *What the credit slice must provide* below. Without a refund record, the slice 1a done when ("one month of the real Bosta settlement is matched line by line including refunds") cannot be met, because a negative refund line has nothing to match (domain review M6).
- **What 17 contributes.** The type `refund.manual_payout` (linked type `refund`, hat operations, permission `refunds.approve`, outcomes `paid` and `refund_cancelled`, closed by the system only), which the credit module opens when a manual refund is approved and closes when it is confirmed or cancelled; and, until the credit slice exists, the honest stop gap of *Cases and money owed*. If the owner instead places the refund record in feature 22 (lane D), the task contract is the same: whoever owns the refund id opens the same type.

### Cases and money owed (domain review M5, consistent with M6)

An outcome that hands work to another record is offered only when that record can be made in the same step.

- **Before the credit slice exists**, no case offers `refund_owed`. A case that ends with money owed closes with **`refund_needed`**, which requires a note stating the amount and method. Closing with it opens `refund.unrecorded_payout` on the same order (hat operations, permission `refunds.approve`, outcomes `paid` and `not_owed`, closed by a person who pays it), so the money owed stays an open task until someone pays it. The daily report counts the open `refund.unrecorded_payout` tasks as **"refunds owed (unrecorded)"**: a count, never an amount, because the amount lives only in a note.
- **Once the credit slice exists**, `refund_needed` and `refund.unrecorded_payout` are retired (registry rows removed, no new ones opened): a case closes with `refund_owed`, which in the same transaction creates the refund record through the credit module's service and opens `refund.manual_payout`. The open `refund.unrecorded_payout` tasks at that moment are listed for a person to enter as refund records, then closed `paid` or `not_owed`; nothing is migrated from note text.
- **Exchanges**: in slice 1a an exchange is made in Shopify and read back by spec 0015 (task 10), so the outcome is `exchange_made_in_shopify`, with the replacement order's number in the note; a case whose exchange is not made yet stays open.

### What the credit slice must provide (domain review M6; owned by `credit`, a thin slice of feature 35)

This is the brief for the credit module's slice, not a design of it; its own spec decides the shapes.

- **The refund record**: order and store; amount (partial allowed, at most the order's paid amount); method (`instapay`, `wallet`, `bank_transfer`, `carrier_cash` for a Bosta return pickup, `gateway`); state `requested`, `approved`, `in_transit_or_sent`, `confirmed`, or `cancelled`, as spec 0002 reserves; who requested it and when; who approved it and when; who paid it and when; a proof reference (letters and digits, code shaped, as spec 0017 AC-22 does for deposits); the payee detail (an InstaPay handle, a wallet number, or an account), personal data under the same redaction as a note; the case task it came from, when there was one.
- **The approver**: a holder of `refunds.approve` (operations and manager). The `refund.manual_payout` task follows the queue rules of AC-5, so in a team with nobody in the operations hat it reaches the owner (domain review B1).
- **The posting rule when feature 28 lands**: each slice 1a refund is posted to the customer credit ledger as a `return_credit` and `refund_payout` posting pair (`actor_type = 'import'`, the refund's own idempotency key), the way spec 0002 already posts imported history, so a 1a record is never an orphan and its order's outcome derives `refunded`.
- **One definition of "refunds owed"**: refund records `approved` or `in_transit_or_sent` and not `confirmed` or `cancelled`, summed by method, with the age of the oldest, as of the report's instant. The daily report (feature 25) and the dashboard (feature 24) read it from the credit module and show it beside "refunds owed (unrecorded)" while that count is above zero.

## Interface for other modules

This section is the contract feature 18 (spec 0017) and every later process builds against. It lives in `apps/api/src/tasks/` (service) and `packages/contracts/src/tasks/` (registry and shapes). `TasksModule` exports `TasksService`, `TaskQueries`, and `TaskLinks`.

### How a module registers a task type

Add one entry to `TASK_TYPES` in `packages/contracts/src/tasks/task-types.ts` in the same change that builds the code that opens it, plus its label keys in both catalogs of `packages/i18n`. The shape:

```ts
/** When a task of this type is due if the opener passes no due time; always inside working hours (AC-6). */
export type TaskDueRule =
  | { readonly kind: 'none' }
  /** Now, or the next opening when outside working hours. */
  | { readonly kind: 'now' }
  /** This many working minutes from now (from the next opening when outside working hours). */
  | { readonly kind: 'after_minutes'; readonly minutes: number }
  /** The next occurrence of this wall clock time (HH:MM) inside working hours, strictly after now. */
  | { readonly kind: 'next_local_time'; readonly time: string }
  /** The opener must pass a due time (cases, callbacks). */
  | { readonly kind: 'required' };

/** One task type. The code is `<area>.<name>`, `ReasonCode` shaped. */
export interface TaskTypeDefinition {
  /** The api module whose work it is (a `MODULE_REGISTRY` key). */
  readonly module: string;
  readonly linkedTypes: readonly TaskLinkedType[];
  readonly defaultHat: InternalHat;
  /** Needed to see it, to be assigned it, and to close it. */
  readonly requiredPermission: Permission;
  readonly due: TaskDueRule;
  /** Every outcome code it may close with, `ReasonCode` shaped. */
  readonly outcomes: readonly string[];
  /** Outcomes only the system may set (for example `synced`). */
  readonly systemOutcomes?: readonly string[];
  /** Outcomes a person may set only with a note (for example `refund_needed`). */
  readonly noteRequiredOutcomes?: readonly string[];
  /** `system`: a person can never close it by hand. */
  readonly closedBy: 'person' | 'system' | 'both';
  /** False: the snooze route refuses it (the owning module may still reschedule). Default true. */
  readonly snoozable?: boolean;
  /** True when a person may open it through `POST /api/tasks`. */
  readonly openableByPerson: boolean;
  /** True when a dedupe key opens at most one task ever, not one at a time. */
  readonly once?: true;
  /** True when the tasks module cancels it as the order moves to `cancelled`. */
  readonly cancelWhenOrderEnds?: true;
  readonly label: MessageKey;
  readonly outcomeLabels: Readonly<Record<string, MessageKey>>;
}

export const TASK_TYPES: Readonly<Record<string, TaskTypeDefinition>>;
export type TaskTypeCode = keyof typeof TASK_TYPES;
```

### `TasksService` (every method takes the caller's transaction)

```ts
/** Who acts: a person (staff user id) or a system job. */
export type TaskActor =
  | { readonly kind: 'person'; readonly userId: string }
  | { readonly kind: 'system_job' };

export interface TaskLinkedRecord {
  readonly type: TaskLinkedType;
  readonly id: string; // uuid
}

export interface OpenTaskInput {
  readonly type: TaskTypeCode;
  readonly linked: TaskLinkedRecord;
  /** Ids and codes only, `^[a-z0-9:_.-]{1,120}$` (for example a capability key). */
  readonly subjectKey?: string;
  /** Else the type's due rule; `null` means no due time. */
  readonly dueAt?: Date | null;
  /** Else the type's default hat. */
  readonly hat?: InternalHat;
  /** An active person who holds the type's permission. */
  readonly assigneeId?: string;
  /** Built from ids, never a phone or a name: `^[A-Za-z0-9:_.-]{1,200}$`. */
  readonly dedupeKey?: string;
  /** Free text, personal data, at most 1,000 characters. */
  readonly note?: string;
  readonly by: TaskActor;
}

export interface TasksService {
  /** Opens a task, or returns the open one with the same dedupe key (`created: false`). */
  open(tx: Transaction, input: OpenTaskInput): Promise<{ task: TaskRow; created: boolean }>;
  /** Closes an open task with an allowed outcome. */
  close(
    tx: Transaction,
    taskId: string,
    change: { outcome: string; note?: string; by: TaskActor; expectedUpdatedAt?: string },
  ): Promise<TaskRow>;
  /** Closes the open task with this dedupe key; null when none is open. */
  closeByKey(
    tx: Transaction,
    dedupeKey: string,
    change: { outcome: string; by: TaskActor },
  ): Promise<TaskRow | null>;
  /** Moves the due time (snooze, the next callback try). */
  reschedule(
    tx: Transaction,
    taskId: string,
    change: { dueAt: Date; reasonCode?: string; by: TaskActor; expectedUpdatedAt?: string },
  ): Promise<TaskRow>;
  /** Sets or clears the person; may move the task to another internal hat (escalation is hat `manager`). */
  assign(
    tx: Transaction,
    taskId: string,
    change: {
      assigneeId: string | null;
      hat?: InternalHat;
      reasonCode?: string;
      by: TaskActor;
      expectedUpdatedAt?: string;
    },
  ): Promise<TaskRow>;
  /** Cancels one open task (no outcome); the reason code goes to the audit entry. */
  cancel(
    tx: Transaction,
    taskId: string,
    change: { reasonCode: string; by: TaskActor },
  ): Promise<TaskRow>;
  /** Cancels every open task on a record, optionally only some types; answers how many. */
  cancelOpenFor(
    tx: Transaction,
    linked: TaskLinkedRecord,
    change: { types?: readonly TaskTypeCode[]; reasonCode: string; by: TaskActor },
  ): Promise<number>;
  /** The open tasks on a record (optionally some types), or the open task of a key. */
  findOpen(
    tx: Transaction,
    where:
      | { linked: TaskLinkedRecord; types?: readonly TaskTypeCode[] }
      | { dedupeKey: string },
  ): Promise<readonly TaskRow[]>;
  /** How many tasks of a type on a record closed with an outcome. */
  countClosed(
    tx: Transaction,
    where: { linked: TaskLinkedRecord; type: TaskTypeCode; outcome: string },
  ): Promise<number>;
}
```

`TaskRow` is the contract shape `TaskRow` in `packages/contracts/src/tasks/task-api.ts` (id, type, linked type and id, subject key, owner user id, owner hat, due at, status, outcome code, created by type, created at, updated at, closed at). Errors are typed domain errors in `apps/api/src/tasks/task-errors.ts`: `UnknownTaskType`, `TaskLinkNotAllowed`, `InvalidOutcome`, `OutcomeNotForPerson`, `NoteRequired`, `TaskNotOpen`, `TaskNotFound`, `TaskChanged` (a person's `expectedUpdatedAt` is stale), `TaskAssigneeNotEligible`, `DueInvalid`, `DueRequired`.

**Rules a caller can rely on.** Every method locks the task row (`FOR UPDATE`) or, for `open` with a key, inserts with `ON CONFLICT (tenant_id, dedupe_key) WHERE status = 'open' DO NOTHING` then reads the winner; a `once` type takes the transaction advisory lock `hashtext('task_once:' || dedupe_key)` and looks for any row of that key first. A system call (`by: { kind: 'system_job' }`) skips the person checks (permission, `expectedUpdatedAt`) but never the registry checks. `open` called again with a key returns the existing task unchanged: it never moves its due time or owner (call `findOpen` then `reschedule` or `assign`). A due time passed by the caller is kept as passed; only registry rules are fitted to working hours. Nothing here commits or opens a transaction.

### `TaskQueries` (read only)

```ts
export interface TaskQueries {
  /** Open and overdue counts per hat and per type, at an instant (feature 25's status line, feature 24). */
  counts(at: Date, where?: { types?: readonly TaskTypeCode[] }): Promise<readonly TaskCountRow[]>;
  /** Open tasks on any of these records, for a record page (the customer page passes her order ids). */
  openFor(records: readonly TaskLinkedRecord[], access: Access): Promise<readonly TaskListRow[]>;
}
```

### `TaskLinks` (how a module gives its records a label and a link)

```ts
export interface TaskLinkResolver {
  /** Labels and web paths for a page of ids; never a phone, a name, an address, or a note. */
  describe(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { label: TaskLinkLabel; path: string }>>;
  /** For a person opening a case: does the record exist and may this caller see it. */
  exists(id: string, access: Access): Promise<boolean>;
}
export interface TaskLinks {
  /** From the owner's `onModuleInit`; a second resolver for one linked type throws at start. */
  register(linkedType: TaskLinkedType, resolver: TaskLinkResolver, owner: string): void;
  /** A path override for one task type (a confirmation task opens the confirmation card). */
  registerTypePath(type: TaskTypeCode, path: (linkedId: string) => string, owner: string): void;
}
```

`TaskLinkLabel` is a contract union of non personal shapes (`{ kind: 'order', number, storeName }`, `{ kind: 'customer', latestOrderNumber, storeName }`, `{ kind: 'variant', sku }`, `{ kind: 'connection', storeCode }`), rendered by the web from catalog keys. Orders registers `order`; customers registers `customer` (the latest order through `OrderQueries`, from the leaf profile module, domain review M7); connectors `connection` and `inbound_event`; catalog `variant`; the tasks module registers `install` itself (its path comes from `subject_key`).

### What feature 18 does with it (reconciled with spec 0017, domain review m6)

Spec 0017 owns its type codes and outcomes and lists its calls in its *Needs from spec 0016 (tasks)*. In short: one `confirmation.callback` task per order (dedupe `confirmation.callback:<orderId>`, due `required`), opened at the first scheduled try and **rescheduled after each later try** (`findOpen`, then `reschedule`, and `assign` when a promised callback changes hands), closed by `closeByKey` when the confirmation ends; a `confirmation.reconfirm` task (dedupe `confirmation.reconfirm:<orderId>`, due now) when an edit lands after Bosta created the delivery, escalated to `manager` by a system `assign` after `N` no answers. Both are `closedBy: 'system'`: a person closes them by recording an outcome on the confirmation card. **No answers are counted on spec 0017's own `confirmation_attempts` log, not with `countClosed`**, because a rescheduled task closes once. Spec 0017 computes callback times itself, inside the working hours of `operations.working_hours` (it drops its own `confirmation.working_hours`). Its types register a path override so a row opens `/confirmation` on that order, where its soft claim applies. Two orders of one phone give two rows in My work, each opening the confirmation card, which groups by phone; My work does not group by customer because its labels carry no phone. "Edit not synced, hold" stays the order's `write_back_state` (spec 0013 AC-12) plus `sync.write_back_failed` here; spec 0017 shows it on the to pack list (domain review n1 of the stack review).

## Feature design

### Where it lives

- `apps/api/src/tasks/`: `tasks.module.ts` (imports `PlatformModule`, `AuditModule`, the staff directory and the hat directory from identity's public files), `tasks.service.ts`, `task-queries.ts`, `task-links.ts`, `task-due.ts` (the pure due rules, working hours, and grouping in a time zone), `listeners/` (one file per producer event), `manager-task-port.ts`, `tasks.controller.ts` (`@Audience('staff')`, `@RequiresModule('tasks')`), `README.md`. Loaded by `AppModule` and `WorkerModule`.
- `packages/contracts/src/tasks/`: `task-enums.ts` (exists; gains the four linked types), `task-types.ts`, `task-api.ts` (request and answer shapes), `task-due.ts` (pure, shared with the web for the snooze warning).
- `packages/contracts/src/settings/policy-settings.ts`: the `operations.working_hours` row (*Working hours*).
- `packages/db/src/schema/tasks.ts`: the delta below, and `task_notes` in `table-ownership.ts` as `tasks`.
- `apps/web/src/tasks/` (screens, `my-work-list.tsx`, `close-task-dialog.tsx`, `snooze-task-dialog.tsx`, `open-case-dialog.tsx`, `task-row-card.tsx`, `use-task-summary.ts`) and `apps/web/src/app/(backoffice)/my-work/page.tsx`; the nav badges in `apps/web/src/shell/`.
- `packages/contracts/src/modules/module-registry.ts`: the `tasks` row (core, no toggle, spec 0009's table).

### Working hours (domain review M3)

One brand wide setting owned by `platform`, a spec 0009 settings registry row, read by this spec's due rules and by spec 0017's callback times.

| Field | Value |
|---|---|
| key | `operations.working_hours` |
| shape | `{ weekly: { "1".."7": [{ opens: "HH:MM", closes: "HH:MM" }] }, exceptions: [{ from: "YYYY-MM-DD", to: "YYYY-MM-DD", kind, hours: [{ opens, closes }] }] }`; ISO weekday keys; an empty list is a closed day; `kind` one of `ramadan`, `eid`, `public_holiday`, `other`; at most 2 periods a day and 30 exceptions; every time matches `^([01][0-9]|2[0-3]):[0-5][0-9]$`, `opens` before `closes`; exception ranges do not overlap |
| default | 10:00 to 22:00 every day, no exceptions (owner question 7, ratified 2026-11-13; the same default as spec 0017 Q-18.10) |
| bundle, group | `core`, `policies` |
| who may change | `settings.manage`, reason required |
| exposure | `staff` (the web needs it for the snooze warning and the presets) |
| meaning | wall clock times in the `timezone` setting; an exception's hours replace the weekly hours on each of its days (Ramadan hours after iftar, an Eid closure), so a brand needs no release for them |

`task-due.ts` resolves "the next opening", "working minutes", and "inside working hours" from it, across the daylight saving change. AC-15 holds: it is the brand's clock, not a routing rule.

### Data model delta (tables owned by `tasks`)

Two forward migrations, as built in milestone 1: the generated delta, then a hand written rules migration for the append only triggers and grants of `task_notes` (`packages/db/AGENTS.md`: generated files hold no hand written SQL). The table had no writer, so the new checks are added plainly and hold on zero rows; every step is additive (expand only).

| Change | Detail |
|---|---|
| `task_linked_type` | `ALTER TYPE ... ADD VALUE` `connection`, `inbound_event`, `variant`, `install`; `TaskLinkedType` in contracts in the same change (enum parity test) |
| `tasks.subject_key text null` | ids and codes only, check `subject_key IS NULL OR subject_key ~ '^[a-z0-9:_.-]{1,120}$'`; for example `<command kind>:<failure code>` on a sync task, or a capability key on a platform task |
| `tasks.contact_channel text null` | a case's channel, check in (`whatsapp`, `call`, `instagram`, `facebook`, `portal`) (domain review m2) |
| `tasks.external_ref text null` | a carrier ticket reference, check `external_ref IS NULL OR external_ref ~ '^[A-Za-z0-9-]{1,40}$'`, never a note (domain review m2); index (`external_ref`) where not null, so a Bosta ticket can be found |
| check `tasks_owner_hat_set` | `owner_hat IS NOT NULL` (`tasks_has_owner` stays) |
| check `tasks_note_length` | `note IS NULL OR char_length(note) BETWEEN 1 AND 1000` |
| index `tasks_dedupe_key_idx` | (`tenant_id`, `dedupe_key`) where `dedupe_key IS NOT NULL`, for `once` types and `closeByKey` |
| index `tasks_open_due_idx` | (`due_at`, `created_at`, `id`) where `status = 'open'`, for the team view, the overdue held rows, the orphan queue fallback, and the summary |
| index `tasks_open_subject_idx` | (`type`, `subject_key`) where `status = 'open'`, for the stopped commands count and close |
| ★ `task_notes` (append only) | `id`, `tenant_id`, `task_id uuid not null` fk `tasks` restrict, `note text not null` (personal data; the column is named `note` so the redaction list's `note` covers it), `author_id uuid not null` fk `users` restrict, `created_at`; check `char_length(note) BETWEEN 1 AND 1000`; index (`task_id`, `created_at`); index (`author_id`); the app role gets `SELECT, INSERT` only |

Kept as built: `tasks_open_owner_user_idx`, `tasks_open_owner_hat_idx`, `tasks_linked_idx`, the dedupe partial unique, the outcome and closed checks, and the `operating_day` trigger.

**Volume, Assumed**: a four person brand at a few hundred orders a day opens on the order of 100 to 300 tasks a day and holds a few hundred open; the partial indexes keep My work an index range read at any history size.

### The type registry at the start

Labels are catalog keys `tasks.types.<code>` and `tasks.outcomes.<code>`. Hats and permissions marked **Assumed** are the architect's reading; the owning spec may change its own rows. Due rules are evaluated inside working hours (AC-6).

| Code | Linked | Hat | Permission | Due | Outcomes | Closed by | Snooze | Person opens | Built in |
|---|---|---|---|---|---|---|---|---|---|
| `sync.write_back_failed` | order, customer, variant, exchange, refund, connection | operations (or the editor, B1) | `orders.confirm` | now (m1) | `synced`, `resolved` (system) | system | no | no | M1 |
| `sync.write_back_late` | as above | operations (or the editor) | `orders.confirm` | now | `synced`, `resolved`, `became_failed` (system) | system | no | no | when spec 0015 publishes `OutboundCommandOverdue` (M1) |
| `sync.commands_stopped` | install | manager | `settings.manage` | now | `cleared` (system) | system | no | no | M3 |
| `connector.inbound_failed` | inbound_event | operations | `channels.map` | after 60 working minutes | `fixed`, `no_action_needed` | person | yes | no | M3 |
| `platform.wind_down_ended` | install | manager | `settings.manage` | none | `acknowledged` | person | yes | no, `once` | M2 |
| `platform.stock_out_source_missing` | install | manager | `settings.manage` | none | `acknowledged` | person | yes | no, `once` | M2 |
| `order.<attention kind>` (one per `OrderAttentionKind`) | order | per the table below | as below | after 60 working minutes | `fixed`, `no_action_needed`, `cleared` (system) | both | yes | no, `cancelWhenOrderEnds` | M3 |
| `case.wrong_item` | order | support | `orders.view` | required | `exchange_made_in_shopify`, `refund_needed` (note), `resolved`, `no_action_needed` | person | yes | yes | M4 |
| `case.damaged_or_missing` | order | support | `orders.view` | required | `exchange_made_in_shopify`, `refund_needed` (note), `reship_requested`, `claim_opened`, `no_action_needed` | person | yes | yes | M4 |
| `case.late_delivery` | order | support | `orders.view` | required | `delivered`, `escalated_to_carrier`, `customer_cancelled`, `resolved` | person | yes | yes | M4 |
| `case.carrier_ticket` | order | support | `orders.view` | required | `resolved_by_carrier`, `claim_opened`, `unresolved` | person | yes | yes | M4 |
| `case.reorder` | order, customer | support | `orders.view` | required | `reorder_placed`, `customer_declined` | person | yes | yes | M4 |
| `case.other` | order, customer | support | `orders.view` | required | `resolved`, `refund_needed` (note), `no_action_needed` | person | yes | yes | M4 |
| `refund.unrecorded_payout` | order | operations | `refunds.approve` | after 720 working minutes (one default working day) | `paid`, `not_owed` | person | yes | no (opened by `refund_needed`) | M4; retired with the credit slice |
| `refund.manual_payout` | refund | operations | `refunds.approve` | after 720 working minutes | `paid`, `refund_cancelled` (system) | system | yes | no | with the credit slice (audit item 8) |

When the credit slice lands, `refund_needed` gives way to `refund_owed` on the case types above (*Cases and money owed*).

**Order attention kinds to hats (Assumed)**, from `packages/contracts/src/orders/order-attention.ts`: support (`orders.confirm`): `phone_unparseable`, `delivery_created_before_edit_synced` (spec 0007: the agent corrects it in the Bosta dashboard), `reservation_shortened` (the customer is called about a short line); warehouse (`fulfillment.work`): `unpack_cancelled_order`; operations (`orders.view`): `shipped_without_confirmation`, `shipped_before_edit_synced`, `shipped_after_cancellation`, `late_cash_on_nothing_to_collect`, `channel_edit_not_applied`, `channel_cancel_after_pickup`, `terminate_carrier_delivery`, `carrier_fact_contradicts_state`, `shipped_with_unmapped_lines`, `shipment_not_posted`. With the B1 queue rule, the operations kinds reach the manager in a team with nobody in that hat. A kind added to `OrderAttentionKind` later (spec 0015's `fulfillment_partial_stale`, for the warehouse) adds its row in the same change. The orders module may close an attention task with the system outcome `cleared` through `closeByKey` when its condition clears (domain review m4, *Follow-up* for spec 0013).

### Producers and their dedupe keys

| Event (owner) | Task | Dedupe key | Closed by |
|---|---|---|---|
| `OutboundCommandFailed` (connectors) | `sync.write_back_failed` on (`linkedType`, `linkedId`), `subject_key` `<kind>:<failureCode>`, assigned to the person who queued the command when the event names one (B1) | `outbound_command_failed:<commandId>` | `OutboundCommandSynced` → `synced`; `OutboundCommandResolved` → `resolved` |
| `OutboundCommandFailed`, `MODULE_OFF` or `STEP_OFF` | in addition, `sync.commands_stopped` on the install, `subject_key` `<kind>:<failureCode>` | `commands_stopped:<kind>:<failureCode>` | the system, `cleared`, when the last open `sync.write_back_failed` with that `subject_key` closes (M2) |
| `OutboundCommandOverdue` (connectors, new, M1) | `sync.write_back_late`, same linking and assignment | `outbound_command_late:<commandId>` | `synced`, `resolved`, or `became_failed` on the matching events |
| `InboundEventFailed` (connectors) | `connector.inbound_failed` on the inbox event | `inbound_failed:<connectionId>:<subjectExternalId or eventId>` | a person after the retry on the connection screen |
| `OrderAttentionRaised` (orders) | `order.<kind>` | `order_attention:<kind>:<orderId>` | a person, or the orders module with `cleared` |
| `CarrierDeliveryNeedsAttention` (connectors, spec 0018, feature 19) | `carrier.attention` on the `shipment`, **only when the event's `opensTask` is true**: spec 0018 sets it false for the kinds that spec 0019's own delivery tasks replace (exception, repeated attempts, and the flags collected differs, terminated after pickup, no longer followed), so one Bosta event never opens two tasks | `carrier_attention:<kind>:<deliveryId>` | the system on `CarrierDeliveryAttentionCleared` |
| `CarrierRecordStale` (connectors, spec 0018) | `carrier.record_stale` on the order, assigned and timed as spec 0018 requests (its *Task types requested*), then spec 0017's reconfirmation | `carrier_record_stale:<deliveryId>` | a person through spec 0018's record fix route, or the system with `updated` |

The type rows of spec 0018 (`carrier.record_stale`, `carrier.attention`, `carrier.cancel_in_bosta`, `carrier.read_failed`) are spec 0018's to define, as spec 0017 defines its own; the two rows above only fix how the tasks module's listeners open them.
| `OrderStateChanged` (orders), fulfillment to `cancelled` | cancels open tasks of types with `cancelWhenOrderEnds` on that order (m4) | | |
| `ManagerTaskPort.open` (platform) | `platform.<kind>`, `subject_key` = the capability when given | `<kind>:<key>` (`once`) | the manager |

Every listener runs in the publisher's transaction (spec 0013 AC-18): if opening the task fails, the publisher's change rolls back, so a failure can never exist without its task. The manager task port has no transaction: it opens its own. The `sync.commands_stopped` task shows its affected order count from the tasks module's own table (open `sync.write_back_failed` rows with its `subject_key`), so it never reads connectors' tables.

### Who sees what (spec 0008, domain review B1 and M4)

- My work rows follow AC-5: mine; my hats' unassigned; fallen back (assignee disabled or without the permission); overdue tasks held by someone else in my hats, with Take; and, for a manager, the unassigned tasks of any internal hat with no active holder. Identity exports a read only `HatDirectory.holdersOf(hat)` (named in spec 0008, not yet built) through `IDENTITY_PUBLIC_FILES`; the tasks module uses it for the assign picker and the orphan hat rule, once per request.
- The unsynced count is for every `orders.confirm` holder, whatever the task's queue (AC-7): it is a count with a link to the hold filter, no personal data.
- External hats (media buyer, partner) hold no `tasks.*` permission and never see the route; `tasks.work` is a personal data permission (P column), which is why labels still carry no personal data (AC-12).
- Team view, assigning to someone else, moving between hats other than escalation, cancelling, and releasing another person's tasks need `tasks.assign` (operations, manager).

### API surface

All routes: `@Audience('staff')`, `@RequiresModule('tasks')`, `tasks.work` unless stated, bodies and answers as Zod schemas in `packages/contracts/src/tasks/task-api.ts`; each needs its access sweep fixture.

| Endpoint | Method | Key inputs | Key outputs | Permission | Key errors |
|---|---|---|---|---|---|
| `/api/tasks` | GET | `view` (`mine`, `team`), `hat`, `assigneeId`, `type`, `linkedType` with `linkedId`, `cursor` | `{ rows: TaskListRow[], nextCursor }` (row: task fields, `group`, `overdue`, `heldBy`, `link`, `ownerName`, allowed actions) | `tasks.work`; `team` needs `tasks.assign` | 400 `INVALID_QUERY`, 403 |
| `/api/tasks/summary` | GET | none | `{ mine: { open, overdue, dueToday }, unsyncedEdits? }` (`unsyncedEdits` only for `orders.confirm`) | `tasks.work` | |
| `/api/tasks/:id` | GET | | `TaskDetail` (row plus notes, newest first) | `tasks.work` and visible | 404 `TASK_NOT_FOUND` |
| `/api/tasks` | POST | `type`, `linked`, `dueAt`, `contactChannel?`, `externalRef?`, `note?`, `assignToMe?`, `confirmDuplicate?` | 201 `TaskDetail` | `tasks.work` and the type's permission | 409 `CASE_ALREADY_OPEN`; 422 `TASK_TYPE_NOT_OPENABLE`, `DUE_REQUIRED`, `DUE_INVALID`, `VALIDATION_FAILED`; 404 `LINKED_RECORD_NOT_FOUND` |
| `/api/tasks/:id/close` | POST | `outcome`, `note?`, `expectedUpdatedAt` | `TaskDetail` | visible and the type's permission | 409 `TASK_CHANGED`, `TASK_NOT_OPEN`; 422 `OUTCOME_INVALID`, `OUTCOME_NOT_FOR_PERSON`, `NOTE_REQUIRED` |
| `/api/tasks/:id/reschedule` | POST | `dueAt`, `reasonCode?` (`no_answer`, `customer_asked_later`, `waiting_on_carrier`, `other`, domain review m2), `expectedUpdatedAt` | `TaskDetail` | visible and the type's permission | 409 `TASK_CHANGED`, `TASK_NOT_OPEN`; 422 `DUE_INVALID`, `NOT_SNOOZABLE` |
| `/api/tasks/:id/take`, `/release` | POST | `expectedUpdatedAt` | `TaskDetail` | a queue the caller sees, or an overdue task in the caller's hat (take); assignee (release) | 409 `TASK_CHANGED`, `TASK_NOT_OPEN`; 403 |
| `/api/tasks/:id/escalate` | POST | `reasonCode` (`customer_complaint`, `needs_approval`, `cannot_resolve`), `expectedUpdatedAt` | `TaskDetail` | visible | 409; 422 |
| `/api/tasks/release-all` | POST | `userId?` (another person needs `tasks.assign`) | `{ released: number }` | `tasks.work` | 403; 422 |
| `/api/tasks/:id/assign` | POST | `assigneeId` or null, `hat?`, `expectedUpdatedAt` | `TaskDetail` | `tasks.assign` | 422 `ASSIGNEE_NOT_ELIGIBLE`; 409 |
| `/api/tasks/:id/cancel` | POST | `reasonCode` (`duplicate`, `not_needed`, `opened_by_mistake`), `expectedUpdatedAt` | `TaskDetail` | `tasks.assign` | 409; 422 |
| `/api/tasks/:id/notes` | POST | `note` | 201 `TaskNote` | visible | 422 `VALIDATION_FAILED` (never echoes the text) |
| `/api/tasks/assignees` | GET | `type` | `{ id, displayName }[]` (active holders of the type's permission) | `tasks.assign` | 400 |

The Call and WhatsApp actions of a row (AC-14) read the phone through the order's existing read, `GET /api/orders/:id` (`orders.view`, spec 0013), only when tapped; the WhatsApp link follows spec 0017's deep link rule. The list answer never holds a phone.

### Audit actions (spec 0010 AC-11)

A new record type `task` in `AUDIT_RECORD_TYPES` (reason kept as a code; personal key `note`, never written to a diff anyway). Codes: `task.opened` (person only), `task.assigned` (assign, take, release, escalate, release all; the reason code says which), `task.rescheduled`, `task.closed` (person or system, automatic when the system closes it), `task.cancelled`. Spec 0010's table also names `task.reopened`; it is not built (owner question 5). None is undoable.

### Value sourcing

| Action | Value | Source |
|---|---|---|
| open | `owner_hat` | input `hat`, else the type's `defaultHat` |
| open | `due_at` | input `dueAt` as passed, else the type's due rule at `PlatformClock` now, fitted to `operations.working_hours` in the `timezone` setting |
| open from an outbound event | assignee | the person who queued the command, carried on the event (spec 0015 Follow-up), if active with `orders.confirm`; else none |
| open | `created_by_type`, `created_by` | `by` (system job: null person) |
| open | `operating_day` | trigger `ssd_stamp_operating_day` from `created_at` (as built) |
| open from an event | linked record, dedupe key, `subject_key` | the event's ids and codes (producer table) |
| close | allowed outcomes | `TASK_TYPES[type].outcomes`, minus `systemOutcomes` for a person; `noteRequiredOutcomes` need the note |
| close | `closed_at`, `closed_by` | `PlatformClock` now; the person, or null for the system |
| `refund_needed` | amount and method | the required note (personal free text, never parsed, never summed) |
| My work | caller's hats and permissions | `request.access` (spec 0008 `Access`) |
| My work | fallback and orphan hat | `HatDirectory.holdersOf(hat)`, the users' active flag, and their permissions |
| My work | overdue | `due_at < PlatformClock now` |
| My work | group (Due today) | local date of `due_at` and of now in the `timezone` setting (`localDate`, `apps/api/src/platform/settings/settings.service.ts`) |
| My work | label and path | the linked type's `TaskLinkResolver.describe`, or the type's path override |
| My work | owner name, held by | `StaffDirectory` display names |
| summary | `unsyncedEdits` | open `sync.write_back_failed` and `sync.write_back_late` rows, all queues, for an `orders.confirm` holder |
| stopped commands | affected orders | open `sync.write_back_failed` rows with the task's `subject_key` |
| daily report | "refunds owed (unrecorded)" | open `refund.unrecorded_payout` rows through `TaskQueries.counts` |
| daily report | "refunds owed" | the credit module's read (*What the credit slice must provide*) |
| screen | times shown, presets, snooze warning | `timezone` from `GET /api/config`, `operations.working_hours` from the settings read, locale from the user's language |
| support card | orders waiting to confirm | spec 0017's queue counts, read by the web from its own route |

### Key invariants

- Only `TasksService` writes `tasks` and `task_notes` (a single writer test like orders').
- A done task has an outcome its type allows; a cancelled task has none; an open task has no `closed_at`.
- At most one open task per dedupe key; a `once` key opens one task ever.
- `sync.write_back_failed` is open exactly while its command is failed, including `MODULE_OFF` and `STEP_OFF` failures; `sync.write_back_late` is open exactly while its command is overdue and waiting.
- Every open task is visible to at least one active person: its assignee, a holder of its hat, or the manager (B1).
- No outcome claims money owed without a record or an open task that carries it (M5).
- No task, note, label, error, or log line carries a phone, a name, or an address outside the `note` columns, which are redacted.
- A task is never deleted.

### Security model

Staff audience only. Visibility is computed in SQL from the caller's `Access` (hats, permissions); an invisible task is 404, the same as a missing one. Person writes use `expectedUpdatedAt` (409 `TASK_CHANGED`) so two agents cannot close or move the same task over each other. Notes are personal data under Law 151: redacted by the `note` key, never in an audit diff, never in a 422 body. Dedupe keys, subject keys, and carrier ticket references are shape checked so a phone can never be stored in them (security review n4 of spec 0002). Phones for the Call and WhatsApp actions come only from the order read on tap.

### Configuration required

No new environment variables. The brand `timezone` setting (exists) and the new `operations.working_hours` setting (owned by `platform`, *Working hours*) drive due rules and grouping. Due offsets and hats live in the registry (AC-15).

### Critical test scenarios

- Happy path: a fixture connector fails a `shopify.order_edit` command queued by a support agent → one `sync.write_back_failed` on the order, owner hat operations, assigned to that agent, in the same transaction; her My work lists it and `unsyncedEdits` is 1 for every `orders.confirm` holder; the command syncs → the task is `done` with `synced`, a `task.closed` entry by the system, verifies **AC-8**, **AC-7**, **AC-13**.
- Orphan queue (B1): a brand with no active `operations` holder → an unassigned `sync.write_back_failed` and an `order.shipped_without_confirmation` show in the manager's Mine; once someone gets the operations hat they move to that queue, verifies **AC-5**.
- Failure inside the publisher: a listener that throws rolls back the command's failure (no failed command without a task), verifies **AC-8**.
- Step off (M2): three waiting edits fail with `STEP_OFF` → three `sync.write_back_failed` (counted in `unsyncedEdits`) and one `sync.commands_stopped` showing 3; resolving two leaves it open showing 1; resolving the third closes it `cleared`, verifies **AC-8**, **AC-7**.
- Idempotency: the same failure published twice, and two parallel transactions opening one key → one row; a `once` platform request repeated after the manager closed it opens nothing, verifies **AC-2**, **AC-9**.
- Registry: an unknown type, a linked type not allowed, an outcome not allowed, a person closing or snoozing `sync.write_back_failed`, `refund_needed` without a note → each typed error; the registry spec fails a hat that lacks the permission, verifies **AC-1**, **AC-2**, **AC-3**, **AC-4**.
- Visibility: warehouse does not see a support case; a media buyer gets 403 on `/api/tasks`; another person's task id answers 404; an overdue callback held by an absent agent shows in her colleague's Mine as "overdue, held by" with Take, verifies **AC-5**, **AC-12**.
- Working hours and Cairo time: hours 10:00 to 22:00; an attention raised at 02:00 local is due 11:00 (60 working minutes after the 10:00 opening); a failed write back at 23:00 is due 10:00 the next day; a Ramadan exception of 13:00 to 17:00 and 20:00 to 02:00 is not allowed (crosses midnight) while 20:00 to 23:59 is; with a fixed `PlatformClock` at 23:30 local on a summer day, a task due 23:59 local is Due today and one due 00:10 the next day is Later, although both are the same UTC date; `next_local_time 10:00` across the daylight saving change lands at 10:00 local, verifies **AC-6**.
- Escalation (M4): a support agent escalates a case with `needs_approval` → in the manager's queue, assignee cleared, `task.assigned` with that reason; "release all" before a shift ends moves every own task back to its queue with one entry each, verifies **AC-4**, **AC-13**.
- Cases and money (M5): close `case.wrong_item` with `refund_needed` and a note → a `refund.unrecorded_payout` opens for operations; `TaskQueries.counts` reports it; closing that `paid` drops the count; `refund_owed` is refused while the credit slice does not exist, verifies **AC-3**, **AC-10**.
- Duplicates (M7): a second `case.wrong_item` on the same order → 409 `CASE_ALREADY_OPEN`; with `confirmDuplicate` → 201; a customer linked case reads "Customer of #1042, Store A"; the customer page lists both, verifies **AC-10**, **AC-12**.
- Concurrency: two agents close the same task with the same `expectedUpdatedAt` → one 200, one 409 `TASK_CHANGED`, verifies **AC-3**, **AC-4**.
- Notes: the note text never appears in the log sentinel or the audit diff, verifies **AC-11**, **AC-13**.
- Screen: at 360 pixels wide in Arabic, every action reachable by keyboard and touch, overdue marked by text and icon, axe has no violations, verifies **AC-14**.

## Build plan

Tracer Bullet: milestone 1 runs one real thread (a failed write back) from the event through the table, the service, the API, and the screen; each later milestone thickens one segment end to end.

### Milestone 1: one failed write back, from event to My work (backend and frontend)

1. Migration for the data model delta (linked types, the three columns, the checks, three indexes, `task_notes` with its grants), `TaskLinkedType` parity, `table-ownership.ts`, satisfies **AC-2**, **AC-11**
2. `TASK_TYPES` with `sync.write_back_failed` and `task-types.spec.ts`; the `tasks` row in `MODULE_REGISTRY`; catalog keys in English and Arabic, satisfies **AC-1**, **AC-15**
3. `TasksModule` (api and worker) with `TasksService.open`, `close`, `closeByKey`, the single writer test, the three `OutboundCommand*` listeners, and the editor assignment when the event carries the person, satisfies **AC-2**, **AC-3**, **AC-8**
4. `GET /api/tasks?view=mine` with the orphan hat rule (`HatDirectory.holdersOf` from identity), `GET /api/tasks/summary` with `unsyncedEdits`, `POST /api/tasks/:id/close`, access sweep fixtures, and the audit record type `task` with `task.closed`, satisfies **AC-5**, **AC-7**, **AC-13**
5. `/my-work` page with a plain list, the close dialog, the nav item, and the unsynced badge linking to the hold filter, satisfies **AC-7**, **AC-14**

**Done when**: in the e2e suite a fixture connector failure puts one task on the editing agent's My work, the unsynced badge of every `orders.confirm` holder shows it within one poll, a brand with nobody in operations shows it to the manager, and the sync closes it; `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the tasks e2e pass.

### Milestone 2: the full service, working hours, and the interface for feature 18 (backend and frontend)

6. `reschedule` (with `snoozable`), `assign`, escalate, take overdue, release and release all, `cancel`, `cancelOpenFor`, `findOpen`, `countClosed`, `once`, `TaskQueries.counts` and `openFor`, with their audit codes, satisfies **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-13**
7. The `operations.working_hours` settings row (spec 0009 registry, `platform`), `task-due.ts` with the due rules, working minutes, exceptions, and the daylight saving table test, satisfies **AC-6**
8. The manager task port registered in api and worker, `platform.wind_down_ended` and `platform.stock_out_source_missing`, satisfies **AC-9**
9. `TaskLinks` with the orders resolver, the install resolver, and type path overrides, satisfies **AC-12**
10. The screen: groups, Snooze with reasons, presets, and the outside hours warning, Take, Release, Release all, Escalate, Assign, the Team tab, the "held by" rows, keyset paging, satisfies **AC-4**, **AC-5**, **AC-6**, **AC-14**

**Done when**: feature 18 can open, reschedule, assign, and close a callback type in a test module through the exported service alone, with times inside working hours; the daylight saving and working hours tests pass; an agent escalates a task to the manager.

### Milestone 3: every existing producer (backend)

11. Listeners for `OrderAttentionRaised` (every kind, with the attention to hat rows), `OrderStateChanged` (cancel on `cancelled`), `InboundEventFailed`, and the stopped commands rule with its system close; the connectors resolvers for `connection` and `inbound_event`; `sync.write_back_late` and its listener once spec 0015 publishes `OutboundCommandOverdue`, satisfies **AC-3**, **AC-8**, **AC-9**, **AC-12**

**Done when**: each producer event in the e2e suite opens exactly one task for the right queue, twice published still one, a cancelled order cancels its attention tasks, and `task-types.spec.ts` fails when an attention kind lacks a type.

### Milestone 4: support cases, money owed, notes, and the phone pass (backend and frontend)

12. The six case types with the case fields, `refund.unrecorded_payout`, `POST /api/tasks` with the resolver `exists` check and the duplicate rule, `task.opened`, notes routes and `task_notes` writes, `GET /api/tasks/:id`, the customers resolver, satisfies **AC-3**, **AC-10**, **AC-11**, **AC-12**, **AC-13**
13. Open a case from the order page and from My work, listing open tasks first; the task detail sheet with notes; open tasks on the order page and the customer page through `TaskQueries.openFor`; the support card for orders waiting to confirm; Call and WhatsApp on tap, satisfies **AC-10**, **AC-11**, **AC-12**, **AC-14**
14. Phone and accessibility pass in both languages, Playwright flow for a case and for a failed write back, satisfies **AC-14**

**Done when**: an agent on a 360 pixel wide screen in Arabic opens a case on an order, is warned of an open one, snoozes it, adds a note, escalates it, and the manager closes it with `refund_needed` and a note, by touch and by keyboard; `verify.md` passes.

## Open owner questions

Answered by the owner on 2026-11-13 ([owner answers](../../reviews/owner-answers-2026-11-13.md)): every recommendation below is ratified. Question 8 is settled by spec 0017's Q-18.1 answer (both send modes): the 10 minute budget stands for every store, because under either mode a confirmation edit must reach Shopify before the order is packed, and under `app_sync_at_creation` the Bosta side is spec 0017's checklist and spec 0018's stale check, not this budget.

1. **Support cases in feature 17 (audit item 7)?** Recommended: yes, the six case types of AC-10 with a required follow up time, notes, escalation to the owner (M4), no outcome that drops money (M5), a duplicate check and the customer view (M7), and the damaged or missing type (m3); no case table. Alternatives: a separate support cases feature later (the agent keeps a spreadsheet during the pilot, which the pilot's "no spreadsheet" week forbids); or only one generic `case.other` type.
2. **Where does the manual refund record live (audit item 8)?** Recommended: in the `credit` module as a thin slice of feature 35 in slice 1a, built to *What the credit slice must provide*; feature 17 contributes `refund.manual_payout`, and `refund_needed` with `refund.unrecorded_payout` until the slice lands. Alternative: feature 22 owns it (lane D; the task contract is the same, but it ties InstaPay and bank refunds to the carrier statement, which the domain review also advises against).
3. **Landing pages.** Recommended: warehouse and operations land on `/my-work`; support lands on the confirmation queue (spec 0017), with an "orders waiting to confirm" card at the top of My work and the My work counts in the nav; the manager keeps the current home until feature 24. Alternative: My work is a nav item only for everyone.
4. **Who handles a failed Shopify read?** Spec 0015 sends it to operations, but the retry on the connection screen needs `settings.manage`, which only the manager holds. Recommended: keep the task with operations (with the B1 rule it reaches the owner in a team with nobody in that hat) and let `channels.map` retry a failed read (a change to spec 0015 and spec 0008's route mapping). The 60 minute due time stays, counted in working minutes. Alternative: route `connector.inbound_failed` to the manager.
5. **Reopening a closed task?** Recommended: not in slice 1a; a wrong close is followed by a new task, which sees the old one in the open and closed tasks of its record (spec 0010's `task.reopened` stays unbuilt). Alternative: managers may reopen within 7 days.
6. **Notifications beyond the screen?** Recommended: none per task, with one exception: a failed or late write back posts one line (order number and store, no personal data) to the brand's Telegram group through the sender feature 25 builds (*Follow-up*). Everything else stays on the screen and in the daily report's status line. Alternative: no exception at all.
7. **The default working hours.** Recommended: 10:00 to 22:00 every day, Fridays included, the same default as spec 0017 Q-18.10; the manager enters Ramadan and Eid as dated exceptions. Alternative: closed on Fridays.
8. **How long may a confirmation edit wait before it is "late"?** Recommended: 10 minutes (ratified 2026-11-13; spec 0017 Q-18.1 is answered as both send modes, see the note above); the budget lives in spec 0015's sweep. Alternative: 30 minutes, if the Bosta app creates deliveries only at fulfillment.

## Domain review applied

[Domain review of spec 0016](../../reviews/domain-tasks-my-work.md), verdict accept with changes, applied on 2026-11-12 with the lead's rulings.

| Finding | How it was closed |
|---|---|
| B1 orphan operations queue | Closed. A hat with no active holder falls to the `manager` queue at read time (AC-5); every `orders.confirm` holder sees the unsynced count (AC-7); the task is assigned to the agent who queued the edit (AC-8, AC-4, needs the person on the event: Follow-up for spec 0015); the setup warning is carried to spec 0008 (Follow-up) |
| M1 still waiting opens nothing | Closed here, carried for the event: `sync.write_back_late` (AC-8, registry), opened on a new `OutboundCommandOverdue` event from spec 0015's sweep (Follow-up); the 10 minute budget is Assumed and hangs on spec 0017 Q-18.1 (owner question 8) |
| M2 switched off step hides orders | Closed: `MODULE_OFF` and `STEP_OFF` failures open per order sync tasks too, so they are counted; the manager task shows the affected count and closes by the system only (AC-8, producers table) |
| M3 due times through the night | Closed: one brand wide `operations.working_hours` setting owned by `platform` (*Working hours*), weekly hours plus dated exceptions; all due rules fitted to it (AC-6); spec 0017 drops `confirmation.working_hours` and reads it (Follow-up) |
| M4 no escalation, absent colleague | Closed: Escalate to `manager` with a reason, take an overdue task held by someone else in your hat, release all (AC-4, AC-5, API) |
| M5 `refund_owed` loses the money | Closed: `refund_owed` removed until the refund record exists; `refund_needed` needs a note with the amount and opens `refund.unrecorded_payout`, counted as "refunds owed (unrecorded)"; exchanges close as `exchange_made_in_shopify` (*Cases and money owed*) |
| M6 the thin credit slice | Closed as a brief, carried for the build: *What the credit slice must provide* (fields, approver, posting rule for feature 28, one definition of "refunds owed"); "not tracked yet" struck from owner question 2; routing is a Follow-up for the lead |
| M7 what is already open | Closed: duplicate check with `CASE_ALREADY_OPEN`, customer label from her latest order, open tasks on the customer page (AC-10, AC-12, `TaskQueries.openFor`) |
| m1 write back due rule | Closed: due `now`, `snoozable: false` on the sync types (registry, AC-4) |
| m2 case fields and snooze reasons | Closed: `contact_channel`, `external_ref` (delta), snooze reason codes (API) |
| m3 damaged or missing piece | Closed: `case.damaged_or_missing` (registry) |
| m4 tasks that outlive their reason | Closed: `cancelWhenOrderEnds` on attention types with the `OrderStateChanged` listener, and the system outcome `cleared` for the orders module (AC-3; Follow-up for spec 0013 to call it) |
| m5 phone actions | Closed: Call and WhatsApp fetching the phone on tap; snooze presets in Cairo time from working hours (AC-14, API) |
| m6 interface text against spec 0017 | Closed: *What feature 18 does with it* rewritten to spec 0017 (attempt log, one rescheduled callback per order, `confirmation.reconfirm`, path override to the card, why rows are not grouped by phone); spec 0002 amendment 5 |
| m7 notes kept for ever | Carried: notes are added to the erasure follow up of spec 0005 (Follow-up) |
| Owner questions 1 to 6 and the brand questions | Owner questions updated with the review's views; 7 and 8 added; the nine brand questions stay in the review for the pilot onboarding |

## Consequences

**Positive**:

- One primitive, one screen, one count: every module's "someone must look at this" becomes the same row, and B2's failure contract is visible the same minute to everyone who can act on it, whoever wears which hat.
- Feature 18 and every later process build against a small typed service and a registry row, not their own queue table, and one working hours setting.
- Money owed never disappears into a closed task: it is either a refund record or an open task.

**Negative / tradeoffs**:

- Listeners in the publisher's transaction mean a bug in the tasks module can roll back a carrier or Shopify change; this is deliberate (no failure without its task) and is covered by tests.
- The registry is code: a brand that wants another hat for a type needs a release (AC-15, the scope's "no workflow designer").
- "Refunds owed (unrecorded)" is a count without an amount until the credit slice lands.
- The manager sees every orphan queue; in a team where the owner wears only `manager`, My work is longer for the owner by design.

**Neutral**:

- `tasks` is loaded in the worker as well as the api.
- Spec 0002's tasks section is amended in five points (*Decision*); the build updates that child's text when it lands (out of this spec's lane).

## Follow-up

- [ ] Lead: tick the scope row's design box and write the four milestones as its build sub tasks (`docs/scope/confirmation-to-cash.md` feature 17).
- [x] Owner question 2 ratified 2026-11-13 (with spec 0020 Q-22.8: the minimal refund record, with `carrier_cash`, in slice 1a); the scope line for the thin feature 35 slice is applied in `docs/scope/confirmation-to-cash.md`. Originally: route owner question 2 to `/scope` (a thin feature 35 slice in slice 1a, owned by `credit`, built to *What the credit slice must provide*) before features 22 and 25 are designed, and tell lane D (feature 22) that the refund record is not settlement's (domain review M6).
- [ ] Spec 0015 (feature 13): publish `OutboundCommandOverdue` from the scheduled sweep for a confirmation edit command `waiting` longer than the budget (10 minutes, ratified 2026-11-13 for both send modes), and carry the person who queued a command on the four `OutboundCommand*` events (domain review M1, B1).
- [ ] Spec 0017 (feature 18): drop `confirmation.working_hours` and read `operations.working_hours`; register path overrides for its two types (domain review M3, m6).
- [ ] Spec 0008 (feature 8): ~~build `HatDirectory.holdersOf(hat)` in identity's public files~~ (built with milestone 1, `apps/api/src/identity/hats/hat-directory.ts`); show on the people screen "no one holds the operations hat: its tasks go to the manager" when an internal hat that owns task types has no active holder (domain review B1).
- [ ] Spec 0009: add the `operations.working_hours` row of *Working hours* to its rows requested by other specs.
- [ ] Feature 25 (daily report, not designed): send one Telegram line (order number and store, no personal data) for each failed or late write back through its sender; report "refunds owed" from the credit module and "refunds owed (unrecorded)" from `TaskQueries.counts` (owner question 6, domain review M5).
- [ ] Spec 0013: the orders module closes an attention task with `cleared` through `closeByKey` when its condition clears (domain review m4).
- [ ] Spec 0005: add `task_notes` (and `tasks.note`) to the open erasure follow up (domain review m7).
- [ ] Spec 0002 customers, credit, and tasks child: apply the five amendments of *Decision* to its Tasks section.
- [ ] Spec 0010: add `task.opened` and `task.cancelled` to its Actions table and mark `task.reopened` not built.
- [ ] Spec 0015 and spec 0008: owner question 4 (who retries a failed read).
- [ ] Features 19 and 21: open their attention tasks (stalled delivery, failed attempt) as registry rows through this interface.

## Rationale

See [rationale.md](rationale.md).
