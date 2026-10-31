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

### 2. Coding standards & tooling · in-progress
Capture conventions, then install lint, format, type checks, pre commit hooks, and CI from the real scaffolded project.
**Done when:** root `AGENTS.md` reflects the real stack, and lint, format, and pre commit run clean.
- [x] Capture conventions + tooling choices: `/audit`
- [x] Build it: `/develop tooling`
  - [x] ESLint and Prettier, shared from `packages/config`
  - [x] Pre commit hook (lint-staged, then typecheck)
  - [x] CI on GitHub Actions
Code in `packages/config/eslint/`, `.husky/`, `.github/workflows/`

### 3. Data model · needs a decision · GA
Core entities every module builds on: products and variants, locations (warehouse, showroom, bin), an append only stock ledger, lots and serials, parties (suppliers, factories, customers), and cost and price on every transaction.
**Done when:** stock on hand per SKU per location is derived from immutable movements; movements carry quantity, unit cost, lot or serial, and source document; purchase and sales lines carry price, discount, and tax amount; the model handles 100,000+ SKUs and supports purchasing, sales, production, and the accounting export without a breaking migration. (basis: data model is the costliest thing to redo; stock as an append only ledger)
- [ ] Design it (spec): `/architect data model`

### 4. Design system & UI foundation · needs a decision
Visual language, layout, and base components for a dense, data heavy back office (tables, forms, scan screens), mirrored correctly for right to left.
**Done when:** `design.md` covers type, color, spacing, and components; base components work with keyboard and focus, meet WCAG 2.2 AA, and render correctly in both left to right and right to left layouts. (basis: WCAG 2.2 AA)
- [ ] Design it (spec): `/architect design system & UI foundation`

### 5. Localization (English & Arabic) · needs a decision
Every screen in English and Arabic, with direction, numbers, and dates formatted per language, and room for future client languages.
**Done when:** a user can switch language and the whole interface flips direction; no hard coded strings; dates and numbers format per locale; adding a third language needs only translations.
- [ ] Design it (spec): `/architect localization`

### 6. Staff sign in · needs a decision · GA
Real staff accounts and sessions so every slice runs as a known user from day one.
**Done when:** staff can sign in, sign out, and reset a password; sessions expire; an admin can create and disable staff accounts.
- [ ] Design it (spec): `/architect staff sign in`
