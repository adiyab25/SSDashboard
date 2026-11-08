# Order screens

The order list at `/orders`, one order at `/orders/[orderId]`, and the new order form at `/orders/new`, for people with `orders.view` (the form needs `orders.confirm`, a gifted order `orders.gift`).

## Owns

- List: [orders-page.tsx](orders-page.tsx) (the access gate), [orders-view.tsx](orders-view.tsx) (search box, keyset "Load more", the "N shown, more available" status), [order-filter-bar.tsx](order-filter-bar.tsx), [order-results-table.tsx](order-results-table.tsx) (TanStack Table in the design system's fixed column order), [order-flags.tsx](order-flags.tsx) (hold, short, gift, replacement, reopened, phone needs fixing), and the chips [fulfillment-chip.tsx](fulfillment-chip.tsx) and [cash-chip.tsx](cash-chip.tsx)
- Order page: [order-detail-page.tsx](order-detail-page.tsx) (the access gate), [order-detail-view.tsx](order-detail-view.tsx) (header, links both ways, customer), and its sections for the ship to block, lines, money, and the event timeline; the audit entries come from the shared `RecordHistoryPanel` for `audit.read` holders
- New order: [new-order-page.tsx](new-order-page.tsx) (the access gate), [new-order-view.tsx](new-order-view.tsx) (react-hook-form with a Zod form schema built from the contract's field rules, the SKU picker of the inventory feature, gifted mode, the live total), [related-order-picker.tsx](related-order-picker.tsx)
- [order-number.tsx](order-number.tsx): the number with its store beside it (`ESS/#1001`), the one way an order number is drawn (AC-3)
- The api calls, filter shape, and query keys: [orders-api.ts](orders-api.ts), [order-filters.ts](order-filters.ts)
- Routes: `src/app/(backoffice)/orders/page.tsx`, `orders/new/page.tsx`, `orders/[orderId]/page.tsx`

## Never touches

- A typed search in a URL, query string, log, history, or storage (Law 151, spec 0013 AC-4): a search text (a phone or an order number) is sent only as a `POST /api/orders/search` body and kept in component state; `GET /api/orders` carries only the non personal filters. Only a customer id may arrive in the address (`/orders?customerId=`).
- Parsing a phone or computing order totals for the record: the api does both. The form's total is a preview (`LineAmounts.compute` with the options' tax rule) and the prepayment it sends for a prepaid method is that total, which the api checks again.
- Who may see cost: the unit cost column exists only when the answer carries `unitCost`, which the api sends to `cost.view` holders alone.
- Hard coded text or physical side CSS classes. Use `t()` and logical classes; names sit in `<bdi dir="auto">`, order numbers, SKU codes, and phones in `LtrText`, money and dates through `useFormat()`.

## How to test

```bash
pnpm --filter @ssdashboard/web exec vitest run src/orders
pnpm --filter @ssdashboard/web test:e2e e2e/orders.spec.ts --project=desktop --project=mobile
```

The e2e needs the api and Postgres; each test seeds its own signed in person and SKU.

## Governing spec

- [0013 Orders and their state machines](../../../../docs/specs/0013-orders-state-machines/index.md) (milestone 1, task 7: AC-2, AC-3, AC-4, AC-5, AC-20, AC-23)
- [0008 Roles as hats](../../../../docs/specs/0008-roles-as-hats/index.md)
- [0003 Design system and UI foundation](../../../../docs/specs/0003-design-system-ui-foundation/index.md)

## Decisions

- **Filters apply at once and live in component state**, not the address, because the search box shares the filters object and a phone must never reach a URL.
- **Store and channel filters** come from `GET /api/orders/filter-options` (`orders.view`): every store and channel, Shopify ones included. The new order form takes its own, narrower lists from `GET /api/orders/options` (`orders.confirm`).
- **Edit, cancel, confirm, and pack** screens, the write back command detail, and the short mark's source arrive with milestones 2 and 4; the page already shows the hold notice from `writeBackState` and a short mark when a line reports `shortQuantity`.
