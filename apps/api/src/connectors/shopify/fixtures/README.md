# Shopify fixtures (synthetic, to be replaced by recordings)

> **These files are synthetic, to be replaced by recordings.** Nobody recorded them from a Shopify store. They are hand written, shaped per the Shopify Admin GraphQL reference for API version `2026-10` (`SHOPIFY_API_VERSION`, [spec 0015](../../../../../../docs/specs/0015-shopify-connector/index.md)). Owner ruling 2026-11-07: until a Shopify development store exists, fixtures are hand written. Spec 0015 task 1 records them again from a development store with invented customers; the open box is scope feature 13, "Re-record fixtures from a Shopify dev store" ([scope](../../../../../../docs/scope/index.md)). Replace with recordings from a development store (spec 0015 task 1; scope feature 13 box), and until then never claim a Shopify behaviour from these files.

Each file carries a top level `_fixture` key (`synthetic: true`, `note`, `apiVersion`, `scenario`, `step`, `shapedFrom`). JSON cannot hold comments, so that key is the banner. A reader that replays a file ignores `_fixture`.

## Layout

`fixtures/<scenario>/NN-<operation>.json`, the layout of spec 0015 ("Fixtures and the mock server", AC-26). `NN` is the order of the calls inside the scenario: file `02` is what Shopify answers after the change that follows `01`, so a replay that serves the same request twice serves the files in order. Every file holds:

- `request`: `method`, `url` (`https://<shop>/admin/api/2026-10/graphql.json`), `shopDomain`, `operationName`, `variables`, and `headers` (only `X-Shopify-API-Version`; no token).
- `response`: `status`, `headers` (`X-Shopify-API-Version`, `Content-Type`), and `body` (`data`, and `extensions.cost` with the throttle status the client reads for [AC-25](../../../../../../docs/specs/0015-shopify-connector/index.md)).

The operation name `OrderRead` and the query text are not decided yet (`shopify-queries.ts` is spec 0015 task 4 and later); the fixtures keep the name and the variables (`id`) and no query text, so a replay matches on shop, operation, and variables, and the name may change when that file exists.

## Scenarios

| Folder | Files | What it is for |
|---|---|---|
| `order-created-cod` | 01 | Channel intake: a two line COD order (M and L), shipping 50.00 with a tax line, code `WELCOME10`, a customer note, an Arabic name, main phone and second phone, UTM data with one query key that is not on the allow list. |
| `order-edited-size-swap` | 01 to 04 | Channel edit: 01 before, 02 after a size swap (M line `currentQuantity` 0, new L line) and an address change, 03 an echo read with the same `updatedAt` (stale), 04 an echo read with a newer `updatedAt` and identical content. 02 also holds the `UPDATE` and `ORDER` sales of the same day and amount for edit netting (AC-11). |
| `order-unmapped-line` | 01 | Unmapped lines: one line whose variant maps, one naming a variant (`...0999`) with no mapping, one with `variant: null` (deleted variant). |
| `order-bad-phone` | 01 | Phones that do not parse: main phone `+201300000101` (prefix 13 is no Egyptian mobile) on the order, the ship to, and the customer, second phone `0100000`. |
| `order-prepaid-gateway` | 01 to 03 | Payment rules: 01 a card order, PAID, one successful `SALE` on gateway `Fixture Card Gateway`; 02 a COD order, unpaid; 03 the same COD order after "mark as paid" (PAID, a `manual` `SALE`), which must stay `cod` with prepaid 0. For `rederivePaymentMethod` the gateway name maps to a method through `config.gatewayMethods`. |
| `order-cancelled-customer` | 01, 02 | Channel cancel: 01 cancelled by the customer (`CUSTOMER`) before any fulfillment, 02 fulfilled, then cancelled by the customer after delivery. |
| `order-number-collision` | 01 to 03 | Order names: `#1001` in `fixture-store.myshopify.com` (01), `#1001` in `fixture-store-2.myshopify.com` (02), and a second order named `#1001` with another id in the first shop (03). |
| `order-exchange-added-lines` | 01, 02 | Exchange by editing a delivered order (AC-12): 01 the fulfilled order, 02 a new L line added and the M line refunded and restocked (`currentQuantity` 0), with the `ORDER_EDIT` and `REFUND` agreements and the refund line. |
| `order-go-live-import` | 01 to 03 | Orders placed before an assumed go live of `2026-11-01T00:00:00Z`: 01 open and unfulfilled, 02 fulfilled, 03 cancelled by staff. |

## Field conventions

