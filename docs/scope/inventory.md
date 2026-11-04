# Epic: Inventory

Products, locations, and stock movement. This epic is the MVP. Back to [index](index.md).

## Slice 1: Core stock loop

### 7. Core stock loop · in-progress
The thinnest real thread through every layer: sign in, create a SKU, create a warehouse, record incoming stock, see stock on hand. This slice is the walking skeleton.
**Done when:** a signed in user can add one SKU and one warehouse, record a stock receipt, and see the correct on hand quantity, read from the stock ledger, in both languages. (basis: tracer bullets prove the whole pipe before any part is built fully)
**Spec:** [0006](../specs/0006-core-stock-loop/index.md)
- [x] Design it (spec): `/architect core stock loop`
- [x] Build it: `/develop core stock loop`
  - [x] The thin thread: migration, ledger `within` callback, SKU and location create, receipt posting, Stock page, both languages (AC-1, AC-4 to AC-7, AC-9 to AC-11, AC-13, AC-14, AC-16, AC-17)
  - [x] Receipts in full: list and search, void, busy retry, backdating (AC-5, AC-7, AC-8, AC-12, AC-14, AC-15)
  - [x] Master data in full: SKU list, edit, code change, archive with locking, delete, Locations page, SKU history (AC-2 to AC-4, AC-10, AC-11, AC-13, AC-15)
  - [x] Hardening: Stock page polish, accessibility in both languages, scale checks (AC-9, AC-16, AC-18)
- [x] Verify it: `/check verify core stock loop`
- [ ] Test it: `/test core stock loop`

## Slice 2: Inventory depth & go live

### 8. Product catalog & variants · needs a decision
Full product records: variants (size, color), attributes, categories, units of measure, barcodes, images.
**Done when:** a user can create a product with many variants, each its own SKU with a barcode; units of measure convert (box to piece); archived SKUs leave history intact.
- [ ] Design it (spec): `/architect product catalog & variants`

### 9. Catalog search & filtering · needs a decision
Find any SKU fast across 100,000+ products by name, SKU, barcode, attribute, or category.
**Done when:** search returns results in under a second at full catalog size; filters combine and are reflected in the URL; Arabic and English text both match; empty and error states render.
- [ ] Design it (spec): `/architect catalog search & filtering`

### 10. Locations & bins
Warehouses and showrooms as locations, each with a zone, aisle, shelf, and bin hierarchy.
**Done when:** a user can create locations and bins, put stock into a specific bin, and see stock per bin and per location.
- [ ] Build it: `/develop locations & bins`

### 11. Stock adjustments & counts
Fix stock with reasoned adjustments and run full or cycle counts.
**Done when:** an adjustment requires a reason and posts a ledger movement; a count compares counted vs expected per bin and posts the difference on approval.
- [ ] Build it: `/develop stock adjustments & counts`

### 12. Stock transfers · needs a decision
Move stock between warehouses and showrooms, with stock tracked while in transit.
**Done when:** a transfer moves through draft, shipped, received; stock leaves the source on ship and arrives on receive; partial receipts and discrepancies are recorded.
- [ ] Design it (spec): `/architect stock transfers`

## Slice 3: Tracking & scanning

### 17. Barcode scanning · needs a decision
Scan items on a handheld or phone to receive, pick, move, and count without typing.
**Done when:** a staff member can scan to find a SKU, scan a bin then items to move stock, and scan during counts; unknown barcodes show a clear error; works on a phone camera and a hardware scanner. (basis: GS1 GTIN barcodes)
- [ ] Design it (spec): `/architect barcode scanning`

### 18. Lots, batches & expiry · needs a decision
Track stock by lot or batch with expiry dates, for production, recalls, and first expired first out.
**Done when:** SKUs can be flagged lot tracked; every movement of such a SKU carries a lot; a user can trace where a lot came from and went; stock near expiry is listed.
- [ ] Design it (spec): `/architect lots, batches & expiry`

### 19. Serial numbers
Track individual units by serial number, following the lot tracking pattern.
**Done when:** SKUs can be flagged serial tracked; each unit's serial is captured on receive and on sale; a user can look up a serial's full history.
- [ ] Build it: `/develop serial numbers`
