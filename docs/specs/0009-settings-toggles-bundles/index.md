# 0009. Settings, module toggles, bundles, and the license from one typed registry

**Date**: 2026-11-05
**Status**: Proposed
**Depends on**: the feature 4 baseline ([spec 0002 amendment](../0002-core-data-model/index.md#amendment-2026-11-05), [tenancy child](../0002-core-data-model/0002-tenancy-platform.md): `tenant_id`, the `install` row, the `settings` table keyed on (`tenant_id`, `key`), `ssd_operating_day`, `ssd_reject_change()`, the append only list, the table ownership map; [catalog child](../0002-core-data-model/0002-catalog-locations.md): `location_owner_policies`, `LocationPolicyService`, `order_cost_rules`, `CostRulesService`). Milestone 1 starts only after that baseline migration has landed. The audit writer of [spec 0010](../0010-audit-trail/index.md) (`AuditService.record`) is needed by task 5; hats (spec 0008, written in parallel) are a soft dependency: until they land, the spec 0005 `admin` role stands in for "manager".

## Summary

One image becomes a Warehouse install, an Operations install, or both through three things kept in one place: a typed list of every brand setting (what it is, its default, who may change it), a list of modules with the bundle each belongs to and an on or off switch, and a signed license file that says which bundles the brand bought and until when. When a module is off, its pages hide, its api answers "module off", and its background jobs and schedules are removed, so nothing is left running half way. When the yearly Operations plan lapses, the app warns first (30, 14, 7 days), gives 14 days of grace, then winds down gently: it keeps following shipments already out with Bosta until their cash settles, and a renewal catches up on the gap. Every step that acts on the outside world on the brand's behalf (creating Bosta shipments, refunding, writing to Shopify, sending Meta events or WhatsApp messages, approving exchanges by rule) is its own switch, off on a fresh install.

## Requirements

**User stories**:
- As the brand's manager, I want one settings screen where I can see and change how the brand works (policies, automations, modules, owner types, cost rules), with the reason recorded, so that the app fits the brand without a developer.
- As the vendor, I want one image for every brand, switched by a license and toggles, so that a Warehouse only brand and a full Operations brand run the same tested code.
- As the brand owner, I want a lapsed Operations plan to warn me early and never strand cash already out with the carrier, so that I am never afraid of the app switching off under me.
- As an operations agent, I want automations to stay off until a manager switches each one on, so that nothing ships, refunds, or messages a customer by surprise.
- As a developer, I want a module that is off to leave no schedules, queued jobs, or half sent commands behind, so that turning it back on is safe.

**Acceptance criteria**:

*The settings registry and its read path*
- **AC-1** (registry): Every brand setting is one entry in one registry in `packages/contracts/src/settings/` with: `key`, the Zod `schema` of its value, `default`, `bundle` (`core`, `warehouse`, or `operations`), `group` (the settings screen section), `whoMayChange` in business words (`manager` or `nobody`; feature 8 maps `manager` to its permission), `reason` (`required` or `optional`, passed to `AuditService.record` as the tightening flag spec 0010 AC-5 allows), `exposure` (`public_config` or `staff`), and `sqlRead` (true when SQL reads the row, so a seed row must exist). A unit test (`registry.spec.ts`) fails when two entries share a key, a default fails its own schema, a `sqlRead` key has no seed row in the baseline, an `executing_step` entry defaults to anything but `false`, or an entry lacks an English or Arabic label key.
- **AC-2** (one read path): `SettingsService.read(keys)` and `SettingsService.get(key)` are the only readers of the `settings` table and return typed values. A key with no row returns its registry default. A stored value that fails its schema returns the default, logs one error naming the key (never the value), and is flagged `invalid` in the staff read. A read given a transaction (`executor`) goes to the database; any other read is served from a per process cache. Reading a key that is not in the registry fails `tsc`.
- **AC-3** (one write path): `PUT /api/settings/:key` validates the value with the entry schema and, in one transaction, writes the row (`updated_at`, `updated_by`), writes the `setting.changed` audit entry with before, after, and reason, sends `NOTIFY ssd_platform_changed`, and enqueues the `platform.reconcile_modules` job. It answers 404 `SETTING_UNKNOWN`, 422 `SETTING_INVALID` (with the Zod issues), 422 `REASON_REQUIRED`, 409 `STALE_SETTING` when `expectedUpdatedAt` differs from the row, 409 `SETTING_LOCKED` when `whoMayChange` is `nobody`, and 403 for anyone who is not a manager.
- **AC-4** (cache across processes): after a committed change, a running api and a running worker both read the new value within 5 seconds (LISTEN on `ssd_platform_changed`); with the listener connection killed, both read it within 35 seconds (a 30 second cache lifetime), and the listener reconnects by itself. A rolled back change is never seen by any process.
- **AC-5** (what is public): `GET /api/config` stays `@Audience('public')` and returns exactly the fields of spec 0004 AC-4 (`clientName`, `version`, `currency`, `timezone`, `languages`, `defaultLanguage`, `mailEnabled`) and only registry entries marked `public_config`. Nothing about bundles, the license, module states, executing steps, policy knobs, owner policies, or cost rules. A test asserts the exact key set.

*Modules, bundles, and what "off" means*
- **AC-6** (module registry): one registry in `packages/contracts/src/modules/` lists every api module with its `bundle`, whether it has a toggle (`core` modules never do), the modules it `requires`, and its capabilities. A capability has a `key`, a `bundle` (may differ from its module's, for example the Shopify stock push is `warehouse` inside the `core` connectors module), a `kind` (`read`, `write`, or `executing_step`), and `windDown` (true only for the read only work that continues after a lapse). A unit test fails when a `core` module requires a non core module, a module requires one with no path to it, or a capability key repeats.
- **AC-7** (one state rule): one pure function, `moduleState` in `packages/contracts/src/modules/module-state.ts`, gives every module and capability one state: `on`, `read_only`, or `off`, from the licensed bundles, the Operations phase (AC-15), the module toggle, and, for an executing step, its switch. `read_only` applies when the bundle was licensed at some point on this install (or the module was toggled off while licensed); `off` when the bundle was never licensed. An exhaustive test covers every combination.
- **AC-8** (routes): every api controller declares exactly one `@RequiresModule(key)`; `requires-module.spec.ts` fails the build otherwise (the same shape as `audience.spec.ts`). A global `ModuleGate` guard, after the audience guard, answers 404 `{ "code": "MODULE_OFF" }` for every route of an `off` module, and for every non `GET` route of a `read_only` one; `GET` routes of a `read_only` module keep answering so the brand's data stays readable. Portal routes (`@Audience('portal')`) answer 404 `MODULE_OFF` unless their module is `on`. Hook routes (`@Audience('hook')`) never answer 404 for module state: they answer 200 and the connector records `ignored_unlicensed`, except the wind down events of AC-18. No route answers 500 because a module is off.
- **AC-9** (screens): the back office shell reads `GET /api/platform/modules` and hides every navigation and command palette entry whose module is `off`, and every action entry (new, approve, queue) whose module is `read_only`, which shows its history pages with a read only notice. A page of an `off` module opened by its URL shows a "not available on this install" state inside the shell with one `<h1>`, never a crash. Module state is refetched on window focus, at most every 60 seconds otherwise, and at once after any api answer of 404 `MODULE_OFF`. Changing a toggle, a step, or the license never signs anyone out. Both languages, keyboard reachable.
- **AC-10** (no orphaned jobs): every pg-boss queue and cron schedule is declared through the platform `JobRegistry` with the capability it serves. When a capability stops being runnable (`off`, or `read_only` without `windDown`), the worker's `ModuleJobSupervisor`, in this order: removes its schedules (`unschedule`), stops its workers (`offWork`), and cancels its queued jobs (`cancel`); marks its `waiting` outbound commands `failed` with reason `MODULE_OFF` (one task for the manager per capability, not one per command, feature 17); and calls the capability's `onDisable` hook (connector features remove the Shopify and Meta webhook subscriptions they registered through those APIs). Every job handler asks `ModuleStateService.isRunnable(capability)` before any work; a job that starts in the race window completes with output `{ "skipped": "MODULE_OFF" }`, never `failed`. The test `apps/api/test/module-off-no-orphaned-jobs.e2e-spec.ts`, case "a module turns off with no orphaned jobs", proves it with a fixture Operations module: after the toggle, `getSchedules()` lists none of its queues, `findJobs` with `queued: true` finds none, no job of the module is `active` or `failed`, its waiting command is `failed` with `MODULE_OFF`, its routes answer as AC-8 says, and no error level log line was written.
- **AC-11** (turning back on): turning the same module on again restores its schedules (in the current `timezone` setting) and workers, replays nothing that was cancelled, leaves `MODULE_OFF` commands for a person to retry, and, when the capability declares a `backfill`, enqueues one backfill job for the gap from the moment it went off to now (singleton key on the gap, so a second reconcile adds none). Same test file, case "turning it back on restores schedules and replays nothing".
- **AC-12** (toggles): a module toggle is the setting `module.<key>.enabled` (default `true`), changed only by a manager with a required reason through AC-3. Turning on a module whose bundle is not licensed answers 409 `NOT_LICENSED`; turning off a module that another `on` module requires answers 409 `MODULE_REQUIRED_BY` with the dependants; a `core` module has no toggle (404 `SETTING_UNKNOWN`). The worker reconciles within 5 seconds (the `platform.reconcile_modules` job from AC-3) and at worker start.
- **AC-13** (calls between modules): a core module never depends on an optional one; it asks `ModuleStateService.isOn(key)` before calling one. Write methods of an optional module's exported services call `ModuleStateService.assertOn(key)` and throw the domain error `ModuleOff`; its in process event listeners return without work when it is not `on`.

*The license*
- **AC-14** (file and verification): a license is a JSON envelope `{ "keyId", "payload", "signature" }` of at most 16 KB, where `payload` is base64url of UTF 8 JSON bytes and `signature` is a base64url Ed25519 signature over exactly those bytes. The payload (Zod, strict) is `{ "format": 1, "licenseId", "clientCode", "tenantId", "bundles" (non empty subset of `warehouse`, `operations`), "operationsExpiresOn" (a date, present exactly when `operations` is in bundles), "issuedOn" }`. Verification uses only public keys built into the image (`license-keys.ts`), never the network. A key marked `devOnly` is refused when `NODE_ENV` is `production`. `clientCode` and `tenantId` must equal the `install` row. A license is checked at api start, at worker start, daily by the worker (`LICENSE_CHECK_CRON`), and on upload; a valid one not yet recorded is added to `licenses`.
- **AC-15** (Operations phases): one pure function, `operationsPhase` in `packages/contracts/src/license/license-phase.ts`, from the latest `operationsExpiresOn` among all recorded licenses, today's date in the `timezone` setting, `operations_wind_down_days`, the count of open wind down items, and whether the wind down already ended, returns `not_licensed`, `active`, `expiring` (0 to 30 days left; behaves as active), `grace` (expiry plus 1 to plus 14 days; behaves as active), `wind_down`, or `off`. The lapse instant is local midnight starting day expiry plus 15. The test covers expiry day (still `expiring`, 0 days left), day 1 and day 14 of grace, the lapse day, the last wind down day, an early end at zero open items, and that `off` stays `off` until a renewal.
- **AC-16** (bad or missing file): a missing file, an unset `LICENSE_FILE`, unreadable or malformed JSON, a bad signature, an unknown key, a dev key in production, or a license for another install each records a `license_checks` row with its outcome, logs one error with the outcome and the file's SHA 256 (never its contents), and changes nothing else: recorded licenses keep counting, so a deleted or damaged file never switches a module off. The api and the worker keep running. The manager sees a banner naming the outcome. With no license ever recorded, only `core` modules are on.
- **AC-17** (warnings): `LicenseService.notice(day)` returns the phase, days left, and a level. The shell shows a banner to managers only from 30 days before expiry and through grace and wind down; the daily report's automation status line (feature 25) includes it on days 30, 14, and 7 before expiry and on every grace and wind down day. A warning is never shown to other hats and never sent outside the brand's own report channel.
- **AC-18** (lapse and wind down): at the lapse instant the next license check (or the worker start) records phase `wind_down` and emits `LicenseChanged`; every Operations capability without `windDown` goes `read_only` and loses its jobs as AC-10 says (the confirmation queue, driver mode, new shipment mirroring, Meta and WhatsApp sends stop). Capabilities with `windDown` (the Bosta mirror reads and the cash cycle sweep, declared by features 19 and 22) keep running only for shipments created before the lapse instant, read from `LicenseService.windDown()`. During the wind down a Bosta webhook for a pre lapse shipment is still enqueued; one for a later shipment, and every Operations event after the wind down ends, is answered 200 and recorded `ignored_unlicensed` (carried n2). The wind down ends at `operations_wind_down_days` after the lapse, or earlier when every wind down capability reports zero open items (orders not in a final cash state: `reconciled`, `nothing_to_collect`, `prepaid`). Core capabilities never change. The test `apps/api/test/license-lapse.e2e-spec.ts` proves each step with a fixture clock.
- **AC-19** (renewal): recording a license whose `operationsExpiresOn` is later moves the phase to `active` or `expiring` and emits `LicenseChanged`. From `wind_down` or `off`, the supervisor restores schedules and enqueues each Operations capability's `backfill` job once for the gap from the lapse instant to the renewal (singleton key on the gap). From `grace`, nothing was stopped, so nothing is backfilled. Same test file.
- **AC-20** (installing a license): a manager can upload a license on the settings screen (`POST /api/platform/license`), which verifies it like the file, records it, and writes the `license.added` audit entry. A license that verifies but grants nothing new (an older or identical one) answers 200 with `changed: false`. Recorded licenses only ever add: a new license never shortens an expiry or removes a bundle. The Warehouse bundle has no expiry and never switches off by time.

*Executing steps and policy knobs*
- **AC-21** (executing steps): each step in *Executing steps* below is its own registry entry with `kind: executing_step`, default `false`, `whoMayChange: manager`, reason required, its bundle, and an optional precondition its feature supplies (turning on answers 409 `STEP_PRECONDITION` with the precondition's code). A fresh install has every step off. The code that executes asks `ModuleStateService.isRunnable(step)` inside the job, at the moment it would act, never only at enqueue time; turning a step off makes queued executions complete as skipped and marks their waiting commands `failed` with reason `STEP_OFF`, as AC-10 does for a module.
- **AC-22** (policy knobs): the knobs in *Policy knobs* below exist with the defaults shown, are changed only by a manager with a required reason, and each feature that applies one records the value it used on its decision (for example the approval record of feature 31). Changing `operating_day_cutoff_hour` or `timezone` shows that days already stamped are never restated, and the supervisor re registers every cron schedule in the new time zone within 5 seconds.
- **AC-23** (per order cost rules): a person with the cost permission sees the current rule for each kind and its history; a manager with the cost permission adds a rule (`set` with a value, or `not_set`) from an effective date through `CostRulesService.record` (a new append only row, `cost_rule.recorded` audit entry, reason required). The rules from spec 0002 AC-32 hold (percent 0 to 100, a value exactly when `set`).

*Location owner types as a setting*
- **AC-24** (owner policy editing): a manager edits a `location_owner_policies` row on the settings screen through `PUT /api/inventory/owner-policies/:ownerType`, served by the inventory module (which owns the table) through `LocationPolicyService.updatePolicy`, with a required reason, the `policy.changed` audit entry, and `expectedUpdatedAt` (409 `STALE_SETTING`). It refuses: an inconsistent row (`handover_is_sale` must equal not `stock_owned_by_brand`, and `sale_recorded_at` is `at_handover` exactly when `handover_is_sale`) with 422 `OWNER_POLICY_INCONSISTENT`; any change to the stock fields (`stock_owned_by_brand`, `handover_is_sale`, `sale_recorded_at`) of the `own` row, or of a row with at least one location that is not archived, with 409 `OWNER_POLICY_IN_USE`; and `can_sell_online` set to false while a location of that type has `sellable_online`, with 409 `SELLABLE_LOCATIONS_EXIST`. A change answers only future questions; recorded movements and settlement lines are never reinterpreted. `test/location-owner-types.e2e-spec.ts` (spec 0002) still passes, and a new case edits a refund field through the endpoint and sees the next `policyFor` answer change with no code branch.

*The settings screen and staff reads*
- **AC-25** (settings screen): a manager opens `/settings` in the back office (one `<h1>`) with sections: Brand (languages, default language, currency shown read only, time zone, operating day cutoff, document prefixes, prices include VAT, inventory lock date), Modules and license, Automations (executing steps), Policies, Location owner types, and Cost rules (only with the cost permission). Each item shows its value, its default, whether it is the default, who changed it last and when, and whether its bundle is licensed (an unlicensed item is shown disabled with "needs the Warehouse plan" or "needs the Operations plan"). A change opens a dialog with the new value and a reason field (required where the registry says so); turning on an executing step states in plain words what the app will start doing for the brand. Errors show on the field from the stable codes. Both languages, logical CSS, keyboard and focus support, axe clean, built to `packages/ui/DESIGN.md`. Any other hat opening `/settings` gets the 403 state.
- **AC-26** (staff reads): `GET /api/settings` (manager) returns every registry entry the caller may see with value, default, `isDefault`, `invalid`, `updatedAt`, `updatedBy` (name through the identity service), `canChange`, and `licensed`. `GET /api/platform/modules` (any staff hat) returns each module's and capability's state and, for a manager only, the license notice. `GET /api/platform/license` (manager) returns bundles, Operations expiry, phase, days left, the last check's outcome, and the recorded licenses (id, issued, source, recorded at), never signatures or file paths.

## Decision

**Chosen option**: Option 2 in [rationale.md](rationale.md): one typed registry in `packages/contracts` for settings and modules, module toggles and executing steps stored as ordinary settings rows, a signed license file whose verified copies are recorded in an append only table, and one worker supervisor that reconciles jobs and schedules with the computed module states.

Module toggles and executing step switches are settings (one table, one cache, one audit path, one screen), and their bundle gate comes from the registry; only the license needs its own two tables. Runner up: a dedicated `module_toggles` table with its own service, rejected because it doubles the read, cache, audit, and screen paths for a boolean per module.

**Implementation skills**: `nestjs-best-practices` (`kadajett/agent-nestjs-skills`, `.claude/skills/nestjs-best-practices/`) · `pg-boss-v12` (`sncollective/snc-platform`, `.claude/skills/pg-boss-v12/`) · `tl-pg-boss` (`toddlevy/tl-agent-skills`, `.claude/skills/tl-pg-boss/`) · `drizzle-orm-patterns` (`giuseppe-trisciuoglio/developer-kit`, `.claude/skills/drizzle-orm-patterns/`) · `postgresql-table-design` (`wshobson/agents`, `.claude/skills/postgresql-table-design/`) · `react-hook-form-zod` (`.claude/skills/react-hook-form-zod/`) and `tanstack-query` (`.claude/skills/tanstack-query/`) for the settings screen (their source repositories are not recorded in any `AGENTS.md`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Feature design

### Where things live

- `packages/contracts/src/settings/`: the settings registry (`registry.ts`, one file per group it imports), value schemas, `SettingEntryView`, `PutSettingBody`. Pure, no Nest.
- `packages/contracts/src/modules/`: the module and capability registry, `moduleState`, `ModuleStatesResponse`.
- `packages/contracts/src/license/`: `LicenseEnvelope`, `LicensePayload`, `operationsPhase`, `LicenseSummary`, `LicenseNotice`.
- `apps/api/src/platform/settings/`: `SettingsService` (moved from `platform/settings.service.ts`), `SettingsController`, `SettingsCache`, `PlatformChangesListener` (LISTEN).
- `apps/api/src/platform/modules/`: `@RequiresModule`, `ModuleGate`, `ModuleStateService`, `ModulesController`, `requires-module.spec.ts`.
- `apps/api/src/platform/license/`: `LicenseService`, `LicenseVerifier`, `license-keys.ts`, `LicenseController`, the daily check job, `sign-license.ts` (the vendor's signing command, run from a checkout with a private key path; harmless without the key).
- `apps/api/src/platform/jobs/`: `JobsModule` (one `PgBoss` instance per process: send only in the api, work and schedule in the worker), `JobRegistry`, `ModuleJobSupervisor` (worker only). The existing `ReconcileJob`, `AuthCleanupJob`, and mail worker move onto it, each declaring its capability (`inventory.reconcile`, `identity.cleanup`, `mail.send`, all `core`).
- `apps/api/src/inventory/locations/`: `OwnerPoliciesController` and `LocationPolicyService.updatePolicy` (the inventory module owns the table).
- `apps/web/src/settings/` (feature folder with README) and `apps/web/src/app/(backoffice)/settings/page.tsx`; the shell's `nav.ts` gains a `module` field per entry.

### Data model sketch

No change to `settings` (spec 0002: `tenant_id`, `key`, `value jsonb`, `updated_at`, `updated_by`; primary key (`tenant_id`, `key`)). Rows exist only for changed values and for the seeded `sqlRead` keys; a missing row means the registry default. Module toggles are keys `module.<module key>.enabled`; executing steps are keys `step.<step key>`.

Two new platform tables, both append only (`ssd_reject_change()` triggers and the app role revokes of the tenancy child A4), both in `packages/db/src/schema/platform.ts` and in `table-ownership.ts` under `platform`:

| Table | Fields | Constraints and indexes |
|---|---|---|
| ★ `licenses` | `id uuid pk`, `tenant_id`, `license_id text` (the vendor's id from the payload), `key_id text`, `envelope text` (the file as verified, at most 16 KB), `sha256 text`, `client_code text`, `bundles text[]`, `operations_expires_on date null`, `issued_on date`, `source` enum (`file`, `upload`), `recorded_at timestamptz default now()`, `recorded_by uuid fk users null` | unique (`tenant_id`, `sha256`); check `bundles <@ array['warehouse','operations']` and `cardinality(bundles) > 0`; check (`'operations' = any(bundles)`) = (`operations_expires_on is not null`); index (`operations_expires_on desc`) |
| ★ `license_checks` | `id uuid pk`, `tenant_id`, `checked_at timestamptz` (from `PlatformClock`, the database clock in production), `trigger` enum (`api_start`, `worker_start`, `daily`, `upload`), `outcome` enum (`valid`, `already_recorded`, `none_configured`, `file_missing`, `file_unreadable`, `bad_format`, `bad_signature`, `unknown_key`, `dev_key_in_production`, `wrong_install`), `file_sha256 text null`, `license_row_id uuid fk licenses null`, `operations_phase` enum (`not_licensed`, `active`, `expiring`, `grace`, `wind_down`, `off`), `warehouse_licensed bool`, `clock_behind bool default false` | index (`checked_at desc`). About three rows a day; kept for the life of the install (support evidence) |

A check takes `pg_advisory_xact_lock(hashtext('ssd.license_check'))`, reads the latest check row, evaluates, inserts its row, and emits `LicenseChanged` only when `operations_phase` or `warehouse_licensed` differs from the previous row, so the api and the worker starting together emit it once.

`clock_behind` is true when `now()` is more than 24 hours before the latest earlier `checked_at`. It is recorded and shown, never used to change the phase (see rationale). `LicenseService` reads time only through an injected `PlatformClock` (`SELECT now()` in production), which the lapse and license tests replace with a fixed clock.

### Module registry (initial)

Modules that exist today, all `core`, no toggle: `platform`, `audit`, `identity` (today `auth` and `staff`), `catalog`, `inventory`, `mail`, `health`. Each later module adds its row when its feature builds it, with the bundle from the scope table: `customers`, `orders`, `tasks`, `settlement`, `channels`, `connectors`, `exports`, `reporting` (`core`, no toggle, with capabilities of other bundles); `credit`, `exchanges`, `partners` (`operations`, toggle); purchasing and production (`warehouse`, toggle) with slices 4 and 5. Capabilities that cross a bundle inside a core module, as the scope's bundle labels require: `orders.confirmation_queue` (operations), `connectors.shopify.stock_push` (warehouse), `connectors.bosta.*` and `connectors.meta.*` and `connectors.whatsapp.*` (operations), `inventory.counts` and `inventory.transfers` (warehouse), `reporting.daily_report` and `reporting.dashboard` (operations), `reporting.stock_value` (warehouse), `settlement.carrier_reconciliation` and `settlement.partner` (operations). Wind down capabilities: `connectors.bosta.mirror_reads` and `connectors.bosta.cash_cycle_sweep` (features 19 and 22).

### Effective state

```
moduleState(capability), first matching rule wins:
  1. bundle is operations and phase = wind_down  -> capability.windDown ? on (pre lapse work only) : read_only
  2. bundle is operations and phase = off        -> read_only
  3. bundle not licensed now                     -> ever licensed on this install ? read_only : off
  4. module toggle false                         -> read_only
  5. kind = executing_step and switch false      -> off (for that step only; its module keeps its own state)
  6. otherwise                                   -> on
```

"Licensed now" is `core` always; `warehouse` when any recorded license has it; `operations` when the phase is `active`, `expiring`, or `grace`. "Runnable" (jobs) means state `on`.

### Operations phase

| Today (local date in `timezone`) | Phase |
|---|---|
| no recorded license has `operations` | `not_licensed` |
| more than 30 days before expiry | `active` |
| 30 to 0 days before expiry (expiry day included) | `expiring` |
| expiry plus 1 to expiry plus 14 | `grace` |
| from expiry plus 15 (the lapse instant is local 00:00 that day) until the wind down ends | `wind_down` |
| after `operations_wind_down_days`, or once open items reached zero, until a renewal | `off` |

Expiry is the latest `operations_expires_on` across all recorded licenses.

### Executing steps (each default off, manager only, reason required)

| Key | Bundle | What the app starts doing when on | Owning feature (registers the entry and its precondition) |
|---|---|---|---|
| `step.shopify_order_edit_write_back` | operations | writes confirmation edits (address, variant, added line) to the Shopify order | 18 |
| `step.shopify_duplicate_cancel` | operations | cancels duplicate orders on Shopify with a reason | 18 |
| `step.shopify_return_exchange_write_back` | operations | records returns and exchanges on the Shopify order | 37 |
| `step.shopify_stock_push` | warehouse | pushes stock quantities from the ledger to Shopify | 13 |
| `step.carrier_driver_forward` | operations | creates forward delivery shipments at Bosta | 32 |
| `step.carrier_driver_exchange` | operations | creates exchange shipments with the cash difference | 32 |
| `step.carrier_driver_return_pickup` | operations | creates return pickups, with the cash refund for COD refunds | 32, 35 |
| `step.exchange_auto_approve_clean_swaps` | operations | approves clean size swaps without a person | 31 |
| `step.refund_gateway_execute` | operations | fires card and wallet refunds through Shopify | 35 |
| `step.meta_purchase_events` | operations | sends Purchase events to the Conversions API on confirmation; precondition: the onboarding step "storefront Purchase event stopped or renamed" is confirmed (carried M7) | 48 |
| `step.whatsapp_customer_messages` | operations | sends template messages to customers | 50 |

Driver mode per shipment type is the three `carrier_driver_*` steps; with all three off the carrier runs in mirror mode (spec 0007 section 1). Not executing steps, so not switches here: reading from any provider; the daily report to the brand's own group (it starts when a manager connects the group); period close confirming itself on matching evidence and exact channel code matches (internal, audited, undoable in one step, spec 0010); a refund by manual transfer (it opens a task).

### Policy knobs

| Key | Bundle | Default | Values | Registered by |
|---|---|---|---|---|
| `operating_day_cutoff_hour` | core | `0` | integer 0 to 23; seeded, read by SQL | spec 0002 seed; screen here |
| `operations_wind_down_days` | operations | `60` | integer 0 to 365 | this feature |
| `exchange_credit_timing` | operations | `{ "cleanSwap": "at_approval", "other": "after_inspection" }` | each `at_approval` or `after_inspection` (final plan 7.3) | 31 |
| `exchange_auto_approve_max_price_difference` | operations | `"0.00"` | money string, at least 0; above it a request goes to a person | 31 |
| `retention_task_on_refund_request` | operations | `false` | boolean; opens a retention task beside a refund, which never waits | 36 |
| `retention_bonus_limit` | operations | `{ "status": "not_set" }` | `not_set`, or `set` with `percentOfRefund` (0 to 100) and `maxAmount` (money string); not set means no bonus may be offered | 36 |
| `portal_challenge` | operations | `"turnstile"` | `turnstile` or `server_challenge` (spec 0007 section 2) | 29 |

Existing keys move into the registry unchanged: `currency` (`whoMayChange: nobody`; set at provisioning, because no money column carries a currency), `timezone` (`sqlRead`, reason required), `prices_include_vat` (reason required), `inventory_lock_date` (reason required), `document_prefixes`, `languages` and `default_language` (`public_config`). Every later feature adds its keys to the registry in its own build.

### API surface

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/config` | GET | none | spec 0004 fields only | `public` | none (settings errors fall back, spec 0004 AC-4) |
| `/api/platform/modules` | GET | none | `modules[]`, `capabilities[]` (`key`, `state`), `licenseNotice?` (manager only) | `staff`, any hat | 401 |
| `/api/settings` | GET | none | `entries[]` (AC-26) | `staff`, manager | 403 |
| `/api/settings/:key` | PUT | `value` (req), `reason` (req or opt per entry), `expectedUpdatedAt` (req, null for a default) | the updated entry | `staff`, manager | 404 `SETTING_UNKNOWN`, 422 `SETTING_INVALID`, 422 `REASON_REQUIRED`, 409 `STALE_SETTING`, 409 `SETTING_LOCKED`, 409 `NOT_LICENSED`, 409 `MODULE_REQUIRED_BY`, 409 `STEP_PRECONDITION`, 403 |
| `/api/platform/license` | GET | none | `LicenseSummary` (AC-26) | `staff`, manager | 403 |
| `/api/platform/license` | POST | `envelope` (string, req, at most 16 KB) | `LicenseSummary`, `changed: boolean` | `staff`, manager | 422 `LICENSE_INVALID` with `outcome`, 403, 413 |
| `/api/platform/cost-rules` | GET | none | current rule per kind, history page (keyset) | `staff`, cost permission | 403 |
| `/api/platform/cost-rules` | POST | `kind`, `status`, `value?`, `effectiveFrom`, `reason` | the new rule row | `staff`, manager with cost permission | 422 `SETTING_INVALID`, 422 `REASON_REQUIRED`, 403 |
| `/api/inventory/owner-policies` | GET | none | the three rows, `lockedFields` per row, `updatedAt` | `staff`, manager | 403 |
| `/api/inventory/owner-policies/:ownerType` | PUT | the row's fields, `reason`, `expectedUpdatedAt` | the updated row | `staff`, manager | 422 `OWNER_POLICY_INCONSISTENT`, 409 `OWNER_POLICY_IN_USE`, 409 `SELLABLE_LOCATIONS_EXIST`, 409 `STALE_SETTING`, 422 `REASON_REQUIRED` |
| any route of a module not `on` | any | | `{ "code": "MODULE_OFF" }` | | 404 (AC-8) |

The settings controllers declare `@Audience('staff')` and `@RequiresModule('platform')`; the owner policy controller `@RequiresModule('inventory')`. All shapes are Zod schemas in `packages/contracts`; the web parses each answer with them.

### Value sourcing

| Action | Value produced or displayed | Source |
|---|---|---|
| any setting read | value | `settings` row, else the registry `default`; invalid row: the default plus `invalid: true` |
| any setting read without a transaction | freshness | per process cache, dropped on `NOTIFY ssd_platform_changed`, lifetime 30 seconds |
| `PUT /api/settings/:key` | who may change, reason rule, bundle | registry entry |
| `PUT /api/settings/:key` | `updated_by` and audit actor | the session's user id |
| `PUT /api/settings/:key` | stale check | input `expectedUpdatedAt` against `settings.updated_at` |
| toggle on | licensed? | `moduleState` from recorded `licenses` and the current phase |
| toggle off | dependants | registry `requires` of modules whose state is `on` |
| `moduleState` | Operations phase | latest `license_checks.operations_phase`, recomputed by `operationsPhase` on each check |
| `operationsPhase` | expiry | max `licenses.operations_expires_on` |
| `operationsPhase` | today | `now()` from PostgreSQL, as a date in setting `timezone` |
| `operationsPhase` | wind down length | setting `operations_wind_down_days` |
| `operationsPhase` | open wind down items | each wind down capability's `openItems(lapsedAt)` (features 19 and 22; orders not in `reconciled`, `nothing_to_collect`, `prepaid` with a shipment created before `lapsedAt`) |
| wind down jobs | which shipments | `LicenseService.windDown().lapsedAt` (local 00:00 of expiry plus 15 in `timezone`) |
| license verify | trusted keys | `license-keys.ts` in the image; `devOnly` keys refused when `NODE_ENV` is `production` |
| license verify | install binding | `install.client_code`, `install.id` |
| license check | file | env `LICENSE_FILE` (path); unset gives outcome `none_configured` |
| daily check | when | env `LICENSE_CHECK_CRON` in setting `timezone` |
| banner and report line | phase, days left | `LicenseService.notice(today)` |
| renewal backfill | gap | from `lapsedAt` to the renewing check's `checked_at` |
| module back on | backfill gap | from `settings.updated_at` of `module.<key>.enabled` as stored before the write that turns it on (the moment it went off) to the new write's time |
| job handler | may it work? | `ModuleStateService.isRunnable(capability)` at the start of the job |
| `MODULE_OFF` commands | which ones | `outbound_commands` in `waiting` whose `kind` maps to the capability (connectors module, through its exported service) |
| owner policy edit | locked fields | `own` row always; other rows when `LocationsService.countActiveByOwnerType(type) > 0` |
| cost rule add | the row | `CostRulesService.record` (append only, spec 0002 AC-32) |
| settings screen | last changed by | `settings.updated_by` resolved by the identity module's exported names service |
| settings screen | labels | `@ssdashboard/i18n` keys named by each registry entry |
| shell navigation | module per item | `nav.ts` entry `module` field against `GET /api/platform/modules` |

### Key invariants

- A missing settings row means the registry default; the default of every `executing_step` is `false`; a `sqlRead` key always has a row.
- Writes to `settings` happen only in `SettingsService.write`, always with an audit entry, a `NOTIFY`, and the reconcile job in the same transaction.
- No pg-boss queue or schedule exists outside `JobRegistry`; a capability that is not runnable has no schedule and no queued job after the supervisor's reconcile, and no handler does work for it.
- `licenses` and `license_checks` are append only; the entitlement is the union of recorded licenses, so it never shrinks except by time.
- License verification never opens a network connection; the private signing key never enters the repository, an image, or an install.
- Only `LocationPolicyService` writes `location_owner_policies`; owner type values are compared nowhere else (spec 0002 boundary test).
- `GET /api/config` exposes no commercial state.

### Security model

- Settings, toggles, steps, policies, owner policies, and the license are read and changed by a manager only (the spec 0005 `admin` role until feature 8 lands). Cost rules need the cost permission to read and the manager hat plus it to change. `currency` changes by nobody in the app. Module states are readable by every staff hat (the shell needs them); the license notice only by managers.
- The license carries no personal data and no secret; tampering only makes it invalid. The worst case of a stolen vendor private key is free bundles for any install; mitigated by keeping it offline and by a second, standby public key in the image for rotation (Questions for the owner).
- A setting reason is free text from staff: stored only in the audit entry (phone shaped text masked by spec 0010), never logged.
- No compliance scope beyond the existing Law 151 logging rule: no setting holds customer data.

### Configuration required

- `LICENSE_FILE`: path to the signed license inside the container (api and worker env lists only). Optional; unset gives `none_configured`.
- `LICENSE_CHECK_CRON`: when the daily license check runs (worker), default `20 0 * * *` in the `timezone` setting, validated by the existing `cron()` helper in `env.ts`.
- Both added to `apps/api/src/config/env.ts`, `.env.example`, and the Compose `api` and `worker` services. `pnpm bootstrap` writes a dev license signed with the committed dev key (`devOnly`) for the local install.

### Critical test scenarios

- Registry: a duplicate key, a default failing its schema, a step defaulting to true, and a `sqlRead` key with no seed each fail `registry.spec.ts`, verifies **AC-1**, **AC-21**.
- Read and write: an absent row reads the default; a corrupt row reads the default with `invalid: true` and one log line without the value; a write with a stale `expectedUpdatedAt` answers 409 and changes nothing; a rolled back write leaves no audit entry and no notification, verifies **AC-2**, **AC-3**.
- Two processes: the api changes `operations_wind_down_days`; a second Nest context (the worker) sees it within 5 seconds; with its listener killed, within 35 seconds, verifies **AC-4**.
- Public config: the exact key set, verifies **AC-5**.
- A module turns off with no orphaned jobs, then turns back on, verifies **AC-10**, **AC-11**, **AC-8**, **AC-12**.
- A controller without `@RequiresModule` fails `requires-module.spec.ts`, verifies **AC-8**.
- `moduleState` and `operationsPhase` exhaustive tables, verifies **AC-7**, **AC-15**.
- License: a valid dev license verifies in test and is refused with `NODE_ENV=production`; one flipped byte gives `bad_signature`; another install's license gives `wrong_install`; deleting the file after a valid check keeps every module on and shows the banner, verifies **AC-14**, **AC-16**, **AC-20**.
- Lapse: with a fixture clock, day minus 30, minus 14, minus 7 notices; grace keeps everything on; the lapse instant cancels the fixture confirmation queue and keeps the fixture wind down sweep for a pre lapse shipment only; a post lapse webhook is `ignored_unlicensed`; open items at zero ends the wind down; a renewal enqueues one backfill for the gap, verifies **AC-17**, **AC-18**, **AC-19**.
- Steps: a fresh install has every step off; turning one on without its precondition answers 409; a queued execution after it is turned off completes skipped, verifies **AC-21**.
- Owner policy: an inconsistent row 422; a stock field change with a partner location present 409; a refund field change changes the next `policyFor` answer; the three way test still passes, verifies **AC-24**.
- Permission: a staff member who is not a manager gets 403 on every write and read here except `GET /api/platform/modules`, and the settings page shows the 403 state, verifies **AC-3**, **AC-25**, **AC-26**.
- Screen: Playwright in English and Arabic changes a knob with a reason, uploads a license, sees an Operations item disabled on a Warehouse only fixture license, axe clean, verifies **AC-25**, **AC-9**, **AC-20**.

## Build plan

Tracer Bullet: milestone 1 runs one real setting through every layer (registry, database, api, audit, cross process cache, worker, web screen). Each later milestone thickens one segment end to end: the license, then the module gate with its jobs, then lapse and renewal, then the remaining policies and the full screen. **Depends on the feature 4 baseline**: no milestone starts before `0000_baseline.sql` with the `settings` keys on (`tenant_id`, `key`), `location_owner_policies`, and `order_cost_rules` has landed. Each milestone is one commit. The migration for the two license tables lands in milestone 2, the first that needs it.

**Milestone 1: One setting through every layer**
1. [ ] Settings registry in `packages/contracts/src/settings/` with the existing keys, `operating_day_cutoff_hour`, and `operations_wind_down_days`; `registry.spec.ts`; `SettingEntryView` and `PutSettingBody` schemas, satisfies **AC-1**, **AC-22**
2. [ ] Move `SettingsService` to `apps/api/src/platform/settings/`, typed by the registry: defaults for absent rows, invalid rows read as default with one log line, transaction reads bypass the cache; update its callers (`ConfigController`, `ReconcileJob`, `AuthCleanupJob`, the ledger lock date check), satisfies **AC-2**
3. [ ] `SettingsCache` with a 30 second lifetime and `PlatformChangesListener` (a dedicated `pg` client, `LISTEN ssd_platform_changed`, reconnect with backoff) in both the api and the worker, satisfies **AC-4**
4. [ ] `GET /api/config` limited to `public_config` entries plus the env fields, with the exact key set test, satisfies **AC-5**
5. [ ] `SettingsService.write` and `PUT /api/settings/:key`, `GET /api/settings` (manager only, the `admin` role until feature 8): validation, stale check, `setting.changed` through `AuditService.record` (spec 0010) with the registry reason rule, `NOTIFY`, and the `platform.reconcile_modules` job (a no op handler for now) in one transaction, satisfies **AC-3**, **AC-26**
6. [ ] Web: `apps/web/src/settings/` (README) and `(backoffice)/settings/page.tsx` with the Brand and Policies sections for the keys in task 1, the change dialog with a reason, last changed by and when, English and Arabic keys, the nav entry (manager only), satisfies **AC-25**
7. [ ] `apps/api/test/settings.e2e-spec.ts` (read, write, stale, rollback, 403) and `settings-cache.e2e-spec.ts` (two Nest contexts, listener killed), and `apps/web/e2e/settings.spec.ts` (change a knob with a reason in both languages, axe), satisfies **AC-2**, **AC-3**, **AC-4**, **AC-25**

**Done when** `pnpm test` passes including `registry.spec.ts` and the config key set test; `pnpm build && pnpm --filter @ssdashboard/api test:e2e -- test/settings.e2e-spec.ts test/settings-cache.e2e-spec.ts` passes; and `pnpm --filter @ssdashboard/web test:e2e -- e2e/settings.spec.ts --project=desktop` passes.

**Milestone 2: The license**
8. [ ] Migration: `licenses` and `license_checks` with their enums, checks, index, `ssd_reject_change()` triggers and app role revokes; both tables in `table-ownership.ts` and in the append only cases of `schema.e2e-spec.ts`, satisfies **AC-14**, **AC-16**
9. [ ] Contracts: `LicenseEnvelope`, `LicensePayload`, `LicenseSummary`, `LicenseNotice`, and `operationsPhase` with the exhaustive boundary table test, satisfies **AC-15**
10. [ ] `LicenseVerifier` (size cap, base64url decode, Ed25519 verify over the payload bytes with `node:crypto`, strict payload parse, `devOnly` refusal in production, install binding) and `license-keys.ts` with the dev key and the vendor key(s) from the owner; `sign-license.ts` for the vendor; `pnpm bootstrap` writes the dev license; `LICENSE_FILE` and `LICENSE_CHECK_CRON` in `env.ts`, `.env.example`, and Compose, satisfies **AC-14**
11. [ ] `LicenseService`: the check under the advisory lock at api start, worker start, the daily job, and upload; outcomes recorded; `LicenseChanged` only on a change of phase; `notice(day)`, `windDown()`; `GET` and `POST /api/platform/license` with `license.added` audited, satisfies **AC-14**, **AC-16**, **AC-17**, **AC-20**, **AC-26**
12. [ ] Web: the Modules and license section (bundles, expiry, phase, recorded licenses, upload), the manager banner in the shell top bar from `licenseNotice`, both languages, satisfies **AC-17**, **AC-20**, **AC-25**
13. [ ] `apps/api/test/license.e2e-spec.ts`: valid, flipped byte, unknown key, dev key with `NODE_ENV=production`, wrong install, file deleted after a valid check, an older upload (`changed: false`), two concurrent checks emitting one `LicenseChanged`, satisfies **AC-14**, **AC-16**, **AC-20**

**Done when** `pnpm test` passes including `license-phase.spec.ts` and the verifier unit tests; `pnpm --filter @ssdashboard/db test:e2e` passes with the append only cases for both tables; and `pnpm build && pnpm --filter @ssdashboard/api test:e2e -- test/license.e2e-spec.ts` passes.

**Milestone 3: Module gate, toggles, and no orphaned jobs**
14. [ ] Module registry and `moduleState` in `packages/contracts/src/modules/` with the exhaustive test and the registry checks; `ModuleStateService` (`isOn`, `isRunnable`, `assertOn`, the `ModuleOff` domain error) cached like settings; `module.<key>.enabled` settings derived from toggleable modules; `NOT_LICENSED`, `MODULE_REQUIRED_BY`, satisfies **AC-6**, **AC-7**, **AC-12**, **AC-13**
15. [ ] `@RequiresModule` on every existing controller, `requires-module.spec.ts`, and the global `ModuleGate` (404 `MODULE_OFF`, read only `GET` rule, portal and hook rules); `GET /api/platform/modules`, satisfies **AC-8**, **AC-26**
16. [ ] `JobsModule` (one `PgBoss` per process), `JobRegistry`, and `ModuleJobSupervisor` (reconcile at worker start, on `NOTIFY`, and in the `platform.reconcile_modules` job: `unschedule`, `offWork`, `findJobs` queued then `cancel`, `onDisable`, schedules restored in the current `timezone`, backfill with a singleton key); move `ReconcileJob`, `AuthCleanupJob`, and the mail worker onto it; the handler gate that completes skipped jobs; confirm each pg-boss call against the installed `pg-boss` type definitions, satisfies **AC-10**, **AC-11**, **AC-22**
17. [ ] The `MODULE_OFF` and `STEP_OFF` command rule as an exported connectors service method, with a fixture until feature 13 builds connectors, satisfies **AC-10**, **AC-21**
18. [ ] Web: `module` on every `nav.ts` entry, hidden and read only entries, the "not available on this install" state, refetch on focus and on 404 `MODULE_OFF`, satisfies **AC-9**
19. [ ] `apps/api/test/fixtures/fixture-operations.module.ts` (an `operations` module with a controller, a cron schedule, a queue with queued jobs, a waiting command, an `onDisable`, and a `backfill`) and `apps/api/test/module-off-no-orphaned-jobs.e2e-spec.ts` with the two cases of AC-10 and AC-11, satisfies **AC-8**, **AC-10**, **AC-11**, **AC-12**

**Done when** `pnpm test` passes including `module-state.spec.ts` and `requires-module.spec.ts` (and fails when one `@RequiresModule` is removed); `pnpm build && pnpm --filter @ssdashboard/api test:e2e -- test/module-off-no-orphaned-jobs.e2e-spec.ts` passes; and `pnpm test:e2e` passes with every pre existing suite unchanged.

**Milestone 4: Lapse, wind down, and renewal**
20. [ ] `LicenseChanged` handling in the supervisor: Operations capabilities without `windDown` lose their jobs at `wind_down`; wind down capabilities stay runnable; `openItems` contract for wind down capabilities and the early end; sticky `off`; renewal backfill once per gap, satisfies **AC-18**, **AC-19**
21. [ ] The hooks rule as a platform helper (`LicenseService.acceptsHook(capability, shipmentCreatedAt)`) returning `process` or `ignored_unlicensed`, for features 13 and 19 to call, satisfies **AC-18**
22. [ ] `notice(day)` levels for the report on days 30, 14, 7 and every grace and wind down day, exported for feature 25, satisfies **AC-17**
23. [ ] `apps/api/test/license-lapse.e2e-spec.ts` with a fixture clock and the fixture module plus a fixture wind down capability, every case in Critical test scenarios "Lapse", satisfies **AC-17**, **AC-18**, **AC-19**

**Done when** `pnpm build && pnpm --filter @ssdashboard/api test:e2e -- test/license-lapse.e2e-spec.ts test/module-off-no-orphaned-jobs.e2e-spec.ts` passes, and `pnpm test` passes.

**Milestone 5: Executing steps, policies, owner types, cost rules, and the full screen**
24. [ ] Executing step support: `kind: executing_step` entries, preconditions (`STEP_PRECONDITION`), `isRunnable(step)`; one fixture step in the fixture module proving the off, on, and turned off while queued cases; the step table above recorded in the registry README as the naming contract for features 13, 18, 31, 32, 35, 37, 48, 50, satisfies **AC-21**
25. [ ] `LocationPolicyService.updatePolicy`, `countActiveByOwnerType`, `OwnerPoliciesController`, `policy.changed` audited; `apps/api/test/owner-policies.e2e-spec.ts` and the new case in `location-owner-types.e2e-spec.ts`, satisfies **AC-24**
26. [ ] `CostRulesService.record`, `GET` and `POST /api/platform/cost-rules` with the cost permission (the `admin` role until feature 8), `cost_rule.recorded` audited, satisfies **AC-23**
27. [ ] Web: Automations, Location owner types (locked fields shown with why), and Cost rules sections; the plain words dialog for turning a step on; empty, loading, error, and 403 states, satisfies **AC-21**, **AC-23**, **AC-24**, **AC-25**
28. [ ] Playwright `apps/web/e2e/settings.spec.ts` extended: every section in English and Arabic, keyboard only change of a step with its reason, axe clean, a Warehouse only fixture license showing Operations items disabled, satisfies **AC-25**, **AC-9**

**Done when** `pnpm build && pnpm --filter @ssdashboard/api test:e2e -- test/owner-policies.e2e-spec.ts test/location-owner-types.e2e-spec.ts` passes; `pnpm --filter @ssdashboard/web test:e2e -- e2e/settings.spec.ts --project=desktop` passes; and `pnpm lint && pnpm typecheck && pnpm test` pass.

## Consequences

**Positive**:
- Adding a setting, a policy knob, or an executing step costs one registry entry and its labels: no migration, no new endpoint, no new screen code.
- A module that is off is provably quiet: no schedule, no queued job, no half sent command, and every later feature inherits that by declaring its jobs through the registry.
- A lapse never strands cash already out with the carrier, and the license never phones home, so self hosted and offline installs behave like vendor hosted ones.
- Location owner types stay one code path while their answers become the brand's to edit.

**Negative / tradeoffs**:
- Every controller carries one more decorator and every job one more declaration; the build test makes forgetting cheap to catch, not free.
- One shared `PgBoss` instance replaces the per job instances: a refactor of three working jobs in milestone 3.
- A dedicated LISTEN connection per process costs one connection on the shared PostgreSQL server per api and worker; a future connection pooler in transaction mode would break LISTEN, leaving only the 30 second lifetime.
- The license cannot stop a determined self host client who rolls back the clock or patches the image; it records evidence instead. It is a commercial lock, not copy protection.
- Recorded licenses only add, so a mistaken license issued with too long an expiry cannot be revoked remotely; the vendor fixes it by contract.
- Read only states for lapsed modules mean history pages of every Operations feature must work without their write routes.

**Neutral**:
- The settings registry, module registry, and step list become shared files every later feature edits (like the table ownership map).
- `apps/web/src/shell/nav.ts` gains a required `module` field on every entry.

## Questions for the owner

1. **The vendor signing key.** Who generates and holds the private key that signs licenses? Recommended default: you generate one Ed25519 key pair on an offline machine, keep the private key in your password manager plus one sealed offline backup, and give Igris only the public key for `license-keys.ts`; a second standby key pair is made the same day and its public key also ships in the image, so a lost or leaked key is replaced by a release, not a scramble. Until answered, only the dev key exists and no production license can be issued.
2. **Clock rollback.** Should the app enforce the license against a server clock set back in time? Recommended default: no, record it only (`clock_behind` on the check, shown to the manager and in support bundles), because enforcing it would let a clock wrongly set far ahead switch Operations off for good. Alternative: refuse to evaluate on a clock more than 24 hours behind the last check.
3. **Brand managed toggles.** May the brand's manager turn a licensed Operations module off and on again, or only the vendor? Recommended default: the manager may (reason required, audited), and may never turn on what the license does not cover.
4. **Retention bonus default.** Recommended default: not set, so no retention bonus can be offered until a manager sets a percent and a cap. Alternative: a starting limit you choose (for example a percent of the refund with an EGP cap).
5. **Core after an Operations only lapse.** Recommended default: Core keeps working with no time limit after the wind down (catalog, stock, orders, customers, imports, exports, the exit package), so the brand's own data is never held back. Alternative: Core becomes read only too after a longer period.

## Follow-up

- [ ] Igris: spec 0002 [tenancy child](../0002-core-data-model/0002-tenancy-platform.md) A4 (append only table) and A5 (ownership map, platform row "module toggles and license tables: feature 9") should list `licenses` and `license_checks`; module toggles are settings rows, not a table. Out of this task's scope.
- [ ] Igris: spec 0007 *Bundles, module toggles, and the license* says lapsed Operations routes "answer 404 with code `MODULE_OFF`"; this spec keeps that for writes and keeps `GET` routes answering in read only mode so "data stays readable" holds. Amend that sentence when 0007 is next touched.
- [ ] Igris: spec 0004 `## Follow-up` names "Feature 46 (client settings and module toggles)"; that is feature 9 now, and this spec's screen covers `languages` and `default_language`.
- [ ] Igris: `apps/web/src/shell/nav.ts` comment "Features 13 and 46 later filter this by role and module toggle" names old feature numbers; features 8 and 9 do it (code comment, fixed by the milestone 3 build).
- [ ] Feature 8 (spec 0008): map `whoMayChange: manager` and "the cost permission" to its permission names; until then the `admin` role stands in.
- [ ] Features 13, 18, 19, 22, 25, 29, 31, 32, 35, 36, 37, 48, 50: register your capabilities, steps, knobs, wind down `openItems`, and `backfill` as this spec names them; call `LicenseService.acceptsHook` in hooks (carried n2).
- [ ] Feature 17: one task per capability for `MODULE_OFF` and `STEP_OFF` commands, not one per command.
- [ ] Feature 26: put `LICENSE_FILE` into the per client deploy template and the renewal step into the runbook (replace the file or upload on the screen).
- [ ] Feature 47: provisioning issues the first license with the install's `client_code` and tenant id.
- [ ] `react-hook-form-zod` and `tanstack-query` conventions are installed under `.claude/skills/` but not listed in `apps/web/AGENTS.md` `## Agent skills`; they belong there (web area only), for `/sync` or `/audit`.

## Rationale

Reasoning, options, and references: see [rationale.md](rationale.md).
