import { z } from 'zod';

/** The settlement primitive's closed lists, matching the settlement database enums (spec 0002 settlement). Keep both in step in one change. */

/** Who a settlement account settles with. Matches `settlement_accounts.owner_type`. */
export const SettlementOwnerType = z.enum(['carrier', 'consignment_partner', 'gateway']);
/** One SettlementOwnerType value. */
export type SettlementOwnerType = z.infer<typeof SettlementOwnerType>;

/** How a statement reached us. Matches `settlement_statements.kind`. */
export const SettlementStatementKind = z.enum([
  'carrier_file',
  'carrier_api',
  'partner_file',
  'partner_upload',
  'partner_api',
  'count',
]);
/** One SettlementStatementKind value. */
export type SettlementStatementKind = z.infer<typeof SettlementStatementKind>;

/** What a settlement line is; positive amounts are owed to the brand. Matches `settlement_lines.line_kind`: carrier kinds, then partner kinds, then kinds any owner may use. */
export const SettlementLineKind = z.enum([
  'cod_collected',
  'cod_fee',
  'shipping_fee',
  'opening_package_fee',
  'other_fee',
  'fee_vat',
  'customer_refund',
  'compensation',
  'deposit',
  'consignment_sale',
  'consignment_return',
  'defective_return_credit',
  'missing_piece_charge',
  'partner_payment',
  'adjustment',
]);
/** One SettlementLineKind value. */
export type SettlementLineKind = z.infer<typeof SettlementLineKind>;

/** What one match row says about a line. Matches `settlement_line_matches.result`. */
export const SettlementMatchResult = z.enum(['matched', 'accounted', 'unmatched', 'cleared']);
/** One SettlementMatchResult value. */
export type SettlementMatchResult = z.infer<typeof SettlementMatchResult>;

/** Who wrote a match row. Matches `settlement_line_matches.matched_by_type`. */
export const SettlementMatchedByType = z.enum(['rule', 'person']);
/** One SettlementMatchedByType value. */
export type SettlementMatchedByType = z.infer<typeof SettlementMatchedByType>;

/** Whether a period is open for changes. Matches `settlement_periods.status`. */
export const SettlementPeriodState = z.enum(['open', 'closed']);
/** One SettlementPeriodState value. */
export type SettlementPeriodState = z.infer<typeof SettlementPeriodState>;

/** What a period event did. Matches `settlement_period_events.action`. */
export const SettlementPeriodAction = z.enum(['closed', 'revoked']);
/** One SettlementPeriodAction value. */
export type SettlementPeriodAction = z.infer<typeof SettlementPeriodAction>;

/** Who wrote a period event. Matches `settlement_period_events.actor_type`. */
export const SettlementPeriodActorType = z.enum(['person', 'rule']);
/** One SettlementPeriodActorType value. */
export type SettlementPeriodActorType = z.infer<typeof SettlementPeriodActorType>;
