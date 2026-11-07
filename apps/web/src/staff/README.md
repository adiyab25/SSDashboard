# Staff screens

The people page at `/staff` (needs `people.manage`) to list, invite, edit, disable and reset staff accounts, and to give and take their hats and cost access.

## Owns

- The page: [staff-page.tsx](staff-page.tsx)
- Dialogs: [staff-form-dialog.tsx](staff-form-dialog.tsx) (add with hats and cost, edit details), [staff-hats-dialog.tsx](staff-hats-dialog.tsx) (edit hats, `PUT /api/staff/:id/access`), [staff-confirm-dialog.tsx](staff-confirm-dialog.tsx), [staff-setup-dialog.tsx](staff-setup-dialog.tsx)
- The hat checkboxes and the cost switch both dialogs share: [hats-fieldset.tsx](hats-fieldset.tsx)
- Where the cost switch starts (`COST_VIEW_DEFAULT` for a hat being added, else the stored grant) and the staff hats in catalog order: [cost-prefill.ts](cost-prefill.ts)
- Calls to the api: [staff-api.ts](staff-api.ts)
- The route: `src/app/(backoffice)/staff/page.tsx`

## Never touches

- The signed in user's own profile. That is [account](../account/).
- Account and access rules such as the last manager rule, self changes and who may change cost. The api enforces them; the page only hides Edit hats on the signed in person's own row and disables the cost switch without `cost.view`.
- The hat names and descriptions. They come from the catalog (`access.hats.<hat>`), never the hat codes.
- Hard coded text. Use `t()`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/staff
pnpm --filter @ssdashboard/web test:e2e -- e2e/staff.spec.ts e2e/hats.spec.ts
```

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md) (AC-7, AC-12, AC-14, AC-18)

## Decisions

- The cost switch prefill only ever turns the switch on (a hat being added whose `COST_VIEW_DEFAULT` is on), so ticking a hat never quietly removes cost a person already sees; once moved by hand it stays where the manager put it.
- Record other non obvious decisions as ADRs in docs/adr/ and link them here.
