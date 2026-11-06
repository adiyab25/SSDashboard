import { z } from 'zod';
import { OrderPaymentMethod } from '../orders/payment-method.js';

/** The credit ledger's closed lists, matching the `credit_entries` database enums (spec 0002 customers, credit, and tasks). Keep both in step in one change. */

/** What a credit entry is. Matches `credit_entries.kind`; the sign of each kind is checked by the database. */
export const CreditEntryKind = z.enum([
  'return_credit',
  'shipping_credit',
  'order_consumption',
  'refund_payout',
  'retention_bonus',
  'goodwill',
  'opening_balance',
  'inspection_reversal',
  'return_not_collected',
  'consumption_release',
  'debt_payment',
  'adjustment',
]);
/** One CreditEntryKind value. */
export type CreditEntryKind = z.infer<typeof CreditEntryKind>;

/** Where a credit entry's value came from. Matches `credit_entries.funding`; `credit_only` was never cash and is never paid out. */
export const CreditFunding = z.enum(['cod_cash', 'gateway', 'instapay_or_transfer', 'credit_only']);
/** One CreditFunding value. */
export type CreditFunding = z.infer<typeof CreditFunding>;

/** How a refund payout is paid. Matches `credit_entries.payout_method`. */
export const PayoutMethod = z.enum([
  'carrier_cash_refund',
  'gateway_refund',
  'instapay_or_transfer',
]);
/** One PayoutMethod value. */
export type PayoutMethod = z.infer<typeof PayoutMethod>;

/** Who posted a credit entry. Matches `credit_entries.actor_type`. */
export const CreditActorType = z.enum(['person', 'rule', 'system_job', 'import']);
/** One CreditActorType value. */
export type CreditActorType = z.infer<typeof CreditActorType>;

/** A way money can be paid: every order payment method except `none`. Each maps to a credit funding (spec 0002 "Tenders"). */
export const PaymentTender = OrderPaymentMethod.exclude(['none']);
/** One payment tender. */
export type PaymentTender = z.infer<typeof PaymentTender>;
