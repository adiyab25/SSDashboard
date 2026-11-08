# Customer screens

The customer search at `/customers` and the customer profile at `/customers/[id]`, for people with `customers.view` (support, operations, manager).

## Owns

- Search: [customers-page.tsx](customers-page.tsx) (the access gate), [customers-view.tsx](customers-view.tsx) (one box for a phone in any form or a name fragment, sent as a POST body), [customer-results-table.tsx](customer-results-table.tsx) (TanStack Table), [customer-search-input.ts](customer-search-input.ts) (phone or name)
- Profile: [customer-detail-page.tsx](customer-detail-page.tsx) (the access gate), [customer-detail-view.tsx](customer-detail-view.tsx) (header, merged notice), and its sections for phones, channel ids, the flag, and merged records
- The api calls and query keys: [customers-api.ts](customers-api.ts)
- Routes: `src/app/(backoffice)/customers/page.tsx` and `src/app/(backoffice)/customers/[id]/page.tsx`

## Never touches

- A phone, name, or channel id in a URL, query string, log, or `console` call (Law 151, spec 0014 AC-3 and AC-17): search state lives in component state and the search is a POST.
- Parsing or normalizing a phone: the api does it, so one number is one customer however it was typed.
- Hard coded text or physical side CSS classes (`left`, `ml-`). Use `t()` and logical classes; phones and ids sit in `LtrText`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/customers
pnpm --filter @ssdashboard/web test:e2e -- e2e/customers.spec.ts --project=desktop
```

## Governing spec

- [0014 Customers by phone](../../../../docs/specs/0014-customers-by-phone/index.md) (milestone 1, AC-3, AC-4, AC-5, AC-18)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)
- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

None yet. Merge, flag, and timeline screens arrive with later milestones of spec 0014.
