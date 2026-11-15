/**
 * Every Shopify Admin GraphQL query and mutation text the connector sends, one exported constant
 * each (spec 0015, *Where it lives*), for API version `2026-10` (`SHOPIFY_API_VERSION` in
 * `shopify-client.ts`). Each text names its operation, so a recording matches on the operation
 * name and variables (`apps/api/test/shopify-fixture-fetch.ts`).
 *
 * Fields were read on `https://shopify.dev/docs/api/admin-graphql/2026-10/` (the connector README
 * lists the pages). Never add a field from memory, and never select more personal data than the
 * caller needs: a selected name, phone, or address passes through memory only, never a log.
 */

/** The operation name of `CONNECT_SHOP`. */
export const CONNECT_SHOP_OPERATION = 'ConnectShop';

/**
 * The shop's name, currency, and IANA time zone, read at connect (AC-1: the store's names, the
 * currency check, and the time zone warning). `Shop.name`, `currencyCode`, `ianaTimezone`, and
 * `myshopifyDomain` are non null on `2026-10`.
 */
export const CONNECT_SHOP = `query ConnectShop {
  shop {
    name
    currencyCode
    ianaTimezone
    myshopifyDomain
  }
}`;

/** The operation name of `CONNECT_ACCESS_SCOPES`. */
export const CONNECT_ACCESS_SCOPES_OPERATION = 'ConnectAccessScopes';

/**
 * The scopes the store granted the app, compared with `SHOPIFY_REQUIRED_SCOPES` at connect and
 * every hour. `AppInstallation.accessScopes` is `[AccessScope!]!` and `AccessScope.handle` a
 * `String!` such as `read_orders`.
 */
export const CONNECT_ACCESS_SCOPES = `query ConnectAccessScopes {
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}`;

/** The operation name of `CONNECT_LOCATIONS`. */
export const CONNECT_LOCATIONS_OPERATION = 'ConnectLocations';

/**
 * The store's locations with whether each fulfils online orders, for the stock location mapping
 * and the "other locations" check (AC-22). Inactive locations are included on purpose
 * (`includeInactive: true`; the default returns only active ones), so the connect job sees all.
 * Variables: `first` (at most 250, Shopify's input array cap).
 */
export const CONNECT_LOCATIONS = `query ConnectLocations($first: Int!) {
  locations(first: $first, includeInactive: true) {
    nodes {
      id
      name
      fulfillsOnlineOrders
      isActive
    }
  }
}`;

/** The operation name of `CONNECT_LATEST_ORDER`. */
export const CONNECT_LATEST_ORDER_OPERATION = 'ConnectLatestOrder';

/**
 * The most recent order's ship to name, phone, and first address line, read only to tell whether
 * the protected customer fields are granted (`PROTECTED_DATA_MISSING`). The caller reduces each
 * value to "present or not" at once and never stores, logs, or returns the values themselves.
 */
export const CONNECT_LATEST_ORDER = `query ConnectLatestOrder {
  orders(first: 1, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id
      shippingAddress {
        name
        phone
        address1
      }
    }
  }
}`;

/** The operation name of `WEBHOOK_SUBSCRIPTION_CREATE`. */
export const WEBHOOK_SUBSCRIPTION_CREATE_OPERATION = 'WebhookSubscriptionCreate';

/**
 * Registers one webhook topic for a connection. Variables: `topic` (`WebhookSubscriptionTopic`)
 * and `webhookSubscription` (`{ uri, format: JSON }`, the address `PUBLIC_URL` +
 * `/api/hooks/shopify/<connection id>`). `userErrors` are read as codes only: `message` may echo
 * the input, so the client never puts it in an error or a log.
 */
export const WEBHOOK_SUBSCRIPTION_CREATE = `mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription {
      id
      topic
      uri
      format
    }
    userErrors {
      field
      message
    }
  }
}`;

/** The operation name of `WEBHOOK_SUBSCRIPTIONS`. */
export const WEBHOOK_SUBSCRIPTIONS_OPERATION = 'WebhookSubscriptions';

