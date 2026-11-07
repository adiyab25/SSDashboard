# Scope: SSDashboard

The back office behind an Egyptian clothing brand's Shopify, Bosta account, and showroom partners, built for cash on delivery: it confirms every order, runs every exchange and refund in one tap, reconciles every piaster, and shows the owner the real margin on a phone. One shared core, deployed as one stack per brand, sold as two bundles.

**Build approach:** Tracer Bullet (prove one real thread through every layer first, then thicken one segment at a time, always end to end).
**Workflow:** Beta (after `/develop`: `/check verify`, then `/test`). Features that touch money, access, a ledger, a settlement, a write to Shopify or a carrier, an export a client's accountant imports, or a public page with customer data are tagged `· GA` and also get a fresh model `/check review` and `/document`, plus a `domain-reviewer` pass on the spec before it is accepted. `/architect` is the recommended first stop for a feature with a real decision to make. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`.

**What to build comes from** [the final plan](../positioning/2026-11-05-egypt-order-operations-layer.md) (sections 6 to 8 and 10) and **how we get there** from [the approved rebuild plan](../positioning/2026-11-05-rebuild-plan.md). This scope replaces the earlier warehouse ERP scope, which stays readable in git history (`git show 1e7225e:docs/scope/index.md`).

**Planning notes**
- Who: Egyptian clothing brands behind Shopify (often two stores), Bosta cash on delivery, consignment showroom partners, Meta ads, and a team of about four (support, operations, warehouse, manager) plus a freelance media buyer and the partners. Must feel right at four people and work at forty.
- Design target: **10,000 SKUs, tested at 50,000.** The old 100,000 SKU target is parked.
- **Two bundles on one core**, one image, switched by module toggles plus a license. **Core** (never sold alone): catalog, stock ledger, locations, orders, customers, settlement primitive, tasks, roles, audit, import. **Warehouse** (bought once): counts, transfers, purchasing, receiving, production runs, costing and valuation, Shopify stock sync, bulk import and export. **Operations** (yearly, in EGP, hosting included): confirmation, exchanges and returns, carriers, cash on delivery and settlements, credit, refunds, retention, partner settlement, Meta, dashboards, tax documents, WhatsApp. When the Operations plan lapses its connectors switch off cleanly.
- Arabic and English from day one, right to left correct, phone first for the manager. Cairo operating day in the model.
- Every executing step (Bosta driver mode, auto approval, refunds, Shopify write back) is a switch per brand; the product must be valuable with all of them off.
- No live third party calls in tests: connectors prove themselves on recorded fixtures.
- Vendor hosted by default in an Egyptian data center, with a self host option and a working exit package from the first pilot day. A tenant id on every row from the first migration.
- **Spec 0007 carries requirements into later features.** Before `/architect` designs any feature, read [spec 0007](../specs/0007-stack-architecture-operations-layer/index.md)'s `## Carried from the domain review` table and the re-review findings in [the stack domain review](../reviews/domain-stack.md) (n1 to features 18 and 21, n2 to features 9 and 19) for that feature's number; only some rows carry an "Also from spec 0007" line.
- **Pilot window**: mid March to early May 2027, between Eid al Fitr and Eid al Adha. Foundations and slice 1a must land before it (spec 0007, Build plan).

## Epics

