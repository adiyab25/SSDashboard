# Verify: core stock loop · spec 0006 · updated 2026-11-04
_Steps derived from spec 0006 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. This first set covers Milestone 1 (the thin thread); later milestones append theirs._

## UI / manual
- [ ] Sign in as a staff member, open `/stock`, choose New SKU, enter code ` tee-blk-m ` and an English or Arabic name → toast "SKU TEE-BLK-M created"; the code is stored trimmed and uppercased → AC-1
- [ ] In the New SKU dialog submit with no name in either language → "Give a name in English or Arabic", focus on the first invalid field, nothing created → AC-1, AC-16
- [ ] Create a second SKU with the same code in lower case → the code field shows "Another SKU already uses this code" (409 `SKU_TAKEN`) → AC-1
- [ ] As staff, `/stock` shows no New location button; as an admin, New location creates `WH-CAI` (warehouse) and the top bar location switcher lists it without a reload → AC-4, AC-15
- [ ] As staff, open `/stock-receipts/new`, pick `WH-CAI`, open the SKU picker with Enter, type `tee`, pick with Enter, quantity 10, unit cost 5.0000, Post receipt → lands on the receipt page numbered `SR-<year>-000001`, status Posted → AC-5, AC-13, AC-16
- [ ] While the picker search is still loading, press Enter → nothing is picked until results for the typed text appear → AC-13
- [ ] On that receipt page as staff → no Unit cost, Line total, or Reference value; as an admin → unit cost EGP 5.0000, line total and reference value EGP 50.00 → AC-11
- [ ] `/stock` as staff → TEE-BLK-M, Cairo warehouse, on hand 10, no cost columns; as an admin → average cost 5.0000 and stock value 50.00 → AC-9, AC-11
- [ ] Switch the language to Arabic → the page is right to left, Arabic names show for the SKU and location, codes and numbers keep left to right order, amounts use Western digits → AC-16
- [ ] Post a receipt with the same SKU on two lines → each faulty line shows its own message, nothing posted → AC-7
- [ ] Each new page (`/stock`, `/stock-receipts/new`, `/stock-receipts/<id>`) has one `<h1>`, a loading skeleton, an empty or error state, and passes axe in both languages → AC-16

## Commands
- [x] `pnpm --filter @ssdashboard/api test:e2e -- test/stock-receipts.e2e-spec.ts` (after `pnpm build`) → 10 passed: thread, replay and conflict, key required, line faults, system location and future date, backdating, atomicity, codes in use, search, 401 → AC-1, AC-4 to AC-7, AC-9, AC-11, AC-13, AC-15, AC-17
- [x] `pnpm --filter @ssdashboard/api test:e2e -- test/ledger.e2e-spec.ts` → the `within` callback commits, rolls back on throw, reruns once on a forced deadlock with one result, and never runs on a replay → AC-5, AC-6
- [x] `pnpm --filter @ssdashboard/web test:e2e -- e2e/stock-loop.spec.ts --project=desktop` → the thread in both languages, cost hidden for staff, axe clean, and the balance equals its movements → AC-17
- [ ] Query the database after the thread: `SELECT on_hand, total_value FROM stock_levels` for the SKU at `WH-CAI` → `10`, `50.00`, and `ReconciliationService.reconcile()` records 0 discrepancies → AC-17

## Value sourcing checks
- [ ] Post with no `Idempotency-Key`, or `not-a-uuid` → 400 `IDEMPOTENCY_KEY_REQUIRED`; the same key and body twice in parallel → one 201 and one 200, stock moved once → AC-6 (receipt id from the header)
- [ ] The same key with only the note changed → 409 `IDEMPOTENCY_CONFLICT` → AC-6 (`request_hash` over location, date, reference, note, lines)
- [ ] Post the same key from a freshly started api process → 200, not a ledger conflict → AC-6 (line ids are UUID v5 of `<receipt id>:<position>`)
- [ ] Post with `receiptDate: 2025-12-31` → number `SR-2025-…` and `effectiveAt` `2025-12-31T10:00:00.000000Z` (12:00 Cairo); a date three days ahead → 422 `FUTURE_DATE` → AC-5 (`effective_at` from the install time zone, in SQL)
- [ ] Make the line insert fail after the movements are written (a test trigger) → no receipt, no balance change, and the next receipt takes the same number → AC-5 (number issued inside `within`)
- [ ] A line of 1,000,000 at 10000 → 422 `INVALID_LINES` with `LINE_TOTAL_TOO_LARGE` at its index → AC-5 (`quantity × unitCost` cap)
- [ ] A transit location id → 422 `INVALID_LOCATION` → AC-7 (receipts service location check)
- [ ] Search `%` and `0%` → only the SKU whose name holds a literal percent sign; `srch-a` finds `SRCH-ALPHA` by code prefix; an Arabic fragment finds by Arabic name → AC-13 (escaped LIKE, uppercased prefix)
- [ ] As staff, every stock and receipt answer (replays included) has no `unitCost`, `lineTotal`, `referenceValue`, `avgUnitCost`, or `totalValue`; as an admin they are present → AC-11 (one serializer per response, by session role)
- [ ] `updatedAt` on a SKU or location read is a microsecond UTC string like `2026-11-04T10:57:12.123456Z` → Value sourcing, used by the stale checks of Milestone 3

