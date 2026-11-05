# Slice 1a: confirmation to cash

The walking skeleton, target about month three: a real Shopify order confirmed in the app, shipped with Bosta in mirror mode, its failures handled, and its cash reconciled, then reported to the owner's phone. The pilot starts right after this slice. [Back to the scope](index.md).

**Slice done when:** the brand runs one full week of real confirmations in the app with no spreadsheet, every returned to origin piece of that week is restocked by scan with both shipping legs on its order, and one month of the real Bosta settlement is matched line by line including refunds, negative lines, and at least one partial delivery, with unmatched lines listed.

### 11. Stock ledger & locations · GA · needs a decision
The single writer of stock movements, and the locations it moves stock between. Locations carry an owner type (own warehouse or shop, consignment partner, wholesale customer) and a sellable online flag; only the warehouse sells online. Bins stay flat for now.
**Done when:** every stock change is a new movement with quantity, unit cost, location, and source document; a correction is a new movement, never an edit; partner stock is never offered online; on hand per variant and location reads fast at 50,000 SKUs.
- [ ] Design it (spec): `/architect stock ledger & locations`

### 12. Catalog, styles & variants · needs a decision
Products as the brand thinks of them: style, season, product group, and variants by size and color, mostly arriving from Shopify, searchable at warehouse scale.
**Done when:** staff can find any variant by name, SKU, or barcode in Arabic or English in well under a second at 10,000 SKUs (tested at 50,000), see its style, season, and group, and every variant inherits its style's cost unless overridden.
- [ ] Design it (spec): `/architect catalog, styles & variants`

### 13. Shopify connector · GA · needs a decision
The reference connector that sets the pattern for every channel: orders, products, and customers from one or several stores of one brand, by webhooks plus a scheduled backfill, with stock pushed back to Shopify.
**Done when:** webhooks are signature verified, a backfill catches anything missed, order edit pairs (a positive and a negative line of the same order, variant, day, and value) are netted before anything counts them, stock pushes never echo back as changes, each field has one owner, rate limits hold, and recorded fixtures replay green with no live call.
- [ ] Design it (spec): `/architect shopify connector`

### 14. Customers by phone · needs a decision
One customer record keyed on a normalized Egyptian phone number, holding many phones and channel ids, with merge as routine daily work and one timeline per customer.
**Done when:** 010, 0010, +2010, and Arabic digit forms normalize to one number; one customer holds several phones and Shopify ids across stores; merge is a fast audited screen that can be undone; a repeat returner flag shows on the record; the timeline reads the same records through each role's lens.
- [ ] Design it (spec): `/architect customers by phone`

### 15. Onboarding imports · GA · needs a decision
Day one data from the brand's spreadsheets: a stock snapshot per location, cost per style and season from factory invoices, customers, and the existing blacklist.
**Done when:** each import previews before it applies and lists rejected rows with reasons; the brand verifies the stock snapshot, after which the ledger takes over; imported cost lands per style and season; the blacklist sets the repeat returner flag.
- [ ] Design it (spec): `/architect onboarding imports`

### 16. Orders & their state machines · GA · needs a decision
The order at the heart of cash on delivery: a fulfillment state machine, a cash state machine, its store, channel, and source, its type, and one derived outcome.
**Done when:** fulfillment moves through new, confirmed, packed, shipped, delivered, partially delivered, failed attempt, returned to origin, exchanged, refused; cash moves through unpaid, collected by carrier, remitted, reconciled, with the COD fee and shipping fee as their own lines and partial amounts allowed; gifted orders stay out of revenue and return rates; the order is editable until pickup is created, with every edit audited.
- [ ] Design it (spec): `/architect orders & their state machines`

### 17. Tasks & My work inbox · needs a decision
One task primitive (type, linked record, owner, due time, outcome code) that every process creates as it moves, and one inbox that shows each person their work.
**Done when:** a process can open, assign, and close tasks with an outcome code; each person's "My work" shows their tasks filtered by permission and sorted by due time; overdue tasks stand out; there is no workflow designer.
- [ ] Design it (spec): `/architect tasks & my work inbox`

### 18. Confirmation queue · GA · needs a decision
Where support confirms every order before it ships: oldest first, grouped by phone, with a WhatsApp deep link, outcome codes, callbacks, address zones, and edits written back to Shopify.
**Done when:** an agent opens WhatsApp with a prefilled message or calls, records one outcome (confirmed, no answer with an automatic callback, call back at a time, cancelled with reason, duplicate, fake); three no answers close the order; duplicates merge in one tap and cancel on Shopify with a reason; the address is fixed into the carrier's governorate, city, and zone with suggestions from past orders; size changes and added pieces write back to Shopify; confirmed orders move on to fulfillment.
- [ ] Design it (spec): `/architect confirmation queue`

