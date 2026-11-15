# Tasks and My work

The one small record every process opens when a person must look at something, and the one screen (My work) that shows each person their own tasks and their hats' queues in due order.

## Owns

- Its registry row (spec 0009, AC-6, `packages/contracts/src/modules/module-registry.ts`): `tasks`, core, no toggle. The controller declares `@RequiresModule('tasks')`.
- The tables `tasks` and `task_notes` (defined in [packages/db](../../../../packages/db/src/schema/tasks.ts), owned by `tasks` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts)). `task_notes` is append only: the app role may only read and insert (`UPDATE`, `DELETE`, and `TRUNCATE` are revoked and refused by trigger; `schema.e2e-spec.ts` runs all three against it). Its `created_at` is a plain `now()` default, not stamped by trigger: the stamp convention (`ssd_stamp_recorded_at`) belongs to history columns named `recorded_at`, only `TasksService` inserts the row and never passes the column, and nothing orders or replays by it beyond the note list of one task.
- `TasksService` ([tasks.service.ts](tasks.service.ts)), the only file that issues `INSERT` or `UPDATE` on those tables (`tasks-single-writer.spec.ts`). Milestone 1 has `open` (dedupe through `ON CONFLICT (tenant_id, dedupe_key) WHERE status = 'open' DO NOTHING`, then the winner is read; a `once` type looks at every status under an advisory lock), `close` (row `FOR UPDATE`, a person's `expectedUpdatedAt`, the registry's outcome rules, one `task.closed` audit entry in the same transaction), `closeByKey`, and `eligibleFor` (who may hold a type). Every method takes the caller's transaction and never commits. Reschedule, assign, cancel, and the finders follow in milestone 2.
- `TaskLinks` ([task-links.ts](task-links.ts), spec 0016 AC-12, pulled forward from milestone 2): `register(linkedType, resolver, owner)` (a second resolver for one type throws `TaskLinkResolverTaken` at start) and `describe(linkedType, ids)`, called once per kind on a page; a kind with no resolver shows its kind only (`link.path` and `link.label` null). `TaskLinkResolver.exists` (for a person opening a case) is left out until milestone 4.
- The typed domain errors ([task-errors.ts](task-errors.ts)) and their HTTP mapping ([tasks-http.ts](tasks-http.ts)).
- `TaskQueries` ([task-queries.ts](task-queries.ts)): what the caller sees in My work (`view=mine`, keyset pages of 50 sorted by due time, no due time last, then creation, then id) and the shell counts. Visibility is decided by the pure [task-visibility.ts](task-visibility.ts) from the caller's `Access` and `HatDirectory.holdersByHat()`: her own tasks, the unassigned or fallen back tasks of her internal hats, and, for a manager, the unassigned tasks of any hat nobody active wears (spec 0016 AC-5, review B1). "Overdue held by someone else" and the team view are milestone 2.
- The listener ([listeners/write-back-failed.listener.ts](listeners/write-back-failed.listener.ts)): `OutboundCommandFailed` opens `sync.write_back_failed` (dedupe `outbound_command_failed:<command id>`, owner hat operations, due now, assigned to `queuedByUserId` when she is active and holds `orders.confirm`); `OutboundCommandSynced` and `OutboundCommandResolved` close it with `synced` and `resolved`. All run in the publisher's transaction, so a failure rolls the command back with it.
- `TasksController` ([tasks.controller.ts](tasks.controller.ts)): `GET /api/tasks?view=mine`, `GET /api/tasks/summary`, `POST /api/tasks/:id/close`, all `@Audience('staff')` and `tasks.work`.
- The due rules ([task-due.ts](task-due.ts)). Milestone 1 reads `now` as the platform clock; fitting it to working hours arrives in milestone 2.
- The audit record type `task` and the action `task.closed` (`packages/contracts/src/audit/`).

## Never touches

- Other modules' tables, and any business module's code: it imports none. Hats and staff names come from identity's public files (`HatDirectory`, `StaffDirectory`), settings and the clock from platform, and the label and path of a record from the resolver its owner registers in `TaskLinks` (orders registers `order` from its own `onModuleInit`, so orders and later confirmation import tasks and never the reverse).
- Personal data. A task, a label, an error, a log line, and an audit entry carry ids, codes, times, display names, and an order's number and store code, never a phone, a name, an address, or a note. A note lives in `task_notes` (and `tasks.note`), redacted by the key `note`.
- A task's deletion: a task is cancelled, never deleted.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/tasks src/module-boundary.spec.ts
pnpm --filter @ssdashboard/contracts test
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/tasks.e2e-spec.ts test/access-sweep.e2e-spec.ts
```

`test/tasks-rules.e2e-spec.ts` registers a fixture type a person may close (with a note required outcome) in the in process `TASK_TYPES`, because milestone 1's only type is closed by the system; it proves the racing open and the racing close, the fallback of a disabled or demoted assignee, paging with null and tied due times, notes kept out of answers and audit entries, and "due today" at the Cairo midnight with a fixed clock.

The e2e needs Postgres (the dev database); the outbound command events are published by the test as a fixture connector, since the outbound side is a stand in until spec 0015 task 13.

## Governing spec

[Spec 0016, Tasks and My work](../../../../docs/specs/0016-tasks-my-work-inbox/index.md), scope feature 17 ([confirmation to cash](../../../../docs/scope/confirmation-to-cash.md)).

## Decisions

None yet.