## Acceptance-criteria coverage
- AC-1 UI steps 1 to 3, Commands 1 · AC-4 UI step 4, Commands 1 · AC-5 UI step 5, Commands 1 and 2, Value sourcing 4 to 6 · AC-6 Commands 2, Value sourcing 1 to 3 · AC-7 UI step 10, Value sourcing 7 · AC-9 UI step 8 · AC-11 UI steps 7 and 8, Value sourcing 9 · AC-13 UI steps 5 and 6, Value sourcing 8 · AC-15 UI step 4, Commands 1 · AC-16 UI steps 2, 5, 9, 11 · AC-17 Commands 3 and 4
- Not yet covered (later milestones): AC-2, AC-3, AC-8, AC-10 (history), AC-12, AC-14 (web retry), AC-18, and the void half of AC-17

---

# Verify: core stock loop, Milestone 2 (receipts in full) · spec 0006 · updated 2026-11-04

## UI / manual
- [ ] Open `/stock-receipts` → receipts newest first with number, date, location, reference, line count, status badge, and who posted; the scope line follows the top bar location switcher → AC-12
- [ ] Type part of a reference (any case) or the last digits of a number in Search receipts → only matching receipts; a search with no match says so → AC-12
- [ ] As an admin, open a posted receipt, choose Void receipt, submit with an empty reason → "Give a reason, up to 500 characters."; enter a reason and confirm → toast, Voided badge, voided on, by, and reason shown, the Void button gone, the list badges it Voided → AC-8
- [ ] As staff, a posted receipt shows no Void receipt button, and `POST /api/stock-receipts/<id>/void` answers 403 `FORBIDDEN` → AC-8, AC-15
- [ ] After the void, `/stock` no longer lists the SKU at that location (on hand 0) → AC-8, AC-17
- [ ] On `/stock-receipts/new` the Receipt date starts at today in Cairo; pick tomorrow → "Choose today or an earlier day." and nothing is sent; pick yesterday → the receipt is numbered in yesterday's year → AC-5, AC-7
- [ ] With the date left at today, the post body has no `receiptDate` → AC-5
- [ ] When the api answers 503 `BUSY`, the form waits for `Retry-After` and sends the same request once more; if still busy it shows "Stock is busy…" with Try again, the form stays filled, and Try again posts with the same idempotency key → AC-14

## Commands
- [x] `pnpm --filter @ssdashboard/api test:e2e -- test/stock-receipts.e2e-spec.ts` (after `pnpm build`) → 15 passed, including list and paging, void once and back to 0, two voids at once (one 200, one 409 `ALREADY_VOIDED`), `INSUFFICIENT_STOCK` naming the SKU, and the void value at the average → AC-8, AC-12, AC-15
- [x] `pnpm --filter @ssdashboard/web test:e2e -- e2e/stock-loop.spec.ts --project=desktop` → 4 passed: the thread through the void, busy retry, backdating, and the balance equal to its movements → AC-5, AC-7, AC-8, AC-14, AC-17
- [x] Run the web e2e suite twice in a row on the same database → the second run's global setup still signs in (the e2e admin is reset in place, never deleted, since it now has ledger history)

