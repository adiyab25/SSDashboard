# Slice 1a: confirmation to cash

The walking skeleton, target about month three: a real Shopify order confirmed in the app, shipped with Bosta in mirror mode, its failures handled, and its cash reconciled, then reported to the owner's phone. The pilot starts right after this slice. [Back to the scope](index.md).

**Slice done when:** the brand runs one full week of real confirmations in the app with no spreadsheet, every returned to origin piece of that week is restocked by scan with both shipping legs on its order, and one month of the real Bosta settlement is matched line by line including refunds, negative lines, and at least one partial delivery, with unmatched lines listed.

### 11. Stock ledger & locations · GA
The single writer of stock movements, and the locations it moves stock between. Locations carry an owner type (own warehouse or shop, consignment partner, wholesale customer) and a sellable online flag; only the warehouse sells online. Bins stay flat for now.
**Done when:** every stock change is a new movement with quantity, unit cost, location, and source document; a correction is a new movement, never an edit; partner stock is never offered online; on hand per variant and location reads fast at 50,000 SKUs.
Also from spec 0011: a thin slice of features 38 and 41 comes forward (owner decision Q-11.6): a minimal consignment partner record and numbered send to and return from a showroom, so partner stock leaves the online count from the first move.
- [x] Design it (spec): `/architect stock ledger & locations`
- [ ] Build it: `/develop stock ledger & locations`
  - [x] The gated online location and the online stock read
  - [ ] Reservations, waiting demand, carrier shipments, and catalog locks
  - [ ] Partners, owner type screens, and showroom moves
  - [ ] Adjustments, adjustment requests, and the receipt cost rule
  - [ ] Discrepancies a manager can act on, and the scale budgets
- [ ] Verify it: `/check verify stock ledger & locations`
- [ ] Test it: `/test stock ledger & locations`
- [ ] Review it (fresh model): `/check review stock ledger & locations`
- [ ] Document it: `/document stock ledger & locations`
Spec [0011](../specs/0011-stock-ledger-locations/index.md) (Accepted 2026-11-07; domain review [domain-stock-ledger](../reviews/domain-stock-ledger.md): accept with changes, folded in)

### 12. Catalog, styles & variants
Products as the brand thinks of them: style, season, product group, and variants by size and color, mostly arriving from Shopify, searchable at warehouse scale.
**Done when:** staff can find any variant by name, SKU, or barcode in Arabic or English in well under a second at 10,000 SKUs (tested at 50,000), see its style, season, and group, and every variant inherits its style's cost unless overridden.
- [x] Design it (spec): `/architect catalog, styles & variants`
- [ ] Build it: `/develop catalog, styles & variants`
  - [x] Arabic and English search through every layer
  - [x] Seasons, product groups, and styles
  - [x] Inherited cost, visible and recordable
  - [ ] The channel upsert contract
- [ ] Verify it: `/check verify catalog, styles & variants`
- [ ] Test it: `/test catalog, styles & variants`
Spec [0012](../specs/0012-catalog-styles-variants/index.md) (Accepted 2026-11-07)

### 13. Shopify connector · GA
The reference connector that sets the pattern for every channel: orders, products, and customers from one or several stores of one brand, by webhooks plus a scheduled backfill, with stock pushed back to Shopify.
**Done when:** webhooks are signature verified, a backfill catches anything missed, order edit pairs (a positive and a negative line of the same order, variant, day, and value) are netted before anything counts them, stock pushes never echo back as changes, each field has one owner, rate limits hold, and recorded fixtures replay green with no live call.
Also from spec 0007: one store per Shopify connection, order numbers unique per store and shown with the store everywhere; a failed write back opens a task and blocks packing that order.
Also from spec 0009 (owner rulings 2026-11-08): this feature builds stock out from Shopify fulfillment (`connectors.shopify.fulfillment_stock_out`) as a task of spec 0015, the Warehouse only stock out source the stock push waits for; and before go live the gift tag pattern (`shopify_gift_tags`) is compared with the pilot brand's real Shopify tags ("Accept, check with brand").
- [x] Design it (spec): `/architect shopify connector`
- [ ] Build it: `/develop shopify connector`
  - [ ] Recorded fixtures and one order through a signed webhook (tasks 2 to 7 built 2026-11-08 on synthetic fixtures: one order through a signed webhook works; task 1, recording from a Shopify development store, waits for the store)
  - [ ] Catalog, orders in full, go live, backfill, the sweep, and stock out from Shopify fulfillment (owner ruling 2026-11-08) (tasks 9 to 12 built: orders in full and customer webhooks 2026-11-08, edit netting, exchange by edit, and the sync jobs 2026-11-09; task 8 products waits for spec 0012's catalog sync and task 9a for spec 0013's stock out)
  - [ ] The outbound door and the stock push
  - [ ] The connection screen, health, and the runbook
  - [ ] Stock out from Shopify fulfillment, the Warehouse only stock out source (spec 0015 task; owner ruling 2026-11-08)
  - [ ] Check the gift tag pattern against the pilot brand's real Shopify tags before go live (owner: "Accept, check with brand")
  - [ ] Re-record fixtures from a Shopify dev store (owner ruling 2026-11-07: the fixtures are synthetic until then, written to the shopify.dev shapes of the pinned API version; this feature is not done until this box is ticked)
