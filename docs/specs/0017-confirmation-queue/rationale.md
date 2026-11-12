# 0017. Confirmation queue: decision record

The reasoning behind [index.md](index.md). `/develop` builds from the index; this file says why.

## Context

> Premise note: the scope row says confirmed orders "move on to fulfillment" and the address is "fixed into the carrier's governorate, city, and zone", but in mirror mode the app never talks to Bosta: the Bosta Shopify app creates the delivery from the Shopify order ([spec 0007](../0007-stack-architecture-operations-layer/index.md), "What mirror mode cannot do"), and it does so either automatically on order creation or when someone presses "Deliver with Bosta" by hand (lane D's research for spec 0018; the domain review's C1). So the queue's result reaches the courier only through the Shopify order: its confirmed and held state as tags, its edits as write backs, and only if they land before the delivery is made. The first owner question (Q-18.1: send by hand after confirmation, or keep the automatic sync) decides whether confirmation edits are routine or exceptions, and must be answered before milestone 2.

Confirmation is where a cash on delivery brand decides its returned to origin rate. The simulated brand of the [owner debate](../../positioning/2026-11-05-brand-owner-debate.md) ships 120 orders a day in season with 22 percent returned to origin and called the confirmation queue "where the 22 percent is decided"; the reference brand has no confirmation in its system at all, so the decision is made "in WhatsApp on personal phones and in Sheets, invisible to the owner" ([reference brand notes](../../positioning/2026-11-05-reference-brand-notes.md), section 7). The pilot's acceptance is "one full week of real confirmations in the app with no spreadsheet" ([scope, slice 1a](../../scope/confirmation-to-cash.md)), and the independent audit of 2026-11-11, section 4, item 1, ranks this feature first among what is missing for a first sale.

Several built and parallel pieces constrain the shape. Orders is the only writer of orders and already has `confirm`, `cancel`, `edit`, the write back hold, and the duplicate cancel with its target ([spec 0013](../0013-orders-state-machines/index.md)); customers by phone gives one customer per phone, briefs, and the returner signal ([spec 0014](../0014-customers-by-phone/index.md)); the Shopify connector shapes the `shopify.order_edit` and `shopify.order_cancel` commands and leaves their executors to this feature ([spec 0015](../0015-shopify-connector/index.md)); the settings spec already names this feature's capability `orders.confirmation_queue` and its two executing steps ([spec 0009](../0009-settings-toggles-bundles/index.md)). Tasks ([spec 0016](../0016-tasks-my-work-inbox/index.md)) and the Bosta mirror (spec 0018, feature 19, lane D, in progress) are designed at the same time, so this feature must start without either and plug into both.

