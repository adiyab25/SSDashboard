import { z } from 'zod';
import { OrderTaskKind } from './order-states.js';

/**
 * Everything the orders module asks someone to look at (spec 0013 AC-18): the four carrier fact
 * task kinds of the transition table plus the attentions the module raises itself. The orders
 * module publishes each as `OrderAttentionRaised`; feature 17 opens one task per kind and order.
 * Until then only tests observe them.
 */
export const OrderAttentionKind = z.enum([
  ...OrderTaskKind.options,
  'phone_unparseable',
  'channel_edit_not_applied',
  'channel_cancel_after_pickup',
  'delivery_created_before_edit_synced',
  'terminate_carrier_delivery',
  'unpack_cancelled_order',
  'carrier_fact_contradicts_state',
  'reservation_shortened',
  'shipped_with_unmapped_lines',
  'shipment_not_posted',
  // Spec 0013 AC-27 (b, d): pieces that left stock and are expected back on the shelf.
  'returned_pieces_to_receive',
]);
/** One attention kind. */
export type OrderAttentionKind = z.infer<typeof OrderAttentionKind>;
