# 0022 rationale: period close with evidence

The decision record behind [index.md](index.md). `/develop` does not need it.

## Context

Spec 0020 imports Bosta's money, matches every line, and moves an order's cash to reconciled, but it labels every figure provisional because no period can be closed. The scope's rule (spec 0007, and the reference brand's practice recorded in the reference brand notes, section 2) is that confirmed data is the only data reports, settlements, and exports trust: a range is confirmed by a person after review, or automatically when the evidence matches exactly; re importing into a confirmed range is refused without an admin's written reason; a confirmation is revoked with a reason and never deleted; every automatic action is undoable. Spec 0007 section 3 adds a second class: the brand's own records fed by API are complete for a day once the day has closed and a sweep after it agrees, confirmed with no person needed before dawn.

The forces:

- **The tables already exist.** Spec 0002 built `settlement_periods` (no overlap, dates fixed while closed) and the append only `settlement_period_events` (a close must carry evidence; a revoke must carry a reason code; status follows the latest event). The design must use them, not invent a second confirmation store for money.
- **Bosta keeps sending.** Cash cycle revisions arrive by event and by the nightly sweep at any time, so the gate cannot be a dialog: late data must be caught without a person present and must not be lost.
- **Two independent sources.** The per delivery cash cycles and Bosta's deposited amounts come from one system; Bosta's downloadable sheet and the bank are the independent evidence. An automatic close on one source alone would confirm a number nothing checked.
- **Bosta's sheet is not one total.** The wallet sheet lists daily Collected Cash Cycle and Bosta Fees rows (kept by spec 0020 as day evidence, not lines) beside per transaction wallet rows; staff download whatever range the dashboard offers, so sheets span periods and overlap.
- **The owner's fear is a short cash out** (spec 0020 Q-22.10): money Bosta says it sent that never reached the bank.
- **The accountant posts months.** Once a month is booked, a late correction belongs in the open month, not in a reopened one.
- **Concurrency.** A close and an import can run at the same moment; a close must never confirm a set of lines that changed while it ran.
- **Reporting must only read.** Specs 0023 and 0024 (features 24, 25) need yesterday's orders confirmed by 06:00 and must never decide a confirmation themselves.

## Options considered

### Option A: a confirmed days table per account, separate from periods

A `confirmed_ranges` table (account, from, to, confirmed by, revoked at) like the reference brand's own sheet, with reports reading it.

**Pros**: mirrors how the reference brand already works; per day ranges are flexible.
**Cons**: duplicates `settlement_periods` and its events, so two things can each claim a money day is confirmed; evidence, the no overlap rule, and the dates fixed rule would be built twice.

### Option B: close with evidence on the built periods, and own records days in their own small module (chosen)

A pure close check of named conditions over the period, a person's close with acceptances or the rule's close on exact evidence, a line snapshot, database triggers that refuse writes into a closed period, held arrivals for late carrier data, a posted mark, and the provisional flag read from period status; own records days confirmed per store from the connectors' sweeps; one `ConfirmedDays` read over both.

**Pros**: one confirmation store per class, the money one already guarded by the database; the evidence column and the reason code already exist; the gate holds even against a future writer; reporting reads one service.
**Cons**: six new insert triggers; held arrivals, posted marks, and a new module are new work.

### Option C: no gate, a "changed after close" flag

Let every import write as today; when a closed period's lines change, flag it and notify a manager.

**Pros**: the least code; no data ever waits.
**Cons**: a confirmed number changes while the label still says confirmed; reports that already used it are silently wrong; it fails the scope's "refused without an admin's written reason".

## Rationale

Option B uses what spec 0002 built and adds only the parts the scope names. The check is a pure function over one read model so the screen and the closing transaction see the same rows, and the hash the person sends back proves they closed what they saw. The sheet is compared with the app day by day and per group because a file total means nothing for a wallet sheet whose daily cash cycle money is evidence rows, and because sheets span periods and overlap (domain review B1). The gate sits in the database because the importers are jobs: a service check alone leaves a window between the check and the close. Triggers that take `FOR SHARE` on the period row against the close's `FOR UPDATE` close that window without a global lock.