Carried requirements: B2 (an order with an unsynced confirmation edit cannot be packed) and n1 (in slice 1a the queue and the warehouse's list show "edit not synced, hold"; the pilot includes one deliberately failed write back caught before pickup) from the [stack domain review](../../reviews/domain-stack.md); D2 (the prepaid share of a piece that never reaches the customer, and the purpose of a shipping deposit on a refusal) from the [data model build re-read](../../reviews/domain-data-model.md#build-re-read-2026-11-06); m4 (warn when the same phone has another open order) from the [orders domain review](../../reviews/domain-orders.md); and the independent audit's section 4, item 9 (a confirmation edit after Bosta created the delivery leaves the wrong COD at the door), split with feature 19. Constraints: a team of about four, Arabic first, used on a phone beside WhatsApp, personal data under Law 151, Cairo time with daylight saving.

## Options considered

### Option 1: A view over `new` orders, with an orders owned try state and attempt log, and tasks only for timed work (chosen)

The queue reads `orders` in state `new` left joined to a small `order_confirmations` row (next try time, counts, claim) and keeps every outcome in an append only `confirmation_attempts` table, both owned by the orders module beside the order. An outcome calls the existing order moves in one order transaction. Tasks are opened through spec 0016 only for a scheduled callback and for a reconfirmation, as a projection of the row.

**Pros**:
- Every new order is in the queue the moment it exists, with no row, job, or task needed first; the queue works from milestone 1, before tasks or Bosta exist.
- Oldest first and grouping by customer are one indexed read over orders (`orders_fulfillment_placed_idx` already exists).
- The outcome history is permanent and complete, which the confirm rate, time to confirm, and the agent figures need.
- The outcome, the order move, and the task commit together in the transaction spec 0013 already provides.

**Cons**:
- A callback is described twice once tasks exist (the row and the task); the projection must be kept exact.
- Two more tables in the orders module.

### Option 2: The queue as a list of tasks

Every new order opens a `confirmation.call` task; the queue is the support hat's task list filtered to that type; no answers are counted from closed tasks, as spec 0002's tasks section first suggested.

**Pros**:
- One list for all work; overdue highlighting and assignment come from the tasks module.
- No confirmation tables.

**Cons**:
- First sale would wait on spec 0016 being built, and an order whose task failed to open would be invisible.
- With one dedupe key per order the task is rescheduled, not reopened, so counting closed tasks gives 1, not 3; with a new task per try the list fills with closed rows and the count breaks whenever a task is cancelled or reassigned.
- Grouping by customer and oldest first would be rebuilt on the task table, which holds neither the phone nor the placed time.

### Option 3: A separate `confirmation` module owning its own tables

The queue lives in its own api module that reads orders through `OrderQueries` and moves them through the exported moves.

**Pros**:
- A clean toggle boundary of its own.
- The orders module stays smaller.

**Cons**:
- The queue's main read joins order state with try state on every page; across a module wall that becomes two reads and an in memory join, or a projection of order state into the new module.
- Spec 0009 already places the queue as the capability `orders.confirmation_queue` inside the core `orders` module (its AC-8 example), so this would change a ratified registry row.

### Option 4: A spreadsheet like grid with free text notes

A table of new orders where the agent types a status and a note per row, closest to what the brand does today.

**Pros**:
- Familiar; fastest to build.

**Cons**:
- Free text notes about customers are personal data kept for ever, and no metric can be computed from them.
- No callback rule, no automatic close, no hold: the spreadsheet's failures move into the app.

## Rationale

Option 1 is the only one that lets the pilot's acceptance week start before tasks and Bosta are built, which matters because the audit puts slice 1a about one fifth built with a mid March 2027 pilot. It also follows how the project already models history: state moves are `order_events`, not audit rows, and stock moves are an append only ledger; confirmation tries are the same kind of fact and belong in an append only log next to the order. The task projection is kept because the support agent's whole day should be one My work list (spec 0016), but the queue never reads it, so a bug there cannot hide an order.

The callback rule (a second try three hours later, a third the next working day, then close) is fixed rather than freely configurable because "three no answers closes" (final plan 7.1) is only fair if the tries are spread: three calls in ten minutes would close real orders. The two knobs spec 0009 deferred to this feature (D19: the attempt count and the duplicate window) are settings; the shape of the spread is code, in one pure function the screen also uses to preview the next try.

The WhatsApp deep link is built in the browser because the message holds the customer's name and address: sending it through the api would put personal data in a request the api must then never log, for no gain. The link format is WhatsApp's documented click to chat form (References).

Duplicates merge by cancelling the extra orders with the `duplicate` reason and its target, because spec 0013 already defines that cancel, its two order lock, and its Shopify command; the merge only adds the lines and the multi order lock. Keeping the oldest order by default keeps the campaign of the first visit, which the media buyer counts (domain review M7 of the orders review is the same concern for reopened orders).

The carrier area list is spec 0018's (lane D owns the Bosta connector and loads the list from Bosta's v2 city, zone, and district reads, with an operator import as the fallback), so this spec reads it through that service and owns no area table. Governorate and city are required and the zone is optional, because a Shopify address has no zone field and the courier sees the zone only in the courier note (domain review M3).

The confirmed and held tags (domain review C1) are a state push, computed from the order at execution time like the stock push of spec 0015, rather than an add or remove per event: commands run one at a time and may fail independently, and a state push converges to the right pair of tags whatever order the commands ran in. Tag commands are left out of the hold itself, or a waiting tag command would hold the order it is trying to mark.

A WhatsApp message is not a call (domain review M1): the desk sends messages and waits for replies, so `message_sent` waits without using a try, and only a call or an expired wait counts toward the close. The callback after a WhatsApp try goes to the agent whose phone holds the thread, because that is where the reply arrives.

