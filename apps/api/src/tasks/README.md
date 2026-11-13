# Tasks and My work

The one small record every process opens when a person must look at something, and the one screen (My work) that shows each person their own tasks and their hats' queues in due order.

## Owns

- Its registry row (spec 0009, AC-6, `packages/contracts/src/modules/module-registry.ts`): `tasks`, core, no toggle. The controller declares `@RequiresModule('tasks')`.
- The tables `tasks` and `task_notes` (defined in [packages/db](../../../../packages/db/src/schema/tasks.ts), owned by `tasks` in [table-ownership.ts](../../../../packages/db/src/table-ownership.ts)). `task_notes` is append only: the app role may only read and insert.
- `TasksService` ([tasks.service.ts](tasks.service.ts)), the only file that issues `INSERT` or `UPDATE` on those tables (`tasks-single-writer.spec.ts`). Milestone 1 has `open` (dedupe through `ON CONFLICT (tenant_id, dedupe_key) WHERE status = 'open' DO NOTHING`, then the winner is read; a `once` type looks at every status under an advisory lock), `close` (row `FOR UPDATE`, a person's `expectedUpdatedAt`, the registry's outcome rules, one `task.closed` audit entry in the same transaction), `closeByKey`, and `eligibleFor` (who may hold a type). Every method takes the caller's transaction and never commits. Reschedule, assign, cancel, and the finders follow in milestone 2.
- The typed domain errors ([task-errors.ts](task-errors.ts)) and their HTTP mapping ([tasks-http.ts](tasks-http.ts)).
- `TaskQueries` ([task-queries.ts](task-queries.ts)): what the caller sees in My work (`view=mine`, keyset pages of 50 sorted by due time, no due time last, then creation, then id) and the shell counts. Visibility is decided by the pure [task-visibility.ts](task-visibility.ts) from the caller's `Access` and `HatDirectory.holdersByHat()`: her own tasks, the unassigned or fallen back tasks of her internal hats, and, for a manager, the unassigned tasks of any hat nobody active wears (spec 0016 AC-5, review B1). "Overdue held by someone else" and the team view are milestone 2.
- The listener ([listeners/write-back-failed.listener.ts](listeners/write-back-failed.listener.ts)): `OutboundCommandFailed` opens `sync.write_back_failed` (dedupe `outbound_command_failed:<command id>`, owner hat operations, due now, assigned to `queuedByUserId` when she is active and holds `orders.confirm`); `OutboundCommandSynced` and `OutboundCommandResolved` close it with `synced` and `resolved`. All run in the publisher's transaction, so a failure rolls the command back with it.
- `TasksController` ([tasks.controller.ts](tasks.controller.ts)): `GET /api/tasks?view=mine`, `GET /api/tasks/summary`, `POST /api/tasks/:id/close`, all `@Audience('staff')` and `tasks.work`.
- The due rules ([task-due.ts](task-due.ts)). Milestone 1 reads `now` as the platform clock; fitting it to working hours arrives in milestone 2.
- The audit record type `task` and the action `task.closed` (`packages/contracts/src/audit/`).

## Never touches

- Other modules' tables. Hats and staff names come from identity's public files (`HatDirectory`, `StaffDirectory`), order numbers from `OrderQueries.summaryOf`, settings and the clock from platform.
- Personal data. A task, a label, an error, a log line, and an audit entry carry ids, codes, times, display names, and an order's number and store code, never a phone, a name, an address, or a note. A note lives in `task_notes` (and `tasks.note`), redacted by the key `note`.
- A task's deletion: a task is cancelled, never deleted.

## How to test

```bash
pnpm --filter @ssdashboard/api exec vitest run src/tasks src/module-boundary.spec.ts
pnpm --filter @ssdashboard/contracts test
pnpm --filter @ssdashboard/api build
pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/tasks.e2e-spec.ts test/access-sweep.e2e-spec.ts
```

The e2e needs Postgres (the dev database); the outbound command events are published by the test as a fixture connector, since the outbound side is a stand in until spec 0015 task 13.

## Governing spec

[Spec 0016, Tasks and My work](../../../../docs/specs/0016-tasks-my-work-inbox/index.md), scope feature 17 ([confirmation to cash](../../../../docs/scope/confirmation-to-cash.md)).

## Decisions

None yet.