/**
 * The connection's existing webhook subscriptions, for the connect job and the hourly check
 * (Shopify deletes a subscription after 8 failed deliveries in a row). Variables: `first` and
 * `after` (a cursor, or null).
 */
export const WEBHOOK_SUBSCRIPTIONS = `query WebhookSubscriptions($first: Int!, $after: String) {
  webhookSubscriptions(first: $first, after: $after) {
    nodes {
      id
      topic
      uri
      format
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

// --- Order read back (spec 0015 Inbound processing item 4, `order-mapper.ts`) -----------------

/** The operation name of `ORDER_READ`. */
export const ORDER_READ_OPERATION = 'OrderRead';

/**
 * Line items read per order. An order with more makes the mapper refuse with
 * `LINE_ITEMS_TRUNCATED` (never a short snapshot, which would cancel the unread lines).
 */
export const ORDER_READ_LINE_ITEMS_PAGE = 40;

/**
 * Tax lines read per line item; their percentages are summed into the line's rate. A full page
 * makes the mapper refuse with `TAX_LINES_TRUNCATED` (more may exist). 4 (lowered from 10 by spec
 * 0015 task 10, to make room for the sales history inside the 900 point budget) still reads 3 tax
 * lines a line, above any real Egyptian line (VAT is one tax line), so a valid order is not
 * refused for its tax lines.
 */
export const ORDER_READ_TAX_LINES_PAGE = 4;

/** Discount applications read per order, for the shipping discount exclusion. */
export const ORDER_READ_DISCOUNT_APPLICATIONS_PAGE = 10;

/** Fulfillments read per order. A full page makes the mapper refuse with `FULFILLMENTS_TRUNCATED`. */
export const ORDER_READ_FULFILLMENTS_PAGE = 10;

/** Transactions read per order. A full page makes the mapper refuse with `TRANSACTIONS_TRUNCATED`. */
export const ORDER_READ_TRANSACTIONS_PAGE = 30;

/**
 * Sales agreements read per order, newest first (`reverse: true`; spec 0015 task 10, edit netting
 * and refunds, Inbound processing item 5): the order itself, each edit, each refund. A next page
 * is not refused, because the agreements change no order: `edit-netting.ts` nets and records what
 * it read and reports the history as truncated, which the inbox job keeps on the mapping
 * (`state.salesHistoryTruncated`). Newest first, so a long history loses its oldest agreements,
 * whose pairs and refunds earlier read backs already recorded.
 */
export const ORDER_READ_AGREEMENTS_PAGE = 8;

/**
 * Sales read per agreement (one per line, shipping line, fee, or tip it touched). A next page is
 * reported as truncated, as for the agreements, and a refund whose sales are truncated is not
 * recorded (its amount would be short).
 */
export const ORDER_READ_SALES_PAGE = 9;

/**
 * The requested cost estimate of `ORDER_READ` in points, by the rule its TSDoc states (objects 1,
 * scalars 0, a connection sized by `first`), computed from the page sizes, so a page change that
 * breaks the 900 point budget of the rate policy (AC-25) fails `shopify-queries.spec.ts`. Task
 * 1's recordings replace it with Shopify's `requestedQueryCost`.
 */
export const ORDER_READ_ESTIMATED_COST =
  // a line item: the item, its variant, its money bag and money, one discount allocation with its
  // money bag and money, and each tax line
  ORDER_READ_LINE_ITEMS_PAGE * (1 + 1 + 2 + 3 + ORDER_READ_TAX_LINES_PAGE) +
  // a transaction: the transaction, its money bag and money
  ORDER_READ_TRANSACTIONS_PAGE * 3 +
  ORDER_READ_FULFILLMENTS_PAGE +
  ORDER_READ_DISCOUNT_APPLICATIONS_PAGE +
  // the customer, its phone, the address, the journey and its visits, and the order's money bags
  15 +
  // an agreement: the agreement, a refund's id object, and each sale (the sale, its money bag and
  // money, its line item)
  ORDER_READ_AGREEMENTS_PAGE * (1 + 1 + ORDER_READ_SALES_PAGE * 4);

/**
 * The fields of one order every order read selects (`ORDER_READ` and the paged backfill fallback
 * `ORDERS_BACKFILL_PAGE`), exactly what `ShopifyOrder` in `order-mapper.ts` parses, the sales
 * history (`agreements`, task 10) included.
 */
const ORDER_FIELDS = `
    id
    name
    createdAt
    updatedAt
    test
    cancelledAt
    cancelReason
    paymentGatewayNames
    totalPriceSet {
      shopMoney {
        amount
      }
    }
    currentTotalPriceSet {
      shopMoney {
        amount
      }
    }
    taxesIncluded
    currentShippingPriceSet {
      shopMoney {
        amount
      }
    }
    discountCodes
    discountApplications(first: ${ORDER_READ_DISCOUNT_APPLICATIONS_PAGE}) {
      nodes {
        __typename
        targetType
        ... on DiscountCodeApplication {
          code
        }
      }
      pageInfo {
        hasNextPage
      }
    }
    note
    phone
    tags
    customAttributes {
      key
      value
    }
    customer {
      id
      defaultPhoneNumber {
        phoneNumber
      }
      phone
    }
    shippingAddress {
      name
      phone
      address1
      address2
      city
      province
    }
    customerJourneySummary {
      firstVisit {
        landingPage
        referrerUrl
        utmParameters {
          source
          medium
          campaign
          content
        }
      }
      lastVisit {
        landingPage
        referrerUrl
        utmParameters {
          source
          medium
          campaign
          content
        }
      }
    }
    lineItems(first: ${ORDER_READ_LINE_ITEMS_PAGE}) {
      nodes {
        id
        title
        variantTitle
        quantity
        currentQuantity
        unfulfilledQuantity
        variant {
          id
        }
        originalUnitPriceSet {
          shopMoney {
            amount
          }
        }
        discountAllocations {
          allocatedAmountSet {
            shopMoney {
              amount
            }
          }
        }
        taxLines(first: ${ORDER_READ_TAX_LINES_PAGE}) {
          rate
          ratePercentage
        }
      }
      pageInfo {
        hasNextPage
      }
    }
    fulfillments(first: ${ORDER_READ_FULFILLMENTS_PAGE}) {
      id
      status
      createdAt
    }
    transactions(first: ${ORDER_READ_TRANSACTIONS_PAGE}) {
      id
      kind
      status
      gateway
      amountSet {
        shopMoney {
          amount
        }
      }
    }
    agreements(first: ${ORDER_READ_AGREEMENTS_PAGE}, reverse: true) {
      nodes {
        id
        happenedAt
        ... on RefundAgreement {
          refund {
            id
          }
        }
        sales(first: ${ORDER_READ_SALES_PAGE}) {
          nodes {
            id
            actionType
            lineType
            quantity
            totalAmount {
              shopMoney {
                amount
              }
            }
            ... on ProductSale {
              lineItem {
                id
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
`;

/**
 * The read back of one order (AC-7, AC-9 to AC-13), selecting exactly what `ShopifyOrder` in
 * `order-mapper.ts` parses. Variables: `id` (the order gid). Carry-overs settled in the Shopify
 * README: the customer phone is `defaultPhoneNumber.phoneNumber` with the deprecated `phone` as a
 * fallback (D4); line items select `unfulfilledQuantity`, never the deprecated
 * `fulfillableQuantity` (D5); the shipping discount exclusion reads `discountApplications` with
 * `targetType` and `DiscountCodeApplication.code` (D6).
 *
 * The sales history (spec 0015 task 10, Inbound processing item 5) reads `agreements` newest
 * first, with each agreement's `id`, `happenedAt`, the refund id of a `RefundAgreement`, and its
 * `sales`: `id`, `actionType`, `lineType`, `quantity`, `totalAmount`, and the line item id of a
 * `ProductSale` (read on `interfaces/SalesAgreement`, `objects/RefundAgreement` (its `refund`
 * is non null), `interfaces/Sale`, `objects/ProductSale` (its `lineItem` is non null),
 * `enums/SaleActionType`, `enums/SaleLineType`, and the `agreements` field of `objects/Order`
 * (`first`, `reverse`, no sort key), `2026-10`, on 2026-11-08). A sale's variant is the variant
 * of its line item, looked up in `lineItems` (every line item is read, or the read is refused),
 * so the sales select no variant. The default order of `agreements` is not stated on that page
 * (not verified): `edit-netting.ts` orders sales by id itself.
 *
 * Requested cost estimate (objects 1, scalars 0, a connection sized by `first`, shopify.dev
 * "GraphQL Admin API rate limits", read 2026-11-08; that page gives no rule for a plain list such
 * as `taxLines`, so each listed tax line is counted as one object, the most it can cost): line
 * items 40 x 11 (the item 1, its variant 1, its `MoneyBag` and money 2, one discount allocation
 * with its `MoneyBag` and money 3, 4 tax lines 4) = 440, transactions 30 x 3 = 90 (the
 * transaction, its `MoneyBag` and money; its `id`, a scalar, read on `objects/OrderTransaction`
 * 2026-10 on 2026-11-08 for lead decisions D10 and D10a), fulfillments 10, discount applications
 * 10, customer, address, journey, and money about 15, agreements 8 x 38 (the agreement 1, a
 * refund 1, 9 sales x 4: the sale 1, its `MoneyBag` and money 2, its line item 1) = 304: about
 * 869 (`ORDER_READ_ESTIMATED_COST`), under the 900 budget of the rate policy (AC-25). The trade
 * off (task 10, 2026-11-08): the tax line page went from 10 to 4 to make room for the sales
 * history; keeping 10 tax lines would have left room for about one agreement. Task 1's
 * recordings replace the estimate with Shopify's `requestedQueryCost`.
 */
export const ORDER_READ = `query OrderRead($id: ID!) {
  order(id: $id) {${ORDER_FIELDS}
  }
}`;

// --- Customer read back (spec 0015 AC-15, `customer-mapper.ts`) -------------------------------

/** The operation name of `CUSTOMER_READ`. */
export const CUSTOMER_READ_OPERATION = 'CustomerRead';

/**
 * The read back of one customer for `customers/create` and `customers/update` (AC-15), selecting
 * exactly what `ShopifyCustomer` in `customer-mapper.ts` parses: the id, `updatedAt` (the stale
 * rule), the first and last name (joined into the customer's name), and the phone. Variables:
 * `id` (the customer gid). Read on `objects/Customer` and `queries/customer` (`2026-10`,
 * 2026-11-08): `id: ID!`, `updatedAt: DateTime!`, `firstName` and `lastName` nullable `String`,
 * `defaultPhoneNumber: CustomerPhoneNumber` (`phoneNumber: String!`), and `phone` deprecated, so it
 * is read only as a fallback (carry-over D4, as `ORDER_READ`); the query takes `id: ID!` and
 * returns a nullable `Customer`. No email or address is selected: the app needs neither.
 *
 * Requested cost estimate (objects 1, scalars 0): the customer 1 and its phone number object 1,
 * about 2 points; the recordings of task 1 replace it with Shopify's `requestedQueryCost`.
 */
export const CUSTOMER_READ = `query CustomerRead($id: ID!) {
  customer(id: $id) {
    id
    updatedAt
    firstName
    lastName
    defaultPhoneNumber {
      phoneNumber
    }
    phone
  }
}`;

/** The expected cost of `CUSTOMER_READ` in points, passed to the client's throttle (AC-25). */
export const CUSTOMER_READ_EXPECTED_COST = 2;

// --- Product read back (spec 0015 task 8, AC-16, `product-mapper.ts`) ------------------------
// Read on `https://shopify.dev/docs/api/admin-graphql/2026-10/` (`objects/Product`,
// `objects/ProductOption`, `objects/ProductVariant`, `objects/SelectedOption`,
// `objects/InventoryItem`, `objects/InventoryItemMeasurement`, `objects/Weight`,
// `enums/WeightUnit`, `queries/product`, `queries/productVariant`) on 2026-11-12: `Product.handle`,
// `title`, `productType`, `vendor` are `String!`, `tags` `[String!]!`, `status` `ProductStatus!`,
// `isGiftCard` `Boolean!`, `updatedAt` `DateTime!`, `options(first:)` `[ProductOption!]!`
// (`name: String!`, `position: Int!`, `values: [String!]!`), `variants` a
// `ProductVariantConnection!` sorted by `POSITION` by default; `ProductVariant.sku` `String`,
// `price` `Money!`, `compareAtPrice` `Money`, `barcode` `String` (deprecated on `2026-10` in favour
// of the `barcodes` connection, still served; a nested connection per variant would multiply the
// page cost, so the deprecated scalar is read until task 1's recordings decide), `selectedOptions`
// `[SelectedOption!]!` (`name`, `value: String!`), `inventoryItem` `InventoryItem!` (`tracked`,
// `requiresShipping: Boolean!`, `measurement: InventoryItemMeasurement!` with `weight: Weight`,
// `unit: WeightUnit!` of `GRAMS`, `KILOGRAMS`, `OUNCES`, `POUNDS`, `value: Float!`);
// `product(id: ID!)` and `productVariant(id: ID!)` answer nullable objects, and
// `ProductVariant.product` is `Product!`.

/** Product options read per product: Shopify allows at most 3 (`MAX_CHANNEL_OPTIONS`). */
export const PRODUCT_READ_OPTIONS_PAGE = 3;

/**
 * Variants read per page of one product (spec 0015 AC-16, amended 2026-11-12 from 250): by the
 * cost rule this file uses (objects 1, scalars 0, a connection sized by `first`), a variant with its selected
 * options (up to 3 objects), inventory item, measurement, and weight counts 7 points, so 250 would
 * request about 1,750 points, above Shopify's 1,000 point single query limit (AC-25). 100 keeps
 * the estimate at 708 (`PRODUCT_READ_ESTIMATED_COST`); task 1's recordings give Shopify's
 * `requestedQueryCost`, and the page grows when they allow it. A 2,048 variant product takes 21
 * pages.
 */
export const PRODUCT_READ_VARIANTS_PAGE = 100;

/**
 * The requested cost estimate of `PRODUCT_READ` (and of each `PRODUCT_VARIANTS_PAGE`) in points:
 * the product and its options, plus 7 per variant (see `PRODUCT_READ_VARIANTS_PAGE`).
 */
export const PRODUCT_READ_ESTIMATED_COST =
  1 + PRODUCT_READ_OPTIONS_PAGE + PRODUCT_READ_VARIANTS_PAGE * 7;

/** The fields of one product every product read selects, variants apart. */
const PRODUCT_FIELDS = `
        id
        handle
        title
        productType
        vendor
        tags
        status
        isGiftCard
        updatedAt
        options(first: ${PRODUCT_READ_OPTIONS_PAGE}) {
          name
          position
          values
        }`;

/** The fields of one variant every product read selects (what `ShopifyProductVariant` parses). */
const PRODUCT_VARIANT_FIELDS = `
              id
              sku
              price
              compareAtPrice
              barcode
              selectedOptions {
                name
                value
              }
              inventoryItem {
                id
                tracked
                requiresShipping
                measurement {
                  weight {
                    unit
                    value
                  }
                }
              }`;

/** The operation name of `PRODUCT_READ`. */
export const PRODUCT_READ_OPERATION = 'ProductRead';

/**
 * The read back of one product for `products/create`, `products/update`, and `products/delete`
 * (AC-16) and for the product read before an order (AC-9, review M8): the product and its first
 * `PRODUCT_READ_VARIANTS_PAGE` variants with the page info; further pages come from
 * `PRODUCT_VARIANTS_PAGE`. Variables: `id` (the product gid). Nothing personal is selected.
 */
export const PRODUCT_READ = `query ProductRead($id: ID!) {
  product(id: $id) {${PRODUCT_FIELDS}
    variants(first: ${PRODUCT_READ_VARIANTS_PAGE}) {
      nodes {${PRODUCT_VARIANT_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

/** The operation name of `PRODUCT_VARIANTS_PAGE`. */
export const PRODUCT_VARIANTS_PAGE_OPERATION = 'ProductVariantsPage';

/**
 * One further page of a product's variants (AC-16: paged until Shopify's 2,048 variant limit).
 * Variables: `id` (the product gid) and `after` (the previous page's end cursor).
 */
export const PRODUCT_VARIANTS_PAGE = `query ProductVariantsPage($id: ID!, $after: String!) {
  product(id: $id) {
    id
    variants(first: ${PRODUCT_READ_VARIANTS_PAGE}, after: $after) {
      nodes {${PRODUCT_VARIANT_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

/** The operation name of `PRODUCT_OF_VARIANT_READ`. */
export const PRODUCT_OF_VARIANT_READ_OPERATION = 'ProductOfVariantRead';

/**
 * The product of one Shopify variant (AC-9, review M8): an order line names its variant only, so
 * the product read before an order first asks which product the variant belongs to. Variables:
 * `id` (the variant gid). The variant is null when Shopify no longer has it.
 */
export const PRODUCT_OF_VARIANT_READ = `query ProductOfVariantRead($id: ID!) {
  productVariant(id: $id) {
    id
    product {
      id
    }
  }
}`;

/** The expected cost of `PRODUCT_OF_VARIANT_READ`: the variant and its product, 2 points. */
export const PRODUCT_OF_VARIANT_READ_EXPECTED_COST = 2;

// --- Sweeps (spec 0015 task 12, AC-18, *Backfill, go live, and sweeps*) ----------------------

/** Orders or products listed per sweep page (Shopify's page cap). */
export const SWEEP_PAGE = 250;

/**
 * The expected cost of one sweep page: the connection sized by `first` (250 objects; `id`, `name`,
 * and `updatedAt` are scalars at 0) plus the page info, per the rate limits page read for the
 * order mapper (object 1, scalar 0, a connection sized by `first`). About 252 points; 11 pages fit
 * one chunk's 3,000 point budget.
 */
export const SWEEP_PAGE_EXPECTED_COST = SWEEP_PAGE + 2;

/**
 * The search filter of a sweep: objects updated at or after an instant, in Shopify's search
 * syntax (`updated_at:>='<ISO instant>'`), the shape spec 0015 names for the orders sweep.
 */
export function updatedSinceFilter(sinceIso: string): string {
  return `updated_at:>='${sinceIso}'`;
}

/**
 * The search filter of the backfill and the gateway scan: objects created at or after an instant
 * (`created_at:>='<ISO instant>'`).
 */
export function createdSinceFilter(sinceIso: string): string {
  return `created_at:>='${sinceIso}'`;
}

/** The operation name of `ORDERS_SWEEP`. */
export const ORDERS_SWEEP_OPERATION = 'OrdersSweep';

/**
 * One page of the orders sweep (AC-18): orders updated since the filter, oldest change first, with
 * only their id, name, and `updatedAt`, so nothing personal is read; each one newer than its
 * applied version enters the inbox and is read back by the inbox job. Variables: `query`
 * (`updatedSinceFilter`) and `after` (the page cursor, or null). `Order.name` and `updatedAt` are
 * non null on `2026-10` (read for the order mapper on `objects/Order`).
 */
export const ORDERS_SWEEP = `query OrdersSweep($query: String!, $after: String) {
  orders(first: ${SWEEP_PAGE}, after: $after, sortKey: UPDATED_AT, query: $query) {
    nodes {
      id
      name
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

/** The operation name of `PRODUCTS_SWEEP`. */
export const PRODUCTS_SWEEP_OPERATION = 'ProductsSweep';

/**
 * One page of the products sweep (AC-18, every 30 minutes): products updated since the filter,
 * with their id and `updatedAt` only. Variables as `ORDERS_SWEEP`. Each found product newer than
 * its applied version enters the inbox with its job, which reads it back (`PRODUCT_READ`, task 8).
 */
export const PRODUCTS_SWEEP = `query ProductsSweep($query: String!, $after: String) {
  products(first: ${SWEEP_PAGE}, after: $after, sortKey: UPDATED_AT, query: $query) {
    nodes {
      id
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

// --- Bulk operations (spec 0015 task 12, AC-17: the gateway scan and the backfill) -----------
// Read on `https://shopify.dev/docs/api/usage/bulk-operations/queries` and the `2026-10`
// references of `bulkOperationRunQuery`, `bulkOperation`, `BulkOperation`, and
// `BulkOperationUserError` on 2026-11-08: one top level connection, at most five connections, at
// most two nested levels, every connection a `Node`; `first`, cursors, and `pageInfo` are ignored;
// each node of a nested connection is its own JSONL line after its parent, with `__parentId`; the
// result address is signed and expires after a week; `bulkOperation(id:)` replaces the deprecated
// `currentBulkOperation` from `2026-01`.

/** The operation name of `BULK_OPERATION_RUN_QUERY`. */
export const BULK_OPERATION_RUN_QUERY_OPERATION = 'BulkOperationRunQuery';

/**
 * Starts one bulk query (`bulkOperationRunQuery(query: String!)`, `groupObjects` left at its
 * default `false`). Variables: `query`, the bulk query text. `userErrors` are read as codes only
 * (`BulkOperationUserError.code`): `message` may echo the input.
 */
export const BULK_OPERATION_RUN_QUERY = `mutation BulkOperationRunQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation {
      id
      status
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

/** The operation name of `BULK_OPERATION_READ`. */
export const BULK_OPERATION_READ_OPERATION = 'BulkOperationRead';

/**
 * One bulk operation's progress and result (`bulkOperation(id: ID!)`): `status`
 * (`BulkOperationStatus!`), `errorCode`, `objectCount` and `rootObjectCount`
 * (`UnsignedInt64!`, sent as strings), and `url` (`URL`, null when the query found nothing).
 * The address is never stored or logged: it is read again by every chunk that streams the file.
 */
export const BULK_OPERATION_READ = `query BulkOperationRead($id: ID!) {
  bulkOperation(id: $id) {
    id
    status
    errorCode
    objectCount
    rootObjectCount
    url
  }
}`;

/** The expected cost of a bulk start or read: one object and its scalars. */
export const BULK_OPERATION_EXPECTED_COST = 10;

/**
 * The gateway scan's bulk query (AC-17, review M6): every order created since the instant, with
 * only its id and payment gateway names (`Order.paymentGatewayNames: [String!]!`).
 */
export function gatewayScanBulkQuery(sinceIso: string): string {
  return `{
  orders(query: "${createdSinceFilter(sinceIso)}") {
    edges {
      node {
        id
        paymentGatewayNames
      }
    }
  }
}`;
}

/**
 * The products backfill's bulk query (AC-17, task 8): every product with exactly the fields
 * `PRODUCT_READ` selects, its variants as a nested connection (one JSONL line each, at most
 * `MAX_CHANNEL_VARIANTS` per product), so `assembleBulkProduct` gives the product mapper the read
 * back's shape and the backfill applies each product with no second read (AC-7).
 */
export const PRODUCTS_BULK_QUERY = `{
  products {
    edges {
      node {${PRODUCT_FIELDS}
        variants {
          edges {
            node {${PRODUCT_VARIANT_FIELDS}
            }
          }
        }
      }
    }
  }
}`;

/** `ORDER_FIELDS` as a bulk query takes them (see `ordersBulkQuery`). */
const ORDER_BULK_FIELDS = `
        id
        name
        createdAt
        updatedAt
        test
        cancelledAt
        cancelReason
        paymentGatewayNames
        totalPriceSet {
          shopMoney {
            amount
          }
        }
        currentTotalPriceSet {
          shopMoney {
            amount
          }
        }
        taxesIncluded
        currentShippingPriceSet {
          shopMoney {
            amount
          }
        }
        discountCodes
        discountApplications {
          edges {
            node {
              __typename
              targetType
              ... on DiscountCodeApplication {
                code
              }
            }
          }
        }
        note
        phone
        tags
        customAttributes {
          key
          value
        }
        customer {
          id
          defaultPhoneNumber {
            phoneNumber
          }
          phone
        }
        shippingAddress {
          name
          phone
          address1
          address2
          city
          province
        }
        customerJourneySummary {
          firstVisit {
            landingPage
            referrerUrl
            utmParameters {
              source
              medium
              campaign
              content
            }
          }
          lastVisit {
            landingPage
            referrerUrl
            utmParameters {
              source
              medium
              campaign
              content
            }
          }
        }
        lineItems {
          edges {
            node {
              id
              title
              variantTitle
              quantity
              currentQuantity
              unfulfilledQuantity
              variant {
                id
              }
              originalUnitPriceSet {
                shopMoney {
                  amount
                }
              }
              discountAllocations {
                allocatedAmountSet {
                  shopMoney {
                    amount
                  }
                }
              }
              taxLines(first: ${ORDER_READ_TAX_LINES_PAGE}) {
                rate
                ratePercentage
              }
            }
          }
        }
        fulfillments(first: ${ORDER_READ_FULFILLMENTS_PAGE}) {
          id
          status
          createdAt
        }
        transactions(first: ${ORDER_READ_TRANSACTIONS_PAGE}) {
          id
          kind
          status
          gateway
          amountSet {
            shopMoney {
              amount
            }
          }
        }`;

/**
 * The orders backfill's bulk query (AC-17): every order created since the instant, with the same
 * fields as `ORDER_READ`, its two connections (`lineItems` and `discountApplications`) written as
 * `edges { node }` and their page sizes and `pageInfo` dropped (ignored in bulk). The plain lists
 * (tax lines, fulfillments, transactions) stay inline. `DiscountApplication` does not implement
 * `Node` on `2026-10` (`interfaces/DiscountApplication`, read 2026-11-08), so Shopify may refuse
 * this query in `userErrors`; the backfill then falls back to `ORDERS_BACKFILL_PAGE`.
 */
export function ordersBulkQuery(sinceIso: string): string {
  return `{
  orders(query: "${createdSinceFilter(sinceIso)}") {
    edges {
      node {${ORDER_BULK_FIELDS}
      }
    }
  }
}`;
}

/** The operation name of `ORDERS_BACKFILL_PAGE`. */
export const ORDERS_BACKFILL_PAGE_OPERATION = 'OrdersBackfillPage';

/**
 * The orders backfill's paged fallback (spec 0015 Risk: Shopify refused the bulk selection): one
 * order per page, oldest first, with exactly `ORDER_READ`'s fields (the sales history included),
 * so each page costs what one read back costs (`ORDER_READ_ESTIMATED_COST`, about 869 points, under
 * the 1,000 point cap). Variables: `query`
 * (`createdSinceFilter`) and `after`.
 */
export const ORDERS_BACKFILL_PAGE = `query OrdersBackfillPage($query: String!, $after: String) {
  orders(first: 1, after: $after, sortKey: CREATED_AT, query: $query) {
    nodes {${ORDER_FIELDS}
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

/** The expected cost of one `ORDERS_BACKFILL_PAGE` page: `ORDER_READ`'s estimate and the page. */
export const ORDERS_BACKFILL_PAGE_EXPECTED_COST = ORDER_READ_ESTIMATED_COST + 2;
