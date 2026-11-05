# Foundations

The ground every slice stands on. Nothing here is done yet: the earlier scaffold and its specs predate the new positioning, and the rebuild replaces them once spec 0002 is approved. [Back to the scope](index.md).

### 1. Stack & architecture · needs a decision
Decide the stack again against the new positioning, then wipe the old apps per the rebuild plan's keep list and scaffold a runnable skeleton. The decision covers the two bundles as module toggles plus a license, vendor hosting in an Egyptian data center with self host kept, one database per client, a tenant id on every row, connectors in a worker that respects rate limits, carrier mirror and driver modes, a public HTTPS endpoint per install for webhooks, and the hybrid dev environment.
**Done when:** spec 0002 records the decision with alternatives and marks spec 0001 confirmed or superseded, a `domain-reviewer` pass has no open blocker, you approve it, and the scaffold builds, type checks, lints, and passes CI.
- [ ] Decide the stack (spec): `/architect stack & architecture`
Spec 0001 (to be confirmed or superseded by spec 0002)

### 2. Coding & documentation standards
Capture conventions from the new scaffold, then enforce them: lint, format, type check before every commit, CI, and the documentation rules the next developer relies on.
**Done when:** root `AGENTS.md` reflects the rebuilt stack; a lint rule fails the build when an exported symbol has no TSDoc; a module README template (owns, never touches, how to test, governing spec) and an ADR template exist; the docs tree holds `scope`, `specs`, `adr`, `reviews`, `positioning`, and `research`; lint, format, and CI run clean.
- [ ] Capture conventions + tooling choices: `/audit`

### 3. Dev environment
The hybrid setup the owner chose: the database, object storage, and a mail catcher in containers, the apps on the host for a fast edit loop, and CI building the real images.
**Done when:** a fresh clone reaches running apps in under 10 minutes with one bootstrap command and an example env file, and a "run locally" README says how.
- [ ] Build it: `/develop dev environment`

### 4. Data model · GA · needs a decision
The core entities every slice builds on, shaped for Egyptian cash on delivery from the first migration.
**Done when:** the model holds orders with a fulfillment state machine and a cash state machine (partial amounts allowed), store, channel, source, order type (sale, exchange replacement, gifted), and a derived outcome; append only ledgers for stock and customer credit, and settlement accounts with an owner type (carrier, consignment partner, gateway); one task primitive; customers with many phones and channel ids; locations with an owner type and a sellable online flag; products with style, season, and product group; cost by style and season with per order cost rules that can be "not set"; the Cairo operating day; a tenant id on every row; and it is tested at 50,000 SKUs. A `domain-reviewer` pass has no open blocker.
- [ ] Design it (spec): `/architect data model`

### 5. Design system & UI foundation · needs a decision
Visual language, layout primitives, and base components, shaped with the Impeccable skill, so every screen feels like one product in Arabic and English.
**Done when:** `design.md` covers type, color, spacing, and components; base components handle focus, keyboard, and right to left; there is a phone first pattern for the manager dashboard and a pattern for in screen help.
- [ ] Design it (spec): `/architect design system & UI foundation`

### 6. Localization (Arabic & English) · needs a decision
Arabic first, English always, everywhere: screens, errors, receipts, exports, and templates.
**Done when:** every string comes from the message catalogs in both languages, layout flips right to left correctly, Arabic and Latin digits both parse, money shows in EGP, and dates show in Cairo time.
- [ ] Design it (spec): `/architect localization`

### 7. Staff sign in · GA · needs a decision
Staff accounts, sessions, and lockouts for the brand's team, with a break glass path for the first admin.
**Done when:** staff can sign in and out in both languages, repeated failures lock out safely, sessions expire, and the first admin and recovery steps are written in a run book.
- [ ] Design it (spec): `/architect staff sign in`

### 8. Roles as hats · GA · needs a decision
Permissions as hats one person can wear several of: support, operations, warehouse, manager, plus external hats for the media buyer (campaign results only, no customer data) and partners (their own given, sold, owed). Cost and margin are a separate permission, off for support by default. Teams and routing are later settings on the same data.
**Done when:** each default hat sees only what it should, a person can hold several hats, cost and margin hide without the cost permission, and the external hats cannot reach customer data.
- [ ] Design it (spec): `/architect roles as hats`

### 9. Settings, module toggles & bundles · GA · needs a decision
Per brand settings and the switches that make one image into a Warehouse install, an Operations install, or both: bundle and license, module toggles, policy knobs (credit timing, retention limits, auto approval), and the switch per executing step.
**Done when:** a module turns off cleanly without errors or orphaned jobs, a lapsed Operations license switches its connectors off, every executing step defaults to off, and the location owner types are a setting, not three code paths.
- [ ] Design it (spec): `/architect settings, module toggles & bundles`

### 10. Audit trail · needs a decision
Agent accountability: who did what, when, and why, across edits, merges, overrides, confirmations, exports, and every automatic action.
**Done when:** each of those actions writes an audit entry with actor, time, before and after, and reason where one is required; managers can filter it by person and record; nothing can edit or delete an entry.
- [ ] Design it (spec): `/architect audit trail`
