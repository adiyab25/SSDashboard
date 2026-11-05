# Verify: settings, module toggles & bundles · spec 0009 · written 2026-11-05
_Steps derived from spec 0009 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones. Each milestone of the Build plan ticks the steps it makes runnable._

## UI / manual
- [ ] Sign in as a manager (the `admin` role until feature 8), open `/settings` → one `<h1>`, sections Brand, Modules and license, Automations, Policies, Location owner types, and Cost rules; each item shows value, default, last changed by and when → AC-25, AC-26
- [ ] Change `operations_wind_down_days` from 60 to 45 with no reason → the dialog refuses with the reason message (422 `REASON_REQUIRED`); with a reason → saved, "last changed by" shows you, `/audit` lists one `setting.changed` entry with before 60, after 45, and the reason → AC-3, AC-22
- [ ] Open the same item in two tabs, save in the first, then save in the second → the second shows "changed by someone else, reload" (409 `STALE_SETTING`) and nothing is overwritten → AC-3
- [ ] `currency` shows EGP read only with no edit action → AC-1, AC-25
- [ ] Switch to Arabic → the page is right to left, every label and error is Arabic, amounts and dates use Western digits; keyboard only (Tab, Enter, Escape) changes a knob end to end; axe reports no violation in either language → AC-25
- [ ] Sign in as a staff member who is not a manager, open `/settings` → the 403 state; the sidebar shows no Settings entry → AC-25, AC-26
- [ ] Upload the dev license from `pnpm bootstrap` again → "no change" (`changed: false`); upload a copy with one character of the signature changed → "the license signature does not match" (422 `LICENSE_INVALID`, outcome `bad_signature`) → AC-14, AC-20
- [ ] With a fixture license 20 days from expiry, the manager sees the banner "Operations plan ends in 20 days"; a staff member does not → AC-17
- [ ] With a Warehouse only fixture license, Automations and Policies items of the Operations plan show disabled with "needs the Operations plan"; turning one on is not possible; the fixture Operations module is missing from the sidebar and its page URL shows "not available on this install" → AC-9, AC-12, AC-25
- [ ] Turn on a fixture executing step → the dialog states in plain words what the app will start doing; without its fixture precondition → the precondition message (409 `STEP_PRECONDITION`) → AC-21
- [ ] Location owner types: with a consignment location present, the stock fields of the consignment row show locked with the reason; change "end customer refund by" with a reason → saved; the `own` row's stock fields are always locked → AC-24
- [ ] Cost rules: set COD fee 2.5 from today with a reason → listed as current with history below; as a manager without the cost permission (after feature 8) the section is absent → AC-23

## Commands
- [ ] `pnpm test` → `registry.spec.ts`, `module-state.spec.ts`, `license-phase.spec.ts`, `requires-module.spec.ts`, and the config key set test pass → AC-1, AC-5, AC-7, AC-8, AC-15, AC-21
- [ ] Remove `@RequiresModule` from one controller and run `pnpm test` → `requires-module.spec.ts` fails naming it → AC-8
- [ ] `pnpm build && pnpm --filter @ssdashboard/api test:e2e -- test/settings.e2e-spec.ts test/settings-cache.e2e-spec.ts` → read, write, stale, rollback, 403, and the two process cases pass → AC-2, AC-3, AC-4
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- test/license.e2e-spec.ts` → valid, flipped byte, unknown key, dev key in production, wrong install, file deleted after a valid check, older upload, concurrent checks pass → AC-14, AC-16, AC-20
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- test/module-off-no-orphaned-jobs.e2e-spec.ts` → "a module turns off with no orphaned jobs" and "turning it back on restores schedules and replays nothing" pass → AC-8, AC-10, AC-11, AC-12
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- test/license-lapse.e2e-spec.ts` → notices on days 30, 14, 7; grace keeps everything on; lapse stops non wind down work; pre lapse shipments only during wind down; `ignored_unlicensed` for later ones; early end; one backfill on renewal → AC-17, AC-18, AC-19
- [ ] `pnpm --filter @ssdashboard/api test:e2e -- test/owner-policies.e2e-spec.ts test/location-owner-types.e2e-spec.ts` → the three refusals and the edited answer; the three way test unchanged → AC-24
- [ ] `pnpm --filter @ssdashboard/db test:e2e` → `licenses` and `license_checks` refuse `UPDATE`, `DELETE`, and `TRUNCATE` as the app role and as the owner → AC-14
- [ ] `pnpm --filter @ssdashboard/web test:e2e -- e2e/settings.spec.ts --project=desktop` → every section in both languages, keyboard only, axe clean → AC-9, AC-25

## Value sourcing checks
- [ ] Delete the row of a seeded key that is not `sqlRead` (for example `prices_include_vat`) in a scratch database → reads return the registry default and the screen shows "default" → AC-2 (absent row means default)
- [ ] Write `"abc"` into `operations_wind_down_days` with SQL as the owner → reads return 60, `GET /api/settings` shows `invalid: true`, one error log line names the key and not the value → AC-2 (invalid row)
- [ ] Change a setting through the api while watching the worker's log at debug level → the worker drops its cache within 5 seconds; `SELECT pg_terminate_backend(pid)` on the worker's LISTEN connection, change again → seen within 35 seconds and the listener reconnects → AC-4 (LISTEN plus 30 second lifetime)
- [ ] `SELECT now()` on the database and `LicenseService.notice` → days left equals `operations_expires_on` minus today in `Africa/Cairo`, not in UTC (check at 23:30 Cairo time) → AC-15 (today from the database clock in `timezone`)
- [ ] Record two fixture licenses, one expiring 2027-06-30 and a newer upload expiring 2027-03-31 → the expiry used is 2027-06-30 → AC-20 (max `operations_expires_on`)
- [ ] Override `PlatformClock` in the test module to two days before the last check → the next check row has `clock_behind = true` and the phase does not change → AC-16 (rollback recorded, not enforced)
- [ ] Toggle the fixture module off, wait, toggle on → the backfill job's data carries `from` equal to the toggle off write's `updated_at` → AC-11 (gap source)
- [ ] `GET /api/config` with no session → only the spec 0004 fields; `GET /api/platform/modules` as a non manager → no `licenseNotice` → AC-5, AC-26
- [ ] `docker exec` into the `app` container and run the license check with no network → it completes; no outbound connection is attempted → AC-14 (no phone home)
