# apps/api/src/inventory

## Overview

The inventory module and its ledger service, the only writer of stock in the system. Every stock change in every module is a posting through `LedgerService` (`post`, `reverse`); reads (`getLevels`, `getAvailable`) and reservations (`reserve`, `release`) live here too. The full contract is [spec 0002](../../../../docs/specs/0002-core-data-model/index.md).

## Key files

| File | Owns |
|---|---|
| `inventory.module.ts` | Exports `LedgerService` and `ReconciliationService`; other modules import these, never the tables |
| `ledger/ledger.service.ts` | `post`, `reverse`, `reserve`, `release`, `getLevels`, `getAvailable`; the posting transaction (`apply`) |
| `ledger/costing.ts` | Pure cost rules: `costInbound`, `costOutbound`. Every money rule lives here, unit tested against the spec's worked examples |
| `ledger/locks.ts` | `ledgerTransaction` (READ COMMITTED, 5 second lock cap, one deadlock retry, `LockTimeout`) and `lockPairs` (the SKU and location advisory lock) |
| `ledger/request-hash.ts` | The idempotency request hash (line order and cost format do not matter) |
| `ledger/reconciliation.service.ts` | The nightly `reconcile` (one REPEATABLE READ snapshot) and the admin `rebuildLevel` |
| `ledger/reconcile.job.ts` | The pg-boss job, registered only by `WorkerModule` |
| `ledger/ledger.errors.ts` | `LedgerError` with a stable `code`; feature 7 maps codes to HTTP errors |
| `module-boundary.spec.ts` | Fails if any file outside this folder (or any extension) names a ledger table |

## Conventions

- Only this folder may touch `movement_groups`, `stock_movements`, `movement_serials`, `stock_levels`, `reservations`, and `serials`. A lint rule in `apps/api/eslint.config.js` and `module-boundary.spec.ts` enforce it.
- Every writer of balances, reservations, or discrepancies runs inside `ledgerTransaction` and takes `lockPairs` for each SKU and location before it reads or locks any balance or reservation row. A new writer that skips either breaks the AC-4 reserved stock check or can deadlock.
- Money is `Money` and `UnitCost` from `@ssdashboard/contracts` (bigint, rounded once, half away from zero). Cost rules change in `costing.ts` only, with a test per rule, never inline in SQL.
- Dates are compared in SQL against the stored values (`effective_at`, `recorded_at`), and calendar dates use the `timezone` setting (Africa/Cairo); never parse timestamps in JS for a rule.
- Movements are never updated or deleted. A correction is `reverse`, which writes opposite movements costed by the normal rules.
- Throw `LedgerError` with a code for every rule a caller can break; plain `Error` is only for "cannot happen" states.

## Gotchas

- Run the database suites after any change here: `pnpm build && pnpm --filter @ssdashboard/api test:e2e`. They check after every test that each balance still equals its movement sums.
- A lot tracked SKU is posted and reserved by lot only; a reservation's lot must equal the shipping line's lot.
- `rebuildLevel` fixes only `balance` discrepancies; reservation and serial ones raise `NotRebuildable` and stay open until feature 25 adds a dismiss action.

_Drafted by /sync from the introducing change, worth a quick human pass._
