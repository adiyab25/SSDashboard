# Epic: Costing & accounting handoff

The full books (ledger, payables, receivables, taxes, statements) live in a separate accounting app. This system keeps the cost and price on every stock movement, order, and receipt, values stock correctly, and sends the money side of each transaction to the accounting app. Back to [index](index.md).

## Slice 6: Costing & accounting handoff

### 34. Inventory costing & valuation · needs a decision · GA
Cost every unit of stock and work out cost of goods sold for every sale.
**Done when:** each SKU uses a set costing method (FIFO or weighted average); receipts, transfers, production, adjustments, and sales each record their cost; a stock valuation report shows value per SKU and location at any date; margin per sale (price minus cost) is visible. (basis: IAS 2 costing methods)
- [ ] Design it (spec): `/architect inventory costing & valuation`

### 50. Accounting export · needs a decision · GA
Send the money side of every transaction (purchases received, supplier costs, sales and their cost, returns, stock adjustments, production) to the separate accounting app.
**Done when:** each transaction is sent once, with cost, price, tax amount, and a reference back to its source document; failed sends retry and show in a log; totals sent for a period match the ERP's own cost and sales reports.
- [ ] Design it (spec): `/architect accounting export`

## Moved to the separate accounting app

Kept for history. The accounting app owns these now.

### 33. Chart of accounts & general ledger · dropped
Moved to the separate accounting app.

### 35. Supplier bills & payables · dropped
Moved to the separate accounting app. This system still records the supplier price on each purchase order and the cost on each receipt.

### 36. Customer invoices & receivables · dropped
Moved to the separate accounting app. This system still records the selling price on each order and POS sale.

### 37. Taxes · dropped
Moved to the separate accounting app. This system still records the tax amount on each order line so it can be sent across.

### 38. Financial statements · dropped
Moved to the separate accounting app.
