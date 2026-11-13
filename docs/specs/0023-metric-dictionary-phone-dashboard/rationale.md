# 0023. Metric dictionary and phone dashboard: decision record

The build spec is [index.md](index.md). This file holds the reasoning `/develop` skips.

## Context

The owner of an Egyptian clothing brand runs the business from a phone, mostly in Arabic, and reads numbers in a chat group, not on a desk screen (reference brand notes 9). Slice 1a ends with the figures of confirmation to cash reported to that phone. Two features carry it: this one (the definitions and the dashboard) and feature 25 (the daily report, spec 0024). Both must show the same numbers, or the owner stops trusting either.

The reference brand learned this the hard way. Its delivery views had two different predicates for "lost", its return rate counted cancellations as returns, order edits inflated units sold, and pages contradicted each other until the read models were rewritten and a freshness strip was added (insights section 7). Shopify's own "returned" figure is mostly cancelled orders. A cash on delivery brand also has two clocks that must never be mixed silently: marketing counts an order on the day it was placed (to match ad spend), while cash counts it when it was delivered and when the carrier paid (final plan 6.14).

By the time this feature is built, most of the facts already live in other modules: orders and their two state machines (spec 0013), confirmation attempts and their metrics (spec 0017), delivery outcomes and the returned to origin rate (spec 0019, which explicitly hands its definitions to feature 24), carrier settlement with provisional money (spec 0020), tasks and "refunds owed" (spec 0016), and connection health (specs 0015 and 0018). Each of those modules is the only writer of its tables and exports read services (AGENTS.md, domain driven modules). What "confirmed" means is set by spec 0007 section 3: own records confirm after the day closes and a sweep agrees; third party money only after period close (feature 23, being designed in parallel as spec 0022).

The design system already ships the phone dashboard parts (`MetricCard`, `NeedsYouList`, `BottomTabs`, `CollapsingTable`, `FreshnessStrip`, `ProvisionalValue`) and fixes the first four numbers by owner answer (spec 0003 question 2). Volume is a few hundred orders a day per brand, tested at the spec 0002 scale data. No owner is in this session, so every open question is recorded with a recommended answer.

## Options considered

### Option 1: A typed dictionary in contracts, read at request time through the owners' read services (chosen)

The dictionary is data in `packages/contracts`; one reader per metric in `apps/api/src/reporting/` calls the owning module's exported read and applies one state rule.

**Pros**:
- No second copy of any fact, so nothing can drift from the module that owns it.
- Respects the module rule: reporting never reads another module's tables.
- The dictionary is typed and shared, so the web, the api, and the worker (spec 0024) use the same keys, labels, and rules.

**Cons**:
- Each page read fans out to several modules; a slow owner read slows the page.
- Needs about seven new reads in other modules, so the feature waits on their builds.

### Option 2: A reporting projection (one fact row per order and day, built from domain events)

Reporting listens to `OrderPlaced`, `OrderStateChanged`, `DeliveryOutcomeEnded`, settlement events, and so on, and keeps its own fact table that every figure reads.

**Pros**:
- One fast table for every figure and every cut.
- Reporting does not wait on other modules to add reads.

**Cons**:
- Duplicates spec 0019's `delivery_outcomes` and spec 0020's settlement totals, which already exist for exactly these figures; two copies drift.
- Needs a rebuild job, replay tests, and handling of late and revoked facts, all of which the owners already handle for their own data.

### Option 3: SQL views over the other modules' tables

A set of database views that join orders, outcomes, and settlement lines.

**Pros**:
- Quickest to write, one query per figure.

**Cons**:
- Breaks the module rule (no reading another module's tables) and the table ownership map; every owner's schema change can silently break a figure.

### Option 4: Each page computes its own figures

Every page and the report query what they need.

**Pros**:
- No shared layer to design.

**Cons**:
- This is the failure the reference brand lived through: each page found its own definition and the numbers contradicted each other.

## Rationale

The force that decides this is trust: an owner who sees two different "delivered" numbers stops reading both (insights section 7, "silent zeros destroy trust"). Option 1 makes disagreement impossible by construction, because there is exactly one definition and one reader, and the reader asks the module that owns the fact. Option 2 would also give one definition, but it creates a second copy of data that specs 0019 and 0020 already project with care (late facts, revocations, wind down), and a copy is the thing that drifts. Option 3 breaks a rule the build enforces, and Option 4 is the known failure.

The cost of Option 1 is the fan out and the wait on other modules. At a few hundred orders a day both are acceptable: each owner read is a few indexed counts, and the scale budget (AC-22) turns any slow read into an index in the owning module, not a cache here. The wait is honest: a figure whose source is not built shows `not_available`, so the page can ship in milestone 1 and fill in as specs 0019, 0020, and 0022 land.

Two smaller calls. Gifted orders and exchange replacements are counted on their own lines and left out of orders and rates, because a giveaway week or an exchange heavy week would otherwise look like a sales week (spec 0002 already marks the types for this). Failed deliveries count on the day the parcel turns back, as spec 0019 does, so a recent week is never shown cleaner than it is.

## References

**Project sources**:
- Final plan, `docs/positioning/2026-11-05-egypt-order-operations-layer.md`, sections 6.14, 6.15, 7.6.
- reference brand notes, `docs/positioning/2026-11-05-reference-brand-notes.md`, items 5, 8, 9, 11 and section 7.
- Spec 0007 section 3 (what confirmed means) and carried rows M3, M4, m3.
- Spec 0002 orders child (the derived outcome, gifted and exchange replacement types).
- Spec 0003 owner answer 2 and `packages/ui/DESIGN.md` (phone first dashboard, provisional values).
- Specs 0013, 0015, 0016, 0017, 0018, 0019, 0020 (the owners' reads).

**Practices & standards**:
- One definition per metric (a semantic layer) read through one service.
- Compute at read time until a measured problem says otherwise.
