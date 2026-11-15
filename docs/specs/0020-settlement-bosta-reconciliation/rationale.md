# 0020 rationale: settlement and Bosta reconciliation

The decision record for [index.md](index.md). `/develop` reads index.md; this file holds the why, the options, the Bosta evidence, a worked month, and how both domain review passes were closed.

**Revised**: 2026-11-12 for the domain review (*Domain review*); 2026-11-12 for spec 0019's landed M9; 2026-11-12 for the second pass (*Domain review, second pass*).

## Context

Cash on delivery means the brand's money sits with the carrier for days or weeks. Bosta collects at the door, keeps its fees, and pays the rest into the brand's Bosta wallet, from which it transfers cash to the bank on a schedule. The reference brand measured fees at about 19.4% of the COD it collected in one month (about 80 EGP per parcel), and found delivered COD parcels still waiting for a cash cycle weeks later (E5 below). Nobody in a small brand checks this line by line, so short collections, fees that drift, and parcels Bosta never paid for go unseen. Slice 1a is done only when one month of the real Bosta settlement is matched line by line, including refunds, negative lines, and at least one partial delivery, with unmatched lines listed ([scope](../../scope/confirmation-to-cash.md)).

The pieces already exist but are not joined. Spec 0002 built the settlement primitive (accounts, periods, statements, lines, match rows, all append only) with no importer, no matcher, and no screen. Spec 0018 mirrors each Bosta delivery's cash cycle from the single delivery read and publishes `CarrierCashCycleRecorded`, records the collection at delivery (owner decision Q-19.4), and marks deliveries whose cash cycle is overdue. Spec 0019 records lost parcel claims waiting for compensation and every delivery's charges. Spec 0013 offers the cash moves to `remitted` and `reconciled` but nobody calls them. Spec 0007 carried two items here: the settlement file as a fallback to the cash cycle sweep (M1), and third party money reported as confirmed only after period close, with provisional figures labelled (M4).

Four forces shape the design. Bosta publishes no wallet or settlement API that the research could find (E3), so per delivery cash cycles are the only automatic source, and they carry no cash outs and no compensations. Bosta's downloadable sheet exists, but its columns are unknown (E4), so any importer must adapt to a layout nobody has seen. Settlement lines are immutable third party facts, so two sources describing the same delivery must never both become lines, or the month counts it twice. And the order's cash state is spec 0013's to change, through its named moves only, while the reconciliation compares collected cash with what the customer owed for what she kept (`cod_due_amount`), never with what the parcel was created with.

Not deciding leaves every delivered order at `collected_by_carrier` for ever, the wind down with open items it cannot close, the daily report without a "cash expected versus remitted" figure, and lost parcel claims never closed.

## Options considered

### Option A: per delivery cash cycles only

Import every deposited cash cycle from spec 0018 as lines; match by tracking number; no file import.

**Pros**:
- Fully automatic; no person downloads anything.
- One source, so nothing can count twice.

**Cons**:
- Cash outs, compensations, packing material fees, and anything else that lives only in the wallet never become lines, so the account's balance can never agree with Bosta's wallet and no claim is ever closed.
- A delivery the mirror cannot see (unlinked, past its follow window, deleted at Bosta) is lost; spec 0007 M1 asks for the file as a fallback.

### Option B: Bosta's sheet only

The accountant imports the wallet sheet each week or month; the mirror's cash cycles are shown as provisional only.

**Pros**:
- One source that matches what Bosta itself calls the statement, including cash outs and compensation.
- Close to how the reference brand's accountant works today.

**Cons**:
- Nothing reconciles until someone downloads and imports a file; the owner's daily figures stay provisional for a week or a month.
- The sheet's columns are unknown (E4), so the whole feature rests on a layout nobody has seen.
- Throws away figures the app already reads from Bosta, per delivery, with revisions.

### Option C: both, with the per delivery cash cycles leading (chosen)

