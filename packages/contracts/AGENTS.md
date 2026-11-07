# packages/contracts

## Overview

The shared API contract: Zod schemas and their inferred types, used by the api for validation and by the web to parse every `/api` answer (`apiRequest` in `apps/web/src/api/client.ts`). There is no OpenAPI document or generated client; spec 0007 brings OpenAPI back with the public API.

## Stack

TypeScript, Zod (`catalog:` version). Built to `dist/` with `tsc`; consumers import the built output, so build before typechecking dependents (Turborepo handles this).

## Commands

```bash
pnpm --filter @ssdashboard/contracts build
pnpm --filter @ssdashboard/contracts test   # src/**/*.spec.ts and test/*.spec.ts
```

## Conventions

- One file per module's shapes (`src/health.ts`), re-exported from `src/index.ts`.
- A module with several pure parts is a folder: `src/customers/`, `src/orders/`, `src/credit/`, `src/settlement/`, `src/tasks/`, and `src/audit/` (the actor union, the entry and list shapes, and the `AUDIT_ACTIONS` registry, whose labels are `@ssdashboard/i18n` message keys), plus `src/platform/cost-rules.ts` beside `src/platform.ts`. One file per concern. Each file is re-exported from `src/index.ts`, so consumers import from the package root, not from the folder path.
- The enums in `src/orders/`, `src/customers/`, `src/credit/`, `src/settlement/`, `src/tasks/`, and `src/platform/cost-rules.ts`, plus `LedgerSourceType` and `ReservationStatus` (`src/inventory.ts`), `CostBasis` (`src/catalog.ts`), `LocationOwnerType` (`src/locations.ts`), and `StockReceiptStatus` (`src/stock-receipts.ts`), match the database enums of the same meaning (for example `FulfillmentState` and `orders.fulfillment_state`). `packages/db/test/enum-parity.e2e-spec.ts` fails when one drifts. Keep both in step in one change.
- Every reason, outcome, or account code on append only history is a `ReasonCode` (`src/orders/order-states.ts`), the twin of the database's `reasonCodeShape` check: a code, never a typed note. Settlement's two free text fields are capped at 500 characters (`SettlementPartnerText`, `SettlementPaymentReference`), like their database checks.
- `deriveOrderOutcome` is the only place an order outcome is computed. Never set `orders.outcome` by hand.
- `InvalidPhone` never carries the input text (Law 151). Never put raw phone text into an error message or a log line.
- Schemas are the source of truth; export types with `z.infer`, never a hand written duplicate.
- ESM with NodeNext resolution: relative imports need the `.js` suffix.
- Money never touches a float. Amounts and unit costs cross boundaries as `numeric` text (`MoneyString`, `UnitCostString`) and are parsed into `Money` (cents) and `UnitCost` (ten thousandths) on bigints; every rounding is half away from zero, once. Line totals come from `LineAmounts.compute` (`src/money.ts`).
- Typed numbers at an input edge use `quantityInput`, `moneyInput(digits)`, and `westernDigits` (`src/digit-input.ts`, built on `@ssdashboard/i18n`), so Arabic digits and separators are normalized before the range rules run (spec 0004 AC-18). Never on passwords, tokens, names, search, free text, or response schemas.
- Localized text is `LocalizedText` (`{ en?, ar? }`, `src/localized-text.ts`); reuse it for every `jsonb` name or description field.
- The web calls `/api` with `fetch` and parses the answer with the contract schema (`ConfigResponse.parse`, or `apiRequest(method, path, Schema)`); if OpenAPI is added later, that feature migrates those calls.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
