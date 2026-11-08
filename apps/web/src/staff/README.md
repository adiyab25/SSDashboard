# Staff screens

The people page at `/staff` (needs `people.manage`) with two tabs: Staff, to list, invite, edit, disable and reset staff accounts and to give and take their hats and cost access, and Partner logins, to run the logins of consignment partners (add one bound to a partner account, move it to another account, reset, sign out, disable).

## Owns

- The page: [staff-page.tsx](staff-page.tsx)
- Dialogs: [staff-form-dialog.tsx](staff-form-dialog.tsx) (add with hats and cost, edit details), [staff-hats-dialog.tsx](staff-hats-dialog.tsx) (edit hats, `PUT /api/staff/:id/access`), [staff-confirm-dialog.tsx](staff-confirm-dialog.tsx), [staff-setup-dialog.tsx](staff-setup-dialog.tsx)
- The hat checkboxes and the cost switch both dialogs share: [hats-fieldset.tsx](hats-fieldset.tsx)
- Where the cost switch starts (`COST_VIEW_DEFAULT` for a hat being added, else the stored grant) and the staff hats in catalog order: [cost-prefill.ts](cost-prefill.ts)
- The Staff and Partner logins tabs (WAI-ARIA tabs on native buttons, arrow keys flip in Arabic): [people-tabs.tsx](people-tabs.tsx)
- The Partner logins tab: [partner-logins-tab.tsx](partner-logins-tab.tsx), with [partner-user-form-dialog.tsx](partner-user-form-dialog.tsx) (add with the partner account picker, edit details) and [partner-user-move-dialog.tsx](partner-user-move-dialog.tsx) (`PUT /api/partner-users/:id/access`, optional reason, ends their sessions). While the `consignment` module is `off` the tab stays and every row action works; only Add partner login is disabled (spec 0009, AC-9, W3). The confirm and setup dialogs above are reused
- Calls to the api: [staff-api.ts](staff-api.ts) (`/api/staff`), [partner-users-api.ts](partner-users-api.ts) (`/api/partner-users`), both on the shared [api-request.ts](api-request.ts)
- The route: `src/app/(backoffice)/staff/page.tsx`

## Never touches

- The signed in user's own profile. That is [account](../account/).
- Account and access rules such as the last manager rule, self changes and who may change cost. The api enforces them; the page only hides Edit hats on the signed in person's own row, disables the cost switch without `cost.view`, and (for a person who sees cost, when the signed in person does not) hides Reset password and Reset two factor and locks the email field; the api answers 403 `COST_HOLDER_PROTECTED` anyway.
- The hat names and descriptions. They come from the catalog (`access.hats.<hat>`), never the hat codes.
- Hard coded text. Use `t()`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/staff
pnpm --filter @ssdashboard/web test:e2e -- e2e/staff.spec.ts e2e/hats.spec.ts e2e/audiences.spec.ts
```

## Governing spec

- [0005 Staff sign in](../../../../docs/specs/0005-staff-sign-in/index.md)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md) (AC-7, AC-12, AC-14, AC-15, AC-18)

## Decisions

- The cost switch prefill only ever turns the switch on (a hat being added whose `COST_VIEW_DEFAULT` is on), so ticking a hat never quietly removes cost a person already sees; once moved by hand it stays where the manager put it.
- A partner login has no hats and no cost switch, and its partner account changes only through the move dialog, never the edit form (the api refuses any other field). A partner login is never on the Staff tab and a staff person never on the other: each list asks its own api route.
- When an edit dialog cannot load the person (or the login), its fields and Save stay shut and a Reload button asks again, so Save can never clear a phone or language. A login whose partner account is unknown (archived, or the accounts list failed) shows "Unknown partner account" instead of an empty cell.
- Record other non obvious decisions as ADRs in docs/adr/ and link them here.
