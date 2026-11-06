import { describe, expect, it } from 'vitest';
import {
  CostRule,
  CreditActorType,
  OrderPaymentMethod,
  PaymentTender,
  CreditEntryKind,
  CreditFunding,
  OrderCostRuleKind,
  OrderCostRuleStatus,
  PayoutMethod,
  SettlementLineKind,
  SettlementMatchedByType,
  SettlementMatchResult,
  SettlementOwnerType,
  SettlementPeriodAction,
  SettlementPeriodActorType,
  SettlementPeriodState,
  SettlementStatementKind,
  TaskCreatedByType,
  TaskLinkedType,
  TaskStatus,
} from '../src/index.js';

/** Each list is the spec's, in the spec's order; the database enums must match. */
describe('credit, settlement, task, and cost rule enums', () => {
  it('lists the credit enums as spec 0002 gives them', () => {
    expect(CreditEntryKind.options).toEqual([
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
    expect(CreditFunding.options).toEqual([
      'cod_cash',
      'gateway',
      'instapay_or_transfer',
      'credit_only',
    ]);
    expect(PayoutMethod.options).toEqual([
      'carrier_cash_refund',
      'gateway_refund',
      'instapay_or_transfer',
    ]);
    expect(CreditActorType.options).toEqual(['person', 'rule', 'system_job', 'import']);
  });

  it('lists the settlement enums as spec 0002 gives them', () => {
    expect(SettlementOwnerType.options).toEqual(['carrier', 'consignment_partner', 'gateway']);
    expect(SettlementStatementKind.options).toEqual([
      'carrier_file',
      'carrier_api',
      'partner_file',
      'partner_upload',
      'partner_api',
      'count',
    ]);
    expect(SettlementLineKind.options).toEqual([
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
    expect(SettlementMatchResult.options).toEqual(['matched', 'accounted', 'unmatched', 'cleared']);
    expect(SettlementMatchedByType.options).toEqual(['rule', 'person']);
    expect(SettlementPeriodState.options).toEqual(['open', 'closed']);
    expect(SettlementPeriodAction.options).toEqual(['closed', 'revoked']);
    expect(SettlementPeriodActorType.options).toEqual(['person', 'rule']);
  });

  it('lists the task and cost rule enums as spec 0002 gives them', () => {
    expect(TaskStatus.options).toEqual(['open', 'done', 'cancelled']);
    expect(TaskLinkedType.options).toEqual([
      'order',
      'customer',
      'exchange',
      'refund',
      'shipment',
      'settlement_line',
      'settlement_statement',
      'settlement_period',
      'outbound_command',
      'party',
      'location',
    ]);
    expect(TaskCreatedByType.options).toEqual(['person', 'system_job']);
    expect(OrderCostRuleKind.options).toEqual([
      'cod_fee_percent',
      'gateway_fee_percent',
      'packaging_per_order',
      'rto_unrestocked_percent',
    ]);
    expect(OrderCostRuleStatus.options).toEqual(['set', 'not_set']);
  });
});

describe('payment method enums', () => {
  it('lists the order payment methods and derives the tenders without none', () => {
    expect(OrderPaymentMethod.options).toEqual([
      'cod',
      'gateway',
      'instapay',
      'bank_transfer',
      'wallet',
      'none',
    ]);
    expect(PaymentTender.options).toEqual([
      'cod',
      'gateway',
      'instapay',
      'bank_transfer',
      'wallet',
    ]);
  });

  it('parses cost rules as a set value or not_set', () => {
    expect(CostRule.parse({ status: 'set', value: '2.5000' })).toEqual({
      status: 'set',
      value: '2.5000',
    });
    expect(CostRule.parse({ status: 'not_set' })).toEqual({ status: 'not_set' });
    expect(() => CostRule.parse({ status: 'set' })).toThrow();
  });
});
