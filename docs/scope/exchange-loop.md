# Slice 1b: the exchange loop

Target about month five. One gate for every exchange and return, one tap for the agent, and everything after it automatic: approval, Bosta shipment with cash either way, pick, restock, Shopify update, and credit entries. [Back to the scope](index.md).

**Slice done when:** a real customer on a real Shopify order exchanges a 500 piece for an 800 piece through the portal with no agent touching it, pays 300 to the Bosta courier, the returned piece is restocked by scan, both documents appear in the accounting export, and one transfer with a discrepancy has been recorded.

### 28. Customer credit ledger · GA · needs a decision
The single engine for exchanges, refunds, store credit, and retention bonuses, append only like the stock ledger.
**Done when:** a return credits the price actually paid for the line after discounts; an exchange is an ordinary new sale that consumes credit; a balance due is collected and a leftover is refunded by the original method or kept as store credit; every entry has a reason and an actor; nothing is edited or deleted.
- [ ] Design it (spec): `/architect customer credit ledger`

### 29. Exchange & return portal · GA · needs a decision
The public gate a customer reaches from a WhatsApp link, the Shopify order page, or an agent acting for them, identified by phone plus any order id, with no customer account.
**Done when:** a customer picks eligible lines and a reason (photos required for damaged or wrong items), then picks an outcome: another variant of the same product with live warehouse stock first, any product with the price difference, a refund by an allowed method, or wait for stock with an expected date; it works in Arabic on a phone; it shows nothing about anyone else's orders.
Also from spec 0007: phone plus order number resolves across the brand's stores (asks which store when two match); Turnstile for the pilot, with a server side challenge plus rate limits designed as the fallback.
- [ ] Design it (spec): `/architect exchange & return portal`

### 30. Privacy notice & consumer terms · needs a decision
The notices the public portal and the brand's data handling need under Egyptian law, with GDPR only for brands selling to Europe.
**Done when:** the portal links a privacy notice and the return terms in both languages, written against Law 151 of 2020 (brand as controller, vendor as processor, data kept in Egypt) and Law 181 of 2018 (return right, price display).
- [ ] Design it (spec): `/architect privacy notice & consumer terms`

### 31. Approval rules & review desk · GA · needs a decision
Rules decide which requests approve themselves; a desk shows the rest to a person.
**Done when:** clean size swaps approve automatically when the brand switches that on; damage claims, large price differences, and repeat returners go to the review desk; each decision records who or which rule made it; credit timing follows the brand's policy (at approval for clean swaps, after inspection for the rest).
- [ ] Design it (spec): `/architect approval rules & review desk`

### 32. Bosta driver mode · GA · needs a decision
Create shipments ourselves, switched on per brand and per shipment type: exchange shipments with the cash difference either way, and return pickups with a cash refund.
**Done when:** an approved exchange creates a Bosta exchange shipment with the right amount and a label; a COD refund creates a return pickup with the amount and deducts it from the settlement as a negative line; a brand with driver mode off still works through mirror mode; recorded fixtures replay green with no live call.
- [ ] Design it (spec): `/architect bosta driver mode`

### 33. Pick, pack & ship · needs a decision
Pick by scan, pack, and hand over to the carrier, for exchange replacements first and every confirmed order after.
**Done when:** a pick task lists the pieces and locations, each pick is confirmed by scan, a wrong scan is refused, packing records the parcel, and the order moves to packed and shipped with the stock movement written.
- [ ] Design it (spec): `/architect pick, pack & ship`

### 34. Exchange execution & inspection · GA · needs a decision
Everything between approval and close, including the edge states real customers create.
**Done when:** an exchange id groups the return, the new sale, the shipment, the credit entries, the inspection, and the settlement line; the replacement is reserved; the returned piece is inspected by scan and restocked or written off with reason and cost; refused at the door, old piece never collected ("customer owes"), and inspection rejection after shipping each follow the brand's policy knobs; the exchange cost posts against the original sale; nothing is edited or deleted.
- [ ] Design it (spec): `/architect exchange execution & inspection`

### 35. Refunds by original method · GA · needs a decision
Money goes back the way it came: Bosta return pickup for COD, the gateway through Shopify for cards and wallets, a finance task for InstaPay or manual transfers.
**Done when:** each refund moves through requested, approved, in transit or sent, confirmed; COD refunds ride the Bosta return pickup; gateway refunds fire through Shopify and record the reference; manual refunds open a finance task closed by uploading proof; refunds owed show on the dashboard.
- [ ] Design it (spec): `/architect refunds by original method`

### 36. Retention step · GA · needs a decision
A refund request may open a retention task by policy, in parallel; the refund never waits.
**Done when:** until the cutoff (carrier pickup created or gateway refund fired) the task can convert the refund to an exchange or to store credit with a bonus up to the policy limit, recorded as its own credit entry with reason and agent; after the cutoff it closes as "too late".
- [ ] Design it (spec): `/architect retention step`

### 37. Shopify returns & exchange write back · GA · needs a decision
Shopify stays the truth for the storefront: returns and exchanges done here are recorded there.
**Done when:** a completed return or exchange appears on the Shopify order (or as a linked replacement order where Shopify cannot express the price difference), the brand can switch write back off, and recorded fixtures replay green with no live call.
- [ ] Design it (spec): `/architect shopify returns & exchange write back`

### 38. Minimal transfers · GA · needs a decision
Move stock between locations so partner handovers and returns keep stock true: scan out, in transit, scan in, discrepancy.
**Done when:** a transfer scans out of one location and into another, stock shows in transit between them, a short or extra scan records a discrepancy with a reason, and every step writes ledger movements.
Also from spec 0011: the thinnest part already lands in feature 11 (slice 1a): numbered send to and return from a partner location at average cost (`stock_transfers`, `TR-` numbers), with no transit, scanning, or discrepancy. This feature builds transit and scanning on that record.
- [ ] Design it (spec): `/architect minimal transfers`

### 39. Exchange dashboard · needs a decision
What the exchange loop is costing and where it is stuck, on the manager's phone.
**Done when:** it shows exchanges by state with the stuck ones flagged, exchange cost by product and size, and refunds owed, using the metric dictionary's definitions.
- [ ] Design it (spec): `/architect exchange dashboard`
