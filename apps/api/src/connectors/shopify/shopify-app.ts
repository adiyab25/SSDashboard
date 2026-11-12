/**
 * What the brand's Shopify app must grant and what the connector subscribes to (spec 0015,
 * *Shopify app, auth, and API version*), for API version `2026-10`.
 */

/**
 * The access scope handles every connection needs (spec 0015 AC-3, `SHOPIFY_REQUIRED_SCOPES`),
 * compared with `currentAppInstallation.accessScopes` at connect (and by task 12's hourly check).
 * Only the slice 1a scopes the spec lists by name: the slice 1b refund and return scopes join once
 * task 1 confirms them against a development store. Compared handle by handle: whether Shopify
 * lists a `read_` handle beside its `write_` handle is unverified until task 1 records it.
 */
export const SHOPIFY_REQUIRED_SCOPES: readonly string[] = Object.freeze([
  'read_orders',
  'write_orders',
  'write_order_edits',
  'read_products',
  'read_customers',
  'read_inventory',
  'write_inventory',
  'read_locations',
]);

/** The 13 webhook topics each connection subscribes to (`WebhookSubscriptionTopic` values). */
export const SHOPIFY_WEBHOOK_TOPICS: readonly string[] = Object.freeze([
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_EDITED',
  'ORDERS_CANCELLED',
  'REFUNDS_CREATE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
  'CUSTOMERS_CREATE',
  'CUSTOMERS_UPDATE',
  'INVENTORY_LEVELS_UPDATE',
  'APP_UNINSTALLED',
  'BULK_OPERATIONS_FINISH',
]);

/**
 * The address Shopify delivers a connection's webhooks to: `PUBLIC_URL` + `/api/hooks/shopify/`
 * + the connection id (the hook route itself is task 7's). `PUBLIC_URL` has no path (env.ts).
 */
export function hookAddress(publicUrl: string, connectionId: string): string {
  return `${new URL(publicUrl).origin}/api/hooks/shopify/${connectionId}`;
}

/** Whether Shopify may deliver to this address: a real connection needs https (`PUBLIC_URL_NOT_HTTPS`). */
export function isHttpsAddress(address: string): boolean {
  return new URL(address).protocol === 'https:';
}

/** One existing webhook subscription as `WebhookSubscriptions` answers it. */
export interface ExistingSubscription {
  /** The `WebhookSubscriptionTopic`. */
  readonly topic: string;
  /** Where it delivers. */
  readonly uri: string;
}

/**
 * The topics still to register for an address: every one of `SHOPIFY_WEBHOOK_TOPICS` with no
 * existing subscription of that topic to exactly that address, in the list's order. A
 * subscription of the same topic to another address (an old host) does not count.
 */
export function topicsToCreate(
  existing: readonly ExistingSubscription[],
  address: string,
): string[] {
  const subscribed = new Set(existing.filter((s) => s.uri === address).map((s) => s.topic));
  return SHOPIFY_WEBHOOK_TOPICS.filter((topic) => !subscribed.has(topic));
}