## Value sourcing checks
- [ ] Void with `effectiveAt` omitted → the reversal group is dated now; `stock_receipts.void_group_id` points at it and `voided_by` is the session user → AC-8 (void fields written inside `within`)
- [ ] Receive 10 at 5.0000 (A), then 10 at 7.0000 (B), void A → on hand 10, stock value 60.00, average 6.0000 (not A's 50.00) → AC-8 (value removed at the current average)
- [ ] Take 4 of 5 out with another posting, then void the receipt → 409 `INSUFFICIENT_STOCK` with `skuIds` holding that SKU, receipt still Posted, on hand 1 → AC-8
- [ ] The ledger idempotency key of a void is `stock_receipt_void:<receipt id>`: two voids at once give one reversal group only → AC-8
- [ ] A `Retry-After` header on 503 `BUSY` drives the web's wait (default 2 seconds when absent) → AC-14

## Acceptance-criteria coverage
- AC-5 UI steps 6 and 7 · AC-7 UI step 6 · AC-8 UI steps 3 to 5, Commands 1 and 2, Value sourcing 1 to 4 · AC-12 UI steps 1 and 2, Commands 1 · AC-14 UI step 8, Commands 2, Value sourcing 5 · AC-15 UI step 4 · AC-17 (void half) UI step 5, Commands 2
- Still to come (Milestones 3 and 4): AC-2, AC-3, AC-10 (history), AC-18, the full AC-4 location management

---

# Verify: core stock loop, Milestone 3 (master data in full) · spec 0006 · updated 2026-11-04
_Proved in a real browser by `apps/web/e2e/master-data.spec.ts` (desktop project; English and Arabic). BUG-1 to BUG-3 (QA report of 2026-11-04) are fixed and re-verified; BUG-4 (404 flash after delete) is fixed._

## UI / manual
- [x] Admin creates a location on `/locations` and a SKU on `/skus`, posts a receipt, and `/skus/<id>` shows stock per location with average cost and value plus a history row with unit and total cost → AC-2, AC-4, AC-10, AC-11
- [x] Staff open the same SKU page: no Average cost, Stock value, Unit cost, or Total cost, no `50.00` or `5.0000` anywhere; no Locations or Staff nav entry; `/locations` shows the notice and no table; the edit dialog has no Administrator actions → AC-11, AC-15
- [x] `/skus`: code prefix in any case, English and Arabic name fragments, a literal `%`, no match message, Archived filter, Load more past 50 → AC-13
- [x] Edit name from a second tab → the first tab's save shows the stale message, Reload loads the latest, a second save works → AC-2
- [x] Admin code change before stock works; after stock the field is disabled with its hint, and a change attempted from a dialog opened earlier answers CODE_LOCKED with the explanation → AC-2
- [x] Archive disabled with stock (hint), STOCK_ON_HAND explained when stock lands while the dialog is open, allowed after a void, Unarchive from the Archived filter → AC-3
- [x] Delete: IN_USE explained for a SKU with history; an unused SKU is deleted from its detail page and the page then says "There is no such SKU." → AC-3
- [x] SKU history: void row reads "Void of SR-…" and links to the receipt; a null `postedBy` reads System; 56 movements page 50 then 6 with Load more → AC-10
- [x] Locations: edit name, type, and code before stock; code read only with the hint after stock; stale edit and Reload; archive blocked with stock, allowed after a void; delete IN_USE vs unused; archived and new locations follow the top bar switcher → AC-4
- [x] Arabic: `/skus`, `/skus/<id>`, `/locations` are right to left with Arabic names, Western digits, إلغاء and النظام → AC-16
- [x] axe (WCAG 2.2 AA) clean on `/skus`, `/skus/<id>`, `/locations` and their edit dialogs in both languages, one `<h1>` each, empty and error states → AC-16
- [x] Edit dialog by keyboard: opens with Enter, Tab and Shift+Tab stay inside, Enter in a field saves, a confirm step cancels by keyboard without dropping typed edits → AC-16
- [x] Focus returns to the Edit button after the dialog closes → AC-16 (BUG-1 fixed; re-verified 2026-11-04 on a fresh build, `master-data.spec.ts` focus tests)
- [x] Escape in the confirm step leaves the edit dialog open, typed edits kept → AC-16 (BUG-2 fixed; passed in 3 consecutive runs)
- [x] Focus returns to New SKU, New location (`/stock`) and Void receipt (receipt page) after Escape → AC-16
- [x] A refetch of the SKU behind an open edit dialog does not swap its version: the save answers STALE_RECORD and the colleague's rename survives → AC-2
- [x] Deleting a SKU from `/skus/[id]` goes to the list with no "There is no such SKU." flash → AC-3 (BUG-4 fixed; `deleting from the detail page never flashes` passed in every full run of 2026-11-04)

---

# Verify: core stock loop, Milestone 4 (hardening) and the whole feature · spec 0006 · updated 2026-11-04
_Final re-verification by the QA tester after the last fix wave, on a fresh `pnpm build` (`apps/web/.next` cleared), against a scratch database `ssdashboard_qa0006` migrated to this tree, api on 3201 (`PUBLIC_URL=http://localhost:3300`), web dev on 3300, production build on 3100. Proved by `apps/web/e2e/stock-page.spec.ts` (AC-9), `apps/web/e2e/stock-accessibility.spec.ts` (AC-16 sweep) and the suites below. BUG-5 to BUG-7 are fixed and pass. Verdict: **every criterion AC-1 to AC-18 is met and every suite is green**, BUG-8 (a narrow-screen axe finding on `/stock`) is fixed and now covered by a 375 px axe sweep (2026-11-04 re-verification of the fix, fresh `pnpm build`, same scratch environment)._

## UI / manual
- [x] `/stock` hides rows at zero by default, Show rows at zero adds the voided row (0 on hand) and unchecking removes it, in English and Arabic → AC-9 (`stock-page.spec.ts` › hides rows at zero…)
- [x] A negative row (-3) is badged "Below zero" and is the only flagged row → AC-9 (same test; the balance is seeded straight into `stock_levels`, since no screen can post one yet)
- [x] SKU filter by keyboard (Enter opens, type, Enter picks, one Tab to Clear, Enter clears, the next Tab stop is the Show zero checkbox, Space toggles) → AC-9, AC-16 (`filters by SKU from the keyboard…`, both languages)
- [x] The page follows the top bar location switcher: location one, location two, then all locations → AC-9 (`follows the shell location switcher…`, both languages)
- [x] With a saved location, `/stock` and `/stock-receipts` send no unscoped request first: the network log shows only `/api/stock?limit=50&locationId=<saved>` and `/api/stock-receipts?limit=50&locationId=<saved>` after the location calls → AC-9, AC-12 (checked by script against the dev server; `ready` gates the list queries)
- [x] Most recent movement first; 55 rows page 50 then 5 with Load more → AC-9 (`lists the most recent movement first`, `pages 50 rows at a time…`)
- [x] Empty ("No stock here yet" with a Receive stock link), filtered empty (Show zero on, or a SKU with no stock), and error with Try again that recovers → AC-9, AC-16 (`says so when there is no stock…`, `shows an error with Try again…`)
- [x] Staff see no Average cost or Stock value column and no cost field in the `/api/stock` answer; the admin sees 5.0000 and 50.00; staff have no New location button → AC-9, AC-11 (`staff see no cost columns…`, both languages)
- [x] axe (WCAG 2.2 AA) and one `<h1>` in English and Arabic on `/stock` (loaded, picker open, loading, empty, filtered empty, error), `/stock-receipts` (loaded with a voided row, searched to nothing, loading, empty, error), `/stock-receipts/new` (empty, all errors showing, picker open, two lines), `/stock-receipts/[id]` (posted, voided), the not found and error states of the receipt and SKU pages, and `/skus` and `/locations` loading, empty, error → AC-16
- [x] axe clean in both languages on the New SKU, New location, and Void receipt dialogs (empty and with field errors), the Archive and Delete confirm steps (SKU edit dialog), the Archive confirm step (Locations row), and on `/stock`, the receipt form and a receipt as a person without cost access → AC-16
- [x] `/skus`, `/skus/[id]`, `/locations` and their edit dialogs: axe clean in both languages (existing `master-data.spec.ts` sweep, re-run) → AC-16
- [x] The receipt form by keyboard alone, English and Arabic: pick the place by typing, SKU combobox by Enter, type, Enter, quantity and cost, Add line, remove a line (focus stays in the form), post with Enter, then the Stock page (client navigation, no reload) lists both SKUs → AC-16, AC-5, AC-17 (BUG-6 fixed)
- [x] The SKU picker: Space opens, Escape closes and returns focus to the trigger, ArrowDown and ArrowUp then Enter picks → AC-16, AC-13
- [x] Every page has exactly one `<h1>` while it is loading → AC-16 (BUG-5 fixed: `receipt detail page: the loading skeleton keeps the page's one h1` and the `sku detail page` one, both languages, pass)
- [x] Each stock dialog has exactly one control named Cancel, the corner icon being Close → AC-16 (BUG-7 fixed)
- [x] axe at a phone width (375 px) on `/stock`, `/stock-receipts` and `/skus` with rows, English and Arabic, and the table's scroll region is a focusable, named region → AC-16 (BUG-8 fixed; `stock-accessibility.spec.ts` `phone width (375 px) axe sweep`, 6 tests, run inside the desktop project with `setViewportSize`; `/stock` is asserted to overflow, so the test cannot pass by the table fitting)

## Commands
- [x] `pnpm build` → 4 tasks successful
- [x] `pnpm --filter @ssdashboard/api test:e2e` → Test Files 20 passed, Tests 270 passed, 1 skipped (`bootstrap.sh`, skipped on Windows) → AC-1 to AC-8, AC-11 to AC-15, AC-17
- [x] `npx vitest run --config ./vitest.config.e2e.ts test/scale.e2e-spec.ts --reporter=verbose` (in apps/api) → 9 passed (includes the plan test: the code prefix search uses `Index Scan(product_variants_sku_c_idx)`), and the p95 table below → AC-18
- [x] `npx playwright test` (in apps/web, all three projects: desktop, mobile, production) → 367 passed, 130 skipped (desktop only flows on the mobile project), 0 failed after the BUG-8 fix (the 6 added tests are the 375 px sweep); the earlier failures (BUG-5 to BUG-7) pass
- [x] The four feature specs (`stock-page`, `stock-accessibility`, `master-data`, `stock-loop`), desktop, `--repeat-each=2`, run 3 times → 156 passed in the last two runs. The first run had one test race and one BUG-8 hit: `master-data.spec.ts` read the receipt page `<h1>` while the new loading skeleton's "Stock receipt" heading was still up (the test now waits for `SR-…`), and `stock-loop.spec.ts` (Arabic `/stock`) reported `scrollable-region-focusable` on a data-heavy table at desktop width (not seen again in the two later runs)

## Scale (AC-18), api over HTTP as an admin, 100,000 SKUs and 1,000,000 movements
| Check | p95 | Target |
|---|---|---|
| `GET /stock` first page | 9.4 ms | 200 ms |
| `GET /skus/:id/stock` | 10.8 ms | 200 ms |
| `GET /skus?q=<code prefix>` | 44.9 ms | 100 ms |
| `GET /skus?q=<name part>` | 45.3 ms | 500 ms |
| `POST /stock-receipts` (200 lines) | 189.7 ms | 2000 ms |

## Acceptance-criteria verdict
- AC-1 met · AC-2 met · AC-3 met · AC-4 met · AC-5 met · AC-6 met · AC-7 met · AC-8 met · AC-9 met · AC-10 met · AC-11 met · AC-12 met · AC-13 met · AC-14 met · AC-15 met · AC-16 met (axe clean in both languages on every page and dialog the suites reach, one `<h1>` in every state, keyboard flows, dialog close names, and axe clean at 375 px on `/stock`, `/stock-receipts`, `/skus` with rows in both languages; BUG-8 fixed) · AC-17 met · AC-18 met (code prefix search 44.9 ms of its 100 ms budget, on the index)
- Specced surfaces: `/stock`, `/stock-receipts`, `/stock-receipts/new`, `/stock-receipts/[id]`, `/skus`, `/skus/[id]`, `/locations`, the api route groups, and migration `0008` all exist and are live (`Migrations applied.` on the scratch database)

## Open defects
- None open. BUG-8 (minor, fixed): the shared table wrapper was a scroll container with no keyboard access (`scrollable-region-focusable` at 375 px on `/stock`). `packages/ui/src/components/table.tsx` now renders it as `role="region"`, `tabIndex={0}`, with the table's own label and an inset focus ring (2 px `--ring` outline). Verified: the new 375 px axe sweep passes in both languages; the full Playwright run (desktop, mobile, production) is 367 passed, 130 skipped, 0 failed with no change needed to the existing tab-order, keyboard receipt form, stock filter or `getByLabel` tests; `stock-loop` and `stock-accessibility` desktop `--repeat-each=3` passed (114). Side effect to know: every table now has one extra tab stop and a region with the table's name (by design).
- Test hardening (not a product bug): a `Receipt posted` toast caught mid fade made `stock-loop.spec.ts` report `color-contrast` on `div[data-title=""]` in 2 of 3 repeats of one run. `expectNoAxeViolations` (`e2e/support.ts`) now waits for finite animations to finish first; 6 repeats then 3 more repeats passed.
