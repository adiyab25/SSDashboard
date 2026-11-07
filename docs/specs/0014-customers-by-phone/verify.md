# Verify: customers by phone · spec 0014 · written 2026-11-07

_Steps derived from spec 0014 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Milestone 1 first; later milestones add theirs. Nothing is ticked: the spec is Proposed._

## UI / manual

- [ ] As a support agent, search `٠١٠٠١٢٣٤٥٦٧`, then `00201001234567`, then `+20 100 123 4567` → each opens the same customer → AC-3, AC-5
- [ ] Search `0131234567` → an inline error that does not repeat the typed number; nothing in the address bar holds the phone → AC-3, AC-17
- [ ] Open a customer with Shopify orders from two stores → the header lists her phones (primary first, in left to right text) and two Shopify ids, each with its store → AC-4
- [ ] Search a name fragment of 3 letters in Arabic, then in English → canonical customers only, load more without repeats → AC-5
- [ ] Open the "To review" tab → a suggestion shows both customers and the reason; Merge takes one tap to open and one to confirm; the toast offers Undo → AC-7, AC-9
- [ ] Undo from the toast → both records are back as they were; the profile no longer lists the merge → AC-8
- [ ] Merge two customers on `/customers/merge` by phone, then open the merged one's old address → the survivor opens with a "merged" notice and the address changes → AC-4, AC-6, AC-7
- [ ] As a manager, undo that merge from `/audit` → both records restored; a second Undo from the customer screen says it is already undone → AC-8
- [ ] Dismiss a suggestion as "different people" → it never comes back after the same Shopify order replays → AC-9
- [ ] Flag a customer `refuser` with a note → the header shows kind, source, your name, the time, the note; search rows show the flag; clear it with a reason → gone, both changes on `/audit` → AC-11
- [ ] On a customer refused twice in 180 days with no flag → the header suggests `refuser` with the counts; apply in one tap → manual flag, reason `suggestion_applied` → AC-13
- [ ] Scroll the timeline of a customer with orders and merges → newest first, no gaps, each entry readable; as warehouse open the same URL → no access state, no data loaded → AC-14, AC-15, AC-16, AC-18
- [ ] Switch to Arabic → right to left, every label translated, dates and numbers by the app's rules; tab through search, merge, and flag dialog by keyboard alone → AC-18

## Commands

- [ ] `pnpm --filter @ssdashboard/db test:e2e` → the new checks (flag set time, suggestion pair order, reason and evidence pairing, status and merge id), the foreign key index rule, the tenancy test, and enum parity pass → AC-9, AC-11, AC-19
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/customers.e2e-spec.ts` → rules a to f, twenty parallel calls, every phone form, the log sentinel → AC-1, AC-2, AC-3, AC-17
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/customers-merge.e2e-spec.ts test/customers-audit.e2e-spec.ts` → chain scenario, parallel merges, undo from both doors, every new code writes its entry → AC-6, AC-8, AC-9, AC-10, AC-11, AC-12, AC-19
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/customers-timeline.e2e-spec.ts` → paging across sources, lens per hat, signal thresholds → AC-13, AC-14, AC-15
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/access-sweep.e2e-spec.ts` → every customers route has its fixture and permission; media buyer finds no personal key → AC-16
- [ ] `pnpm --filter @ssdashboard/api test` → `module-boundary.spec.ts` (no orders table named under `customers/`), `permission.spec.ts`, `audience.spec.ts`, the lens unit test → AC-14, AC-15, AC-16, AC-19
- [ ] `pnpm --filter @ssdashboard/contracts test` and `pnpm --filter @ssdashboard/config test` → audit registry test with the new codes and labels; `nameContains` in the redaction keys → AC-17, AC-19
- [ ] `pnpm --filter @ssdashboard/web test:e2e -- e2e/customers.spec.ts --project=desktop` → search, merge, undo, flag, timeline in both languages, axe clean → AC-7, AC-18
- [ ] `pnpm lint && pnpm typecheck && pnpm format:check` → clean → all

## Value sourcing checks

- [ ] `findOrCreate` with a phone known on A and a Shopify id known on B → answers A, one suggestion with `reason = channel_id_conflict` and the external id row as evidence → AC-1, AC-9
- [ ] `findOrCreate` with no phone and a Shopify id known on A → answers A (`matched_by_channel_id`), the order keeps its raw phone → AC-1
- [ ] A customer created from an order → its name is the order's ship to name; a later order with another name leaves it unchanged; `last_seen_at` equals the later order's time → AC-1
- [ ] The merge screen preselects the older record as survivor → AC-7 (`customers.created_at`)
- [ ] After a merge, `customer_merges.repointed_ids` holds exactly the customers that pointed at the merged one → AC-6
- [ ] The flag set by a person stores `manual`, the person, and the time; by an import stores `blacklist_import`, no person → AC-11, AC-12
- [ ] The signal counts change when `customer_risk_signal.windowDays` changes on `/settings`; the window starts at the Cairo operating day → AC-13
- [ ] The store label beside a Shopify id comes from the channels module, not a customers column → AC-4