- [Foundations](foundations.md): 10 features, stack, standards, dev environment, data model, design system, languages, sign in, roles, settings, audit. 8 of 10 done.
- [Slice 1a: confirmation to cash](confirmation-to-cash.md): 17 features, Shopify, orders, customers, confirmation, Bosta mirror, failures, settlement, period close, dashboard, daily report, hosting, exit package. 0 of 17 done.
- [Slice 1b: the exchange loop](exchange-loop.md): 12 features, credit ledger, portal, rules, Bosta driver mode, picking, execution, refunds, retention, write back, transfers. 0 of 12 done.
- [Slice 2: consignment partners and the accounting handoff](consignment-and-accounting.md): 8 features, channel code mapping, partners, ingestion, settlement, tax documents, export engine, provisioning. 0 of 8 done.
- [Slice 3: Meta and WhatsApp](meta-and-whatsapp.md): 6 features, attribution, campaign profit, WhatsApp templates, leads, Instagram, landing page. 0 of 6 done.
- [Slice 4: warehouse depth](warehouse-depth.md): 10 features, counts, transfers, purchasing, receiving, costing, bulk import, stock cover. 0 of 10 done.
- [Slice 5: the production loop](production.md): 2 features, factory runs and the quality report. 0 of 2 done.
- [Later and parked](later.md): toggles for a later client, and what we chose not to build.

## At a glance

