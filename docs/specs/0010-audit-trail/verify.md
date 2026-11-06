# Verify: audit trail · spec 0010 · updated 2026-11-05
_Steps derived from spec 0010 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Milestone 1 first; later milestones append theirs. Nothing is ticked yet: the spec is Proposed._

## UI / manual
- [ ] As a manager, void a posted stock receipt with the reason "wrong supplier" → `/audit` lists a row: your name, the time in Cairo time, "Receipt voided" (Arabic label in Arabic), the receipt number, the reason → AC-1, AC-5, AC-12
- [ ] Void another receipt with no reason → the dialog shows the reason error, the receipt stays posted, `/audit` has no new row → AC-2, AC-5
- [ ] As staff without the manager hat, open `/audit` → the page is not offered and a direct visit shows the forbidden state → AC-13
- [ ] Open the entry detail → field by field before and after (`status: posted` to `voided`), one `<h1>`, readable by keyboard → AC-12, AC-18
- [ ] Edit an order address (when orders exist) → the entry says "address changed" and "hidden, personal data", and the new address appears nowhere on `/audit` → AC-4
- [ ] Filter by person, then by record type and id, then by action, then by day range, then by correlation id (the "same action" link) → each narrows the list and combinations work; clearing a filter restores the list → AC-6, AC-12
- [ ] Load more until the end → no duplicates, no gaps, "No more entries" at the end; the empty filter result says "No entries match" → AC-12, AC-18
- [ ] Switch to Arabic → right to left, labels from the registry in Arabic, dates and numbers keep the app's rules → AC-18
- [ ] Open an undoable entry (after features 14, 16, or 34 land; before that, the fixture in the test) → Undo opens one dialog with a reason; confirming reverses it and adds an "undone" entry; the original shows "Undone" and no Undo button → AC-14
- [ ] Export a 3 day range → a CSV opens in Excel with Arabic text intact; the same rows as the screen; `/audit` now shows "Audit exported" by you → AC-15

## Commands
- [ ] `pnpm --filter @ssdashboard/db test:e2e -- test/audit-append-only.e2e-spec.ts` → app role `UPDATE`, `DELETE`, `TRUNCATE` denied; owner changes rejected "append only"; planted `GRANT UPDATE` still rejected → AC-8
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → the tenancy schema test, the operating day test, and the append only list all include `audit_entries` → AC-1, AC-7, AC-8, AC-9
- [ ] `pnpm --filter @ssdashboard/api test` → `audit-registry.spec.ts` (fields, both labels, proof file, handler for every undoable) and `module-boundary.spec.ts` pass → AC-9, AC-10, AC-19
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- test/audit.e2e-spec.ts` → thread, rollback both ways, reason rules, actor shapes, privacy sentinels, correlation, paging, permissions, undo cases, export cases → AC-2 to AC-6, AC-12 to AC-15
- [ ] `pnpm --filter @ssdashboard/web test:e2e -- e2e/audit.spec.ts --project=desktop` → the thread in both languages, axe clean, keyboard only → AC-12, AC-18
- [ ] `pnpm --filter @ssdashboard/api test:scale` → with 5,000,000 entries, p95 under 150 ms per filter and for the unfiltered page, `record` under 10 ms; measured values pasted into AC-17 → AC-17
- [ ] `pnpm lint && pnpm typecheck && pnpm format:check` → clean → all
- [ ] `node packages/config/scripts/check-doc-links.mjs` → passes → doc rule

## Value sourcing checks
- [ ] Insert through `record` with no `operating_day` and a time of 00:30 Cairo with cutoff 2 → the stored day is the previous day → AC-7 (trigger `ssd_stamp_operating_day`)
- [ ] Insert with the tenant setting reset → fails loudly; otherwise `tenant_id` equals the install id → AC-1 (column default)
- [ ] Two entries in one transaction → `recorded_at` differs and orders correctly (`clock_timestamp()`), `id` increases → AC-1
- [ ] An entry from a worker job → `actor_kind = 'system_job'`, `actor_ref` the job name, `job_id` the pg-boss job id, no user → AC-3
- [ ] An entry from a partner user session → `actor_kind = 'partner_user'`, `actor_user_id` set, `actor_ref` the partner account id (from the session user row, never the request) → AC-3
- [ ] An entry for a customer acting through a signed link → `actor_kind = 'portal_customer'`, `actor_ref` the customer id → AC-3
- [ ] Try to insert `actor_kind = 'person'` with no user, and `system_job` with a user → both fail the table check → AC-3
- [ ] Record with an unknown action code → `UnknownAuditAction`; a required reason missing, or `"   "` → 422 `REASON_REQUIRED` → AC-5, AC-10 (registry)
- [ ] Reason `call 01012345678` → stored as `call [phone]` → AC-5 (`maskPhones`)
- [ ] `undo_args` containing a phone key, or `record_label` with a phone → `AuditPersonalDataRefused` → AC-4, AC-14 (redacted copy must equal input)
- [ ] The list's `actorName` for a disabled person still shows their name; a system actor shows its `actor_ref` → AC-12 (identity `namesByIds`)
- [ ] A list cursor edited by hand → 400 `INVALID_CURSOR` → AC-12 (cursor is base64url of `recorded_at` and `id`)
- [ ] Export of 400 days → 400; over 200,000 rows → 413 `EXPORT_TOO_LARGE` → AC-15 (constants in the module)
