# Settings screen

The settings page at `/settings` (needs `settings.manage`): the Brand and Policies sections, each entry with its value, its default, whether it is the default, who changed it last and when, and a Change dialog. The other sections (Modules and license, Automations, Location owner types, Cost rules) arrive in later milestones of spec 0009.

## Owns

- The page and its body: [settings-page.tsx](settings-page.tsx) (the no access and error states), [settings-view.tsx](settings-view.tsx) (loads `GET /api/settings`, draws the sections)
- A section and a row: [setting-section.tsx](setting-section.tsx), [setting-row.tsx](setting-row.tsx) (an entry that cannot be changed or whose bundle is not licensed has a disabled Change button and says why)
- The change dialog: [setting-change-dialog.tsx](setting-change-dialog.tsx) (warning, typed confirmation, reason, errors from the stable codes) with the input per value type in [setting-value-field.tsx](setting-value-field.tsx)
- How a value shows and becomes a draft and back: [setting-value.ts](setting-value.ts)
- Calls to the api: [settings-api.ts](settings-api.ts) (`GET /api/settings`, `PUT /api/settings/:key`)
- The route: `src/app/(backoffice)/settings/page.tsx`

## Never touches

- What a value may be, who may change it, or whether a bundle is licensed. The registry in `@ssdashboard/contracts` and the api decide; the screen shows `canChange` and `licensed`. The api answers 403, 409 (`SETTING_LOCKED`), or 422 anyway, but it does not yet refuse a write to an unlicensed bundle's entry: that gate is screen only until the license milestone (security review S6).
- The setting names and descriptions. They come from the catalog through the entry's key (`settings.entries.<key>`).
- Hard coded text. Use `t()` and `useFormat()`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/settings
pnpm --filter @ssdashboard/web test:e2e -- e2e/settings.spec.ts --project=desktop
```

## Governing spec

- [0009 Settings, toggles, and bundles](../../../../docs/specs/0009-settings-toggles-bundles/index.md) (AC-25, AC-26)

## Decisions

- The input for a value follows the shape of the entry's default (boolean, number, list, record, null for a date, else text): the api's entry view carries no schema, and the api's own schema is the only judge of a value (422 `SETTING_INVALID` shows on the field).
- `expectedUpdatedAt` is the `updatedAt` the list showed when the dialog opened, never a fresher one, so a change made meanwhile answers 409 `STALE_SETTING` and the dialog offers a reload.
- The typed confirmation asks for the setting's name as the person reads it in their language.
- Record other non obvious decisions as ADRs in docs/adr/ and link them here.
