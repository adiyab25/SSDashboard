# Order screens

The order list at `/orders`, one order at `/orders/[orderId]`, and the new order form at `/orders/new`, for people with `orders.view` (the form needs `orders.confirm`, a gifted order `orders.gift`).

## Owns

- List: [orders-page.tsx](orders-page.tsx) (the access gate), [orders-view.tsx](orders-view.tsx) (search box, keyset "Load more", the "N shown, more available" status), [order-filter-bar.tsx](order-filter-bar.tsx), [order-results-table.tsx](order-results-table.tsx) (TanStack Table in the design system's fixed column order), [order-flags.tsx](order-flags.tsx) (hold, short, gift, replacement, reopened, phone needs fixing), and the chips [fulfillment-chip.tsx](fulfillment-chip.tsx) and [cash-chip.tsx](cash-chip.tsx)
- Order page: [order-detail-page.tsx](order-detail-page.tsx) (the access gate), [order-detail-view.tsx](order-detail-view.tsx) (header, links both ways, customer), and its sections for the ship to block, lines, money, and the event timeline; the audit entries come from the shared `RecordHistoryPanel` for `audit.read` holders
- Order actions (milestone 2): [order-actions.tsx](order-actions.tsx) (Confirm, Pack, Back to confirmed, Edit, Cancel, each only for the permission and the states the api allows, with the stale and "in Shopify" states and the toast), [order-edit-dialog.tsx](order-edit-dialog.tsx) with its rows [order-edit-line-fields.tsx](order-edit-line-fields.tsx) and form rules [order-edit-form.ts](order-edit-form.ts), [cancel-order-dialog.tsx](cancel-order-dialog.tsx) (reason, duplicate target search), [order-hold-block.tsx](order-hold-block.tsx) ("Edit not synced, hold" with each open write back command), and the error text map [order-write-errors.ts](order-write-errors.ts)
- New order: [new-order-page.tsx](new-order-page.tsx) (the access gate), [new-order-view.tsx](new-order-view.tsx) (react-hook-form with a Zod form schema built from the contract's field rules, the SKU picker of the inventory feature, gifted mode, the live total), [related-order-picker.tsx](related-order-picker.tsx)
- [order-number.tsx](order-number.tsx): the number with its store beside it (`ESS/#1001`), the one way an order number is drawn (AC-3)
- The api calls, filter shape, and query keys: [orders-api.ts](orders-api.ts), [order-filters.ts](order-filters.ts)
- Routes: `src/app/(backoffice)/orders/page.tsx`, `orders/new/page.tsx`, `orders/[orderId]/page.tsx`

## Never touches

- A typed search in a URL, query string, log, history, or storage (Law 151, spec 0013 AC-4): a search text (a phone or an order number) is sent only as a `POST /api/orders/search` body and kept in component state; `GET /api/orders` carries only the non personal filters. Only a customer id (`/orders?customerId=`) and the hold flag (`/orders?hold=1`, the unsynced edits link of the navigation, spec 0016 AC-7) may arrive in the address.
- Parsing a phone or computing order totals for the record: the api does both. The form's total is a preview (`LineAmounts.compute` with the options' tax rule) and the prepayment it sends for a prepaid method is that total, which the api checks again.
- Who may see cost: the unit cost column exists only when the answer carries `unitCost`, which the api sends to `cost.view` holders alone.
- Hard coded text or physical side CSS classes. Use `t()` and logical classes; names sit in `<bdi dir="auto">`, order numbers, SKU codes, and phones in `LtrText`, money and dates through `useFormat()`.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/orders
pnpm --filter @ssdashboard/web test:e2e e2e/orders.spec.ts e2e/orders-edit.spec.ts --project=desktop --project=mobile
```

The e2e needs the api and Postgres; each test seeds its own signed in person and SKU. The journey that packs makes a stocked warehouse the online location first (`stockedOnline` in `e2e/order-stock.ts`) under the cross worker online flag lock, because a pack of a short line answers `LINE_SHORT`.

## Governing spec

- [0013 Orders and their state machines](../../../../docs/specs/0013-orders-state-machines/index.md) (milestone 1, task 7: AC-2, AC-3, AC-4, AC-5, AC-20, AC-23; milestone 2, task 11: AC-7 to AC-12; milestone 4, task 13: the short flag, filter, and mark and `LINE_SHORT`, AC-4, AC-5, AC-7, AC-13)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)
- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

- **Filters apply at once and live in component state**, not the address, because the search box shares the filters object and a phone must never reach a URL.
- **Store and channel filters** come from `GET /api/orders/filter-options` (`orders.view`): every store and channel, Shopify ones included. The new order form takes its own, narrower lists from `GET /api/orders/options` (`orders.confirm`).
- **Only what changed is sent.** The edit dialog compares each ship to field, the shipping charge, and each line action with the order it was opened on and sends the difference as one edit; a form with no change says so instead of calling the api. Every action sends the `updatedAt` the page showed; a stale answer closes the dialog, refetches, and says the order changed.
- **"Edit in Shopify" is learned from the api, not guessed.** `OrderDetail` carries no store kind, and the app may edit a Shopify order while write back is available, so the buttons stay until the api answers `EDIT_IN_SHOPIFY` or `CANCEL_IN_SHOPIFY`; the page then swaps that button for a calm note (kept until the page is left).
- **A gifted order's lines and shipping** show only to a holder of `orders.gift` (without it the dialog says so and keeps the ship to block), and a gifted line is sent with an equal discount.
- The write back command detail comes from `OrderDetail.writeBackCommands`; the short mark comes from `OrderDetail.lines[].shortQuantity` and the list flag and filter from `OrderListItem.short` and `short=true` (milestone 4, AC-13). A refused pack (409 `LINE_SHORT`) shows its own sentence from [order-write-errors.ts](order-write-errors.ts).
