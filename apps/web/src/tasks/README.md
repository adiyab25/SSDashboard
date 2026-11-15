# My work

The task list of the back office at `/my-work`, and the two task counts the navigation shows: the overdue count beside My work and the unsynced edits badge. For people with `tasks.work`.

## Owns

- Page: [my-work-page.tsx](my-work-page.tsx) (the access gate and the one `<h1>`), [my-work-list.tsx](my-work-list.tsx) (the plain list in due order with keyset "Load more", loading, empty, and error states, and the Close dialog), [task-row-card.tsx](task-row-card.tsx) (type label, record link, due time in the brand time zone, owner, overdue marker with icon and word, Close or the reason a person cannot close it)
- Close: [close-task-dialog.tsx](close-task-dialog.tsx) (the outcomes the api lists as `allowedOutcomes`, an optional note, `expectedUpdatedAt`) and [close-task-errors.ts](close-task-errors.ts) (each api error code as a plain sentence)
- Navigation: [my-work-nav-badge.tsx](my-work-nav-badge.tsx) (overdue count) and [unsynced-edits-nav-item.tsx](unsynced-edits-nav-item.tsx) (link to `/orders?hold=1`, shown only when the summary carries `unsyncedEdits` above 0), both reading [use-task-summary.ts](use-task-summary.ts), which polls `GET /api/tasks/summary` once a minute while the tab is visible
- The api calls and query keys: [tasks-api.ts](tasks-api.ts)
- Route: `src/app/(backoffice)/my-work/page.tsx`

## Never touches

- A note's text beyond sending it: the close note is personal data, never logged, stored, or shown back.
- Who may see or close a task: the api decides (404 `TASK_NOT_FOUND`, 422 `OUTCOME_NOT_FOR_PERSON`); the screen only hides what a person cannot use.
- Hard coded text or physical side CSS classes. Use `t()` and logical classes; order labels in `LtrText`, due times through `useFormat()` (the brand's `timezone`, never the device's).
- Milestone 2 and later (groups, Snooze, Take, Release, Escalate, Assign, the Team tab, notes, Call and WhatsApp, the support card): not built here yet.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/tasks
pnpm --filter @ssdashboard/web test:e2e e2e/my-work.spec.ts --project=desktop --project=mobile
```

The e2e needs the api and Postgres; it seeds its own signed in people and a `sync.write_back_failed` task straight into the database (the app has no outbound publisher that fails a command yet).

## Governing spec

[Spec 0016, Tasks and My work](../../../../docs/specs/0016-tasks-my-work-inbox/index.md): AC-5, AC-6 (overdue marker), AC-7, AC-14; milestone 1 item 5.

## Decisions

None yet.