- Shops: `fixture-store.myshopify.com` and `fixture-store-2.myshopify.com`. No real shop domain, token, or secret anywhere. Hosts of links inside the data end in `.example`.
- Ids are Shopify gids with invented numbers: orders `5550000...`, line items `6660000...`, variants `7770000...`, customers `8880000...`, fulfillments `9990000...`, one location `4440000000001` (the same number prefixes the order agreements, which are `OrderAgreement` ids).
- People: invented Arabic names (`مها تجريبية`, "Maha Experimental"), invented streets, areas that are public place names only. Phones are in the test style `+2010000001xx` (a valid Egyptian mobile shape, `EgyptianPhone.parse` accepts them; they are not claimed to be unassigned numbers).
- **Second phone**: an order custom attribute (`customAttributes`, what Shopify's admin calls a note attribute) with key `alt_phone`. Chosen because spec 0015's value sourcing reads it from "the order custom attribute named by `config.altPhoneAttribute`", so a test sets `altPhoneAttribute` to `alt_phone`; it keeps the note field for the customer's own note.
- **Money**: every amount is a string with two decimals (`"450.00"`), in `shopMoney` and `presentmentMoney`, currency `EGP`. Real Shopify may trim trailing zeros; the recordings will settle it, and the mapper must parse the string, never compare text.
- **Prices**: tee 450.00 a piece, code `WELCOME10` 45.00 a line as a `discountAllocations` entry, VAT 14 percent as `taxLines` (`rate` 0.14, `ratePercentage` 14.0), shipping 50.00 with a 7.00 tax line.
- **Connections** (`lineItems`, `shippingLines`, `agreements`, `sales`, `refundLineItems`) hold `nodes` only, with no `edges` and no `pageInfo`. `fulfillments`, `transactions`, `refunds`, and `customAttributes` are plain lists, as the reference types them.
- **Times**: UTC, ISO 8601 with `Z`. `updatedAt` always moves forward inside a scenario.
- `customerJourneySummary.lastVisit` and `firstVisit` carry `utmParameters` and a `landingPage` with `email_token=fixture-not-on-the-allow-list` to test the UTM allow list (spec 0002 Follow-up m5).

## Fields checked and not checked on shopify.dev (2026-10)

Checked (each field and enum value used was read on its `2026-10` reference page): `Order` (`id`, `name`, `createdAt`, `updatedAt`, `cancelledAt`, `cancelReason`, `test`, `displayFinancialStatus`, `displayFulfillmentStatus`, `paymentGatewayNames`, `currencyCode`, `current*PriceSet`, `totalPriceSet`, `totalShippingPriceSet`, `shippingLines`, `discountCodes`, `note`, `tags`, `sourceName`, `customAttributes`, `phone`, `customer`, `shippingAddress`, `customerJourneySummary`, `lineItems`, `fulfillments`, `transactions`, `refunds`, `agreements`), `LineItem`, `MailingAddress`, `ShippingLine`, `TaxLine`, `Fulfillment`, `OrderTransaction`, `OrderAgreement`, `ProductSale`, `Refund`, `RefundLineItem`, `CustomerVisit`, `UTMParameters`, `DiscountAllocation`, `MoneyBag`, `Attribute`, and the enums `OrderCancelReason`, `OrderDisplayFinancialStatus`, `OrderDisplayFulfillmentStatus`, `FulfillmentStatus`, `SaleActionType`, `SaleLineType`, `OrderActionType`, `OrderTransactionKind`, `OrderTransactionStatus`, `RefundLineItemRestockType`.

Findings and gaps:

- **`Customer.phone` is deprecated** on `2026-10`. Spec 0015's order mapper falls back to `customer.phone`; the fixtures still carry it so that fallback can be tested, but spec 0015 task 1 should check the replacement field (not read here) before the order query is written.
- **`LineItem.fulfillableQuantity` is deprecated.** Spec 0015 says "fulfillable quantity (task 1)"; the fixtures use `unfulfilledQuantity` and `refundableQuantity`, both listed on the page, and leave the choice to task 1.
- **Not verified**: the `DiscountApplication` fields (the fixtures show `__typename` `DiscountCodeApplication` and `code`, from memory of the interface, not read); the `Location` fields beyond `id`; `Order.agreements` ordering; whether Shopify lists `paymentGatewayNames` as `Cash on Delivery (COD)` (a merchant's own manual payment name) or `manual` after "mark as paid"; the real size of the cost extension numbers. These are invented to be plausible.
- `Order.taxesIncluded`, `Order.confirmed`, and webhook payloads are not used. A webhook body is a REST style payload, not part of these GraphQL fixtures; spec 0015 task 7's signature tests carry their own known good and tampered bodies.

## Doc pages used (all `https://shopify.dev/docs/api/admin-graphql/2026-10/`)

`objects/Order`, `objects/LineItem`, `objects/MailingAddress`, `objects/ShippingLine`, `objects/TaxLine`, `objects/Fulfillment`, `objects/OrderTransaction`, `objects/OrderAgreement`, `objects/ProductSale`, `interfaces/Sale`, `interfaces/SalesAgreement`, `objects/Refund`, `objects/RefundLineItem`, `objects/CustomerJourneySummary`, `objects/CustomerVisit`, `objects/UTMParameters`, `objects/DiscountAllocation`, `objects/MoneyBag`, `objects/Attribute`, `objects/Customer`, and under `enums/`: `OrderCancelReason`, `OrderDisplayFinancialStatus`, `OrderDisplayFulfillmentStatus`, `FulfillmentStatus`, `SaleActionType`, `SaleLineType`, `OrderActionType`, `OrderTransactionKind`, `OrderTransactionStatus`, `RefundLineItemRestockType`.

## Who uses them

`apps/api/test/orders-intake.e2e-spec.ts` (spec 0013 milestone 3) reads every scenario through `apps/api/test/shopify-order-fixture.ts`, a test only stand in for spec 0015's `order-mapper.ts` that maps a file to `ChannelOrderInput` and `ChannelOrderSnapshot` and is replaced when spec 0015 tasks 4 to 7 land. A scenario's files are used by number, and the mapper reads only the fields listed in that file's zod subset. The bad phone scenario has its own customer id on purpose, so the order stays unlinked (a known customer id would link it).

## Not here yet

Product reads, shop and location queries, webhook subscription calls, throttled and error responses (`THROTTLED`, 429 with `Retry-After`, 5xx), and the refusing `fetch` and the replay server (`apps/api/test/`) belong to spec 0015 tasks 1 and 4 to 7. Nothing reads these files yet except the tests that name them.

## How to check

```bash
node -e "for (const f of require('node:fs').readdirSync('.', {recursive:true})) if (f.endsWith('.json')) JSON.parse(require('node:fs').readFileSync(f,'utf8'))"
pnpm exec prettier --check apps/api/src/connectors/shopify
```

Run the first line from this folder.
