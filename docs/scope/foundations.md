# Foundations

The ground every slice stands on. Features 1 to 3 are done (wave 3, branch `feat/scaffold-shape-a`, 2026-11-05); features 4 to 10 are designed (wave 4, branch `feat/foundation-specs`, 2026-11-05) and passed the owner's gate: the earlier scaffold and its specs (0002 to 0006) predate the new positioning. Spec 0007 assesses them, and at its gate the owner chose Shape A (2026-11-05): wave 3 keeps and amends them, and each foundation spec below amends the old spec it inherits. [Back to the scope](index.md).

### 1. Stack & architecture
Decide the stack again against the new positioning, then reshape the runnable skeleton by keeping and amending the current code (Shape A, chosen at the gate on 2026-11-05). The decision covers the two bundles as module toggles plus a license, vendor hosting in an Egyptian data center with self host kept, one database per client, a tenant id on every row, connectors in a worker that respects rate limits, carrier mirror and driver modes, a public HTTPS endpoint per install for webhooks, and the hybrid dev environment.
**Done when:** spec 0007 records the decision with alternatives and marks spec 0001 confirmed or superseded, a `domain-reviewer` pass has no open blocker, you approve it, and the scaffold builds, type checks, lints, and passes CI.
- [x] Decide the stack (spec): `/architect stack & architecture`
- [x] Build it: `/develop stack & architecture` (Shape A milestones from spec 0007's Build plan)
  - [x] Baseline and audience seams: rename `(app)` to `(backoffice)`, add portal and partner route groups, api audience guard that denies by default
  - [x] Docs tree and templates (ADR, module README, PR template, research folder, README per module)
  - [x] TSDoc, naming, and personal data redaction rules, with the TSDoc backfill
  - [x] Git checks and CI building the real images
Spec [0007](../specs/0007-stack-architecture-operations-layer/index.md) (Accepted 2026-11-05, supersedes spec 0001; domain review [domain-stack](../reviews/domain-stack.md) approves with 0 open blockers)

### 2. Coding & documentation standards
Capture conventions from the new scaffold, then enforce them: lint, format, type check before every commit, CI, and the documentation rules the next developer relies on.
**Done when:** root `AGENTS.md` reflects the rebuilt stack; a lint rule fails the build when an exported symbol has no TSDoc; a module README template (owns, never touches, how to test, governing spec) and an ADR template exist; the docs tree holds `scope`, `specs`, `adr`, `reviews`, `positioning`, and `research`; lint, format, and CI run clean.
- [x] Capture conventions + tooling choices: `/audit`

### 3. Dev environment
The hybrid setup the owner chose: the database, object storage, and a mail catcher in containers, the apps on the host for a fast edit loop, and CI building the real images.
**Done when:** a fresh clone reaches running apps in under 10 minutes with one bootstrap command and an example env file, and a "run locally" README says how.
- [x] Build it: `/develop dev environment` (`pnpm install && pnpm bootstrap`: PostgreSQL 18, Garage per [ADR 0002](../adr/0002-garage-as-the-s3-compatible-store.md), Mailpit)

### 4. Data model · GA
The core entities every slice builds on, shaped for Egyptian cash on delivery from the first migration.
**Done when:** the model holds orders with a fulfillment state machine and a cash state machine (partial amounts allowed), store, channel, source, order type (sale, exchange replacement, gifted), and a derived outcome; append only ledgers for stock and customer credit, and settlement accounts with an owner type (carrier, consignment partner, gateway); one task primitive; customers with many phones and channel ids; locations with an owner type and a sellable online flag; products with style, season, and product group; cost by style and season with per order cost rules that can be "not set"; the Cairo operating day; a tenant id on every row; and it is tested at 50,000 SKUs. A `domain-reviewer` pass has no open blocker.
Also from spec 0007: order number unique per (tenant, store), never per tenant; carrier accounts belong to the tenant with an optional store binding (one account for all stores, or one per store).
- [x] Design it (spec): `/architect data model`
- [x] Build it: `/develop data model`
  - [x] A new baseline with a tenant id on every row, end to end
  - [x] Operating day, styles and seasons with cost, locations with a fixed owner type, and the ledger changes
  - [x] Stores, channels, customers by phone, and orders with both state machines
  - [x] Customer credit, settlement, tasks, per order cost rules, and the module walls
  - [x] Scale at 50,000 SKUs, in its own CI job
- [ ] Verify it: `/check verify data model`
- [ ] Test it: `/test data model`
- [ ] Review it: `/check review data model`
- [ ] Document it: `/document data model`
Spec [0002](../specs/0002-core-data-model/index.md) (amendment of 2026-11-05, Proposed; Fable gate review approves; domain review [domain-data-model](../reviews/domain-data-model.md): first pass 5 blockers, re-review 2026-11-05 approves with 0 open blockers)

### 5. Design system & UI foundation
Visual language, layout primitives, and base components, shaped with the Impeccable skill, so every screen feels like one product in Arabic and English.
**Done when:** `design.md` covers type, color, spacing, and components; base components handle focus, keyboard, and right to left; there is a phone first pattern for the manager dashboard and a pattern for in screen help.
- [x] Design it (spec): `/architect design system & UI foundation`
- [ ] Build it: `/develop design system & UI foundation`
  - [x] Direction B (Daftar) in tokens, fonts, and `DESIGN.md`
  - [x] Status chips, provisional values, the freshness strip, and the floor density scope
  - [x] Portal and partner frames with per brand theming
  - [ ] Phone first dashboard pattern and in screen help
- [ ] Verify it: `/check verify design system & UI foundation`
- [ ] Test it: `/test design system & UI foundation`
Spec [0003](../specs/0003-design-system-ui-foundation/index.md) (amendment of 2026-11-05, Proposed; the owner chose direction B, Daftar, with the floor density scope, 2026-11-05)

### 6. Localization (Arabic & English)
Arabic first, English always, everywhere: screens, errors, receipts, exports, and templates.
**Done when:** every string comes from the message catalogs in both languages, layout flips right to left correctly, Arabic and Latin digits both parse, money shows in EGP, and dates show in Cairo time.
- [x] Design it (spec): `/architect localization`
- [x] Build it: `/develop localization`
  - [x] The shared catalog package, end to end (web, api mail, worker)
  - [x] Formatting and digits at every input edge
  - [x] Server rendered portal and partner pages
  - [x] Operating day test on the real Cairo transition dates and the time zone release step
- [x] Verify it: `/check verify localization`
- [x] Test it: `/test localization`
Spec [0004](../specs/0004-localization/index.md) (amendment of 2026-11-05, Proposed)

### 7. Staff sign in · GA
Staff accounts, sessions, and lockouts for the brand's team, with a break glass path for the first admin.
**Done when:** staff can sign in and out in both languages, repeated failures lock out safely, sessions expire, and the first admin and recovery steps are written in a run book.
- [x] Design it (spec): `/architect staff sign in`
- [ ] Build it: `/develop staff sign in`
  - [ ] One identity module and the staff cookie contract
  - [ ] Tenant id on the auth tables
  - [ ] Audience aware guard, partner users, and sessions on hat changes
  - [ ] Sign in pages for both audiences and the run book
- [ ] Verify it: `/check verify staff sign in`
- [ ] Test it: `/test staff sign in`
- [ ] Review it: `/check review staff sign in`
- [ ] Document it: `/document staff sign in`
Spec [0005](../specs/0005-staff-sign-in/index.md) (amendment of 2026-11-05, Proposed)

### 8. Roles as hats · GA
Permissions as hats one person can wear several of: support, operations, warehouse, manager, plus external hats for the media buyer (campaign results only, no customer data) and partners (their own given, sold, owed). Cost and margin are a separate permission, off for support by default. Teams and routing are later settings on the same data.
**Done when:** each default hat sees only what it should, a person can hold several hats, cost and margin hide without the cost permission, and the external hats cannot reach customer data.
- [x] Design it (spec): `/architect roles as hats`
- [ ] Build it: `/develop roles as hats`
  - [ ] Hats in the data and one permission per route
  - [ ] Giving and taking hats, audited
  - [ ] The external hats (media buyer, partner) and the access sweep
  - [ ] Hardening and docs
- [ ] Verify it: `/check verify roles as hats`
- [ ] Test it: `/test roles as hats`
- [ ] Review it: `/check review roles as hats`
- [ ] Document it: `/document roles as hats`
Spec [0008](../specs/0008-roles-as-hats/index.md) (Proposed 2026-11-05)

### 9. Settings, module toggles & bundles · GA
Per brand settings and the switches that make one image into a Warehouse install, an Operations install, or both: bundle and license, module toggles, policy knobs (credit timing, retention limits, auto approval), and the switch per executing step.
**Done when:** a module turns off cleanly without errors or orphaned jobs, a lapsed Operations license switches its connectors off, every executing step defaults to off, and the location owner types are a setting, not three code paths.
Also from spec 0007: lapse is a read only wind down (mirror reads and cash sweep continue for shipments created before the lapse until a final cash state or `operations_wind_down_days`, default 60); expiry warnings at 30, 14, and 7 days in the shell and the daily report; 14 day grace; a renewal starts a backfill sweep.
- [x] Design it (spec): `/architect settings, module toggles & bundles`
- [ ] Build it: `/develop settings, module toggles & bundles`
  - [ ] One setting through every layer
  - [ ] The signed license
  - [ ] Module gate and toggles with no orphaned jobs
  - [ ] Lapse, read only wind down, and renewal backfill
  - [ ] Executing steps, policy knobs, owner type policies, cost rules, and the full settings screen
- [ ] Verify it: `/check verify settings, module toggles & bundles`
- [ ] Test it: `/test settings, module toggles & bundles`
- [ ] Review it: `/check review settings, module toggles & bundles`
- [ ] Document it: `/document settings, module toggles & bundles`
Spec [0009](../specs/0009-settings-toggles-bundles/index.md) (Proposed 2026-11-05)

### 10. Audit trail
Agent accountability: who did what, when, and why, across edits, merges, overrides, confirmations, exports, and every automatic action.
**Done when:** each of those actions writes an audit entry with actor, time, before and after, and reason where one is required; managers can filter it by person and record; nothing can edit or delete an entry.
- [x] Design it (spec): `/architect audit trail`
- [ ] Build it: `/develop audit trail`
  - [ ] The thin thread: void a receipt, see the entry, cannot change it
  - [ ] Every action recorded, with no raw personal data
  - [ ] The manager screen and the export
  - [ ] One step undo and scale
- [ ] Verify it: `/check verify audit trail`
- [ ] Test it: `/test audit trail`
Spec [0010](../specs/0010-audit-trail/index.md) (Proposed 2026-11-05)