Cash cycles become lines automatically, one small statement per delivery and revision. The sheet is imported through a saved column mapping with a preview; it adds what the mirror cannot see and confirms the rest. Within one account a delivery's cash cycle kinds live on one live statement only: a later source for the same delivery's cash cycle is compared, never written, and a difference is flagged for a person; the wallet's own rows (compensation, cash outs, insurance, packing, adjustments) always add, deduped by content (the domain review's B1, the lead's ruling).

**Pros**:
- Most of the month reconciles with no person; the sheet covers exactly the gaps of Option A.
- Duplicates are impossible by construction, and a disagreement between sources is itself a finding the accountant wants to see.
- Uses the built tables exactly; the additions are one mapping table and two indexes.

**Cons**:
- First in wins: a wrong sheet imported before the mirror's cash cycle must be corrected by a superseding sheet.
- Thousands of small statements a month; screens group them by deposit day.
- The dedupe rule is subtle and must be tested in both directions.

### Option D: both, imported fully and paired

Import both sources as lines and pair each sheet line with its cash cycle line, clearing one of the pair.

**Pros**:
- Every fact from both sources is stored as a line.

**Cons**:
- `cleared` exists only for superseded statements (spec 0002 settlement child, review R17); clearing half of a pair would need a new result, a schema change the brief rules out.
- Doubles every line, and the pairing step is one more thing that can be wrong; a missed pair is a double count.

### Sub decisions

