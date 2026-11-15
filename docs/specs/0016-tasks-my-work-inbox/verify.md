# Verify: tasks and My work · spec 0016 · written 2026-11-12

_Steps derived from spec 0016 acceptance criteria and its Value sourcing table, revised for the domain review (kept private) (finding IDs in brackets). `/check verify` runs these; `/test` locks the durable ones. Milestone 1 first; later milestones add theirs. Nothing is ticked: the spec is Assumed. Back to the [build spec](index.md)._

## UI / manual

- [ ] As a support agent, edit an address at confirmation and make a fixture connector fail the write back → within one minute the task is in your Mine, and the unsynced badge shows 1 for you, for operations, and for the manager; the badge opens the order list's hold filter → AC-7, AC-8 (B1)
- [ ] On a brand where nobody holds the operations hat, fail a write back made by the system → the manager sees the task in Mine → AC-5 (B1)
- [ ] Open the order from the task, retry the write back so it syncs → the task leaves My work and the badge drops to 0 without any click on the task → AC-8
- [ ] On that task, look for Close and Snooze → neither is offered; the API answers 422 `OUTCOME_NOT_FOR_PERSON` and `NOT_SNOOZABLE` if called by hand → AC-3, AC-4 (m1)
- [ ] Switch the order edit write back step off with three edits waiting → three sync tasks counted in the badge, one manager task showing 3; resolve all three → the manager task closes by itself → AC-7, AC-8 (M2)
- [ ] As support, open My work → your tasks, the support queue, and the "orders waiting to confirm" card; tasks of the warehouse do not appear → AC-5, AC-14
- [ ] With working hours 10:00 to 22:00, raise an order attention at 02:00 → due 11:00; with tasks overdue, due later today, due tomorrow, and without a due time → four groups in that order; overdue rows say "Overdue" in text with an icon; times show in Cairo time even with the device set to another zone → AC-6 (M3)
- [ ] Add a Ramadan exception to `operations.working_hours` on the settings screen with a reason → a task opened on one of its days before its opening is due at its opening → AC-6 (M3)
- [ ] Snooze a task with "next working morning" and a reason → it moves to Later at the next opening; pick 23:30 → a warning that it is outside working hours, kept if confirmed; a past time → refused → AC-4, AC-6 (m2, M3)
- [ ] As support, escalate a case with "needs approval" → it leaves your Mine and shows in the manager's; `/audit` shows the reason → AC-4, AC-13 (M4)
- [ ] With one agent holding an overdue callback, sign in as the other support agent → the row shows "overdue, held by" her name with Take; take it → it is yours → AC-5 (M4)
- [ ] Use "Release all my tasks" → every own task is back in its queue, one audit entry each → AC-4, AC-13 (M4)
- [ ] Open a "Wrong item" case on an order that already has one → the dialog lists the open case and asks; confirm → a second case opens → AC-10 (M7)
- [ ] Close a "Wrong item" case with "Refund needed" without a note → refused; with "EGP 450 by InstaPay" → a refund payout task opens for operations; "Refund owed" is not offered → AC-3, AC-10 (M5)
- [ ] Open a "Damaged or missing" case with channel WhatsApp, and a "Carrier ticket" case with ticket `BST-12345` → both saved; the ticket reference is searchable on the Team tab → AC-10 (m2, m3)
- [ ] Open a customer linked case → the row reads "Customer of #1042, Store A"; the customer page lists her open cases → AC-12 (M7)
- [ ] Cancel an order with an open `phone_unparseable` task → the task is cancelled → AC-3 (m4)
- [ ] On a support row at 360 pixels wide, tap Call → the phone is fetched only now (the list answer holds none) → AC-14 (m5)
- [ ] As a media buyer, open `/my-work` → the no access state, no data requested → AC-5
- [ ] Switch to Arabic at 360 pixels wide → right to left cards, every label translated, all actions reachable by touch and by Tab with a visible focus ring, exactly one `<h1>` → AC-14
- [ ] Look for a settings screen that adds a task type, an outcome, or a routing rule → none exists; working hours is the only task related setting → AC-15

## Commands

- [ ] `pnpm --filter @ssdashboard/contracts test` → `task-types.spec.ts` passes; it fails when a hat lacks the type's permission, a label is missing in one catalog, an outcome is malformed, or an order attention kind has no type; the settings registry spec accepts `operations.working_hours` and refuses overlapping exceptions and `opens` after `closes` → AC-1, AC-6, AC-9
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → `task_notes`, the new checks (`owner_hat` set, note length, subject key, contact channel, external ref shapes), the update and delete refusal on `task_notes` for the app role, enum parity for the four new linked types, the tenancy test → AC-2, AC-10, AC-11
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/tasks.e2e-spec.ts` → open, dedupe under two parallel transactions, `once`, close, closeByKey, reschedule, assign, escalate, take overdue, release all, cancel, cancelOpenFor, findOpen, countClosed, the orphan hat rule, every typed error → AC-2, AC-3, AC-4, AC-5
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/tasks-producers.e2e-spec.ts` → each producer event opens one task for the right queue, the editor assignment, the stopped commands count and system close, published twice still one, a throwing listener rolls the publisher back, the manager task port opens once ever, a cancelled order cancels its attention tasks → AC-3, AC-8, AC-9
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/access-sweep.e2e-spec.ts` → every `/api/tasks` route has its fixture and permission → AC-5, AC-12
- [ ] `pnpm --filter @ssdashboard/api exec vitest run src/tasks` → the due rules in working hours and Cairo time across the daylight saving change and an exception range, and the single writer test → AC-6
- [ ] `pnpm test:e2e` (Playwright) → the failed write back flow, the support case flow with escalation, axe clean in both languages → AC-4, AC-7, AC-10, AC-14
- [ ] `pnpm lint && pnpm typecheck` → the tasks module README, TSDoc, logical CSS, and the audience and module decorators pass → AC-14

## Value sourcing checks

- [ ] Open without a hat or due → `owner_hat` is the registry default, `due_at` the registry rule at the fixed clock, fitted to `operations.working_hours` in the `timezone` setting; a passed `dueAt` is stored as passed
- [ ] A write back failure carrying the person → assigned to that person if active with `orders.confirm`; without one → unassigned in the operations queue (B1)
- [ ] A system close → `closed_by` null, `created_by_type` unchanged, a `task.closed` entry with the system actor
- [ ] The Due today group → computed from `localDate` in the `timezone` setting, not UTC: a task due 00:10 Cairo the next day is Later at 23:30 Cairo
- [ ] The row label → from the resolver (order number and store, or the customer's latest order), never a phone or a name; the network answer for a customer task holds no name
- [ ] `unsyncedEdits` → equals the open `sync.write_back_failed` and `sync.write_back_late` tasks in every queue, and is absent for a caller without `orders.confirm`
- [ ] "Refunds owed (unrecorded)" → the count of open `refund.unrecorded_payout` tasks from `TaskQueries.counts`, never an amount (M5)
- [ ] The log sentinel during the case flow → no note text, phone, or name in api or worker logs, and none in the audit diff
