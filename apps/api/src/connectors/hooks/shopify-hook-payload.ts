import type { InboundSubject } from '@ssdashboard/contracts';

/**
 * The order topics the inbox processes (spec 0015 tasks 7 and 9): each sends one inbox job, which
 * reads the order back and creates it, or applies its cancel, first fulfillment, and edit.
 */
export const SHOPIFY_ORDER_TOPICS: readonly string[] = [
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
];

/**
 * The customer topics the inbox processes (spec 0015 task 11, AC-15): each sends one inbox job,
 * which reads the customer back and calls `CustomersService.findOrCreate`.
 */
export const SHOPIFY_CUSTOMER_TOPICS: readonly string[] = ['customers/create', 'customers/update'];

/**
 * The product topics the inbox processes (spec 0015 task 8, AC-16): each sends one inbox job,
 * which reads the product back and applies it through `CatalogChannelSync.applyProduct`; a
 * product Shopify no longer answers (`products/delete`) marks its mappings removed.
 */
export const SHOPIFY_PRODUCT_TOPICS: readonly string[] = [
  'products/create',
  'products/update',
  'products/delete',
];

/** The app topic milestone 1 processes: confirmed by the inbox job, then health `failing` (L1). */
export const SHOPIFY_APP_UNINSTALLED_TOPIC = 'app/uninstalled';

/**
 * The topics an inbox job processes today (webhook, sweep, and backfill rows alike): every other
 * topic's rows stay `received` with no job until their task, and the purge removes them after 90
 * days (spec 0015 AC-6, code review minor and security review L5 of the sync jobs).
 */
export const PROCESSED_INBOX_TOPICS: readonly string[] = [
  ...SHOPIFY_ORDER_TOPICS,
  ...SHOPIFY_CUSTOMER_TOPICS,
  ...SHOPIFY_PRODUCT_TOPICS,
  SHOPIFY_APP_UNINSTALLED_TOPIC,
];

/** The subject types of the processed topics: the resend scan's index friendly filter. */
export const PROCESSED_INBOX_SUBJECTS: readonly InboundSubject[] = [
  'order',
  'customer',
  'product',
  'app',
];

/**
 * Whether a verified topic gets an inbox job now: the order topics, the customer topics (task 11),
 * the product topics (task 8), and `app/uninstalled` (D9). Every other verified topic (refunds,
 * inventory levels, bulk operations) is still recorded in the inbox with its minimized payload, but no job is sent:
 * it stays `received` until its milestone 2 or 3 task processes it.
 */
export function topicIsProcessed(topic: string): boolean {
  return (
    SHOPIFY_ORDER_TOPICS.includes(topic) ||
    SHOPIFY_CUSTOMER_TOPICS.includes(topic) ||
    SHOPIFY_PRODUCT_TOPICS.includes(topic) ||
    topic === SHOPIFY_APP_UNINSTALLED_TOPIC
  );
}

/** The subject type of a topic, by its resource (the part before the slash). */
function subjectTypeOf(topic: string): InboundSubject | null {
  const resource = topic.split('/')[0] ?? '';
  switch (resource) {
    case 'orders':
    case 'refunds':
      return 'order';
    case 'products':
      return 'product';
    case 'customers':
      return 'customer';
    case 'inventory_levels':
      return 'inventory_level';
    case 'app':
      return 'app';
    case 'bulk_operations':
      return 'bulk_operation';
    default:
      return null;
  }
}

/** The Shopify GraphQL type name of a subject's gid, built from a REST id when no gid is sent. */
const GID_TYPE: Partial<Record<InboundSubject, string>> = {
  order: 'Order',
  product: 'Product',
  customer: 'Customer',
  bulk_operation: 'BulkOperation',
};

/** A Shopify gid of the expected type, or null. */
const GID = /^gid:\/\/shopify\/[A-Za-z]+\/[0-9]{1,20}$/;

/** A REST numeric id (Shopify sends numbers; a string of digits is accepted too). */
function numericId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) return value;
  return null;
}

/** An ISO instant Shopify sent, normalized to UTC, or null when it is absent or not a time. */
function instantOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** What the inbox keeps of one verified webhook: ids and times only (spec 0015 AC-6). */
export interface MinimizedShopifyWebhook {
  /** The subject type, or null for a topic this release does not know (then not recorded). */
  readonly subjectType: InboundSubject | null;
  /** The Shopify gid of the subject (`admin_graphql_api_id`, else built from `id`), or null. */
  readonly subjectExternalId: string | null;
  /** The body's `updated_at` as a UTC instant, or null. */
  readonly subjectVersion: string | null;
  /** The row's `payload`: the topic, the id, the update time, and nothing else. */
  readonly payload: Readonly<Record<string, string | number | null>>;
}

/**
 * Reduces a verified, parsed Shopify webhook body to what the inbox may keep (spec 0015 AC-6,
 * *Value sourcing* "hook" rows): the topic, the subject's Shopify id (`admin_graphql_api_id` when
 * present, else the gid built from `id`; for a refund, its order's id from `order_id`; none when
 * `admin_graphql_api_id` is sent but is not a gid of the topic's resource), and
 * `updated_at`. For an inventory level message it also keeps the item id, the location id, and the
 * `available` quantity, numbers only (AC-6; their field names are Shopify's REST names, not yet
 * checked against a recording). Never a name, phone, email, address, note, line text, or any other
 * field: everything not listed here is dropped. Pure.
 */
export function minimizeShopifyWebhook(topic: string, body: unknown): MinimizedShopifyWebhook {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const subjectType = subjectTypeOf(topic);
  let subjectExternalId: string | null = null;
  if (subjectType && subjectType !== 'app' && subjectType !== 'inventory_level') {
    const typeName = GID_TYPE[subjectType];
    const sent = fields['admin_graphql_api_id'];
    if (topic.startsWith('refunds/')) {
      const orderId = numericId(fields['order_id']);
      subjectExternalId = orderId ? `gid://shopify/Order/${orderId}` : null;
    } else if (sent !== undefined && sent !== null) {
      // A gid of another type than the topic's resource (security review L5: the topic header is
      // not signed, so a signed body of one resource replayed under another topic) names no
      // subject, never a gid built from the body's numeric id.
      subjectExternalId =
        typeof sent === 'string' &&
        GID.test(sent) &&
        typeName &&
        sent.startsWith(`gid://shopify/${typeName}/`)
          ? sent
          : null;
    } else {
      const restId = numericId(fields['id']);
      subjectExternalId = restId && typeName ? `gid://shopify/${typeName}/${restId}` : null;
    }
  }
  const subjectVersion = instantOf(fields['updated_at']);
  const payload: Record<string, string | number | null> = {
    topic,
    id: subjectExternalId,
    updatedAt: subjectVersion,
  };
  if (subjectType === 'inventory_level') {
    const available = fields['available'];
    payload['inventoryItemId'] = numericId(fields['inventory_item_id']);
    payload['locationId'] = numericId(fields['location_id']);
    payload['available'] =
      typeof available === 'number' && Number.isSafeInteger(available) ? available : null;
  }
  return { subjectType, subjectExternalId, subjectVersion, payload };
}
