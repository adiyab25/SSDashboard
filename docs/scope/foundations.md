# Epic: Foundations

The ground every slice stands on. Back to [index](index.md).

## Foundations

### 1. Stack & architecture · done
Decide the stack and how one shared core ships as separate installs per client, then scaffold a runnable project.
**Done when:** the stack and the per client deployment model (own install and database per client, settings and module toggles) are recorded in a spec, and the empty scaffold boots locally and passes build. (basis: one codebase, many deploys, configuration per deployment)
- [x] Decide the stack (spec): `/architect stack & architecture`
- [x] Scaffold from the decision: `/develop stack & architecture`
- [x] Verify it: `/check verify stack & architecture`
- [x] Test it: `/test stack & architecture`
Spec [0001](../specs/0001-stack-architecture/index.md) · code in `apps/`, `packages/`, `deploy/`

### 2. Coding standards & tooling · done
Capture conventions, then install lint, format, type checks, pre commit hooks, and CI from the real scaffolded project.
**Done when:** root `AGENTS.md` reflects the real stack, and lint, format, and pre commit run clean.
- [x] Capture conventions + tooling choices: `/audit`
- [x] Build it: `/develop tooling`
  - [x] ESLint and Prettier, shared from `packages/config`
  - [x] Pre commit hook (lint-staged, then typecheck)
  - [x] CI on GitHub Actions
Code in `packages/config/eslint/`, `.husky/`, `.github/workflows/`

### 3. Data model · GA · done
Core entities every module builds on: products and variants, locations (warehouse, showroom, bin), an append only stock ledger, lots and serials, parties (suppliers, factories, customers), and cost and price on every transaction.
**Done when:** stock on hand per SKU per location is derived from immutable movements; movements carry quantity, unit cost, lot or serial, and source document; purchase and sales lines carry price, discount, and tax amount; the model handles 100,000+ SKUs and supports purchasing, sales, production, and the accounting export without a breaking migration. (basis: data model is the costliest thing to redo; stock as an append only ledger)
- [x] Design it (spec): `/architect data model`
- [x] Build it: `/develop data model`
  - [x] Schema, value objects, and database roles (AC-2, AC-3, AC-12, AC-13)
  - [x] Ledger posting core: inbound, outbound, costing, dates, reversals, reads (AC-1, AC-2, AC-4, AC-5, AC-6, AC-7, AC-12)
  - [x] Lots, serials, and reservations (AC-4, AC-8, AC-9)
  - [x] Numbering, nightly reconciliation, and scale check (AC-10, AC-11, AC-14)
- [x] Verify it: `/check verify data model`
- [x] Test it: `/test data model`
- [x] Review it (fresh model): `/check review data model`
- [x] Document it: `/document data model`
Spec [0002](../specs/0002-core-data-model/index.md) · code in `packages/db/`, `packages/contracts/`, `apps/api/src/inventory/`, `apps/api/src/platform/`

### 4. Design system & UI foundation · done
Visual language, layout, and base components for a dense, data heavy back office (tables, forms, scan screens), mirrored correctly for right to left.
**Done when:** `design.md` covers type, color, spacing, and components; base components work with keyboard and focus, meet WCAG 2.2 AA, and render correctly in both left to right and right to left layouts. (basis: WCAG 2.2 AA)
- [x] Design it (spec): `/architect design system & UI foundation`
- [x] Build it: `/develop design system & UI foundation`
  - [x] Thin thread: `packages/ui`, `GET /api/config`, client name in a minimal shell header (AC-2, AC-5, AC-9, AC-12)
  - [x] Foundations: tokens, fonts, theme, dev direction switch, typed strings, logical CSS check (AC-2, AC-5, AC-6, AC-11, AC-12, AC-13)
  - [x] App shell: sidebar, mobile sheet, top bar, skip link, user menu, command palette (AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-14)
  - [x] Location switcher and `GET /api/locations` (AC-10)
  - [x] `/design` gallery, `DESIGN.md`, and the Playwright accessibility suite (AC-1, AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, AC-11, AC-13, AC-14)
- [x] Verify it: `/check verify design system & UI foundation`
- [ ] Test it: `/test design system & UI foundation` (skipped)
Spec [0003](../specs/0003-design-system-ui-foundation/index.md) · code in `packages/ui`, `apps/web/src/shell`, `apps/web/src/design`, `apps/api/src/inventory/locations`

### 5. Localization (English & Arabic) · needs a decision
Every screen in English and Arabic, with direction, numbers, and dates formatted per language, and room for future client languages.
**Done when:** a user can switch language and the whole interface flips direction; no hard coded strings; dates and numbers format per locale; adding a third language needs only translations.
- [ ] Design it (spec): `/architect localization`

### 6. Staff sign in · needs a decision · GA
Real staff accounts and sessions so every slice runs as a known user from day one.
**Done when:** staff can sign in, sign out, and reset a password; sessions expire; an admin can create and disable staff accounts.
- [ ] Design it (spec): `/architect staff sign in`
