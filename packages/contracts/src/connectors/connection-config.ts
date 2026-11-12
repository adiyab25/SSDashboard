import { z } from 'zod';
import { OrderPaymentMethod } from '../orders/payment-method.js';

/**
 * Who owns the Shopify app a connection uses (spec 0015 AC-1, Q-13.1): the brand's own Shopify
 * organization, or a person's account. A person owned app keeps health `ok` but shows the
 * `APP_OWNED_BY_PERSON` warning, because the brand loses the app when that person leaves.
 */
export const AppOwner = z.enum(['organization', 'person']);
/** One AppOwner value. */
export type AppOwner = z.infer<typeof AppOwner>;

/** An IANA time zone name as Shopify's `Shop.ianaTimezone` gives it (`Africa/Cairo`, `UTC`). */
const ShopTimezone = z.string().regex(/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/);

/**
 * `connections.config` of a Shopify connection (spec 0015 data model): the provider's own
 * settings, never a secret (the table refuses `accessToken`, `clientSecret`, `secret`, and `token`
 * keys). Task 6 writes `appOwner` at connect and `shopTimezone` from the connect job; the mapping
 * fields (`stockLocationId`, `stockLocationName`, `gatewayMethods`, `altPhoneAttribute`) and
 * fulfillment stock out (`fulfillmentStockOut`, `fulfillmentStockOutSince`, set by the server only,
 * AC-28) are set by later tasks through `PATCH /api/connections/:id`. Unknown keys are dropped
 * when read.
 */
export const ShopifyConnectionConfig = z.object({
  appOwner: AppOwner,
  shopTimezone: ShopTimezone.optional(),
  stockLocationId: z.string().min(1).max(200).optional(),
  stockLocationName: z.string().min(1).max(200).optional(),
  gatewayMethods: z.record(z.string().min(1).max(200), OrderPaymentMethod).optional(),
  altPhoneAttribute: z.string().min(1).max(100).optional(),
  fulfillmentStockOut: z.boolean().optional(),
  fulfillmentStockOutSince: z.iso.datetime({ offset: true }).optional(),
});
/** The parsed ShopifyConnectionConfig. */
export type ShopifyConnectionConfig = z.infer<typeof ShopifyConnectionConfig>;
