import { describe, expect, it } from 'vitest';
import {
  ReasonCode,
  SETTLEMENT_TEXT_MAX,
  SettlementPartnerText,
  SettlementPaymentReference,
} from '../src/index.js';

// Security review S4 and review R7: the Zod twins of the database's reasonCodeShape check and the
// two 500 character caps on settlement free text.
describe('ReasonCode', () => {
  it.each(['superseded', 'carrier_resent_cycle', 'confirmation.call', 'a'.repeat(64)])(
    'accepts %j',
    (code) => {
      expect(ReasonCode.parse(code)).toBe(code);
    },
  );

  it('trims surrounding spaces before checking', () => {
    expect(ReasonCode.parse(' same_phone ')).toBe('same_phone');
  });

  it.each([
    'Same lady, called from her sister phone',
    'Bosta resent the file',
    'UPPER',
    '9lead',
    '_lead',
    'a'.repeat(65),
    '',
  ])('refuses %j', (note) => {
    expect(ReasonCode.safeParse(note).success).toBe(false);
  });
});

describe('settlement free text caps', () => {
  it('caps both fields at 500 characters, like the database checks', () => {
    expect(SETTLEMENT_TEXT_MAX).toBe(500);
    expect(SettlementPartnerText.safeParse('x'.repeat(500)).success).toBe(true);
    expect(SettlementPartnerText.safeParse('x'.repeat(501)).success).toBe(false);
    expect(SettlementPaymentReference.safeParse('7'.repeat(500)).success).toBe(true);
    expect(SettlementPaymentReference.safeParse('7'.repeat(501)).success).toBe(false);
  });

  it('refuses an empty payment reference', () => {
    expect(SettlementPaymentReference.safeParse('   ').success).toBe(false);
  });
});
