# Verify: confirmation queue · spec 0017 · written 2026-11-12

_Steps derived from spec 0017 acceptance criteria and its Value sourcing table, revised the same day for the [domain review](../../reviews/domain-confirmation-queue.md) and spec 0018's final "carrier record stale" contract. `/check verify` runs these; `/test` locks the durable ones. Milestone 1 first; later milestones add theirs. Nothing is ticked: the spec is Assumed._

## UI / manual

Milestone 1:

- [ ] As a support agent, open `/confirmation` with three new orders placed 09:00, 09:30, 10:00 → Due now lists them oldest first, each with store beside its number, age, lines with stock, total, COD expected → AC-1, AC-2, AC-3
- [ ] Open a card on a second browser as another agent → "Mona is on this customer" shows for every order of the group; opening it anyway moves the claim with no error → AC-4
- [ ] Pick your WhatsApp line, tap WhatsApp → a new window opens `https://wa.me/20...?text=...` with the Arabic `confirm` template filled (name, store, number, items, payment line, address); on a prepaid order the payment line says paid in full; switch to English and tap again → the English text → AC-5, AC-6
- [ ] A landline customer → WhatsApp disabled with "Landline: call only"; a `+966` mobile → WhatsApp offered; a second phone → WhatsApp and Call offered for it → AC-5
- [ ] Return to the tab after WhatsApp or Call → "What happened?" with focus on the outcome toolbar → AC-6
- [ ] Record `message_sent` at 10:04 → Later shows it "Waiting for a reply since 10:04"; at 12:04 it is back in Due now marked "No reply: call" → AC-8, AC-9
- [ ] Paste the customer's phone (`01xxxxxxxxx`) into Find by phone → her card opens in whatever lane it sits; nothing in the address bar holds the phone → AC-29
- [ ] Record `confirmed` → the order leaves the queue and is `confirmed` on its order page with its tries listed → AC-7, AC-8
- [ ] Confirm an order with a short line → asked "Confirm anyway, or offer another size?"; answering confirms and the try shows `short_acknowledged` → AC-8
- [ ] With the clock at 11:00 Cairo, record `no_answer` by call → Later shows it due 14:00; at 14:00 again → due the next working day at 18:00; then again → cancelled `no_answer`, and the `closing` template is offered → AC-9, AC-10
- [ ] Two `message_sent` and one `no_answer` by call → the order is still open; a `no_answer` on WhatsApp inside the reply wait → refused, asking to wait or call → AC-8, AC-10
- [ ] Record `no_answer` at 21:30 → next try at the next opening; enter an Eid exception in `operations.working_hours` → a try falling on it moves to the day after → AC-9
- [ ] Record `callback_requested` for 18:00 → at 18:00 it sits first in Due now with "Promised 18:00", above older orders → AC-2, AC-8
- [ ] Record `fake` with `confirmed_fake` on a linked customer → cancelled `fake`, the customer page shows the `fake` flag with reason `confirmed_fake`; with `denies_ordering` → cancelled, no flag → AC-8
- [ ] Find by phone a customer whose order closed by no answer yesterday → it shows under recently closed with Reopen; reopen → a new order linked `reopened_from` → AC-29
- [ ] Confirm an order from its order page instead → it leaves the queue, its try state says `superseded` → AC-11
- [ ] Do all of the above in Arabic and in English, on a 360 pixel wide phone, and by keyboard alone on a desk (arrows between cards, Enter, toolbar, focus moves to the next card) → AC-26

Milestone 2:

- [ ] An M at 21:00 and an L at 21:10 on one phone, the second with an office address → "Possible duplicate" shows both side by side; the merge dialog preselects the L and the newer address; merge → one order with the L and the office address, the other cancelled `duplicate` naming it, one edit, and `/audit` shows `order.duplicates_merged` → AC-12, AC-13
- [ ] A group where only the newer order is prepaid → the prepaid one is preselected as kept; a group with two prepaid orders → refused with the prepaid message → AC-13
- [ ] Take a line from an order of the other store → refused `MERGE_OTHER_STORE`; cancelling that duplicate alone works → AC-13
- [ ] On a Shopify order whose checkout chose Giza → the first suggestion is Giza and its city; on a returning customer her last delivered area follows; pick one, leave the zone empty, confirm → governorate and city saved, `order.edited` with reason `address_fix` → AC-14, AC-15
- [ ] Choose a zone → it is also appended to the courier note → AC-15
- [ ] With `confirmation.require_area` at `governorate_city`, confirm an editable order with no city → refused, asking for the area → AC-8
- [ ] Replace an M with an L from the card → the new line shows, "Tell the customer the new amount" appears, the WhatsApp message carries the new amount → AC-16

Milestone 3:

- [ ] On the Shopify fixture server with the three steps on, confirm an order → the Shopify order gets the confirmed tag → AC-27
- [ ] Change a size and fix an address → the commands sync; the Shopify fixture order shows the new line, the address, the city, and Shopify's province code (never a Bosta name); a governorate with no province code fails the command with `PROVINCE_UNMAPPED` in words → AC-18
- [ ] Merge a duplicate Shopify order → a `shopify.order_cancel` command syncs with the duplicate reason → AC-13, AC-18
- [ ] With the cancel step off, record `fake` on a Shopify order → Held shows "Cancel in Shopify"; replay the channel cancel → it leaves Held → AC-8, AC-11
- [ ] **Pilot acceptance run:** force a rejection on a size change of a confirmed order → the card and Held show "Edit not synced, hold" with the provider code; the Shopify order has the held tag and no confirmed tag, so it is missing from the Shopify view "confirmed and not held"; as a warehouse person open `/orders/to-pack` → the order sits at the top under "Edit not synced, hold: do not pack"; try Pack → refused `WRITE_BACK_OPEN`; operations sends the day's orders to Bosta from the Shopify view and the held order is not among them; undo the edit → the read back restores the Shopify line, the hold clears, and the tags flip back to confirmed → AC-19, AC-27
- [ ] Force a failure of the tag command itself → a `sync.write_back_failed` task opens and the order is not held by it → AC-19, AC-27
- [ ] Print the to pack list → one A4 page per 30 orders, held section first → AC-19
- [ ] The runbook `docs/runbooks/confirmation-and-sending-to-bosta.md` exists and states the operating rule of AC-27 → AC-27

