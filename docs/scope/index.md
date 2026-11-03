# Scope: SSDashboard

A warehouse and ERP system for an ecommerce business with thousands to 100,000+ SKUs. It tracks stock across warehouses and showrooms, buys from suppliers and factories, runs its own and contract production, sells through showrooms, marketplaces, an existing ecommerce platform, and its own storefront, and records cost and price on every transaction for a separate accounting app. It is built for one client first, and later deployed for more clients from one shared core. Each client gets their own install, settings, and modules.

**Build approach:** Tracer Bullet (prove one real thread through every layer first, then thicken one segment at a time, always end to end).
**Workflow:** Beta (after `/develop`: `/check verify`, then `/test`). Features that touch costs, access, payments, or the stock ledger are tagged `· GA` and also get `/check review` and `/document`. `/architect` is the recommended first stop for a feature with a real decision to make. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`.

**Planning notes from the kickoff**
- MVP: stock across locations (catalog, live stock per warehouse and showroom, transfers, adjustments). That is Slices 1 to 3.
- Tracking depth: bins, barcode scanning, lots and expiry, serial numbers.
- Factories: both your own production and contract manufacturing.
- Finance: the books live in a separate accounting app. This system keeps cost and price on every movement, order, and receipt, values stock, and exports transactions to that app.
- Channels: marketplaces, showroom POS, an existing ecommerce platform, and your own storefront.
- Interface in English and Arabic (right to left) from day one.
- Small team (1 to 3 developers), so breadth is phased and each slice ships on its own.
- Go live needs a spreadsheet import of SKUs, suppliers, and opening stock.

## Epics

- [Foundations](foundations.md): 6 features, stack, data model, design system, languages, sign in. 3 of 6 done.
- [Inventory](inventory.md): 9 features, core stock loop, catalog, locations, transfers, scanning, lots, serials. 0 of 9 done.
- [Platform](platform.md): 10 features, roles, audit trail, import, operations, alerts, dashboard, client setup, API. 0 of 10 done.
- [Purchasing](purchasing.md): 4 features, suppliers, purchase orders, receiving, reorder. 0 of 4 done.
- [Sales & fulfillment](sales.md): 8 features, prices, orders, fulfillment, returns, channels, POS. 0 of 8 done.
- [Costing & accounting handoff](finance.md): 2 active features, costing and accounting export (5 moved to the separate accounting app). 0 of 2 done.
- [Production](production.md): 3 features, bills of materials, production orders, contract manufacturing. 0 of 3 done.
- [Storefront](storefront.md): 4 features, catalog pages, checkout, customer accounts, legal. 0 of 4 done.

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | [Stack & architecture](foundations.md) | Foundation | done |
| 2 | [Coding standards & tooling](foundations.md) | Foundation | done |
| 3 | [Data model](foundations.md) | Foundation | done |
| 4 | [Design system & UI foundation](foundations.md) | Foundation | planned |
| 5 | [Localization (English & Arabic)](foundations.md) | Foundation | planned |
| 6 | [Staff sign in](foundations.md) | Foundation | planned |
| 7 | [Core stock loop](inventory.md) | Slice 1 | planned |
| 8 | [Product catalog & variants](inventory.md) | Slice 2 | planned |
| 9 | [Catalog search & filtering](inventory.md) | Slice 2 | planned |
| 10 | [Locations & bins](inventory.md) | Slice 2 | planned |
| 11 | [Stock adjustments & counts](inventory.md) | Slice 2 | planned |
| 12 | [Stock transfers](inventory.md) | Slice 2 | planned |
| 13 | [Roles & permissions](platform.md) | Slice 2 | planned |
| 14 | [Audit trail](platform.md) | Slice 2 | planned |
| 15 | [Bulk import & export](platform.md) | Slice 2 | planned |
| 16 | [Deployment, backups & monitoring](platform.md) | Slice 2 | planned |
| 17 | [Barcode scanning](inventory.md) | Slice 3 | planned |
| 18 | [Lots, batches & expiry](inventory.md) | Slice 3 | planned |
| 19 | [Serial numbers](inventory.md) | Slice 3 | planned |
| 20 | [Suppliers & factories](purchasing.md) | Slice 4 | planned |
| 21 | [Purchase orders](purchasing.md) | Slice 4 | planned |
| 22 | [Receiving goods](purchasing.md) | Slice 4 | planned |
| 23 | [Alerts & notifications](platform.md) | Slice 4 | planned |
| 24 | [Reorder suggestions](purchasing.md) | Slice 4 | planned |
| 25 | [Ops dashboard & reports](platform.md) | Slice 4 | planned |
| 49 | [Prices & price lists](sales.md) | Slice 5 | planned |
| 26 | [Sales orders & stock reservation](sales.md) | Slice 5 | planned |
| 27 | [Pick, pack & ship](sales.md) | Slice 5 | planned |
| 28 | [Returns](sales.md) | Slice 5 | planned |
| 29 | [Channel connector framework](sales.md) | Slice 5 | planned |
| 30 | [Ecommerce platform sync](sales.md) | Slice 5 | planned |
| 31 | [Marketplace sync](sales.md) | Slice 5 | planned |
| 32 | [Showroom point of sale](sales.md) | Slice 5 | planned |
| 34 | [Inventory costing & valuation](finance.md) | Slice 6 | planned |
| 50 | [Accounting export](finance.md) | Slice 6 | planned |
| 33 | [Chart of accounts & general ledger](finance.md) | Slice 6 | dropped |
| 35 | [Supplier bills & payables](finance.md) | Slice 6 | dropped |
| 36 | [Customer invoices & receivables](finance.md) | Slice 6 | dropped |
| 37 | [Taxes](finance.md) | Slice 6 | dropped |
| 38 | [Financial statements](finance.md) | Slice 6 | dropped |
| 39 | [Bills of materials](production.md) | Slice 7 | planned |
| 40 | [Production orders](production.md) | Slice 7 | planned |
| 41 | [Contract manufacturing](production.md) | Slice 7 | planned |
| 42 | [Storefront catalog & product pages](storefront.md) | Slice 8 | planned |
| 43 | [Cart & checkout](storefront.md) | Slice 8 | planned |
| 44 | [Customer accounts](storefront.md) | Slice 8 | planned |
| 45 | [Legal pages & cookie consent](storefront.md) | Slice 8 | planned |
| 46 | [Client settings & module toggles](platform.md) | Slice 9 | planned |
| 47 | [New client provisioning](platform.md) | Slice 9 | planned |
| 48 | [Public API & webhooks](platform.md) | Slice 9 | planned |

**Why this order:** foundations before features, the data model first because it is the costliest thing to redo, then one working stock thread, then the inventory depth the MVP needs, then the go live essentials (roles, audit trail, import, backups). Purchasing comes before sales because receiving is where stock and cost enter. Costing and the accounting export follow once purchases and sales exist to cost and send. Production, the storefront, and the multi client tooling come after the core business runs on the system. (basis: foundations before features; data model is the costliest thing to redo; vertical slices ship real value early)

## Deferred

Out of scope for the current build pass, kept so the plan stays honest.
- **Multiple currencies**: suppliers or channels priced in other currencies · needs a decision · GA
- **Demand forecasting & BI**: forecasts, automatic reorder quantities, a custom report builder · needs a decision
- **Carrier label integration**: buy and print shipping labels from carriers · needs a decision
- **Offline POS**: keep showroom sales running without internet · needs a decision
- **Storefront analytics**: conversion and funnel tracking for the storefront · needs a decision

## References

**Project sources**
- Kickoff answers recorded in *Planning notes from the kickoff* above.

**Practices & standards**
- Tracer bullets and walking skeleton: thin, real, end to end slices first.
- Foundations before features; the data model is the costliest thing to redo.
- Stock as an append only ledger: every change is a new movement or entry, never an edit.
- One codebase, many deploys, configuration per deployment.
- Inventory costing methods allowed under IAS 2 (FIFO, weighted average).
- WCAG 2.2 AA for accessibility; W3C guidance for right to left layout.
- GS1 barcodes (GTIN) for product identifiers.
- PCI DSS scope for card payments at checkout; GDPR and ePrivacy for cookie consent.

**Links** (web verified)
- Tracer bullets, Hunt and Thomas interview: https://www.artima.com/articles/tracer-bullets-and-prototypes
- Accounting Patterns, Martin Fowler: https://martinfowler.com/eaaDev/AccountingNarrative.html
- IAS 2 Inventories, IFRS Foundation: https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/
- The Twelve-Factor App, Codebase: https://12factor.net/codebase
- The Twelve-Factor App, Config: https://12factor.net/config
- WCAG 2.2, W3C: https://www.w3.org/TR/WCAG22/
- W3C Internationalization, the dir attribute and right to left text: https://www.w3.org/International/questions/qa-html-dir
- PCI DSS, PCI Security Standards Council: https://www.pcisecuritystandards.org/standards/pci-dss/
- SEO Starter Guide, Google Search Central: https://developers.google.com/search/docs/fundamentals/seo-starter-guide
- Cookies and GDPR (gdpr.eu, not an official EU source): https://gdpr.eu/cookies/
- EDPB Guidelines 05/2020 on consent: https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en
- Not verified: a canonical walking skeleton page, and the GS1 GTIN page (the site blocked the fetch).

## Legend

**The decision box.** Every feature carries exactly one, the sub task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally, `Decide the stack (spec)` on Stack & architecture), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**: the scope updates as a feature moves; each row is what it shows and who sets it:

| State | Set by | The feature shows |
|---|---|---|
| `planned` · needs a decision | `/scope` | one box: `Design it (spec): /architect <feature>` |
| `in-progress` (designed) | **`/architect` at spec capture** | `Design it` ticked; spec linked; `Build it: /develop <feature>` + **2 to 5 milestones**; the tier's closing boxes (`Verify it` Alpha+, `Test it` Beta+, `Review it` + `Document it` GA); any surfaced follow up enrolled |
| `in-progress` (building) | `/develop` | milestone sub boxes tick one by one; code pointer filled |
| `in-progress` (verified) | `/check verify` | `Build it` + milestones ticked; `Verify it` ticked |
| `done` | **you, when you decide it is** (any skill sets it when you say so); `/sync` reconciles | boxes you ran ticked, skipped ones marked skipped; the tier's last stage (`Prototype` → after `/develop`; `Alpha` → after `/check verify`; `Beta`/`GA` → after `/test`) is the suggested point to call it done; `/sync` captures conventions |

- **Next step** = the first unticked box (always a command or a tracked milestone).
- **needs a decision** = run `/architect` first; otherwise straight to `/develop` (or `/audit` for standards & tooling). The tag drops once the spec is captured.
- **Atomic build tasks live in the spec's `## Build plan`, not here**: the scope carries only the milestone rollup.
- **Status** `planned` → `in-progress` → `done`, plus `existing` (pre workflow) and `dropped` (de scoped, kept for history).
- **Approach tag** beside a heading (e.g. `· Facade`) overrides the project default for that feature; no tag = inherits it.
- **Workflow tier tag** beside a heading (e.g. `· GA`) sets that one feature's rigor above or below the project default; no tag inherits the default. It decides the feature's check boxes and each skill's next suggestion.
- **Workflow** (header line) is the project default, what runs after `/develop`: **Prototype** = nothing; **Alpha** = `/check verify`; **Beta** = `/check verify` then `/test`; **GA** = adds a fresh model `/check review` then `/document`. A feature built on an unratified decision (an `Assumed` spec) stays flagged, but that never blocks `done`.
- **Pointer line** (`spec <n> · code in <path>`): the spec link added by `/architect`, the code path by `/develop`.