### 19. Bosta connector, mirror mode · GA · needs a decision
Read the deliveries the carrier's own Shopify app created, with their states, fees, and cash cycles, without executing anything.
**Done when:** tracking updates move the order's states; attention rules flag exceptions or holds, stuck at pickup over two days, no movement over three days, the carrier's delayed flag, two or more attempts, and stalled after 48 hours; fees and cash cycle amounts come from the per delivery detail and are never overwritten by a list sync that lacks them; recorded fixtures replay green with no live call.
- [ ] Design it (spec): `/architect bosta connector, mirror mode`

### 20. Barcode scanning · needs a decision
Scan to find a variant and scan to move stock, on a phone camera or a handheld scanner, starting with restock of returned pieces.
**Done when:** a scan finds the variant in under a second, an unknown barcode says so clearly, a restock by scan writes a stock movement, and it works with a phone camera and a keyboard wedge scanner.
- [ ] Design it (spec): `/architect barcode scanning`

### 21. Delivery failures & returned to origin · GA · needs a decision
What happens when the door does not go as planned: failed attempts, returned to origin, partial delivery, and a refusal with a request for another size.
**Done when:** a failed attempt schedules the next try; a returned to origin piece is restocked by scan and both shipping legs post against the order and its campaign; a partial delivery splits the order into delivered and returned lines with the partial cash amount; the returned to origin rate shows by governorate, product, and carrier; every order ends with an outcome.
- [ ] Design it (spec): `/architect delivery failures & returned to origin`

### 22. Settlement & Bosta reconciliation · GA · needs a decision
The settlement primitive with its first owner, the carrier: Bosta remits cash minus fees and refunds, and every line is matched to an order.
**Done when:** a Bosta settlement file or the per delivery cash cycles import into a carrier settlement account; each line matches an order by tracking number (COD collected, COD fee, shipping fee, refund as a negative line, partial amounts); matched orders become reconciled; unmatched lines list with a reason; period totals agree with the app's own cash state.
- [ ] Design it (spec): `/architect settlement & bosta reconciliation`

### 23. Period close with evidence · GA · needs a decision
Confirmed data is the only data reports, settlements, and exports use. A channel's date range is confirmed by a person after review, or automatically when the evidence matches exactly.
**Done when:** a range can be confirmed by a person or by matching evidence (the carrier's statement total, a file checksum); re importing into a confirmed range is refused without an admin's written reason; a confirmation is revoked with a reason, never deleted; provisional data shows as provisional everywhere; every automatic action writes a snapshot and undoes in one step.
- [ ] Design it (spec): `/architect period close with evidence`

### 24. Metric dictionary & phone dashboard · needs a decision
Every figure defined once in the model, and the owner's first dashboard designed for a phone in Arabic.
**Done when:** the dashboard shows today's orders, confirmed, shipped, delivered, returned to origin by governorate and product, and cash expected versus remitted; real returns are separated from cancellations and order edits; marketing figures (placed day order value) and cash figures (delivered and remitted) never share a number without saying which; today's numbers are marked live; it reads well on a phone.
- [ ] Design it (spec): `/architect metric dictionary & phone dashboard`

### 25. Daily report · needs a decision
A short morning report to the Telegram or WhatsApp group the owner already reads, built only from confirmed data, as a worker job with no host privileges.
**Done when:** at a fixed Cairo time the report sends yesterday's orders, confirmed, shipped, delivered, returned to origin, cash expected versus remitted, one line per store and per partner, exchanges and refunds owed, plus an automation status line (what synced, what failed, what needs a sign in); a failed send retries and shows up on the dashboard.
- [ ] Design it (spec): `/architect daily report`

### 26. Deployment, backups & monitoring · GA · needs a decision
One stack per brand, vendor hosted by default in an Egyptian data center with backups kept in Egypt, and the same images for a self hosted install.
**Done when:** a brand's stack deploys from the published images with its own settings, backups run on a schedule and a restore has been rehearsed, health and errors are monitored, and the public webhook endpoint is reachable over HTTPS.
- [ ] Design it (spec): `/architect deployment, backups & monitoring`

### 27. Exit package · GA · needs a decision
The brand's way out, as product rather than contract prose, live from the first pilot day.
**Done when:** a scheduled encrypted export of the database and files lands in storage the brand controls; offline images ship with every release; a self host guide has been followed successfully by someone outside the team; source escrow is arranged.
- [ ] Design it (spec): `/architect exit package`