- [ ] Verify it: `/check verify shopify connector`
- [ ] Test it: `/test shopify connector`
- [ ] Review it (fresh model): `/check review shopify connector`
- [ ] Document it: `/document shopify connector`
Spec [0015](../specs/0015-shopify-connector/index.md) (Accepted 2026-11-07; domain review [domain-shopify-connector](../reviews/domain-shopify-connector.md): accept with changes, folded in)

### 14. Customers by phone
One customer record keyed on a normalized Egyptian phone number, holding many phones and channel ids, with merge as routine daily work and one timeline per customer.
**Done when:** 010, 0010, +2010, and Arabic digit forms normalize to one number; one customer holds several phones and Shopify ids across stores; merge is a fast audited screen that can be undone; a repeat returner flag shows on the record; the timeline reads the same records through each role's lens.
- [x] Design it (spec): `/architect customers by phone`
- [x] Build it: `/develop customers by phone`
  - [x] One phone, one customer, end to end
  - [x] Merge and undo as daily work
  - [x] The repeat returner flag
  - [x] One timeline through each lens
- [x] Verify it: `/check verify customers by phone`
- [x] Test it: `/test customers by phone`
Spec [0014](../specs/0014-customers-by-phone/index.md) (Accepted 2026-11-07)

### 15. Onboarding imports · GA · needs a decision
Day one data from the brand's spreadsheets: a stock snapshot per location, cost per style and season from factory invoices, customers, and the existing blacklist.
**Done when:** each import previews before it applies and lists rejected rows with reasons; the brand verifies the stock snapshot, after which the ledger takes over; imported cost lands per style and season; the blacklist sets the repeat returner flag.
- [ ] Design it (spec): `/architect onboarding imports`

### 16. Orders & their state machines · GA
The order at the heart of cash on delivery: a fulfillment state machine, a cash state machine, its store, channel, and source, its type, and one derived outcome.
**Done when:** fulfillment moves through new, confirmed, packed, shipped, delivered, partially delivered, failed attempt, returned to origin, exchanged, refused; cash moves through unpaid, collected by carrier, remitted, reconciled, with the COD fee and shipping fee as their own lines and partial amounts allowed; gifted orders stay out of revenue and return rates; the order is editable until pickup is created, with every edit audited.
- [x] Design it (spec): `/architect orders & their state machines`
- [ ] Build it: `/develop orders & their state machines`
  - [x] One manual order through every layer
  - [x] Editing, confirming, cancelling, packing, and the hold
  - [x] The channel intake contract for feature 13
  - [ ] Stock: holds at creation, short lines, and carrier shipments
  - [ ] Carrier and cash moves, the shipment posting, and scale
- [ ] Verify it: `/check verify orders & their state machines`
- [ ] Test it: `/test orders & their state machines`
- [ ] Review it (fresh model): `/check review orders & their state machines`
- [ ] Document it: `/document orders & their state machines`
Spec [0013](../specs/0013-orders-state-machines/index.md) (Accepted 2026-11-07; domain review [domain-orders](../reviews/domain-orders.md): accept with changes, folded in)

### 17. Tasks & My work inbox · needs a decision
One task primitive (type, linked record, owner, due time, outcome code) that every process creates as it moves, and one inbox that shows each person their work.
**Done when:** a process can open, assign, and close tasks with an outcome code; each person's "My work" shows their tasks filtered by permission and sorted by due time; overdue tasks stand out; there is no workflow designer.
- [ ] Design it (spec): `/architect tasks & my work inbox`

