# Customer screens

The customer search and the To review tab at `/customers`, the customer profile at `/customers/[id]`, and the merge screen at `/customers/merge`. Search, review, and the profile are for people with `customers.view`; merging and undoing need `customers.merge` (support, operations, manager).

## Owns

- Customers screen: [customers-page.tsx](customers-page.tsx) (the access gate), [customers-view.tsx](customers-view.tsx) (the one `<h1>`, the Search and To review tabs in [customers-tabs.tsx](customers-tabs.tsx), and the suggestion count)
- Search: [customer-search-panel.tsx](customer-search-panel.tsx) (one box for a phone in any form or a name fragment, sent as a POST body), [customer-results-table.tsx](customer-results-table.tsx) (TanStack Table), [customer-search-input.ts](customer-search-input.ts) (phone or name)
- To review: [merge-suggestions-panel.tsx](merge-suggestions-panel.tsx) (list, load more, dismiss), [merge-suggestions-table.tsx](merge-suggestions-table.tsx) and [merge-pair-customer.tsx](merge-pair-customer.tsx); Merge opens the merge screen with the pair and the suggestion
- Merge: [merge-page.tsx](merge-page.tsx) (the `customers.merge` gate), [merge-view.tsx](merge-view.tsx) (two slots filled from `?a=&b=&s=` or by finding a customer by phone, the older record preselected, Swap, one Merge button), [merge-customer-picker.tsx](merge-customer-picker.tsx), [merge-customer-card.tsx](merge-customer-card.tsx), [merge-page-href.ts](merge-page-href.ts); [use-merge-actions.ts](use-merge-actions.ts) merges and undoes (the toast with Undo, reason `wrong_merge`) and [merge-error-key.ts](merge-error-key.ts) maps each stable api code to a translated message
- Profile: [customer-detail-page.tsx](customer-detail-page.tsx) (the access gate), [customer-detail-view.tsx](customer-detail-view.tsx) (header, merged notice, link to merge), and its sections for phones, channel ids, the flag, and merged records ([customer-merges-section.tsx](customer-merges-section.tsx), with Undo while `undoable`)
- Flag: [customer-flag-actions.tsx](customer-flag-actions.tsx) (Flag, Change, Clear buttons for holders of `customers.flag`), [customer-flag-dialog.tsx](customer-flag-dialog.tsx) (kind, note up to 500, optional reason code), [customer-clear-flag-dialog.tsx](customer-clear-flag-dialog.tsx) (required reason code), [flag-error-key.ts](flag-error-key.ts); a stale record reloads the profile and keeps the dialog open. The Search tab has a Show flagged customers button (`{ flagged: true }`).
- Timeline: [customer-timeline-section.tsx](customer-timeline-section.tsx) (the `GET /api/customers/:id/timeline` infinite query, 25 a page, Load more, empty and error states), [customer-timeline-entry.tsx](customer-timeline-entry.tsx) (kind and time, then the body of the kind) and one body per kind: [timeline-order-entry.tsx](timeline-order-entry.tsx) (link to the order page, state chips, total), [timeline-merge-entry.tsx](timeline-merge-entry.tsx) (merge and undo entries; Undo only when the api sent `undoable: true`, Open in audit only when it sent `audit`); focus never falls to the page: Undo from an entry moves it to the Timeline heading, Load more to the first new entry, and the buttons use `aria-disabled` while they work, [timeline-phone-entry.tsx](timeline-phone-entry.tsx), [timeline-channel-id-entry.tsx](timeline-channel-id-entry.tsx), [timeline-flag-entry.tsx](timeline-flag-entry.tsx), and [timeline-reason-text.tsx](timeline-reason-text.tsx). The screen shows what arrives: the api applies each hat's lens (AC-15), so no permission check decides what an entry shows.
- Suggested flag: [customer-signal-suggestion.tsx](customer-signal-suggestion.tsx) on the profile header, only with no flag and a `signal.suggestedKind` (the api leaves `signal` out without `orders.view`); the apply button is for holders of `customers.flag` and sends `suggestion_applied` with the profile's `updatedAt`; a 422 `REASON_INVALID` says the suggestion no longer holds and reloads; the failure message (and a toast) lives in the profile header, outside the box, so it stays when the reloaded profile has no suggestion, and after a success focus moves to the flag card heading. The merge compare card shows `orderCount` when the api sent it.
- The api calls and query keys: [customers-api.ts](customers-api.ts)
- Routes: `src/app/(backoffice)/customers/page.tsx`, `src/app/(backoffice)/customers/merge/page.tsx`, and `src/app/(backoffice)/customers/[id]/page.tsx`

## Never touches

- A phone, name, or channel id in a URL, query string, log, `console` call, toast, or error message (Law 151, spec 0014 AC-3 and AC-17): search state lives in component state and the search is a POST; the merge address carries ids only.
- Parsing or normalizing a phone: the api does it, so one number is one customer however it was typed.
- Hard coded text or physical side CSS classes (`left`, `ml-`). Use `t()` and logical classes; phones and ids sit in `LtrText`.

## How to test

```bash
pnpm --filter @ssdashboard/web test -- src/customers
pnpm --filter @ssdashboard/web exec playwright test e2e/customers.spec.ts e2e/customers-merge.spec.ts e2e/customers-flag.spec.ts e2e/customers-flag-checks.spec.ts e2e/customers-timeline.spec.ts --project=desktop
```

## Governing spec

- [0014 Customers by phone](../../../../docs/specs/0014-customers-by-phone/index.md) (milestones 1 to 4: AC-3, AC-4, AC-5, AC-7, AC-9, AC-11, AC-13, AC-14, AC-15, AC-18)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)
- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

None yet.
