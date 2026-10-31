# Epic: Sales & fulfillment

Prices, and orders from every channel in one place, reserved, picked, shipped, and returned. Back to [index](index.md).

## Slice 5: Sales & fulfillment

### 49. Prices & price lists · needs a decision
Selling prices per SKU, with separate price lists per channel, showroom, or customer group, and the tax rate each line carries.
**Done when:** every SKU has a base selling price; a price list can override it per channel or showroom; orders and POS sales record the price, discount, and tax amount used at the time of sale, so later price changes never alter past sales.
- [ ] Design it (spec): `/architect prices & price lists`

### 26. Sales orders & stock reservation · needs a decision
One order list for every channel; each order reserves stock so it is never sold twice.
**Done when:** an order can be created by hand or arrive from a channel; it reserves stock at the right location; available stock equals on hand minus reserved everywhere; cancelling releases the reservation.
- [ ] Design it (spec): `/architect sales orders & stock reservation`

### 27. Pick, pack & ship · needs a decision
Turn orders into pick lists, pack them, and mark them shipped with tracking.
**Done when:** staff get pick lists grouped by bin route, confirm picks by scanning, pack into shipments, and record tracking numbers; shipping posts the stock movement and updates the channel.
- [ ] Design it (spec): `/architect pick, pack & ship`

### 28. Returns · needs a decision
Accept returns from any channel, inspect them, and restock or write off.
**Done when:** a return links to its original order; each item is restocked to a bin or written off with a reason; the refund amount and returned cost are recorded and sent to the accounting app.
- [ ] Design it (spec): `/architect returns`

### 29. Channel connector framework · needs a decision
One shared pattern every sales channel plugs into: pull orders, push stock levels, push shipment status.
**Done when:** a connector can be added without changing core order code; sync runs on a schedule and on events, retries failures, and shows a per channel sync log with errors.
- [ ] Design it (spec): `/architect channel connector framework`

### 30. Ecommerce platform sync · needs a decision
Connect the client's existing online store through the connector framework.
**Done when:** new online orders appear in the ERP within minutes; stock changes in the ERP reach the store; SKUs are matched between both sides.
- [ ] Design it (spec): `/architect ecommerce platform sync`

### 31. Marketplace sync · needs a decision
Connect the marketplaces the client sells on through the same connector framework.
**Done when:** marketplace orders arrive and reserve stock; stock per marketplace can be capped; shipment status is pushed back.
- [ ] Design it (spec): `/architect marketplace sync`

### 32. Showroom point of sale · needs a decision · GA
A POS screen for showroom staff that sells from that showroom's stock in real time.
**Done when:** staff can scan items, take payment, print or send a receipt in English or Arabic, and the sale decreases showroom stock at once; end of day closes the register with totals.
- [ ] Design it (spec): `/architect showroom point of sale`
