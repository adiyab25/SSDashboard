# Epic: Purchasing

Buying from suppliers and factories and bringing goods into stock. Back to [index](index.md).

## Slice 4: Purchasing

### 20. Suppliers & factories
A directory of suppliers and factories with contacts, the SKUs they supply, their prices, and lead times.
**Done when:** a user can create a supplier or factory, link SKUs with supplier price and lead time, and see a supplier's open orders and history.
- [ ] Build it: `/develop suppliers & factories`

### 21. Purchase orders · needs a decision
Create, approve, and send purchase orders to suppliers and factories.
**Done when:** a purchase order moves through draft, approved, sent, partly received, closed; approval follows a configurable limit; the order can be printed or emailed in English or Arabic.
- [ ] Design it (spec): `/architect purchase orders`

### 22. Receiving goods · needs a decision
Receive deliveries against a purchase order into specific bins, capturing lots, serials, and cost.
**Done when:** a staff member can receive full or partial quantities by scanning, put them into bins, record lots and serials, and note damaged or short items; each receipt posts ledger movements with unit cost.
- [ ] Design it (spec): `/architect receiving goods`

### 24. Reorder suggestions · needs a decision
Per SKU and location reorder points that suggest what to buy and from whom.
**Done when:** each SKU can have a minimum and reorder quantity per location; a list shows what is below its point with the preferred supplier; a user can turn suggestions into draft purchase orders.
- [ ] Design it (spec): `/architect reorder suggestions`