For D2, the deposit is allocated to shipping first because the review's worked example shows the gross share rule opens a false 23.81 shortfall on a partial delivery; keeping it as the refused delivery fee is the usual reason a brand asks for one (the review's own note), but whether Egyptian consumer law allows it is not known, so the pilot runs with `released` and switches only on the brand's lawyer's yes (Q-18.3, the same question as spec 0019 Q-21.12). Keeping it then needs evidence that the customer was told before she paid, so the disclosure is recorded on the order (spec 0019 review M9); a `wa.me` link can prove only that the agent opened the prefilled text, so the agent's `message_sent` is the record that it was sent, and no message body is kept. The prepaid share of a piece that never arrives is owed back by the same tender because spec 0002 already decided refunds go back the way the customer paid (owner question 13 there).

## References

**Project sources** (verifiable, in this repo):
- `AGENTS.md` (modules talk through exported services; append only history; Law 151; logical CSS and one `<h1>`)
- [spec 0013](../0013-orders-state-machines/index.md) AC-7 to AC-12, AC-21, AC-22, *Write paths*, Follow-up for feature 18
- [spec 0014](../0014-customers-by-phone/index.md) *Exported service*, Follow-up for feature 18
- [spec 0015](../0015-shopify-connector/index.md) *Outbound commands*, AC-23, AC-24
- [spec 0009](../0009-settings-toggles-bundles/index.md) the capability `orders.confirmation_queue`, the executing steps, Follow-up D19 and D10
- [spec 0016](../0016-tasks-my-work-inbox/index.md) *Interface for other modules*, *Working hours*, `refund.unrecorded_payout`
- [domain review of this spec](../../reviews/domain-confirmation-queue.md) (C1, M1 to M6, m1 to m12), folded in on 2026-11-12
- Spec 0018 (feature 19, lane D, in progress): the carrier area list, the "carrier record stale" flag, and the Bosta app triggers (lane D's research notes, Q7 and Q8)
- [spec 0002](../0002-core-data-model/index.md) Follow-up for features 18 and 21 (D2); the customers, credit, and tasks child (tenders, refunds by the same tender, counting attempts)
- [spec 0007](../0007-stack-architecture-operations-layer/index.md) section 1 (outbound failures, mirror mode) and *Carried from the domain review* (B2)
- [domain-stack review](../../reviews/domain-stack.md) B2 and n1; [domain-data-model review](../../reviews/domain-data-model.md#build-re-read-2026-11-06) D2; [domain-orders review](../../reviews/domain-orders.md) m4 and X1
- [final plan](../../positioning/2026-11-05-egypt-order-operations-layer.md) section 7.1; [owner debate](../../positioning/2026-11-05-brand-owner-debate.md); [reference brand notes](../../positioning/2026-11-05-reference-brand-notes.md)
- Code read: `apps/api/src/orders/transitions/order-transitions.service.ts` (`confirm`, `cancel` with `duplicateOfOrderId`), `apps/api/src/connectors/connectors.service.ts` (`writeBackAvailable` answers false until an executor registers), `apps/api/src/connectors/shopify/order-mapper.ts` (the Shopify address is joined into one text with its city and province), `packages/contracts/src/orders/order-api.ts` (`OrderAreaCodes`), `packages/contracts/src/orders/order-reasons.ts` (`CancelReasonCode`), `apps/api/src/customers/flags/customer-flags.service.ts` (`CustomerFlags.set` opens its own transaction), `packages/contracts/src/customers/customer-reason-codes.ts` (`confirmed_fake`)
- The independent audit of 2026-11-11, section 4, items 1 and 9 (cited in text, not linked)

**Practices & standards**:
- Append only history for business facts; idempotency keys on every press that changes data; a projection written in the same transaction as its source
- WCAG 2.2 SC 2.1.4 (character key shortcuts) and SC 2.5.8 (target size minimum)

**Links** (opened during this task):
- WhatsApp Help Center, "How to use click to chat": https://faq.whatsapp.com/5913398998672934 (the `https://wa.me/<number>?text=<urlencoded text>` form, full international number with no zeros, brackets, or dashes)
- Bosta area or zone API: none verified by this lane (a search found no Bosta developer page); lane D's research for spec 0018 found the v2 city, zone, and district reads, and spec 0018 cites them
