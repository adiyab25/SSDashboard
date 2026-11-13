# 0019 rationale: delivery failures and returned to origin

The decision record for [index.md](index.md). `/develop` reads index.md; this file holds the why, the options, the Bosta evidence, and the worked D2 cases.

## Context

Cash on delivery lives or dies at the door. For the brands this product serves, a large share of parcels fail at least once, many come back, and each one that comes back costs two shipping legs and leaves a piece that must be found, checked, and put back on sale. Slice 1a is done only when every returned to origin piece of the pilot week is restocked by scan with both shipping legs on its order, and one month of Bosta's settlement matches line by line including at least one partial delivery ([scope](../../scope/confirmation-to-cash.md)).

Spec 0018 mirrors Bosta and moves the order through spec 0013's named moves: picked up, failed attempt, delivered, returned to origin at 46, lost at 100 and 101. It deliberately leaves to this spec the refusal, the next try, the restock, the partial delivery, terminated after pickup, and the claims. It also leaves a gap of its own: at delivered it moves every open line to delivered, so a partial delivery has nowhere to land unless the delivered move waits.

Four other forces shape the design. Bosta's exception reasons are free text, often Arabic, and its code list is unpublished, so any reason list must survive text it has never seen. Personal data law (Law 151) means the courier's text, which can describe a person, must not spread into new tables, events, or logs. The money of a piece that never reaches the customer has no rule yet: domain review D2 found that the prepaid share of such a piece, and a shipping deposit, were left undefined, and D3 found that a refused parcel keeps its full cash due while it travels back. And the independent audit of 2026-11-11 found two holes in slice 1a: an order handed to any courier but Bosta stays packed and unpaid for ever (item 11), and a lost or damaged parcel's piece and cash are both gone with no claim to follow (item 12). The domain review of the stack (n1) adds that in slice 1a nothing in the app stops the warehouse packing by hand from Shopify, so the hold on an unsynced edit must reach whatever list the warehouse packs from.

Not deciding leaves the pilot with refusals nobody calls, pieces that sit in a corner unrecorded, a returned to origin rate nobody can compute, and settlement lines (compensation, partial cash) with nothing to match.

## Options considered

### Option A: put it all in the orders module

Orders already owns the line split, the awaiting restock quantities, and the "Received on the shelf" action. Add attempts, parcels, charges, claims, and handovers as more order tables.

**Pros**:
- No new module; the moves are local calls.
- One place for everything about an order.

**Cons**:
- Orders is already the largest module and the only writer of the order's money; adding reason rules, claims, and carrier charges mixes order truth with follow up work.
- The connector events would be handled inside orders, coupling orders to spec 0018's payloads.
- Tables like `failure_reason_rules` and `carrier_claims` are not order rows and have their own lifecycles.

### Option B: a new core module `deliveries` that follows the order after it leaves (chosen)

A module that listens to spec 0018's events and to orders' events, owns attempts, rules, returned parcels and their pieces, charges, claims, manual handovers, and an outcome projection, and changes orders and stock only through spec 0013's named moves and `restockAwaiting`.

**Pros**:
- Each table has one writer with one purpose; orders keeps its moves small.
- Works without Bosta (manual courier, returned parcels from a partial delivery), so the module is core; only the Bosta listeners carry the Operations capability.
- Rates read the module's own projection, never another module's tables.

**Cons**:
- Requests fifteen changes to spec 0013, eight to spec 0018, and one to spec 0011 (listed in index.md, *Calls this feature makes* and Follow-up).
- A projection must be kept in step with orders (a rebuild command proves it).

### Option C: keep it in the connector

Let `connectors` turn its own events into tasks, parcels, and charges.

**Pros**:
- Closest to the Bosta facts.

**Cons**:
- A manual courier, a partial delivery recorded by a person, and the outcome rule have nothing to do with a provider; spec 0007 keeps provider facts inside the adapter and business rules outside.
- A second carrier would repeat all of it.

### Option D: do failures by tasks only

Open tasks from spec 0018's attention events and let people handle the rest by hand, with no new tables.

**Pros**:
- Smallest build.

**Cons**:
- No reason data for the rate, no record of what came back, no charge per order, no claim identity for spec 0020: the slice's done when cannot be met.

### Sub decisions

