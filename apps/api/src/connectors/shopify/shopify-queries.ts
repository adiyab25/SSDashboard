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
 * makes the mapper refuse with `TAX_LINES_TRUNCATED` (more may exist); 10 is far above any real
 * line (Egyptian VAT is one tax line), so a valid order is never refused for its tax lines.
 */
export const ORDER_READ_TAX_LINES_PAGE = 10;

/** Discount applications read per order, for the shipping discount exclusion. */
export const ORDER_READ_DISCOUNT_APPLICATIONS_PAGE = 10;

/** Fulfillments read per order. A full page makes the mapper refuse with `FULFILLMENTS_TRUNCATED`. */
export const ORDER_READ_FULFILLMENTS_PAGE = 10;

/** Transactions read per order. A full page makes the mapper refuse with `TRANSACTIONS_TRUNCATED`. */
export const ORDER_READ_TRANSACTIONS_PAGE = 30;

/**
 * The read back of one order (AC-7, AC-9 to AC-13), selecting exactly what `ShopifyOrder` in
 * `order-mapper.ts` parses. Variables: `id` (the order gid). Carry-overs settled in the Shopify
 * README: the customer phone is `defaultPhoneNumber.phoneNumber` with the deprecated `phone` as a
 * fallback (D4); line items select `unfulfilledQuantity`, never the deprecated
 * `fulfillableQuantity` (D5); the shipping discount exclusion reads `discountApplications` with
 * `targetType` and `DiscountCodeApplication.code` (D6).
 *
 * Requested cost estimate (objects 1, scalars 0, a connection sized by `first`, shopify.dev
 * "GraphQL Admin API rate limits", read 2026-11-08; that page gives no rule for a plain list such
 * as `taxLines`, so each listed tax line is counted as one object, the most it can cost): line
 * items 40 x 17 (the item 1, its variant 1, its `MoneyBag` and money 2, one discount allocation
 * with its `MoneyBag` and money 3, 10 tax lines 10) = 680, transactions 30 x 3 = 90, fulfillments
 * 10, discount applications 10, customer, address, journey, and money about 15: about 805, under
 * the 900 budget of the rate policy (AC-25). With 10 tax lines, 50 line items would come to about
 * 975, so the line item page is 40. Task 1's recordings replace the estimate with Shopify's
 * `requestedQueryCost`.
 */
export const ORDER_READ = `query OrderRead($id: ID!) {
  order(id: $id) {
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
    totalShippingPriceSet {
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
      kind
      status
      gateway
      amountSet {
        shopMoney {
          amount
        }
      }
    }
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
