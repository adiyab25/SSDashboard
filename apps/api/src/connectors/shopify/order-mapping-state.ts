// The `state` of an order mapping row (`connection_external_ids`, entity `order`; spec 0015 Data
// model): what the inbox job remembers of a Shopify order between read backs. Pure: no database.
// It holds ids, quantities, codes, and gateway names only, never a name, phone, or address.
import { OrderPaymentMethod } from '@ssdashboard/contracts';
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
 * The order mapping state the inbox job reads and writes. Keys it does not know (task 9a's
 * `stockOuts`, task 10's `nettedSaleIds` and `pendingReplacementLines`, and the `gatewayMethods`
 * an earlier build of task 9 wrote) are kept as they are, so a later task's keys survive a read
 * back of this one.
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
   * The order's gateway names at creation and the method each mapped to then. Written once at
   * creation and never changed (lead decision D10): a rederive runs only when the current config
   * maps one of them differently.
   */
  creationGateways: z.record(z.string(), OrderPaymentMethod.nullable()).optional(),
  /**
   * The successful sale and capture transactions at creation, written once (D10): a rederive
   * counts only these (and refunds of them), never a later "mark as paid".
   */
  creationTransactionIds: z.array(z.string()).optional(),
  /** The Shopify fulfillment whose time was reported as the carrier delivery (AC-13, m1). */
  deliveryFulfillmentId: z.string().optional(),
  /** Set once `rederivePaymentMethod` answered `PaymentMethodLocked`: recorded and left. */
  paymentMethodLocked: z.boolean().optional(),
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
 * facts of lead decision D10 (`creationGateways`, `creationTransactionIds`), and the fulfillment
 * whose time the job reports as the carrier delivery right after creation, when it does.
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