| # | Feature | Phase | Bundle | Tier | Status |
|---|---------|-------|--------|------|--------|
| 1 | [Stack & architecture](foundations.md) | Foundation | Core | Beta | done |
| 2 | [Coding & documentation standards](foundations.md) | Foundation | Core | Beta | done |
| 3 | [Dev environment](foundations.md) | Foundation | Core | Beta | done |
| 4 | [Data model](foundations.md) | Foundation | Core | GA | done |
| 5 | [Design system & UI foundation](foundations.md) | Foundation | Core | Beta | done |
| 6 | [Localization (Arabic & English)](foundations.md) | Foundation | Core | Beta | done |
| 7 | [Staff sign in](foundations.md) | Foundation | Core | GA | done |
| 8 | [Roles as hats](foundations.md) | Foundation | Core | GA | done |
| 9 | [Settings, module toggles & bundles](foundations.md) | Foundation | Core | GA | in-progress |
| 10 | [Audit trail](foundations.md) | Foundation | Core | Beta | in-progress |
| 11 | [Stock ledger & locations](confirmation-to-cash.md) | Slice 1a | Core | GA | planned |
| 12 | [Catalog, styles & variants](confirmation-to-cash.md) | Slice 1a | Core | Beta | planned |
| 13 | [Shopify connector](confirmation-to-cash.md) | Slice 1a | Core | GA | planned |
| 14 | [Customers by phone](confirmation-to-cash.md) | Slice 1a | Core | Beta | planned |
| 15 | [Onboarding imports](confirmation-to-cash.md) | Slice 1a | Core | GA | planned |
| 16 | [Orders & their state machines](confirmation-to-cash.md) | Slice 1a | Core | GA | planned |
| 17 | [Tasks & My work inbox](confirmation-to-cash.md) | Slice 1a | Core | Beta | planned |
| 18 | [Confirmation queue](confirmation-to-cash.md) | Slice 1a | Operations | GA | planned |
| 19 | [Bosta connector, mirror mode](confirmation-to-cash.md) | Slice 1a | Operations | GA | planned |
| 20 | [Barcode scanning](confirmation-to-cash.md) | Slice 1a | Core | Beta | planned |
| 21 | [Delivery failures & returned to origin](confirmation-to-cash.md) | Slice 1a | Operations | GA | planned |
| 22 | [Settlement & Bosta reconciliation](confirmation-to-cash.md) | Slice 1a | Operations | GA | planned |
| 23 | [Period close with evidence](confirmation-to-cash.md) | Slice 1a | Core | GA | planned |
| 24 | [Metric dictionary & phone dashboard](confirmation-to-cash.md) | Slice 1a | Operations | Beta | planned |
| 25 | [Daily report](confirmation-to-cash.md) | Slice 1a | Operations | Beta | planned |
| 26 | [Deployment, backups & monitoring](confirmation-to-cash.md) | Slice 1a | Core | GA | planned |
| 27 | [Exit package](confirmation-to-cash.md) | Slice 1a | Core | GA | planned |
| 28 | [Customer credit ledger](exchange-loop.md) | Slice 1b | Operations | GA | planned |
| 29 | [Exchange & return portal](exchange-loop.md) | Slice 1b | Operations | GA | planned |
| 30 | [Privacy notice & consumer terms](exchange-loop.md) | Slice 1b | Core | Beta | planned |
| 31 | [Approval rules & review desk](exchange-loop.md) | Slice 1b | Operations | GA | planned |
| 32 | [Bosta driver mode](exchange-loop.md) | Slice 1b | Operations | GA | planned |
| 33 | [Pick, pack & ship](exchange-loop.md) | Slice 1b | Core | Beta | planned |
| 34 | [Exchange execution & inspection](exchange-loop.md) | Slice 1b | Operations | GA | planned |
| 35 | [Refunds by original method](exchange-loop.md) | Slice 1b | Operations | GA | planned |
| 36 | [Retention step](exchange-loop.md) | Slice 1b | Operations | GA | planned |
| 37 | [Shopify returns & exchange write back](exchange-loop.md) | Slice 1b | Operations | GA | planned |
| 38 | [Minimal transfers](exchange-loop.md) | Slice 1b | Warehouse | GA | planned |
| 39 | [Exchange dashboard](exchange-loop.md) | Slice 1b | Operations | Beta | planned |
| 40 | [Channel code mapping](consignment-and-accounting.md) | Slice 2 | Core | GA | planned |
| 41 | [Consignment partners & handover](consignment-and-accounting.md) | Slice 2 | Operations | GA | planned |
| 42 | [Partner sales ingestion](consignment-and-accounting.md) | Slice 2 | Operations | GA | planned |
| 43 | [Partner settlement](consignment-and-accounting.md) | Slice 2 | Operations | GA | planned |
| 44 | [Tax authority documents](consignment-and-accounting.md) | Slice 2 | Operations | GA | planned |
| 45 | [Export engine](consignment-and-accounting.md) | Slice 2 | Core | GA | planned |
| 46 | [Sell through report](consignment-and-accounting.md) | Slice 2 | Operations | Beta | planned |
| 47 | [Client provisioning](consignment-and-accounting.md) | Slice 2 | Core | GA | planned |
| 48 | [Attribution & Meta Conversions API](meta-and-whatsapp.md) | Slice 3 | Operations | GA | planned |
| 49 | [Campaign profit report](meta-and-whatsapp.md) | Slice 3 | Operations | Beta | planned |
| 50 | [WhatsApp templates & backup number](meta-and-whatsapp.md) | Slice 3 | Operations | GA | planned |
| 51 | [Lead capture: Meta lead ads & click to WhatsApp](meta-and-whatsapp.md) | Slice 3 | Operations | Beta | planned |
| 52 | [Instagram DM attribution](meta-and-whatsapp.md) | Slice 3 | Operations | Beta | planned |
| 53 | [COD landing page](meta-and-whatsapp.md) | Slice 3 | Operations | GA | planned |
| 54 | [Full stock counts](warehouse-depth.md) | Slice 4 | Warehouse | GA | planned |
| 55 | [Transfers with routing](warehouse-depth.md) | Slice 4 | Warehouse | GA | planned |
| 56 | [Suppliers & factories](warehouse-depth.md) | Slice 4 | Warehouse | Beta | planned |
| 57 | [Purchase orders](warehouse-depth.md) | Slice 4 | Warehouse | GA | planned |
| 58 | [Receiving with landed cost](warehouse-depth.md) | Slice 4 | Warehouse | GA | planned |
| 59 | [Costing & valuation](warehouse-depth.md) | Slice 4 | Warehouse | GA | planned |
| 60 | [Bulk import & export](warehouse-depth.md) | Slice 4 | Warehouse | GA | planned |
| 61 | [Reorder suggestions](warehouse-depth.md) | Slice 4 | Warehouse | Beta | planned |
| 62 | [Stock cover & alerts](warehouse-depth.md) | Slice 4 | Warehouse | Beta | planned |
| 63 | [Stock value dashboard](warehouse-depth.md) | Slice 4 | Warehouse | Beta | planned |
| 64 | [Factory production runs](production.md) | Slice 5 | Warehouse | GA | planned |
| 65 | [Quality report from return reasons](production.md) | Slice 5 | Warehouse | Beta | planned |