Late data is held, not refused, because nobody is there to see a refusal at 03:30 when the sweep runs; a held arrival is a small row with a reference the import can replay, and one task per period keeps the manager's inbox short. A sheet row that repeats what a closed month holds is skipped, so a "last 60 days" download never disturbs a confirmed month (review M5). Before posting, admitting reopens the period so that confirmed always means the snapshot is still true; after posting, carrying the difference forward keeps the accountant's books and the app in step (review M6). Option C's flag was rejected for the same reason.

The rule is deliberately narrow: off until the manager turns it on after seeing one close by hand, never over a judgment made by hand, and never again after a revoke, because a revoke records something the conditions cannot see (review B2, M1, m6). Cash in transit at the end of a month is a figure, not a condition: Bosta's cash cycle runs days behind delivery, and a condition on it would block every month.

Own records days are not money, so they live in a small `day-close` module that reads the connectors' sweep evidence and order counts through exported services. An own records day may confirm itself again after a revoke (unlike a period), because each run's evidence is a new, later sweep. `ConfirmedDays` puts both classes behind one read so reporting never decides.

## Worked month 1: a per delivery sheet

One carrier account, November 2026, created by operations on 3 December. Lines with `occurred_on` in November: 1,240 (412 deliveries' cash cycle lines, and 6 wallet rows: 4 cash outs and 2 compensations). The cash cycle lines net 186,420.55 (collected 241,300.00 less Bosta's fees 54,879.45); the compensations are 1,200.00; the 4 cash outs are −186,000.00 (negative lines). The live lines of the period sum to 186,420.55 + 1,200.00 − 186,000.00 = 1,620.55. Operations imported Bosta's `per_delivery` sheet for 1 to 30 November.

| Condition | App | Bosta | State |
|---|---|---|---|
| C1 lines settled | 1,240 lines, all matched, accounted, or cleared (rules only) | | met |
| C2 cash outs in bank | 4 cash outs, 4 received (one 5.00 short, accepted as `bank_charge` in spec 0020) | | met |
| C3 sources agree | no open disagreement | | met |
| C4 sheet days | each of 30 days: `cash_cycle` net and `wallet_only` net of the lines (month: 186,420.55 and −184,800.00) | the sheet's day totals per group (month: 186,420.55 and −184,800.00) | met |
| C5 day totals split | | the sheet has no daily Collected Cash Cycle rows | not applicable |
| C6 deposits agree | 412 statements, each deposited equals its lines | | met |
| C7 wallet | opening 3,100.00 (observed 31 October) + lines 1,620.55 = 4,720.55 | closing observation 30 November 4,720.55 | met |

Figures recorded: owed by Bosta at 30 November 18,250.00 (61 parcels delivered 26 to 30 November, cash cycles in December), of which overdue 0; cash outs not in the bank by 30 November 0; closing balance not cashed out 4,720.55; Bosta's tax invoice for November, fees net 48,139.87 and VAT 6,739.58 (14 percent), against the lines' 48,139.87 and 6,739.58 (together the 54,879.45 of fees). Judgments by a person: none.

October was closed by a person and the manager turned automatic close on afterwards. With Friday and Saturday as the weekend, the fifth working day after Monday 30 November is Monday 7 December, so the job closes November by itself that morning, writes 1,240 snapshot rows, and opens "November closed automatically" for operations. The accountant marks November posted on 8 December. On 20 December a revision 2 cash cycle arrives for a delivery deposited 12 November, 45.00 lower in fees: the import holds it and opens "Late Bosta data for a closed period" for the manager. Because November is posted, the manager carries it forward: one `late_correction` adjustment of +45.00 dated 20 December, in December's open period. November and its snapshot stay as they were.

Had the manager instead admitted it (before posting), November would reopen, the revision would import, and only a person could close November again: the rule never closes a period after a revoke.

