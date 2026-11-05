# Slice 4: warehouse depth

The Warehouse bundle in full: counts, routed transfers, purchasing, receiving with landed cost, costing by style and season, and stock cover. Until this slice the brand runs on verified snapshots and imported cost. [Back to the scope](index.md).

### 54. Full stock counts · GA · needs a decision
Full and cycle counts of a location, with counts by difference for partners already in slice 2.
**Done when:** a count is scanned against a frozen snapshot, differences post as ledger movements with a reason and cost, and a count in progress does not block selling.
- [ ] Design it (spec): `/architect full stock counts`

### 55. Transfers with routing · GA · needs a decision
Transfers grown from the minimal version in slice 1b: requests, approvals, routes between several locations, and partial receipt.
**Done when:** a transfer can be requested, approved, routed, received in part, and closed, with every step on the ledger and discrepancies recorded.
- [ ] Design it (spec): `/architect transfers with routing`

### 56. Suppliers & factories · needs a decision
Fabric suppliers abroad and locally, and the contracted factories that make the pieces.
**Done when:** suppliers and factories are recorded with contacts, currency, and terms, and a factory can also be a location that holds materials.
- [ ] Design it (spec): `/architect suppliers & factories`

### 57. Purchase orders · GA · needs a decision
Orders to suppliers and factories, with expected dates the exchange portal can promise against.
**Done when:** a purchase order can be raised, approved, and tracked to received in part or in full, and its expected date feeds "wait for stock".
- [ ] Design it (spec): `/architect purchase orders`

### 58. Receiving with landed cost · GA · needs a decision
Where stock and cost enter: receive against a purchase order or a run, with freight, customs, and clearance rolled into unit cost.
**Done when:** a receipt posts ledger movements at unit cost in EGP at the rate on the day materials were paid; landed cost spreads onto the pieces; cost is frozen at receipt and never restated when the pound moves.
- [ ] Design it (spec): `/architect receiving with landed cost`

### 59. Costing & valuation · GA · needs a decision
Cost by style and season, the per order cost rules, stock valuation, and a "cost to make today" view for pricing.
**Done when:** stock value per location and style agrees with the ledger; per order cost rules (COD fee percent, gateway fee percent, packaging per order, unrestockable share of returned to origin) apply to margin; a rule that is not set shows as not set; "cost to make today" sits apart from historical cost.
- [ ] Design it (spec): `/architect costing & valuation`

### 60. Bulk import & export · GA · needs a decision
Spreadsheet import and export of the catalog, stock, and cost at full size.
**Done when:** a 50,000 row import previews, validates, and applies within an agreed time, lists rejected rows with reasons, and exports round trip without loss.
- [ ] Design it (spec): `/architect bulk import & export`

### 61. Reorder suggestions · needs a decision
Suggest what to make or buy next from sales, stock, and lead times.
**Done when:** suggestions list per style and size with the reasoning shown, and can become a draft purchase order or run.
- [ ] Design it (spec): `/architect reorder suggestions`

### 62. Stock cover & alerts · needs a decision
Days of cover on gross demand, restock alerts, and slow movers, with "no demand" and "net returns" as explicit states.
**Done when:** each variant shows days of cover, a restock alert reaches the right person, slow movers list per location, and the two explicit states never show as a number.
- [ ] Design it (spec): `/architect stock cover & alerts`

### 63. Stock value dashboard · needs a decision
What the stock is worth and where it sits, for people with the cost permission.
**Done when:** the dashboard shows stock value by location, owner type, style, and season, hides for anyone without the cost permission, and reads well on a phone.
- [ ] Design it (spec): `/architect stock value dashboard`