**Why this order:** foundations first, with the data model before anything that stores data because it is the costliest thing to redo and it must already hold both order state machines, three ledgers, the settlement primitive, and location owner types. Then slice 1a, the walking skeleton: one real Shopify order confirmed, shipped with Bosta in mirror mode, and its cash reconciled, because cash on delivery leakage is the brand's biggest daily loss and mirror mode needs no permission to execute anything. Hosting and the exit package sit in 1a because the pilot starts right after it. The exchange loop follows (1b) because it needs the credit ledger, driver mode, and picking that 1a does not. Consignment and the accounting export come next because they reuse the settlement primitive and period close from 1a. Meta and WhatsApp depend on confirmed orders and the campaign source already on them. Warehouse depth and production come last because a brand can run on snapshots and imported cost until then. (basis: the final plan sections 8 and 9; foundations before features; data model is the costliest thing to redo; vertical slices ship real value early)

**Where the bundle labels come from:** section 5 of the final plan lists each bundle's contents. Shopify and pick, pack and ship are labelled Core because both bundles need them (stock sync for Warehouse, orders for Operations). Barcode scanning is Core because returned to origin restock in 1a needs it before warehouse depth exists. (basis: final plan section 5)

## Later and parked

Toggles for a later client and the parked list live in [later.md](later.md). Nothing there is built in the current pass.

## References

**Project sources**
- [Final plan: the back office behind Egyptian clothing brands](../positioning/2026-11-05-egypt-order-operations-layer.md), sections 5 (bundles), 6 (design rules), 7 (processes), 8 (slice plan), 9 (pilot), 10 (scope changes), 12 (Egyptian market facts), 13 (open questions).
- [Approved rebuild plan](../positioning/2026-11-05-rebuild-plan.md): owner decisions, keep list, waves, model routing, documentation standards.
- [Brand owner debate](../positioning/2026-11-05-brand-owner-debate.md) and [reference brand notes](../positioning/2026-11-05-reference-brand-notes.md): the evidence behind the slice 1a contents.
- `AGENTS.md` (project rules, until `/audit` rewrites it after the scaffold).

**Practices & standards**
- Tracer bullets and the walking skeleton: thin, real, end to end slices first.
- Foundations before features; the data model is the costliest thing to redo.
- Append only ledgers (stock, customer credit): every change is a new entry, never an edit.
- One codebase, many deploys, configuration per deployment.
- Historical cost frozen at receipt, as IAS 2 allows.
- WCAG 2.2 AA for accessibility; W3C guidance for right to left layout.
- Egyptian Personal Data Protection Law 151 of 2020 and Consumer Protection Law 181 of 2018.
- Contract tests on recorded fixtures for every third party connector; no live calls in tests.

## Legend

**The decision box.** Every feature that needs a decision carries exactly one, the sub task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally, `Decide the stack (spec)` on Stack & architecture), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

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
- **Bundle** (table column): `Core` ships in both bundles and is never sold alone; `Warehouse` is the perpetual license; `Operations` is the yearly plan and must switch off cleanly through module toggles.
- **Tier** (table column) is every feature's effective workflow tier. A `· GA` tag beside a heading marks the features above the Beta default; no tag means Beta.
- **Workflow** (header line) is the project default, what runs after `/develop`: **Prototype** = nothing; **Alpha** = `/check verify`; **Beta** = `/check verify` then `/test`; **GA** = adds a fresh model `/check review` then `/document`. A feature built on an unratified decision (an `Assumed` spec) stays flagged, but that never blocks `done`.
- **Pointer line** (`spec <n> · code in <path>`): the spec link added by `/architect`, the code path by `/develop`.
