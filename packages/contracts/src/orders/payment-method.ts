import { z } from 'zod';

/**
 * How an order is paid. Matches the `orders.payment_method` enum; `prepaid_method` uses the same
 * enum (spec 0002 "Tenders"). `none` is an order with nothing to pay, which has no tender and so
 * no credit funding.
 */
export const OrderPaymentMethod = z.enum([
  'cod',
  'gateway',
  'instapay',
  'bank_transfer',
  'wallet',
  'none',
]);
/** One order payment method. */
export type OrderPaymentMethod = z.infer<typeof OrderPaymentMethod>;
