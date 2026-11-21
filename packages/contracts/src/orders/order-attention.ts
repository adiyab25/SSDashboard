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
  // Spec 0013 AC-27 (a): Shopify fulfilled other quantities than the order's open lines (warehouse).
  'fulfilled_lines_differ',
  // Spec 0013 AC-27 (g): a line has awaited restock for 10 operating days (warehouse).
  'awaiting_restock_overdue',
  // Spec 0013 AC-27 (f): a warehouse hat asks a manager to close pieces that never came back.
  'awaiting_restock_close_requested',
  // Spec 0015 AC-28: an order stayed partly fulfilled in Shopify for 3 operating days (warehouse).
  'fulfillment_partial_stale',
  // Spec 0013 AC-27 (c) and row 4 of *After a cancel*, amended 2026-11-21: a reversal booked back
  // only the pieces not yet restocked or closed, because some were (warehouse checks the shelf).
  'reversal_after_restock',
]);
/** One attention kind. */
export type OrderAttentionKind = z.infer<typeof OrderAttentionKind>;
