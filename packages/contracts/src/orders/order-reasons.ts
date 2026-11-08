import { z } from 'zod';

/**
 * The reason code lists of spec 0013: why an order is cancelled, edited, gifted, or a line removed,
 * and how an order links to another. Every one is a `ReasonCode` shaped value, never a typed note
 * (a note about a customer would be personal data kept for ever). The labels live in the
 * `orders.reasons` keys of `@ssdashboard/i18n`.
 */

/** What kind of order it is. Matches the `orders.type` enum. */
export const OrderType = z.enum(['sale', 'exchange_replacement', 'gifted']);
/** One order type. */
export type OrderType = z.infer<typeof OrderType>;

/** How a stored order relates to `related_order_id`. Matches the `order_relation` enum. */
export const OrderRelation = z.enum(['duplicate_of', 'reopened_from', 'goodwill_for']);
/** One stored relation. */
export type OrderRelation = z.infer<typeof OrderRelation>;

/**
 * The relation a caller asks for when it creates an order from another (spec 0013 AC-23).
 * `replacement_for` is stored as `type = 'exchange_replacement'` with `original_order_id`, never in
 * `related_order_relation`.
 */
export const RelatedOrderRelation = z.enum(['reopened_from', 'replacement_for', 'goodwill_for']);
/** One requested relation. */
export type RelatedOrderRelation = z.infer<typeof RelatedOrderRelation>;

/** Why a person cancels an order (AC-7). `duplicate` also names the order it duplicates. */
export const CancelReasonCode = z.enum([
  'customer_cancelled',
  'duplicate',
  'fake',
  'no_answer',
  'out_of_stock',
  'wrong_details',
  'other',
]);
/** One cancel reason. */
export type CancelReasonCode = z.infer<typeof CancelReasonCode>;

/** Why a person edits an order (AC-9). */
export const EditReasonCode = z.enum([
  'customer_request',
  'address_fix',
  'size_change',
  'out_of_stock',
  'price_fix',
  'other',
]);
/** One edit reason. */
export type EditReasonCode = z.infer<typeof EditReasonCode>;

/** Why a line is removed in an edit (AC-9). A replaced line is cancelled with `edit_removal` by the edit itself. */
export const LineRemovalReasonCode = z.enum(['customer_cancelled', 'out_of_stock', 'duplicate']);
/** One line removal reason. */
export type LineRemovalReasonCode = z.infer<typeof LineRemovalReasonCode>;

/** Why a gifted order is given (AC-2). `replacement_goodwill` also names the order it makes good. */
export const GiftReasonCode = z.enum([
  'influencer',
  'giveaway',
  'staff',
  'replacement_goodwill',
  'other',
]);
/** One gift reason. */
export type GiftReasonCode = z.infer<typeof GiftReasonCode>;

/** The reason codes of `order.created_manually` (spec 0013 Audit). */
export const ORDER_CREATED_MANUALLY_REASONS = [
  'whatsapp_order',
  'instagram_order',
  'phone_order',
  'gift',
  'reopened',
  'replacement',
  'other',
] as const;

/** The reason codes of `order.edited`: the edit reasons plus `channel_edit` (channel edits only). */
export const ORDER_EDITED_REASONS = [...EditReasonCode.options, 'channel_edit'] as const;

/** The reason codes of `order.partial_delivery_split`. */
export const ORDER_PARTIAL_DELIVERY_REASONS = ['carrier_report', 'courier_note', 'other'] as const;

/** The reason codes of `order.collection_recorded_manually` (a reason is required). */
export const ORDER_COLLECTION_REASONS = [
  'courier_note',
  'carrier_missing_report',
  'correction',
] as const;

/** The reason codes of `order.payment_method_rederived`. */
export const ORDER_PAYMENT_METHOD_REDERIVED_REASONS = ['gateway_mapping_changed'] as const;
