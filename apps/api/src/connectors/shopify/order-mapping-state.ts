// The `state` of an order mapping row (`connection_external_ids`, entity `order`; spec 0015 Data
// model): what the inbox job remembers of a Shopify order between read backs. Pure: no database.
// It holds ids, quantities, codes, and gateway names only, never a name, phone, or address.
import { ChannelOrderLineInput, GiftReasonCode, OrderPaymentMethod } from '@ssdashboard/contracts';
import { z } from 'zod';
import {
  gatewayMappingOf,
  paymentTransactionIdsOf,
  ShopifyOrderMappingError,
  type ShopifyMappingNotes,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';

/**
 * What a replacement order that waits for its original needs beyond its lines and the ship to
 * (spec 0015 AC-12, task 10): its number on the order (`R<n>`), its order number, placed time,
 * type, payment method, and the Shopify customer id. Ids, codes, and the Shopify order name only,
 * never a name, phone, or address: `retryWaitingReplacements` takes the ship to from the original
 * app order.
 */
export const PendingReplacement = z.object({
  n: z.number().int().positive(),
  orderNumber: z.string().min(1).max(64),
  placedAt: z.string().min(1),
  type: z.enum(['sale', 'gifted']),
  giftReasonCode: GiftReasonCode.nullable(),
  paymentMethod: OrderPaymentMethod,
  /** The Shopify customer gid of the order, or null when it has none. */
  customerExternalId: z.string().min(1).max(255).nullable(),
});
/** The validated shape of `PendingReplacement`. */
export type PendingReplacement = z.infer<typeof PendingReplacement>;

/**
 * The order mapping state the inbox job reads and writes. Keys it does not know (task 9a's
 * `stockOuts` and `returnSourceIds`, and the `gatewayMethods` an earlier build of task 9 wrote)
 * are kept as they are, so a later task's keys survive a read back of this one.
 */
export const OrderMappingState = z.looseObject({
  /**
   * The Shopify line item ids the app order holds. Written beside `appliedLines` only so a
   * milestone 1 reader keeps working; a later task may drop it once no reader is left.
   */
  appliedLineIds: z.array(z.string()).optional(),
  /** The Shopify line item ids the app order holds, at the quantity last applied (task 9). */
  appliedLines: z.record(z.string(), z.number().int().positive()).optional(),
  /** Lines mapped with a null variant: Shopify line and variant ids (AC-9, the late link). */
  unmappedLines: z
    .array(z.object({ channelLineId: z.string(), variantGid: z.string().nullable() }))
    .optional(),
  /** Gateway names with no `config.gatewayMethods` entry, listed until mapped. */
  unmappedGateways: z.array(z.string()).optional(),
  /** Every discount code the order ever carried, in the order first seen (feature 48). */
  discountCodes: z.array(z.string()).optional(),
  /**
   * The order's gateway keys at creation (the raw Shopify name capped at 200, as
   * `config.gatewayMethods` keys it, security review N1) and the method each mapped to then.
   * Written once at creation and never changed (lead decision D10): a rederive runs only when the
   * current config maps one of them differently.
   */
  creationGateways: z.record(z.string(), OrderPaymentMethod.nullable()).optional(),
  /**
   * The successful sale, capture, and refund transactions at creation, written once (D10, D10a):
   * a rederive counts only these, never a later "mark as paid" or a later refund (task 10's).
   */
  creationTransactionIds: z.array(z.string()).optional(),
  /** The Shopify fulfillment whose time was reported as the carrier delivery (AC-13, m1). */
  deliveryFulfillmentId: z.string().optional(),
  /** Set once `rederivePaymentMethod` answered `PaymentMethodLocked`: recorded and left. */
  paymentMethodLocked: z.boolean().optional(),
  /** The Shopify sale ids already netted (task 10, `ChannelEditNetted`): never netted again. */
  nettedSaleIds: z.array(z.string()).optional(),
  /** The Shopify refund ids already published as `ChannelRefundRecorded` (task 10). */
  recordedRefundIds: z.array(z.string()).optional(),
  /** Set while the last read did not hold the whole sales history (task 10, netting). */
  salesHistoryTruncated: z.boolean().optional(),
  /** The replacement orders made from lines added while a fulfillment was active (AC-12). */
  replacementOrderIds: z.array(z.string()).optional(),
  /** The Shopify line item ids those replacement orders hold, never sent again. */
  replacementLineIds: z.array(z.string()).optional(),
  /**
   * The added lines of a replacement whose original is not yet `delivered`, `partially_delivered`,
   * or `refused` (`RELATED_ORDER_STATE`): line id, variant, quantity, price, discount, tax rate,
   * and the product title (Value sourcing), tried again on every read back and by the hourly check
   * (`retryWaitingReplacements`). Absent when nothing waits (the hourly check's partial index).
   */
  pendingReplacementLines: z.array(ChannelOrderLineInput).min(1).optional(),
  /** The rest of that waiting replacement (`PendingReplacement`), beside its lines. */
  pendingReplacement: PendingReplacement.optional(),
});
/** The validated shape of `OrderMappingState`. */
export type OrderMappingState = z.infer<typeof OrderMappingState>;

/**
 * Parses the stored state of an order mapping. Throws `ShopifyOrderMappingError`
 * (`MAPPING_STATE_UNREADABLE`, paths only) when it does not fit, so a damaged row fails its event
 * for a person to see instead of being applied without its line memory.
 */
export function parseOrderMappingState(raw: unknown): OrderMappingState {
  const parsed = OrderMappingState.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ShopifyOrderMappingError(
      'MAPPING_STATE_UNREADABLE',
      parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'),
    );
  }
  return parsed.data;
}

/** The lines of a mapped order or snapshot as the state keeps them: line item id to quantity. */
export function appliedLinesOf(
  lines: readonly { channelLineId: string; quantity: number }[],
): Record<string, number> {
  return Object.fromEntries(lines.map((line) => [line.channelLineId, line.quantity]));
}

/** The stored codes, then each read code not yet held, in the order first seen (m3). */
export function unionOfCodes(
  stored: readonly string[] | undefined,
  read: readonly string[],
): string[] {
  return [...new Set([...(stored ?? []), ...read])];
}

/**
 * The state of a new order's mapping, written before `createFromChannel` (AC-7): its lines and
 * quantities, the unmapped lines, every discount code, the unmapped gateway names, the creation
 * facts of lead decisions D10 and D10a (`creationGateways`, `creationTransactionIds`), and the
 * first active fulfillment the creation read already holds (`deliveryFulfillmentId`, for every
 * order created not cancelled, imported shipped ones included, so a later refund never reaches
 * `applyChannelEdit`; code re-review R1).
 */
export function createdOrderState(
  order: ShopifyOrder,
  context: Pick<ShopifyOrderContext, 'gatewayMethods'>,
  lines: readonly { channelLineId: string; quantity: number }[],
  notes: ShopifyMappingNotes,
  deliveryFulfillmentId: string | null = null,
): OrderMappingState {
  const state: OrderMappingState = {
    appliedLineIds: lines.map((line) => line.channelLineId),
    appliedLines: appliedLinesOf(lines),
    discountCodes: [...notes.discountCodes],
    unmappedGateways: [...notes.unmappedGateways],
    creationGateways: gatewayMappingOf(order, context),
    creationTransactionIds: paymentTransactionIdsOf(order),
  };
  if (notes.unmappedLines.length > 0) state.unmappedLines = [...notes.unmappedLines];
  if (deliveryFulfillmentId !== null) state.deliveryFulfillmentId = deliveryFulfillmentId;
  return state;
}