Milestone 4:

- [ ] After a `message_sent` on line 2, open My work as the agent of line 2 at the reply wait's end → the `confirmation.callback` task is hers; after a call with no answer it sits in the support pool; its row opens the card; recording `confirmed` closes it → AC-17
- [ ] An unconfirmed order with a Bosta delivery → "Bosta already has this parcel: any change you make here must also be made in Bosta", edits still allowed; confirm it → line and shipping edits now refused with the Bosta app instruction; the current tracking number shows → AC-20
- [ ] Fire `CarrierRecordStale` with `receiver_address` and `receiver_phone`, both `merchant` fixable, `editedBy` you → your card shows "Change it in the Bosta app now: address, phone" at once and the order is held; after 30 minutes the `carrier.record_stale` task is with operations; fire the cleared event with `fixOutcome` `updated` → no reconfirmation, the hold clears → AC-19, AC-21
- [ ] Fire `CarrierRecordStale` with `fixableBy` `nobody` → the banner says operations decides to cancel or deliver as is; fire the cleared event with `cannot_update` after a `cod` mismatch → the order enters Reconfirm listing "amount to collect" with both amounts in the script; `reconfirmed` records the accepted amount → AC-21
- [ ] A `cod` mismatch with `origin` `at_creation` → reconfirmed like any other, the card saying "Bosta's amount differed from the start" → AC-21
- [ ] A stale with only `receiver_phone`, cleared `cannot_update` → the script has no money or pieces line and shows no phone value → AC-21
- [ ] A cleared event with reason `order_matches` and a null `fixOutcome` while a reconfirmation is open → it closes `cleared_by_carrier` → AC-21
- [ ] Three counted no answers on a reconfirmation → the task moves to the manager hat and the order is not cancelled → AC-21
- [ ] On a flagged customer, send the `deposit_request` template (it states the refusal rule), record `awaiting_transfer` → Later shows the deadline; past it the card is back in Due now marked "Deposit not received"; cancel with `deposit_not_paid` → AC-8, AC-22
- [ ] On an internal store order of 1,000.00 plus 50.00, record a 50.00 InstaPay deposit with its reference → shipping prepaid 50.00, COD expected 1,000.00, "Deposit claimed, not yet checked", `order.deposit_recorded` on `/audit`; as operations, check it from "Deposits to check" → the stamp shows → AC-22, AC-23
- [ ] Try the deposit on a Shopify order → refused, "record it in Shopify; it will sync" → AC-22
- [ ] Cancel the internal store deposit order → the button named "50.00 InstaPay is owed back"; a `refund.unrecorded_payout` task opens for operations; cancelling a card prepaid Shopify order shows "This cancels and refunds 2,000.00 to the card" before the press → AC-8, AC-31
- [ ] The today strip and `/api/confirmation/metrics` for a seeded week match a hand count of confirmed (including one confirmed on the order page), cancelled by reason, closed, fake, duplicate (left out of the rate), confirm rate, and median time to confirm in clock and working minutes → AC-24

## Commands

- [ ] `pnpm --filter @ssdashboard/contracts test` → `nextCallbackAt` across working hours, exceptions, the other part of the day rule, and the Cairo daylight saving change; `renderConfirmationMessage` (payment line, the three templates) and `waMeUrl` (digits without `+`, URL encoding of Arabic); the allocation with a shipping deposit (the D2 examples) → AC-5, AC-9, AC-23
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → the append only trigger on `confirmation_attempts` refuses `UPDATE` and `DELETE`; the checks on both confirmation tables and the new `orders` columns; enum parity; the tenancy test → AC-7, AC-22
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/confirmation.e2e-spec.ts` → every row of the outcome table, the counting rule and the close at `N`, `attemptKey` replay and conflict, two agents at once, `superseded`, find by phone, merge with its locks and choices, undo edit, the tag state push → AC-7 to AC-13, AC-19, AC-27, AC-29
- [ ] `pnpm --filter @ssdashboard/api exec vitest run --config ./vitest.config.e2e.ts test/access-sweep.e2e-spec.ts` → every new route has its fixture and permission; a warehouse hat gets 403 on `/api/confirmation/*` → AC-25
- [ ] `pnpm --filter @ssdashboard/api test` → `requires-module.spec.ts`, `audience.spec.ts`, `permission.spec.ts`, `module-boundary.spec.ts`, the single writer test of the confirmation tables, and a log sentinel test (a phone, an address, and a deposit reference appear in no log line, event, attempt row, or task) → AC-25
- [ ] `pnpm --filter @ssdashboard/web test:e2e -- e2e/confirmation.spec.ts --project=desktop` and the phone project → the queue in both languages, keyboard only, axe clean → AC-26
- [ ] `pnpm lint` and `pnpm typecheck` → green, TSDoc on every export