- **One statement per delivery and revision** [one per cash cycle id]. A revision must replace only that delivery's lines; with one statement per cash cycle id, a single revised delivery would force superseding every delivery of the cycle. Whether one id groups a day is unverified (E4). Spec 0002's statement unique key (`external_reference`, `sha256`) and supersede chain then work unchanged.
- **Dedupe by tracking number for the cash cycle kinds only, wallet rows by content** [spec 0002's per kind content key for everything]. A sheet may give only a total fee where the mirror itemises shipping, open package, FlexShip, and VAT; a per kind key would see no duplicate and count the fees twice. A wallet row is not part of a cash cycle: a compensation for a delivered parcel carries the same tracking number and must add, not be compared away (review B1).
- **Daily totals in the sheet are evidence, never lines.** Bosta's wallet lists a "Collected Cash Cycle" credit and a "Bosta Fees" debit per day (E3); the per delivery lines already hold that money, so the daily rows are compared, not added.
- **The FlexShip refusal fee is a charge, not order cash** (spec 0019 domain review M9, relayed by the lead). Cash a courier takes from a customer who refuses is the brand's charge recovery, so a cash cycle `cod` on a send that did not end delivered becomes an `other_fee` line with `fee_code` `flex_ship_refusal`, matched to the order as a charge and never compared with the order's collected cash.
- **Exact amounts** (Q-22.3). The float noise Bosta sends is removed by parsing to 2 decimals (E5); what is left is real money.
- **The order's cash move is a direct call** to spec 0013's `recordSettlement` inside the matching unit, decided by a pure `carrierCashTarget`, so a match and its cash move commit or roll back together.

## Rationale

Option C is the only one that meets the slice's done when with the facts available. Option A cannot match compensations or cash outs, and spec 0019's claims and the wallet's balance need both. Option B makes reconciliation wait for a person and rests entirely on a sheet nobody has seen. Option D needs a match result the database does not have. Option C keeps the automatic path for the bulk of the month (every delivered, returned, and partial parcel through its own cash cycle) and uses the sheet for what only the wallet knows, while the delivery level dedupe makes a double count impossible, which matters more than anything else in a ledger that can never be edited.

The match rules stay deliberately narrow: a tracking number and an exact amount, or a fee by tracking number alone (fees have nothing in the order to compare with; they are checked as a whole against spec 0019's delivery charges). Anything else gets a reason and goes to a person. This keeps the rules honest about the unknowns (E4, E6) rather than guessing, and the reason list tells the accountant what to do for each line. The domain review showed that most of these comparisons set Bosta against Bosta: the collected amount and the delivery charges both come from Bosta's own cash cycle. So the design adds three checks against something outside Bosta's cash cycle: the brand's own rate card (AC-30), Bosta's shown wallet balance (AC-31), and the bank (AC-32). Wallet balances and bank receipts sit beside the order machine and never move an order's cash, so `remitted` keeps its one meaning (credited in Bosta's wallet) and the bank has a state of its own.

The order's cash moves only from evidence: `remitted` from a matched cash line whose cash cycle carries Bosta's deposit time, `reconciled` only when collected equals due and every line of the order is settled. A shortfall is never hidden: it stays a blocker with a task, and only a person with `settlement.close` and a reason can reconcile a difference (Q-22.4). Every figure stays provisional until feature 23 closes the period, as spec 0007 M4 requires.

## Bosta evidence

Copied from the research report of 2026-11-12 (Bosta's public docs, help center, SDKs, and the reference brand's code and audits, read only, no live call). Labels: **[doc]** Bosta docs, **[help]** Bosta help center, **[sdk]** Bosta SDK, **[3p]** third party SDK, **[SO]** the reference brand's code or audit (strong for field names; its comments are its authors' findings, not Bosta's). Source numbers are the report's.

| # | Fact | Source |
|---|---|---|
| E1 | The single delivery read carries `wallet.cashCycle` with `_id`, `shipping_fees`, `opening_package_fees`, `flex_ship_fees`, `vat`, `bosta_fees`, `cod`, `deposited_amt`, `deposited_at`; the list read carries no fees (`pricing: {}`). | [SO] SO1 `src/lib/bosta/client.ts`, SO6 `20260924140000_bosta_fees.sql`; [3p] S9 `BostaService.php` (`data.wallet.cashCycle` on v2) |
| E2 | `bosta_fees = shipment_fees + vat`, VAT 14% of `shipment_fees` on all 21 checked rows; `deposited_amt = cod − bosta_fees`, negative when the brand owes Bosta (returned to origin and prepaid parcels: 2,248 of 5,622 rows, −178,482.34 EGP). | [SO] SO3 `fees.ts`, SO6, SO7 second audit |
| E3 | No wallet, transactions, or cash out API was found. The dashboard's wallet lists transaction types Collected Cash Cycle (added at the end of each day, "View Breakdown" lists the orders), Bosta Fees (deducted each day), Cash-out (on transfer to the bank, "View Receipt"), Compensation, Packing Material Fees, Recharge Balance; credits are collected cash, refunds, recharged balance, compensations; debits are cash outs, shipping, packing material, insurance fees, VAT. | [help] S11 (wallet daily transactions), S13 (wallet total balance page) |
| E4 | The transactions table offers "downloading a sheet depending on the transaction type", but no page lists its columns. Whether one `cashCycle._id` groups a whole day is unverified (the help center's "cash cycle" is a daily wallet entry; the API's is the cycle a delivery was settled in). | [help] S13; report, *Q4* |
| E5 | Money fields arrive as strings with float noise (for example `-15.760000000000005`); parse to 2 decimals and never derive VAT or totals. `cashCycle` is null until Bosta settles the delivery and sometimes arrives weeks late (18 delivered COD orders worth 17,169.50 EGP waited on 2026-10-22). One month's cohort: COD collected 844,337.15, fees 163,919.46, net 680,417.69; fees 19.4% of COD, about 80 EGP per parcel; bank deposit matching had no data. | [SO] SO1, SO3, SO7 second audit 3.1 and A1 |
| E6 | Compensation is a wallet transaction named "Compensation", "added after Bosta validates and approves a complaint about a completed order", "paid out with your next cash-out"; whether it carries a tracking number is unverified. | [help] S11 |
| E7 | Cash out cadence depends on monthly volume (from weekly on Wednesday for small accounts to Sunday to Thursday for large ones); the article's wording is inconsistent, so confirm with the brand's account. | [help] S12 |
| E8 | Bosta does not record refunds to the end customer in the reference brand's data: its customer return pickups carry COD 0; a customer return pickup "accepts only refund COD values" at creation, so one with a refund amount is possible. | [SO] SO7 second audit A3; [doc] S4 (create delivery) |
| E9 | FlexShip is Bosta's service for refused parcels, 10 EGP per collected order in the WooCommerce plugin's popup; the Shopify app has a FlexShip setting for refused packages. | [doc] S16, S6 |
| E10 | Partial delivery on one tracking number: no Bosta source describes it; the delivered webhook's `cod` is "amount collected", the only place a short collection could show. | report, *Q6*; [doc] S1 |

Source URLs as listed by the report: S1 `http://docs.bosta.co/docs/how-to/get-delivery-status-via-webhook/`; S4 `http://docs.bosta.co/docs/how-to/create-your-first-delivery/`; S6 `http://docs.bosta.co/docs/plugins-and-sdks/integrate-with-shopify/`; S9 `https://github.com/shippulse/laravel-bosta`; S11 `https://bosta.freshdesk.com/en/support/solutions/articles/36000339392-what-s-your-wallet-daily-transactions-`; S12 `https://bosta.freshdesk.com/en/support/solutions/articles/36000339388-your-e-wallet-cash-out-transfers`; S13 `https://bosta.freshdesk.com/en/support/solutions/articles/36000339391-what-s-in-your-e-wallet-s-total-balance-page-`; S16 `https://cdn.jsdelivr.net/wp/plugins/bosta-woocommerce/trunk/components/settings/flexship/flexship.html`; SO1 to SO8 in the reference repo `<reference-repo>` (`src/lib/bosta/`, `supabase/migrations/`, `ops/audits/2026-10-22/`). This task did not open those pages itself; it relies on the report's reading of them.

**Unverified, designed around rather than on**: the sheet's columns (Q-22.6, mapping and preview); how a customer return pickup refund shows (the sign test of the *Lines from a cash cycle* table); whether a Compensation row carries a tracking number (AC-14 matches with or without one); what `deposited_at` means (Q-22.2); whether one cash cycle id groups a day (one statement per delivery); how the FlexShip refusal fee shows in a cash cycle (brand question 7).

## A worked month (the fixture month of the critical tests, in small)

| Delivery | Bosta cash cycle | Lines | Order cash after matching |
|---|---|---|---|
| T1 delivered, 1,650.00 due | cod 1,650.00, shipping 60.00, VAT 8.40, deposited 1,581.60 | +1,650.00 `cod_collected`, −60.00 `shipping_fee`, −8.40 `fee_vat` | `reconciled` |
| T2 partial, 2,450.00 expected, one piece of three back, due 1,650.00 after spec 0019's split | cod 1,650.00, shipping 60.00, VAT 8.40, deposited 1,581.60 | as T1 | the collection is recorded at 45 and the cash line matches; before spec 0019's split `remitted` with `collected_below_due` ("awaiting the partial split"); `reconciled` once split (review M9) |
| T3 returned to origin | cod 0, shipping 60.00, VAT 8.40, deposited −68.40 | −60.00, −8.40 | stays `nothing_to_collect`; fees matched |
| T4 refused with FlexShip | cod 150.00, FlexShip 10.00, shipping 60.00, VAT 9.80, deposited 70.20 | +150.00 `other_fee` `flex_ship_refusal`, −10.00, −60.00, −9.80 | stays `nothing_to_collect`; all charge lines matched; the +150.00 agrees with the `refusal_fee` leg and the rest with the other legs, so the period still agrees (review M4) |
| T5 customer return pickup, refund 300.00 | cod 300.00, shipping 45.00, VAT 6.30, deposited −351.30 | refund branch A: −300.00 `customer_refund`, −45.00, −6.30; their signed sum −351.30 equals Bosta's deposit, so AC-5 passes (the first draft checked `cod − bosta_fees` = 248.70 and failed, review B2) | the refund line matches the `carrier_cash` refund record |
| T6 one piece, 1,650.00 due, the courier collected 1,500.00 (review r2 N1) | cod 1,500.00, shipping 60.00, VAT 8.40, deposited 1,431.60 | +1,500.00 `cod_collected`, −60.00, −8.40 | `remitted`, blocked "claim with Bosta pending" while spec 0019's `short_collection` claim of 150.00 waits; the sheet's Compensation of 150.00 with T6's tracking number matches the claim (`claim_by_tracking`), the resolution becomes `claim_paid`, and 1,500.00 + 150.00 = 1,650.00 reconciles it |
| T7 delivered on the period's last day, 900.00 due (review r2 N2) | deposited the next day, outside the period | none in this period | `collected_by_carrier` at `ends_on`; counted in "owed by Bosta at period end", not in "of which overdue" |
| wallet sheet | Compensation 800.00 (no tracking), Compensation 150.00 (T6's tracking number), Cash-out 2,000.00, Packing Material Fees 120.00, Collected Cash Cycle for the day | +800.00 and +150.00 `compensation`, −2,000.00 `deposit`, −120.00 `other_fee` `packing_material`; the daily total is stored as day evidence | both claims close `received`; deposit and packing accounted |

The period totals then show COD collected 4,800.00 on both sides (T1, T2, T6), cash due 4,950.00 with the 150.00 shortfall shown as compensation received on a `short_collection` claim, fees net of VAT and VAT on fees against the six deliveries' charges, refund 300.00 against the refund record, compensation 950.00 against the two claims, Bosta's deposited 1,581.60 + 1,581.60 − 68.40 + 70.20 − 351.30 + 1,431.60 = 4,245.30 against the sum of the cash cycle lines, cash outs 2,000.00 (received in bank 2,000.00), refusal fees 150.00 against the `refusal_fee` leg, and no unmatched line. With a recorded opening wallet balance of 1,000.00, the lines net 4,245.30 + 950.00 − 2,000.00 − 120.00 = 3,075.30 (the cash out is a negative line, counted once), so the roll forward expects a closing balance of 4,075.30, which the balance the person records at the period's end must equal. "Owed by Bosta at period end" is T7's 900.00 of COD not yet deposited, no compensation outstanding, the closing balance of 4,075.30 not cashed out, and no cash out missing from the bank. Every figure is provisional.

## Domain review

The domain review domain-settlement-reconciliation (kept private) (2026-11-12) found the first draft not ready to accept. Every finding was folded in on 2026-11-12, with the lead's rulings on B1, B2, B3, M1, M2, M8, M10, Q-22.8 to Q-22.11, and the names of spec 0019's revision (`refusal_fee`, `short_collection`, `CarrierClaims.overdueCompensation`).

| # | Severity | How it was closed |
|---|---|---|
| B1 | blocker | AC-9 limits "one live statement per delivery" to the cash cycle kinds; `wallet_only` rows (compensation, adjustment, deposit, insurance, packing) always add, deduped by transaction id or by content (spec 0002 M8); the mapping gives every type value a family (AC-6); a verify row writes a compensation beside a reconciled delivery and closes the claim by `claim_by_tracking`. |
| B2 | blocker | AC-5 now checks the signed sum of the derived lines against `deposited_amt` after the refund branch, plus Bosta's own `cod − bosta_fees` for sends and returns to origin; the derivation table states branches A, B, and C; T5 is fixed in the worked month and in the tests. |
| B3 | blocker | Owner decision Q-22.8 (recommended (a)): the minimal `carrier_cash` refund record in slice 1a, as spec 0016's owner question 2 extended, not a second question; AC-29 counts a refund line only if the pilot month has one, else the runbook records how refunds were paid, and AC-29 also needs the prepaid parcels' fee only negatives. The scope's done when is not changed (out of lane); recommended (a) keeps it true. |
| M1 | major | Owner decision Q-22.9 (recommended (a)): the rate card of AC-30 with effective dates, shipping by city and type, the COD fee percent, VAT 14%, opening package, FlexShip, refusal fee; `fee_above_contract` is an unmatched reason and an order blocker; `charges_differ` is labelled "Bosta's two records differ". |
| M2 | major | Owner decision Q-22.10 (recommended (a)): the wallet roll forward (AC-31) and the cash out bank state (AC-32), beside the order machine, with no change to spec 0002's cash enum; `remitted` is shown as "credited by Bosta" (AC-16); bank evidence for close goes to feature 23. Opening balances are observations in their own table, not `adjustment` lines (the review's suggestion), so a person's figure never sits among Bosta's facts. |
| M3 | major | AC-33 stores each `evidence_only` figure as day evidence and recomputes the per delivery side on read; differing days are `day_total_differs` on the Unmatched tab and a totals row. |
| M4 | major | The FlexShip refusal fee is compared only with spec 0019's `refusal_fee` leg (requested) and has its own totals row; the fee rows leave it out; T4 is in the period fixture and the period agrees. |
| M5 | major | AC-20 lists claims from `CarrierClaims.overdueCompensation` (requested) older than the latest cash out or 21 days; "approved compensation not received" is in the owed at period end figures; AC-14 offers the single awaiting claim as a candidate whatever the amount, confirmed by a person, never a rule. |
| M6 | major | AC-21 answers "owed by Bosta at period end" (awaiting cash cycles, awaiting compensation, the closing wallet balance, cash outs not in bank) and a second grouping by final state day. |
| M7 | major | AC-19 and Q-22.4 revised: below due raises a `short_collection` claim first and writes off only after it is rejected or with a written note, `rounding` only under 1.00; above due is never written off and needs an owed back record in the credit module. |
| M8 | major | AC-34: a minimal CSV export of a period's lines and summary in slice 1a (CSV only, by the lead's ruling, not the review's xlsx), audited; feature 45 replaces it with the client's template. |
| M9 | major | Settled by spec 0019 as landed: the collection is recorded at 45 and only the delivered move is held. The cash line matches the collection; the order stays `remitted` with `collected_below_due`, labelled "awaiting the partial split" and linked to `delivery.collection_differs`, until the split lowers `cod_due_amount`. The reason `awaiting_partial_split` and the alternative fixture of the first revision are dropped. |
| M10 | major | AC-35: an opening cutoff per account from the go live instant; cash cycle lines of parcels Bosta created before it are `accounted` `pre_go_live` and shown apart, never `no_order_for_tracking`; feature 15 may bring the open orders in instead. |
| M11 | major | AC-36: when Bosta revises a cash cycle a sheet already settled, a person may take Bosta's revision, which clears only that delivery's sheet lines with `replaced_by_carrier_revision` (an expand only chain rule change requested of spec 0002). The mirror does not win automatically, because the sheet may hold a person's checked figure. |
| m1 | minor | In part. The reference data run is required before milestone 1 and recorded in verify.md (AC-5). Rejected: folding a residue of up to 0.02 into the VAT line, because it would change a figure Bosta gave; a residue stays Bosta's own `bosta_unitemized` line. |
| m2 | minor | Owner decision Q-22.11 (recommended (a)): a settlement only hat, requested of spec 0008. |
| m3 | minor | AC-21 and AC-34 split fees net of VAT and VAT on fees. |
| m4 | minor | The wallet's "refunds" credit maps to `adjustment` with the type text in `partner_text`. Changed from the review: no `fee_code`, because the built check allows `fee_code` only on `other_fee` lines. Brand question 11. |
| m5 | minor | AC-26: each Unmatched group shows its count, amount total, oldest age, and a next step sentence from the catalog. |
| m6 | minor | AC-21 and AC-23: one manual couriers line on the period page. |
| m7 | minor | Retention of stored sheets carried to features 23 and 27 (Follow-up, AC-27). |
| m8 | minor | AC-21 and Q-22.7: the shortcut "from the last period's end to the latest cash out". |
| Q-22.1 to Q-22.7 | judgement | Kept, with Q-22.2's label (M2), Q-22.4's revision (M7), Q-22.6's sheet now required in AC-29, and Q-22.7's shortcut (m8). |
| Brand questions 1 to 12 | | All twelve are in index.md *Follow-up*, replacing the first draft's seven. |

## Domain review, second pass

The second pass domain-settlement-reconciliation-r2 (kept private) (2026-11-12) found the revision ready to accept once N1 to N4 change. Every finding was folded in on 2026-11-12 with the lead's rulings on N1 to N8 and the slice 1a trim. Before it, spec 0019's landed M9 (collection recorded at 45, only the delivered move held) replaced the first revision's `awaiting_partial_split` reason and its second fixture.

| # | Severity | How it was closed |
|---|---|---|
| N1 | major | Spec 0019 decides every cash difference; settlement reads `CashDifferences.resolutionOf` (spec 0019 AC-32) in `carrierCashTarget` (AC-17, AC-19, Q-22.4). Removed: the reconcile with difference route, the "raise a claim" action, settlement's call of `openShortCollection` (spec 0019 calls it itself), the `settlement.cash_short` task, and settlement's write off reasons. A paid `short_collection` claim reconciles when collected plus compensation equals due; `written_off` (`courier_shortfall_written_off` or `brand_side_write_off`) is the evidence; `over_collection_belongs_to_brand` puts the excess in "kept by the brand at the door"; during a held partial (`held_partial`) no claim is offered and the blocker links to spec 0019's task; a brand side difference (`brand_side_pending`: collected equals Bosta's `cod_amount`) reads "Bosta was never told the new amount". Names as landed in spec 0019's second pass (AC-32). T6 in the worked month asserts the paid claim. |
| N2 | major | "Owed by Bosta at period end" counts every delivery final on or before `ends_on` with collected COD not deposited by then, read as of `ends_on` (`CarrierDeliveries.collectedNotDepositedAsOf`, requested), with "of which overdue" as a sub row; compensation not received is read as of `ends_on` too (`CarrierClaims.approvedNotReceivedAsOf`, requested). T7 in the worked month asserts it. |
| N3 | major | Exactly `CarrierClaims.overdueCompensation({ connectionId, decidedBefore })` with spec 0019's `claim_compensation_overdue_days` (30); `settlement_compensation_overdue_days` and the "before the latest cash out" rule are dropped (AC-20). |
| N4 | major | AC-30 and Q-22.9: every save or correction reruns the check over every fee line of open periods from the version's `effective_from`, rule matched lines included (a person's match counts as "accepted above contract"); a version is corrected for the same days by superseding it with a reason, audited; versions have no end date, so the table stays append only; one price per delivery type with optional zone overrides by carrier area id. |
| N5 | major | AC-37: bulk `retry`, `account`, or `accept` on up to 500 lines of an Unmatched group, one match row per line, one audit entry. `accept` is added to the lead's two actions because the review's own example (a rate change the owner agreed) needs it. |
| N6 | major | AC-29 and Q-22.12: partial deliveries and prepaid parcels get the refunds' fallback (a real one if the month has one, else the recorded fixture month proves the path and the runbook says why). The scope's slice done when line is out of this lane; the lead takes it (Follow-up). |
| N7 | major | AC-9: a `wallet_only` fee row with a tracking number equal to that delivery's live `bosta_unitemized` line is `confirmed`, not added. Insurance stays `wallet_only` in the starting map with this exception, by the lead's ruling, rather than the review's switch to `cash_cycle_part`; brand question 17 settles it. |
| N8 | major | AC-38 and rule 5: cash on a `prepaid` order, or `nothing_to_collect` with fulfillment delivered, is `collected_with_nothing_due` ("the customer may have paid twice"), linked to spec 0019's over collection (requested for this case, `over_collection_pending`), with its own totals row; matched once the resolution is `over_collection_refund_customer` or `over_collection_belongs_to_brand`. |
| m1 | minor | AC-1: the account code uses the last 8 characters of the connection id. |
| m2 | minor | Derivation table: any other type with `cod` not zero writes `cod_collected` `non_forward_cash`. With spec 0019's second pass, a customer return pickup with `cod` above 0 is always a refund (the first revision's branch C is gone). |
| m3 | minor | Carried with the day comparison to feature 23 (*Later than slice 1a*) and brand question 19. |
| m4 | minor | The refusal fee is off the rate card; a refusal fee below the brand's terms is spec 0019's check. |
| m5 | minor | AC-32: a `settlement.close` holder accepts a bank difference with `bank_charge` or `other`, closing the task and showing it by reason. |
| m6 | minor | AC-31: cash outs are negative lines, counted once; a negative balance reads "owed to Bosta". |
| m7 | minor | AC-1: the balance shown is the roll forward's expected balance, or "opening balance not recorded". |
| m8 | minor | AC-16: `reconciled` reads "checked against Bosta" on carrier orders; the Orders tab shows "cashed out, not yet seen in bank". |
| m9 | minor | AC-34: the summary gains the opening balance and owed by Bosta at period end; text cells starting with `=`, `+`, `-`, or `@` get a leading apostrophe. |
| m10 | minor | The spec 0018 request row is corrected: `CarrierCashCycleRecorded` already carries `deliveryType` and `beganAsSend`; `final_at` is no longer needed once the final state day grouping moved to feature 24. |
| m11 | minor | AC-18: settlement is the writer of a corrected collection on a remitted order; spec 0013 clears `collection_changed_after_remittance` when that collection applies. |
| m12 | minor | AC-17: the split sets `cod_due_amount` from the kept pieces, and any rest is spec 0019's `short_collection` claim. |
| m13 | minor | `non_forward_cash` has its own totals row and a next step naming feature 34; the two cash cycles per tracking number question is brand question 13, before milestone 2 (AC-3). |
| OQ-1 to OQ-5 | owner questions | OQ-1 is Q-22.4 revised; OQ-2 is settled by spec 0019's setting (AC-20); OQ-3 is Q-22.12; OQ-4 is Q-22.9 revised; OQ-5 is Q-22.13. |
| Trim | | By the lead's ruling, moved to *Later than slice 1a*: AC-36 (convenience; `sources_disagree` and a corrected sheet cover it), the totals by final state day and the Other couriers tab (feature 24), and the live day total comparison (feature 23). Kept, against the review's list: the bank receipts (M2's leak check). |
| Brand questions B1 to B8 | | Added to index.md *Follow-up* as questions 13 to 20. |

## References

**Project sources**: `AGENTS.md`; specs 0002, 0007, 0009, 0013, 0018, 0019; spec 0016 on branch `docs/tasks-and-confirmation-queue`; `packages/db/src/schema/settlement.ts`; `packages/db/migrations/0002_baseline_rules.sql`; `packages/contracts/src/settlement/`; private `docs/reviews/domain-data-model.md` (M3, M8); private `docs/reviews/security-data-model.md` (S11); the lead's relay of spec 0019's domain review findings M9 and X1 (2026-11-12).

**Practices and standards**: append only ledgers corrected by new rows; events as hints with read back; idempotent imports keyed by content checksum; exact decimal money; Law 151 data minimisation (read only the mapped columns).

**Bosta evidence**: the research report of 2026-11-12, `bosta-api-research.md` in the lead's side session notes, summarised above with its labels.
