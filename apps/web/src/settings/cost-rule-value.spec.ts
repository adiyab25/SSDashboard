import { describe, expect, it } from 'vitest';
import { checkRuleValue, isPercentKind, shownDigits } from './cost-rule-value';

describe('shownDigits (spec 0009, AC-23)', () => {
  it('shows 2 decimals unless the third or fourth is not zero', () => {
    expect(shownDigits('2.5000')).toBe(2);
    expect(shownDigits('12')).toBe(2);
    expect(shownDigits('2.7500')).toBe(2);
    expect(shownDigits('2.7525')).toBe(4);
    expect(shownDigits('0.0001')).toBe(4);
  });
});

describe('checkRuleValue (spec 0009, AC-23)', () => {
  it('reads Western and Arabic digits into numeric text', () => {
    expect(checkRuleValue(' 2.75 ', 'cod_fee_percent')).toEqual({ ok: true, value: '2.75' });
    expect(checkRuleValue('٢٫٧٥', 'cod_fee_percent')).toEqual({ ok: true, value: '2.75' });
    expect(checkRuleValue('1,250.5', 'packaging_per_order')).toEqual({
      ok: true,
      value: '1250.5',
    });
  });

  it('refuses an empty, malformed, negative, too precise, or too long value', () => {
    expect(checkRuleValue('  ', 'cod_fee_percent')).toEqual({ ok: false, problem: 'required' });
    expect(checkRuleValue('abc', 'cod_fee_percent')).toEqual({ ok: false, problem: 'invalid' });
    expect(checkRuleValue('-1', 'packaging_per_order')).toEqual({ ok: false, problem: 'invalid' });
    expect(checkRuleValue('1.23456', 'packaging_per_order')).toEqual({
      ok: false,
      problem: 'invalid',
    });
    // Eleven integer digits do not fit numeric(14,4).
    expect(checkRuleValue('12345678901', 'packaging_per_order')).toEqual({
      ok: false,
      problem: 'invalid',
    });
    expect(checkRuleValue('1234567890.1234', 'packaging_per_order')).toEqual({
      ok: true,
      value: '1234567890.1234',
    });
  });

  it('holds a percent kind to 100, and an amount kind not', () => {
    expect(isPercentKind('gateway_fee_percent')).toBe(true);
    expect(isPercentKind('packaging_per_order')).toBe(false);
    expect(checkRuleValue('100.0001', 'rto_unrestocked_percent')).toEqual({
      ok: false,
      problem: 'percentTooHigh',
    });
    expect(checkRuleValue('100', 'rto_unrestocked_percent')).toEqual({ ok: true, value: '100' });
    expect(checkRuleValue('250', 'packaging_per_order')).toEqual({ ok: true, value: '250' });
  });
});