| Decision | Chosen | Runner up | Why |
|---|---|---|---|
| Reason classification | Code rule, then phrase rules on normalized text, then `unclassified`; rules taught by a manager | A fixed code table | Bosta's code meanings are unpublished (E2); text is free and often Arabic (E2); a fixed table would be invented |
| Where the reason text lives | Only in spec 0018's `carrier_delivery_events`, read in memory through `attemptsOf` | A copy on `delivery_attempts` | One place for personal text (Law 151) |
| Refusal timing | At the type flip with a refusal reason (Q-21.5) | First refused attempt | `refused` cannot go back to delivered; customers do accept a later try |
| Partial delivery signal | Short cash at delivered holds the move (Q-21.4) | Apply delivered, fix later | Bosta has no partial representation (E6); spec 0013 allows partial only from shipped or failed attempt |
| Return leg charge | One `round_trip` row from Bosta's charge for the parcel | Estimate two legs from a rate card | Bosta settles a returned parcel once on the same tracking number with a fee only, negative deposit (E4, E5); a split would be invented |
| Restock | Through `OrderStock.restockAwaiting`, keyed by the piece row | A direct ledger posting | Orders owns the restock posting and the cap (spec 0013 AC-27 (e)); inventory has one writer |
| Lost stock | No movement; close awaiting quantities | A `write_off` adjustment | The shipment already took the piece out (spec 0002 orders child); a second movement would count the loss twice |
| Claim value | Price share, with cost beside (Q-21.6) | Cost | What the brand lost in sales; Bosta's rules unknown (E7) |
| Manual courier | Minimal person path (Q-21.1) | "Bosta only" pilot condition | The audit's item 11 is otherwise open |
| Pick list | A printable app page with holds (Q-21.8) | Tasks only | n1: nothing else reaches the warehouse in slice 1a |

## Rationale

Option B wins because each piece of follow up work has its own lifecycle and its own people (support calls, the warehouse receives, operations decides and claims, the manager teaches rules), and none of them is order truth. Keeping them out of orders keeps the single writer of the order's money small, and keeping them out of the connector keeps provider facts apart from business rules, so a manual courier or a second carrier reuses everything. The price is a set of requests to specs 0013 and 0018, which are mostly small (a person actor on rows that already exist, an awaiting quantity set on a move that already exists, two event fields), and one real change: spec 0018 holding the delivered move when the cash is short.

The reason vocabulary is deliberately small and owned by the team, not by Bosta. Seven reasons are enough to route the call (unreachable and postponed go to support, address problems need a Bosta ticket, refusals start the return, carrier side goes to operations) and to report the rate by cause. The classifier is tolerant by construction: anything it cannot place is `unclassified`, kept for a person, and turned into a rule once; nothing ever blocks the order.

For D2 the design follows the domain review's own fix: a prepaid share of a piece that never arrives is owed back through a release that does not count as a refund, so a card order and a COD order with the same partial delivery derive the same outcome; and a shipping deposit is a deposit for shipping, allocated to shipping first and kept on a refusal, which is why brands ask for it. Both are consistent pending with spec 0017, which owns the deposit marker on the confirmation side.

## Bosta evidence

