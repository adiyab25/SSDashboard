# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Settings registry in `packages/contracts/src/settings/`: one typed entry per brand setting, read through `SettingsService` and written through `PUT /api/settings/:key`. Every write is audited with its reason (PR #37, spec 0009 AC-1 to AC-5).
- Signed license: `{ keyId, payload, signature }` envelopes verified with Ed25519 in the api, recorded in the append only `licenses` and `license_checks` tables, with `LICENSE_FILE` and `LICENSE_CHECK_CRON` in `env.ts`. Upload and read through `POST` and `GET /api/platform/license` (PR #39, spec 0009 AC-14 to AC-16 and AC-20; migrations 0003 and 0004).
- Only the committed development key is trusted, and only when `NODE_ENV` is not `production` and `APP_VERSION` is `0.0.0-dev`. A production build refuses every license until the owner's production public keys are added (spec 0009 owner ruling 1).
- Module registry in `packages/contracts/src/modules/`, the `ModuleGate` guard (404 `MODULE_OFF`, 500 `MODULE_MISSING`), `@RequiresModule` and `@RequiresCapability` on every controller, `GET /api/platform/modules`, module toggles stored as `module.<key>.enabled` settings, and `GET /api/settings/:key/off-impact` (PR #40, spec 0009 AC-6 to AC-13 and AC-30).
- `JobRegistry` and `ModuleJobSupervisor` in `apps/api/src/platform/jobs/`: schedules removed, workers stopped, and queued jobs cancelled when a capability stops, and the `platform.backfill` queue on turn on (PR #40, spec 0009 AC-10, AC-11).
- Lapse, wind down, and renewal: `bundlePhase`, `LicenseService.notice`, `inWindDownScope`, the `WindDownEnded` event, the phase watch cron, renewal backfills, and the `wind_down_ended` manager task (PR #46, spec 0009 AC-15 to AC-19).
- Executing steps as `kind: executing_step` settings, checked in order by `StepTurnOnCheck` (PR #48, spec 0009 AC-21).
- `GET` and `PUT /api/inventory/owner-policies`, with `policy.changed` audited and the four consistency rules as api checks (PR #48, spec 0009 AC-24).
- `GET` and `POST /api/platform/cost-rules`, with `cost_rule.recorded` and `cost_rule.recorded_in_locked_period` audited (PR #48, spec 0009 AC-23).
- Settings screens at `/settings` and `/settings/cost-rules` in the back office (PR #48, spec 0009 AC-25).
- Carrier and cash moves on orders (spec 0013 AC-15 to AC-17, in `apps/api/src/orders/transitions/carrier-moves.ts`): a carrier fact moves the open lines and the cash, a partial delivery splits a line, and collections, deposit remittance, reconciliation, and exchanges are recorded with a reason and an audit entry. They run in process with no route yet; feature 19 will call them.
- Shipment posting for orders (spec 0013 AC-24, AC-27 b): a carrier shipped fact or a Shopify stock out takes the order's pieces out of the stock ledger once per generation through the `orders.post_shipment` job. A retry never posts twice, and a cancel before pickup books the pieces back once.
- Shopify stock out and awaiting restock on orders (spec 0013 AC-27 b to g): the stock out block, the Awaiting restock filter, `POST /api/orders/:id/lines/:lineId/restock`, `POST /api/orders/:id/lines/:lineId/close-awaiting-restock`, and a daily overdue check at 06:00. The Shopify inbox calls wait on spec 0015 task 9a.

### Changed
- Every api controller now declares exactly one module or capability gate. `channels`, `customers`, and `orders` are core modules with their own registry rows (PR #40).
- Every background job runs on the `JobRegistry`, and every job handler asks `ModuleStateService.isRunnable` before it does work (PR #40, spec 0009 AC-10).
- Migration `0011_owner_policy_editing` adds the `locked_terms_changed_at` column and four CHECK constraints to `location_owner_policies`. Migration `0012_owner_policy_grant` grants the app role column level UPDATE on the eight policy columns and the three bookkeeping columns, and nothing else (PR #48).
- `unarchive` of a location whose locked owner terms changed after it was archived answers 409 `OWNER_POLICY_CHANGED_SINCE_ARCHIVE` (PR #48, spec 0009 AC-24).
- Migrations `0024_orders_stock_out` and `0025_orders_restock_cap` add the stock out and restock columns, their checks, and one index (expand only, no data moved). Pack answers 409 `STOCK_ALREADY_LEFT` once a stock out is requested, and a line's Short mark clears once its stock has left.

### Security
- `inventory_lock_date` and `document_prefixes` are registered with `onInvalid: 'refuse'`. A damaged stored value stops the ledger and numbering work with 409 `LOCK_DATE_UNREADABLE` or `DOCUMENT_PREFIXES_UNREADABLE` instead of running without its guard (PR #37, spec 0009 AC-2).
- License rows are stamped by the database (`id`, `seq`, `recorded_at`), and the duplicate check runs under `LICENSE_CHECK_LOCK` (PR #39).
- Changes to the owner policy rows are kept consistent by database CHECK constraints, so the api cannot store partner or customer stock as sellable online (PR #48, migration `0011`).