## Worked month 2: a per transaction sheet that spans periods

Same account. Operations downloads a `per_transaction` sheet for 25 October to 24 November, then a second for 1 to 30 November. October is closed and posted.

- October rows (25 to 31 October) on the first sheet: the app already holds all of them with equal amounts, so the preview shows "57 rows in October already confirmed, skipped", and apply writes nothing for them. One October row differs by 2.00: it is held as one arrival for the manager. October does not change.
- For each November day, C4 takes the latest received live sheet covering that day: 1 to 30 November from the second sheet, so overlapping days count once.
- This layout carries Bosta's daily Collected Cash Cycle and Bosta Fees rows, stored as day evidence, so C5 applies: each day's `collected_cash` equals the day's `cod_collected` lines and `bosta_fees` equals the fee kinds (as fixed by the real sheet check before milestone 3).
- During November the operations lead matched 3 lines by hand with differing amounts. The judgments panel lists them with her name, and the rule does not close November: a person does, seeing the notice "You matched 3 of these lines yourself".

## How each domain review finding was closed

| Finding | Where |
|---|---|
| B1 sheet total compared the wrong things | C4 per day and per group from `settlement_sheet_day_totals`; worked months rebuilt on spec 0020 AC-31 |
| B2 an undone period closed itself again | AC-4: never after a revoke unless a person closed since |
| M1 judgments invisible | AC-2 judgments, the Close tab notice, AC-4 no rule close over them |
| M2 "Reconciled, confirmed" on unreconciled orders | AC-14 `forOrders` cash state and blockers; AC-15 two facts, never "Reconciled" unless it is |
| M3 Bosta Exchange cash | C1 depends on spec 0020's Q-21.13 amendment, with an interim next step |
| M4 no day evidence | C5 `not_applicable`; the real sheet check widened (Follow-up) |
| M5 whole sheet refused | AC-9 skip unchanged rows, hold changing rows |
| M6 reopen after posting | AC-26 posted mark, AC-10 carry forward, AC-11 the accountant's task |
| M7 operating days | AC-27 working days and holidays; the lateness measurement (Follow-up) |
| M8 nobody creates the period | AC-5 the create task |
| M9 daily report from confirmed data only | routed to the lead (Follow-up); Q-23.10 |
| M10 cash out returned to the wallet | C2 `returned_to_wallet`, requested of spec 0020 |
| M11 the pilot month cannot close | milestone 4 task 18: closed, or the check recorded with every blocking line |
| M12 the tax invoice | AC-28 and the AC-2 figure |
| m1 to m7 | C7 nearest observation; AC-2 two figures; reason codes and reference; AC-10 dialog amounts; AC-7 day evidence triggers and stored evidence for a closed period; Q-23.2 off by default with the offer; AC-12 one undo path |

## References

**Project sources**:
- [Spec 0002, settlement child](../0002-core-data-model/0002-settlement.md): periods, events, derived line periods, the period close rule, and the open question on the superseded clear.
- [Spec 0007](../0007-stack-architecture-operations-layer/index.md), section 3: what confirmed means for the report.
- [Spec 0020](../0020-settlement-bosta-reconciliation/index.md): AC-9, AC-11, AC-21, AC-22, AC-31 to AC-34, AC-37, *Later than slice 1a*.
- [Spec 0010](../0010-audit-trail/index.md): AC-10 and AC-14, the undo registry.
- reference brand notes (kept private), section 2, item 5: confirmed ranges as a gate.
- Domain review (kept private).

**Practices and standards**:
- Period close in accounting: a closed period is not posted to; before posting a correction reopens it, after posting it is booked in the open period with a reference, and the close is evidenced.
- Optimistic concurrency with a content hash for a person's decision on a computed view.
- Row level locking (`FOR SHARE` against `FOR UPDATE`) to serialize writers against a close without a table lock.
- Egypt: input VAT on a supplier's fees is recovered against a validated electronic invoice (cited by the domain review).