Copied from the lead's research report of 2026-11-12 (no live Bosta call; the official API reference page could not be read). Labels: **[doc]** Bosta official docs, **[help]** Bosta help center, **[SO]** the reference brand's code and audits (a real brand reading Bosta in production; strong for field names, its comments are its authors' findings), **[3p]** a third party SDK. Source numbers are the report's.

| # | Fact | Source |
|---|---|---|
| E1 | State 47 Exception is one failed attempt; the delivery keeps moving and is attempted again. Attempts are listed in `state.exception[]` (`reason`, `time`, `code`) on the single delivery read, one entry per failed attempt in order; the webhook carries `exceptionReason` and `exceptionCode` only in Exception | [doc] S1; [SO] SO1 `client.ts`, SO4 `attempts.ts` |
| E2 | Forward exception codes are 1 to 8, 12 to 14, 100, 101; return exception codes 20 to 30; the code to text list is not published. In production the reason is free text, often Arabic, not an enum; the reference brand builds its filter from the distinct texts | [doc] S1; [SO] SO6 `shipping_exception_reasons_facet.sql` |
| E3 | Three forward attempts before return is the reference brand's assumption (`maxAttempts: 3`); Bosta states three failures only for pickups, cash collection, and returns (103 Awaiting your action after three failed returns) | [SO] SO4; [doc] S1 |
| E4 | A failed Send does not stay a Send: Bosta turns the same tracking number into type Return to Origin (24 while moving back, 46 once back at the business); a Send at 46 also occurs and is treated as returned to origin. A customer return pickup after delivery is a new delivery with its own tracking number | [SO] SO6 `delivery_overview.sql`, SO8 `cogs/load.ts`, SO7 |
| E5 | `deposited_amt = cod - bosta_fees`, negative when the merchant owes Bosta (returned to origin and prepaid parcels: 2,248 of 5,622 rows were fee only negatives); `bosta_fees = shipment_fees + vat`; there is no separate return fee column | [SO] SO3, SO6 `bosta_fees.sql`, SO7 |
| E6 | Partial delivery: no Bosta document, help page, or SDK field describes delivering part of a parcel; the delivery carries one `cod` and an item count, and the Delivered webhook's `cod` is the amount collected, the only place a short collection could show | [doc] S1, S4; search found none |
| E7 | Lost is 100, Damaged 101 (never seen by the reference brand), Investigation 102. Compensation is a wallet transaction "Compensation", "added after Bosta validates and approves a complaint about a completed order", paid with the next cash out; it is not a field on the delivery. Whether it carries a tracking number, and any cap or time limit, are unverified | [doc] S1; [help] S11; [SO] SO7 |
| E8 | At Out for delivery or Exception nobody can change address or COD; the phone only through the hub by ticket ("we will try"); before that the merchant (created) or Bosta staff (picked up to in transit) can | [help] S10 |
| E9 | Terminated (48) is "sent after three failed pickup or cash collection attempts"; whether a failed Send ends at 48 is unverified | [doc] S1 |
| E10 | Cash out pays revenue of orders in a final state (Delivered, Exchanged and Returned, Cash Collected, Returned to Origin) on a cadence by monthly volume; the source is inconsistent | [help] S12 |
| E11 | FlexShip: the business may "specify the amount to be collected if the shipment is refused (maximum 150 EGP)", "solely in cases where the end-customer refuses to receive the shipment"; "a 10 EGP service fee is paid to Bosta for each order in case of collection only"; "Bosta does not guarantee the collection"; "the business shall remain fully responsible for all original shipping fees". `flex_ship_fees` sits inside `shipmentFees`; the Shopify app has a setting "FlexShip for refused packages" | [doc] S16 (Bosta's WooCommerce plugin, opened again by the domain review), S6; [SO] Q4 |
| E12 | Consumer Protection Law 181 of 2018: a summary gives a refund right within 14 days of receipt and a 7 day limit to cancel an online order; it says nothing about who bears shipping on a door refusal. The law's own text could not be read by the domain review | Legal 500 summary opened by the domain review; the law text unread |

What is assumed here and must be checked with the pilot brand (Follow-up in index.md): the seeded phrases of the reason vocabulary; that a returned to origin parcel's cash cycle is one charge covering both legs; how a door refusal of one piece of two is reported; whether the parcel label's barcode is the tracking number.

## D2 worked cases

From the domain review's build re-read (D2) and the allocation rules of the spec 0002 orders child.

1. **Card order, one piece refused at the door.** `gateway`, prepaid 2,000.00 for two 1,000.00 pieces, free shipping, open package. The split leaves a returned row with `prepaid_amount = 1,000.00`. AC-14 publishes `PrepaidShareOwed` 1,000.00, funding `gateway`; the refund is a refund request by the same method, posted later as `prepayment_release` then `refund_payout`. `returned_credit_amount` is unchanged, so the outcome is `kept`, the same as the COD version of this order.
2. **Shipping deposit, one piece kept.** 1,000.00 plus 50.00 shipping, two 500.00 pieces, 50.00 InstaPay shipping deposit. With shipping first allocation, `shipping_prepaid_amount = 50.00` and the lines carry 0. Keeping one piece: `cod_due_amount = 500.00 + (50.00 − 50.00) = 500.00`; Bosta collects 500.00; no shortfall (the gross share allocation gave a false 23.81).
3. **Shipping deposit, both refused.** `cod_due_amount` is 0 (spec 0013 request f), cash `nothing_to_collect`. With the deposit disclosed at confirmation, no FlexShip fee collected, and spec 0017's `shipping_deposit_on_refusal = kept_as_delivery_fee`, nothing is owed back and the 50.00 stays as the delivery fee (`kept_customer_caused`); with `released`, 50.00 is owed back as a refund; with `store_credit`, as store credit.
4. **Credit paid replacement refused.** The credit share comes back by spec 0002's `consumption_release`; the order's `credit_applied_amount` stays frozen (domain review D4), so the order's check holds.
5. **Shipping deposit, Bosta lost the parcel** (review M10). The ending is not the customer's doing, so 50.00 is owed back (`released_lost_or_damaged`), after a person chooses refund rather than send again on `delivery.lost_resolve`.
6. **Shipping deposit and a FlexShip fee** (review M9). The customer refuses and pays Bosta's 60.00 FlexShip amount at the door. The cash cycle posts a `refusal_fee` charge of 60.00 (positive: money Bosta holds for the brand, as settlement's +60.00 line) and the order's cash stays `nothing_to_collect`; the deposit is owed back (`released_refusal_fee_collected`), so the refusal is charged once.

## Domain review

The [domain review of this spec](../../reviews/domain-delivery-failures.md) (2026-11-12, verdict accept with changes) found 1 blocker, 13 majors, and 12 minors. Every finding is applied; none is rejected outright, and where the change differs from the review's wording the row says why. The lead's rulings on X1, M1, M9, and M10, and the names agreed with spec 0017, are applied as given.

| Finding | Closed by | How |
|---|---|---|
| X1 blocker: customer return pickups and exchange pickups have no home | AC-29, AC-8, AC-11, *Event handling*, spec 0013 request (i), `delivery.return_pickup_received` | Their deliveries open a parcel (`customer_return_pickup`, `exchange_pickup`), back at 46 or 23; the warehouse picks the delivered line; `OrderStock.recordCarrierReturn` puts it on awaiting restock and `customer_return_restock` posts; legs `return_pickup` and `exchange_pickup`; an operations task says the refund or replacement is outside the app until feature 34. The `found` pilot condition stays only as a fallback, as the lead ruled |
| M1: one failed attempt, two tasks | AC-4, AC-12, Follow-up (spec 0018 item 2) | This spec's tasks replace spec 0018's `exception`, `repeated_attempts`, `collected_differs`, `terminated_after_pickup`, and `no_longer_followed` tasks for a linked forward delivery; the exact list for the lead to apply is in Follow-up |
| M2: the call comes after the courier, and only once | AC-4, AC-5, `delivery_attempt_contacts`, `call-due.ts`, two knobs | Due at the earlier of the working hours and 10:00 the next operating day; contacts are an append only log; `no_answer` keeps the task and retries after 2 hours; `ALREADY_CONTACTED` is gone; both phones and the WhatsApp link on the task's order view |
| M3: the customer's answer never reaches Bosta | AC-5, `passed_to_carrier` | Every answer but `no_answer` records how a person told Bosta (app, ticket with reference, courier, hub, not needed, not possible); the next try task says whether Bosta was told; the app still never claims it told Bosta |
| M4: refuse the M, take the L | AC-7, Q-21.11, spec 0013 request (k) | "Create the replacement" from `failed_attempt` once a size swap was asked; a person links a Shopify made replacement after intake; `size_swap` follows both |
| M5: pieces with nothing to receive them against | AC-30, spec 0011 request | Pre go live parcels list the order's lines and receive through a named `recordFound` with `pre_go_live_return`; "A parcel that is not on the list" records `held` pieces with no posting and an operations task |
| M6: two doors for one piece | AC-9 (the review's option a), spec 0013 requests (a) and (j) | Expected pieces are read live from awaiting quantities; `AwaitingRestockChanged` moves the parcel whichever door was used; no claim for a quantity no longer awaiting; spec 0013's `awaiting_restock_overdue` suppressed for lines in an open parcel |
| M7: the wrong piece is usually our mispack | AC-10, `returned_parcel_piece_answers`, task permission `stock.receive` | Two answers, `packed_wrong` (restock the expected line, no posting for the returned piece) and `customer_swapped` (a `found` request to the manager, close the expected line `customer_kept`, draft `missing_from_return`); the runbook names the manager for `found` and the damaged close |
| M8: the partial's returned piece has no Bosta trail | AC-13, AC-8, `partial_return_receive_days`, AC-12 | A partial's parcel starts `returning` with its own 7 day knob and moves on a later return delivery or the first piece; the claim notes Bosta shows delivered and the runbook asks for the courier's receipt; the stale carrier record is shown on the collection task |
| M9: FlexShip refusal fee | AC-11 (`refusal_fee`), AC-15, Q-21.10, E11 | A cash cycle COD on a refused or return to origin delivery becomes a `refusal_fee` charge (positive, its leg giving the direction, after spec 0020's review M4), never order cash; spec 0020 matches it to the charge row; a deposit is never kept as well for the same refusal, as the lead ruled |
| M10: deposit kept when the fault was Bosta's; refund opened for a resent parcel | AC-15 (`deposit-rule.ts`, `deposit_rule`), AC-14 (`delivery.lost_resolve`), Q-21.9, Q-21.12, Follow-up for spec 0017 | Kept only for customer caused endings with a recorded disclosure and no refusal fee; released on lost, damaged, carrier side, or no customer contact; a lost parcel first asks send again or refund; the legality is Q-21.12, recommending the brand's lawyer before pilot, as the lead ruled |
| M11: the manual courier path as drivers really work | AC-23, AC-24, `courier_cash_receipts`, `ManualHandoverRecorded` | One run receipt for many handovers; `other_courier` reconciles net of its fee; a `customer_pickup` kind; a handover raises spec 0018's `cancel_in_bosta` on an open auto synced delivery through an event, so connectors never reads this module; the "Bosta only" fallback if milestone 5 is late |
| M12: the cuts the owner and media buyer act on | AC-18, AC-17 (`returning_since`) | `campaign`, `city`, and `refusal_reason` cuts; `campaigns.view` reads the campaign cut; returns count from the flip; `open` beside every rate and "not settled yet" above 20 percent; the confirming agent cut is carried to feature 24 |
| M13: a packed order that never leaves; the pick list and the AWB stack | AC-31, AC-25 | `delivery.packed_not_shipped` after 2 operating days; tracking numbers on the pick list, a fourth hold for a cancelled packed parcel listed first, a tick column, and `day` defined |
| m1: seeded phrases misfire | AC-2, *Reason vocabulary* | The bare "غير موجود" is not seeded; specific unreachable phrases and common Egyptian forms added; real distinct texts replace the seeds before milestone 2, not after the pilot; labels in plain Egyptian Arabic |
| m2: only the owner can teach a phrase | AC-3 | Phrase rules need `channels.map` (operations and the manager); code rules stay with `settings.manage`. The review suggested "`orders.confirm` holders on the operations hat"; a permission check cannot test a hat, and `orders.confirm` is also support's, so the closest permission operations holds and support does not is used |
| m3: a flip with no attempt row | AC-1 | Attempts counted with no exception entry are `unclassified`; a flip with no attempt row opens the call task "find out why it is coming back" |
| m4: receiving while `returning` | AC-8, *Lifecycles* | Pieces may be received in `returning`, which may go straight to `received` or `closed_short` |
| m5: damaged is not always Bosta's | AC-10, AC-20 | Withdraw reason `customer_damage`; the runbook routes kept seconds through spec 0011 later |
| m6: claims need evidence; `not_received` missing | AC-19, AC-20, Follow-up | `evidence_ref` on the claim and the kind `not_received` (person only). The attachment is deferred, not rejected: the api has no object store service yet (no S3 client in `apps/api/src`), so it is a Follow-up rather than invented here |
| m7: the returner signal counts size swaps | Follow-up (spec 0014) | Carried to spec 0014 |
| m8: pilot charge check timing; "by scan" in the scope | *Pilot acceptance* (2), the feature 21 scope entry, Follow-up (scope) | Charges checked within 14 days after the week; the feature 21 entry says restock is by tap until feature 20; the slice line is the lead's to reword |
| m9: spec 0002 says feature 21 opens an exchange | Follow-up (spec 0002 orders child) | Carried by name |
| m10: two overdue tasks for one piece | AC-8, spec 0013 request (a) | Covered with M6 |
| m11: next try day and Bosta's days off | AC-5, `carrier_non_delivery_weekdays` | Grace counted in carrier delivery days; public holidays wait for brand question 7 and are not modelled yet |
| m12: "size swaps left out" ambiguous | AC-18 | Left out of both the numerator and the denominator |

**From spec 0020's domain review** (`docs/reviews/domain-settlement-reconciliation.md`, findings routed by the lead): M4, the `refusal_fee` sign, is closed by AC-11 (every amount positive, the leg gives the direction, so 150.00 agrees with settlement's +150.00); M7, a shortfall written off only through a claim, by the claim kind `short_collection` (AC-12, AC-13, AC-19) and `delivery.over_collection` for an excess that belongs to the customer; M5 by `CarrierClaims.overdueCompensation` and the setting `claim_compensation_overdue_days` (AC-22); M9 by AC-12 stating that the collection is recorded and only the delivered move is held.

The three new owner questions of the review are Q-21.9 to Q-21.11 in index.md; the lead's ruling adds Q-21.12 on the deposit's legality. The review's twelve brand questions are listed in index.md's Follow-up.

## Domain review, second pass

The [second pass domain review](../../reviews/domain-delivery-failures-r2.md) (2026-11-12, verdict accept with changes) found 1 blocker, 5 majors, and 11 minors, and asked three owner questions (OQ-1 to OQ-3, now Q-21.13 to Q-21.15) and nine brand questions (Follow-up, 13 to 21). Every finding is applied; the lead's rulings on B1 and N1 to N5 are applied as given; n11 is not rejected but moved to *Later than the pilot* in index.md, as the lead asked.

| Finding | Closed by | How |
|---|---|---|
| B1 blocker: an exchange delivery takes a new piece out and nothing posts it; "back at 23" is not a Bosta fact | AC-29, AC-8, *Lifecycles*, *Event handling*, Q-21.13, `delivery.exchange_not_supported`, *Later than the pilot* | A written pilot condition: no Bosta Exchange type during the pilot; a swap is a return pickup plus a new `replacement_for` order. Any type 30 delivery opens an operations task with the runbook step (record the replacement and a manual handover naming the tracking number, which posts the shipment). The old piece is received on an `exchange_pickup` parcel. 23 means the courier has the piece at the customer's door: the parcel stays `returning` until 46 or its first piece. The review's option 2 (type 30 as the replacement's forward delivery) is listed under Later. verify AC-29 fixed |
| N1: short cash equal to Bosta's own COD is not a partial and not Bosta's fault | AC-12 (a) to (c), AC-13, AC-22 (`openShortCollection` refuses it), Q-21.14, Follow-up (spec 0018 item 6) | Compare the collected cash with Bosta's `cod_amount` first. Equal: no hold (requested of spec 0018 AC-16), no claim; `cod_difference_brand_side` with cause `carrier_record_stale` or `cod_rule_mismatch`, answered `brand_side_write_off` (reason and note, `settlement.close`, audited) or `customer_owes`; nothing at all while `COD_RULE_MISMATCH` stands. A `short_collection` claim only for the part below Bosta's COD. The invariant names both write offs |
| N2: the customer's latest answer must beat the courier's earlier reason | AC-6 (`effective-answer.ts`), AC-15 (`released_carrier_ignored_request`) | A recorded contact always overrides the courier's reason, for the ending and the deposit rule. A later `will_receive`, `rescheduled`, or `details_corrected` passed to Bosta stops the flip from making the order `refused`, releases the deposit, and opens `delivery.next_try_missed` to complain or reopen |
| N3: a size swap replacement has no undo | AC-7, AC-25 (hold), `delivery.replacement_check`, spec 0013 request (o) | "Undo the replacement" while it is not shipped (spec 0013's cancel, `size_swap_undone`); the original delivered while the replacement waits holds it on the pick list and opens a support task (`cancel_replacement`, `keep_both`); a shipped replacement stays a second order with the task; `size_swap` recomputed on each event |
| N4: the app never learns that the warehouse packed | AC-25 ("Packed" through `markPacked`, prints, "Cancelled since printed"), AC-31 widened to confirmed orders (`delivery.not_shipped`), Q-21.15, `pick_list_prints` | Packing is a tap on the pick list that the holds refuse; marking packed is a pilot condition; every order on a print that is cancelled afterwards is listed first until taken out; a confirmed or packed order that never ships gets a task; the invariant covers every confirmed order |
| N5: `found` is refused whenever the same variant awaits on another order | AC-10, AC-30, Follow-up (spec 0011) | Requested of spec 0011: `pre_go_live_return` and `customer_swapped_return` skip the `RETURN_AWAITING_RESTOCK` check, carry the parcel piece id, and get their own label. The AC-29 fallback is a plain `found` and keeps the guard (it is only a fallback) |
| n1: return pickups are the customer's side | AC-29, spec 0013 request (i), Follow-up (spec 0020) | No claim for a damaged piece on a return pickup unless the bag is marked tampered; `recordCarrierReturn` sets the line `returned`; a return pickup COD above 0 goes to spec 0020 as a refund paid by Bosta |
| n2: a lost COD order has no customer follow up | AC-14 | `delivery.lost_resolve` opens for every lost order, with `send_again`, `refund` (only when prepaid), or `customer_declined` |
| n3: the manual courier path at the door | AC-23, AC-24 | `cashCollected` required when COD is due; a `fulfillment.work` holder records the collected amount on an office pickup; a stale Bosta record no longer refuses a handover |
| n4: a flip with no attempt row has nowhere to record the call | AC-1 | The flip inserts an `unclassified` attempt row and the task is attached to it |
| n5: the pilot's deposit setting | AC-15, *Pilot acceptance*, the runbook | `released` until the lawyer answers, set at install and checked in the pilot acceptance |
| n6: the address problem clause | AC-15 | `address_problem` always releases |
| n7: the rate's buckets and cohort | AC-18, `outcome_ending` | One bucket per order (`returning` until ended); `refused` is a reason, not an ending; `cohort=placed\|shipped` with placed the default for the campaign cut; a "no area" group |
| n8: a lost parcel Bosta later delivers | AC-16, `delivery.lost_parcel_moved`, spec 0013 request (n) | A task to withdraw the claim and correct the order by a person, with evidence |
| n9: one tap per piece on a bag of twenty | AC-9, `/receive-all` | "Receive all as sellable", one piece row and key per expected piece |
| n10: `not_received` has no customer side | AC-19 | The claim page names the slice 1a answer: a `goodwill_for` gifted resend with `replacement_goodwill`, or a refund outside the app until feature 34 |
| n11: complexity the pilot does not need | *Later than the pilot* in index.md | Moved, not deleted: the grouped teaching screen, the prepaid late partial, the `other_courier` fee split, and the over collection answers may slip; marked in the build plan |

**Calls spec 0020 relies on** (its Follow-up "Requested of spec 0019"), matched to the shapes spec 0020 uses: `CarrierClaims.openShortCollection(tx, { orderId, deliveryId, amount }, actor)` (spec 0020 names the field `amount`, not `shortfall`), `CarrierClaims.overdueCompensation({ connectionId, decidedBefore })` as its one signature (spec 0020 second review N3; the caller computes `decidedBefore` from `claim_compensation_overdue_days`), and `ManualHandovers.cashSummary({ from, to, storeId?, courierKind? })` (spec 0020's `storeId?` plus the lead's `courierKind?`).

**From spec 0020's second review** (`docs/reviews/domain-settlement-reconciliation-r2.md`, N1 and N3, routed by the lead): this spec is the single owner of cash difference resolutions (AC-32, `CashDifferences.resolutionOf`), the only write offs are the rejected `short_collection` claim and `brand_side_write_off`, no claim can be opened while a partial is held (`PARTIAL_UNDECIDED`), and `overdueCompensation` has one signature. Spec 0020's last requests (its Follow-up "Requested of spec 0019") are added the same way: `CarrierClaims.approvedNotReceivedAsOf({ connectionId, asOf })` (AC-22) and cash collected on an order with nothing due as an over collection, cause `collected_with_nothing_due`, resolution `over_collection_pending` (AC-12 (e), spec 0020 AC-38).

**The first review's renamed names**: `delivery.packed_not_shipped` and `packed_not_shipped_days` in the table above are now `delivery.not_shipped` and `not_shipped_days`, because AC-31 covers confirmed orders too.

## Owner answers of 2026-11-13

The owner ratified every recommendation ([owner answers](../../reviews/owner-answers-2026-11-13.md)) except the deposit questions and the exchange. **Who bears Bosta's fee** (Q-21.2, Q-21.9, Q-21.10, Q-21.12): usually there is no deposit; Bosta's fee is paid on every parcel, and the reason decides who bears it. AC-33 turns the owner's words into one pure rule over the deciding answer the spec already had (AC-6), with two vocabulary additions the rule needs: the refusal code `wrong_item` (the owner's "wrong item or size", which is the brand's mistake, unlike `size`, a piece that does not fit) and the contact outcome `courier_never_came` (the owner's "Bosta never reached her", which a courier's own reason text never says). `unclassified` becomes `undecided` rather than the customer's, because flagging a customer on a reason nobody knows would punish her for the classifier's gap; a person decides it. The carrier's share becomes a claim kind, `failed_delivery_fee`, so spec 0020 matches Bosta's compensation exactly as it matches any claim. The customer's share is only what the owner named: the FlexShip fee Bosta took at the door and the flag. **Bosta Exchange** (Q-21.13 (b)): the exchange allowance is modelled as a prepayment of its own method on the replacement order so its COD is the price difference with no new money machinery; it is never published as money owed back, because it is the customer's earlier payment moving, not a second payment. The runner up, a credit pair through the credit module, needs feature 28 and is the shape the allowance takes when that module exists. Cost, stated for the owner: a sixth milestone here and requests of specs 0013, 0018, and 0020, roughly two builder weeks.

### Domain review of the owner answers (2026-11-13)

The [domain review](../../reviews/domain-owner-answers-2026-11-13.md) of the three changed designs (verdict accept with changes) and how each finding was closed:

| Finding | Closed by |
|---|---|
| B1 the fee bearer contradicted AC-6 and AC-15 | AC-33: a request passed to Bosta and ignored is `carrier`; `address_problem` is `undecided`, or `brand` after a confirmation edit or out of zone; AC-33 is the only fault table and AC-15 reads it |
| M1 one ending flags her on the courier's word | AC-33: every customer borne ending is counted; the flag is set only for an uncontradicted door refusal with a customer side code; spec 0014's suggestion stays for the rest |
| M2 "wrong size" split two ways | AC-33: `size` is `undecided` until a contact records the code, `brand` with a size swap replacement; a disputed amount is `price`, not `cash_problem`; a bare "السعر" is not seeded |
| M3 app sync compares an old read (specs 0017, 0018) | confirming sends a priority 1 read and the check compares only on it (0017 AC-33 c, 0018 AC-32) |
| M4 the old piece never comes back | AC-34: `delivery.exchange_old_piece_missing` with `courier_did_not_collect` (claim, original `exchanged`) and `customer_kept` (original stays `delivered`, allowance owed) |
| M5 a discounted dress charged the discount back | AC-34: a same style line defaults to the price she paid |
| M6 order level `exchanged` and retries | AC-34: an `exchanged` original accepts exchanges of lines not yet exchanged; a cancelled or refused replacement frees its quantity; a retry is a new exchange |
| m1 to m7 | no flag on an exchange replacement; a packed replacement with no Bosta Exchange is marked and raises `delivery.exchange_unlinked`; the cheaper case nets the shipping charge; `undecided` wording, filter, and how the bearer was reached shown; the replacement's store, number, and campaign stated; `bostaAppSyncsEdits` hides the checklist (0017 AC-33, 0018 AC-32) |

The review's six brand questions are listed in the owner report, not assumed.

## References

- `AGENTS.md`; `apps/api/src/inventory/AGENTS.md`.
- [Spec 0018](../0018-bosta-connector-mirror-mode/index.md) and its [Bosta API evidence](../0018-bosta-connector-mirror-mode/rationale.md); [spec 0013](../0013-orders-state-machines/index.md); [spec 0011](../0011-stock-ledger-locations/index.md); [spec 0002 orders child](../0002-core-data-model/0002-orders.md), [settlement child](../0002-core-data-model/0002-settlement.md), [credit child](../0002-core-data-model/0002-customers-credit-tasks.md).
- [Domain review of the data model, build re-read](../../reviews/domain-data-model.md) (D2, D3, D4); [domain review of the stack](../../reviews/domain-stack.md) (n1).
- The independent audit of 2026-11-11, section 4 items 11 and 12, and the Bosta research report of 2026-11-12 (both kept by the lead outside the repo; the facts relied on are copied above).
- Spec 0016 (feature 17) on branch `docs/tasks-and-confirmation-queue`: the task registry and the slice 1a credit refund record brief.
