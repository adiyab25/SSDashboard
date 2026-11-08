# Settings screen

The settings page at `/settings` (needs `settings.manage`): the Brand and Policies sections, each entry with its value, its default, whether it is the default, who changed it last and when, and a Change dialog; and the Modules and license section (`#license`) between them. The other sections (Automations, Location owner types, Cost rules) arrive in later milestones of spec 0009.

## Owns

- The page and its body: [settings-page.tsx](settings-page.tsx) (the no access and error states), [settings-view.tsx](settings-view.tsx) (loads `GET /api/settings`, draws the sections)
- A section and a row: [setting-section.tsx](setting-section.tsx), [setting-row.tsx](setting-row.tsx) (an entry that cannot be changed or whose bundle is not licensed has a disabled Change button and says why)
- The change dialog: [setting-change-dialog.tsx](setting-change-dialog.tsx) (warning, typed confirmation, reason, errors from the stable codes) with the input per value type in [setting-value-field.tsx](setting-value-field.tsx)
- How a value shows and becomes a draft and back: [setting-value.ts](setting-value.ts)
- Calls to the api: [settings-api.ts](settings-api.ts) (`GET /api/settings`, `PUT /api/settings/:key`)
- The Modules and license section: [license-section.tsx](license-section.tsx) (loads `GET /api/platform/license` itself, with its own loading, error, empty, and no access states), its parts [license-bundle-row.tsx](license-bundle-row.tsx) (Core and each plan with phase, expiry, days left), [license-last-check.tsx](license-last-check.tsx) (outcome, problem alert, clock behind as information), [license-recorded-list.tsx](license-recorded-list.tsx), and the upload [license-upload-dialog.tsx](license-upload-dialog.tsx) (a `.json` file read as text, refused over 16 KB before sending, every refusal `outcome` with its own sentence; after a renewal out of the wind down or off it stays open on an answer view naming the steps that resume, as its accessible description, AC-19), [license-resuming-steps.tsx](license-resuming-steps.tsx) (those steps by setting label; also the section's "steps waiting for a renewal" block from `summary.resumingSteps`); calls and the shared query key in [license-api.ts](license-api.ts); spec fixtures in [license-fixtures.ts](license-fixtures.ts)
- The module switches (spec 0009, AC-12, AC-30): [module-switch-section.tsx](module-switch-section.tsx) (one row per settings entry of group `modules`, drawn only when one exists), [module-switch-row.tsx](module-switch-row.tsx) (effective state, reason, date, Turn off or Turn on), the off dialog [module-off-dialog.tsx](module-off-dialog.tsx) with [module-off-impact.tsx](module-off-impact.tsx) (waiting commands, in flight work, partner stock with value only when the api sends it; typed confirmation when `typedConfirmation`; reason required; `MODULE_REQUIRED_BY` worded with the dependants' labels), and [use-module-label.ts](use-module-label.ts); turning a module on is the plain change dialog, which words `MODULE_REQUIRES`; `GET /api/settings/:key/off-impact` is `getOffImpact` in [settings-api.ts](settings-api.ts)
- The banner for managers lives in the shell, [license-banner.tsx](../shell/license-banner.tsx), and reads the same query (`licenseKeys.all`) and `notices`
- The route: `src/app/(backoffice)/settings/page.tsx`

## Never touches

- What a value may be, who may change it, whether a bundle is licensed, or whether a license is valid (the api verifies an upload; the screen only words the `outcome`). The registry in `@ssdashboard/contracts` and the api decide; the screen shows `canChange` and `licensed`. The api answers 403, 409 (`SETTING_LOCKED`, `NOT_LICENSED` for an entry whose bundle is not licensed now, security review S6), or 422 anyway, and the change dialog words each code.
- The setting names and descriptions. They come from the catalog through the entry's key (`settings.entries.<key>`).
- Hard coded text. Use `t()` and `useFormat()`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/settings
pnpm --filter @ssdashboard/web test:e2e -- e2e/settings.spec.ts e2e/license.spec.ts e2e/modules.spec.ts --project=desktop
```

## Governing spec

- [0009 Settings, toggles, and bundles](../../../../docs/specs/0009-settings-toggles-bundles/index.md) (AC-17, AC-20, AC-25, AC-26)

## Decisions

- The input for a value follows the shape of the entry's default (boolean, number, list, record, null for a date, else text): the api's entry view carries no schema, and the api's own schema is the only judge of a value (422 `SETTING_INVALID` shows on the field).
- `expectedUpdatedAt` is the `updatedAt` the list showed when the dialog opened, never a fresher one, so a change made meanwhile answers 409 `STALE_SETTING` and the dialog offers a reload.
- The typed confirmation asks for the setting's name as the person reads it in their language.
- The license upload takes the file only: `PostLicenseBody` has no reason field, so the dialog has none (the audit entry `license.added` records who and when on the api side).
- The banner also names a failed check of the license file (every problem outcome; `none_configured` only while no license was ever recorded, `license-problem.ts`; with a license recorded it is plain information in the section). It reads `notices` from `GET /api/platform/license`, the only route that carries them for a `settings.manage` holder today; the shell asks for it only after the who am I answer says the person holds that permission. It is a link row under the top bar, not an alert, so it is not announced on every page.
- The upload e2e uploads Warehouse with no expiry under a fixed id (`e2e/license-file.ts`): an upload is permanent. It shrinks nothing and adds no license row on a rerun, but on a fresh database the first upload licenses Warehouse for good, so a later Warehouse gated test must route mock its list (`settings.spec.ts` does this for the Operations item).
- The off dialog has no "disable every partner login" option yet: `PutSettingBody` carries no such field (wave 1 review W3), so it waits for a contract change and for the `consignment` module to exist.
- Record other non obvious decisions as ADRs in docs/adr/ and link them here.