### 18. Confirmation queue · GA · needs a decision
Where support confirms every order before it ships: oldest first, grouped by phone, with a WhatsApp deep link, outcome codes, callbacks, address zones, and edits written back to Shopify.
**Done when:** an agent opens WhatsApp with a prefilled message or calls, records one outcome (confirmed, no answer with an automatic callback, call back at a time, cancelled with reason, duplicate, fake); three no answers close the order; duplicates merge in one tap and cancel on Shopify with a reason; the address is fixed into the carrier's governorate, city, and zone with suggestions from past orders; size changes and added pieces write back to Shopify; confirmed orders move on to fulfillment.
The spec must answer the prepaid share of a piece that never reaches the customer, and what a shipping deposit is for on a refusal ([domain review, build re-read 2026-11-06](../reviews/domain-data-model.md#build-re-read-2026-11-06), D2).
- [ ] Design it (spec): `/architect confirmation queue`

### 19. Bosta connector, mirror mode · GA
Read the deliveries the carrier's own Shopify app created, with their states, fees, and cash cycles, without executing anything.
**Done when:** tracking updates move the order's states; attention rules flag exceptions or holds, stuck at pickup over two days, no movement over three days, the carrier's delayed flag, two or more attempts, and stalled after 48 hours; fees and cash cycle amounts come from the per delivery detail and are never overwritten by a list sync that lacks them; recorded fixtures replay green with no live call.
Also from spec 0007: works with one Bosta account for all stores or one per store; a delivery's store comes from the account's binding, else from its business reference or Shopify store name.
Also from spec 0018: the order stays editable while Bosta reports pickup requested, and a COD difference after a confirmation edit is a stale carrier record with an operations task before support reconfirms (with spec 0017); the connector keeps Bosta's cities, zones, and districts for address fixing.
- [x] Design it (spec): `/architect bosta connector, mirror mode`
- [ ] Build it: `/develop bosta connector, mirror mode`
  - [ ] One delivery from a verified webhook to a moved order (AC-1, AC-2, AC-4 to AC-7, AC-9, AC-13, AC-14, AC-26, AC-27)
  - [ ] Every state, the list pass, the cash cycle sweep, linking, and the wind down (AC-6, AC-8 to AC-19, AC-24, AC-25)
  - [ ] The stale carrier record, attention, and carrier areas (AC-20 to AC-22, AC-28, AC-29, AC-30)
  - [ ] Screens, freshness, and the runbook (AC-2, AC-3, AC-23, AC-27, AC-28)
  - [ ] Record the fixtures from the pilot brand's Read Only key (owner decision Q-19.6: synthetic until then; not done before)
- [ ] Verify it: `/check verify bosta connector, mirror mode`
- [ ] Test it: `/test bosta connector, mirror mode`
- [ ] Review it (fresh model): `/check review bosta connector, mirror mode`
- [ ] Document it: `/document bosta connector, mirror mode`
Spec [0018](../specs/0018-bosta-connector-mirror-mode/index.md) (Proposed 2026-11-12; owner decisions Q-19.1 to Q-19.6 taken as recommended, awaiting the owner)

### 20. Barcode scanning · needs a decision
Scan to find a variant and scan to move stock, on a phone camera or a handheld scanner, starting with restock of returned pieces.
**Done when:** a scan finds the variant in under a second, an unknown barcode says so clearly, a restock by scan writes a stock movement, and it works with a phone camera and a keyboard wedge scanner.
- [ ] Design it (spec): `/architect barcode scanning`

### 21. Delivery failures & returned to origin · GA
What happens when the door does not go as planned: failed attempts, returned to origin, partial delivery, and a refusal with a request for another size.
**Done when:** a failed attempt schedules the next try; a returned to origin piece is restocked by scan and both shipping legs post against the order and its campaign; a partial delivery splits the order into delivered and returned lines with the partial cash amount; the returned to origin rate shows by governorate, product, and carrier; every order ends with an outcome.
The spec must answer the prepaid share of a piece that never reaches the customer, and what a shipping deposit is for on a refusal ([domain review, build re-read 2026-11-06](../reviews/domain-data-model.md#build-re-read-2026-11-06), D2).
Also from spec 0019: restock is by tap until feature 20 brings the scan; customer return pickups come back through the same returned parcels, and the pilot does not use Bosta's Exchange type (a swap is a return pickup plus a new order); the warehouse marks each order packed in the app; a lost or damaged parcel opens a claim that settlement matches to Bosta's compensation; an order handed to another courier is followed by hand; the warehouse packs from a pick list that shows the holds.
- [x] Design it (spec): `/architect delivery failures & returned to origin`
- [ ] Build it: `/develop delivery failures & returned to origin`
  - [ ] Every returned parcel from the Bosta event to the shelf, with its charge (AC-8 to AC-11, AC-27, AC-29, AC-30)
  - [ ] Failed attempts, reasons, the next try, and refusals (AC-1 to AC-7, AC-27)
  - [ ] Partial deliveries and the money of pieces that never arrive (AC-12 to AC-15, AC-27)
  - [ ] Every order ends, the rates, and the pick list (AC-16 to AC-18, AC-25, AC-27, AC-31)
  - [ ] Claims, cash differences, the manual courier path, and the runbook (AC-19 to AC-24, AC-26 to AC-28, AC-32)
- [ ] Verify it: `/check verify delivery failures & returned to origin`
- [ ] Test it: `/test delivery failures & returned to origin`
- [ ] Review it (fresh model): `/check review delivery failures & returned to origin`
- [ ] Document it: `/document delivery failures & returned to origin`
Spec [0019](../specs/0019-delivery-failures-returned-to-origin/index.md) (Proposed 2026-11-12, revised the same day for two domain review passes; owner decisions Q-21.1 to Q-21.15 taken as recommended, awaiting the owner)

### 22. Settlement & Bosta reconciliation · GA
The settlement primitive with its first owner, the carrier: Bosta remits cash minus fees and refunds, and every line is matched to an order.
**Done when:** a Bosta settlement file or the per delivery cash cycles import into a carrier settlement account; each line matches an order by tracking number (COD collected, COD fee, shipping fee, refund as a negative line, partial amounts); matched orders become reconciled; unmatched lines list with a reason; period totals agree with the app's own cash state.
Also from spec 0007: cash matching by tracking number and business reference carries the store id onto every settlement line.
Also from spec 0020: the per delivery cash cycles lead and Bosta's sheet adds the wallet's own rows and confirms the rest, never counting a delivery's cash cycle twice; fees are checked against the brand's Bosta rate card; remitted means credited in Bosta's wallet, and the wallet is rolled forward to the bank beside the order's states; a lost parcel's claim is closed by Bosta's compensation; cash differences are decided in feature 21 (spec 0019) and settlement reconciles from them; the month exports as CSV; a refund line, a partial delivery, and prepaid parcels count in the done when only if the pilot month has them, else a recorded fixture proves the path (owner decisions Q-22.8 and Q-22.12; the slice done when wording is the lead's to align); every figure stays provisional until feature 23 closes the period.
- [x] Design it (spec): `/architect settlement & bosta reconciliation`
- [ ] Build it: `/develop settlement & bosta reconciliation`
  - [ ] One cash cycle from the event to a reconciled order (AC-1, AC-2, AC-5, AC-8, AC-10, AC-11, AC-15 to AC-17, AC-22, AC-24 to AC-26, AC-28, AC-35)
  - [ ] Every carrier line, the contract, spec 0019's cash decisions, a person's and bulk actions, and the cash going back (AC-3, AC-4, AC-10, AC-12 to AC-15, AC-17 to AC-19, AC-26, AC-27, AC-30, AC-35, AC-37, AC-38)
  - [ ] Bosta's sheet: mapping, preview, import, one count across both sources, and the day evidence (AC-6 to AC-9, AC-25 to AC-27, AC-33)
  - [ ] Periods, the wallet and the bank, what is missing, the export, the wind down, scale, and one real month matched (AC-20 to AC-24, AC-25, AC-26, AC-28, AC-29, AC-31, AC-32, AC-34)
- [ ] Verify it: `/check verify settlement & bosta reconciliation`
- [ ] Test it: `/test settlement & bosta reconciliation`
- [ ] Review it (fresh model): `/check review settlement & bosta reconciliation`
- [ ] Document it: `/document settlement & bosta reconciliation`
Spec [0020](../specs/0020-settlement-bosta-reconciliation/index.md) (Proposed 2026-11-12, revised the same day for its domain reviews [domain-settlement-reconciliation](../reviews/domain-settlement-reconciliation.md) and [second pass](../reviews/domain-settlement-reconciliation-r2.md); owner decisions Q-22.1 to Q-22.13 taken as recommended, awaiting the owner)

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
Also from spec 0007: a Telegram group is the first channel; WhatsApp group delivery is a later feature once Meta's documentation is checked.
- [ ] Design it (spec): `/architect daily report`

### 26. Deployment, backups & monitoring · GA · needs a decision
One stack per brand, vendor hosted by default in an Egyptian data center with backups kept in Egypt, and the same images for a self hosted install.
**Done when:** a brand's stack deploys from the published images with its own settings, backups run on a schedule and a restore has been rehearsed, health and errors are monitored, and the public webhook endpoint is reachable over HTTPS.
- [ ] Design it (spec): `/architect deployment, backups & monitoring`

### 27. Exit package · GA · needs a decision
The brand's way out, as product rather than contract prose, live from the first pilot day.
**Done when:** a scheduled encrypted export of the database and files lands in storage the brand controls; offline images ship with every release; a self host guide has been followed successfully by someone outside the team; source escrow is arranged.
Also from spec 0007: destinations in order, Google Drive first, then an S3 bucket the brand controls, then a local disk.
- [ ] Design it (spec): `/architect exit package`
