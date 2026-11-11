# Customer screens

The customer search and the To review tab at `/customers`, the customer profile at `/customers/[id]`, and the merge screen at `/customers/merge`. Search, review, and the profile are for people with `customers.view`; merging and undoing need `customers.merge` (support, operations, manager).

## Owns

- Customers screen: [customers-page.tsx](customers-page.tsx) (the access gate), [customers-view.tsx](customers-view.tsx) (the one `<h1>`, the Search and To review tabs in [customers-tabs.tsx](customers-tabs.tsx), and the suggestion count)
- Search: [customer-search-panel.tsx](customer-search-panel.tsx) (one box for a phone in any form or a name fragment, sent as a POST body), [customer-results-table.tsx](customer-results-table.tsx) (TanStack Table), [customer-search-input.ts](customer-search-input.ts) (phone or name)
- To review: [merge-suggestions-panel.tsx](merge-suggestions-panel.tsx) (list, load more, dismiss), [merge-suggestions-table.tsx](merge-suggestions-table.tsx) and [merge-pair-customer.tsx](merge-pair-customer.tsx); Merge opens the merge screen with the pair and the suggestion
- Merge: [merge-page.tsx](merge-page.tsx) (the `customers.merge` gate), [merge-view.tsx](merge-view.tsx) (two slots filled from `?a=&b=&s=` or by finding a customer by phone, the older record preselected, Swap, one Merge button), [merge-customer-picker.tsx](merge-customer-picker.tsx), [merge-customer-card.tsx](merge-customer-card.tsx), [merge-page-href.ts](merge-page-href.ts); [use-merge-actions.ts](use-merge-actions.ts) merges and undoes (the toast with Undo, reason `wrong_merge`) and [merge-error-key.ts](merge-error-key.ts) maps each stable api code to a translated message
- Profile: [customer-detail-page.tsx](customer-detail-page.tsx) (the access gate), [customer-detail-view.tsx](customer-detail-view.tsx) (header, merged notice, link to merge), and its sections for phones, channel ids, the flag, and merged records ([customer-merges-section.tsx](customer-merges-section.tsx), with Undo while `undoable`)
- The api calls and query keys: [customers-api.ts](customers-api.ts)
- Routes: `src/app/(backoffice)/customers/page.tsx`, `src/app/(backoffice)/customers/merge/page.tsx`, and `src/app/(backoffice)/customers/[id]/page.tsx`

## Never touches

- A phone, name, or channel id in a URL, query string, log, `console` call, toast, or error message (Law 151, spec 0014 AC-3 and AC-17): search state lives in component state and the search is a POST; the merge address carries ids only.
- Parsing or normalizing a phone: the api does it, so one number is one customer however it was typed.
- Hard coded text or physical side CSS classes (`left`, `ml-`). Use `t()` and logical classes; phones and ids sit in `LtrText`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/customers
pnpm --filter @ssdashboard/web exec playwright test e2e/customers.spec.ts e2e/customers-merge.spec.ts --project=desktop
```

## Governing spec

- [0014 Customers by phone](../../../../docs/specs/0014-customers-by-phone/index.md) (milestones 1 and 2: AC-3, AC-4, AC-5, AC-7, AC-9, AC-18)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)
- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

None yet. The flag and timeline screens arrive with later milestones of spec 0014.
