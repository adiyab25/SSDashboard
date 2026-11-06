import { describe, expect, it } from 'vitest';
import { EgyptianPhone, InvalidPhone, PhoneKind } from '../src/index.js';

const MOBILE = '+201001234567';

describe('EgyptianPhone.parse normalization rows', () => {
  it.each([
    ['national mobile', '01001234567', MOBILE, 'mobile'],
    ['dropped leading zero', '1001234567', MOBILE, 'mobile'],
    ['country code with national zero', '+2001001234567', MOBILE, 'mobile'],
    ['country code written 00 with national zero', '002001001234567', MOBILE, 'mobile'],
    ['country code without plus', '201001234567', MOBILE, 'mobile'],
    ['already normalized', MOBILE, MOBILE, 'mobile'],
    ['00 international prefix', '00201001234567', MOBILE, 'mobile'],
    ['doubled zero 0010', '0010 0123 4567', MOBILE, 'mobile'],
    ['doubled zero 0011', '0011 1234 5678', '+201112345678', 'mobile'],
    ['doubled zero 0012', '0012 1234 5678', '+201212345678', 'mobile'],
    ['doubled zero 0015', '0015 1234 5678', '+201512345678', 'mobile'],
    ['010 mobile prefix', '01012345678', '+201012345678', 'mobile'],
    ['011 mobile prefix', '01112345678', '+201112345678', 'mobile'],
    ['012 mobile prefix', '01212345678', '+201212345678', 'mobile'],
    ['015 mobile prefix', '01512345678', '+201512345678', 'mobile'],
    ['landline, 10 digits (Cairo)', '0223456789', '+20223456789', 'landline'],
    ['landline, 9 digits (Alexandria)', '034567890', '+2034567890', 'landline'],
    ['landline already normalized, 10 digits', '+20223456789', '+20223456789', 'landline'],
    ['landline already normalized, 8 digits', '+2034567890', '+2034567890', 'landline'],
    ['foreign number', '+971501234567', '+971501234567', 'foreign'],
    ['foreign number with 00', '00971501234567', '+971501234567', 'foreign'],
  ] as const)('%s: %s', (_label, raw, e164, kind) => {
    expect(EgyptianPhone.parse(raw)).toEqual({ e164, kind });
  });
});

describe('EgyptianPhone.parse scenario inputs', () => {
  it.each([
    ['plain', '01001234567'],
    ['Arabic Indic digits', '٠١٠٠١٢٣٤٥٦٧'],
    ['Eastern Arabic Indic digits', '۰۱۰۰۱۲۳۴۵۶۷'],
    ['spaces after the plus', '+20 100 123 4567'],
    ['00 form', '00201001234567'],
    ['plus with national zero', '+2001001234567'],
    ['country code only', '201001234567'],
    ['dropped zero', '1001234567'],
    ['doubled zero with a right to left mark', '0010 0123 4567‏'],
    ['dashes, dots, brackets, slashes', '(010) 0123-45.67/'],
    ['non breaking space', '010 0123 4567'],
    ['Arabic letter mark, word joiner, soft hyphen', '010؜0123⁠4­567'],
    ['zero width marks and BOM', '﻿​010‪01234‬567⁦'],
  ])('%s gives the normalized mobile', (_label, raw) => {
    expect(EgyptianPhone.parse(raw)).toEqual({ e164: MOBILE, kind: 'mobile' });
  });

  it.each([
    ['0131234567'],
    ['abc'],
    [''],
    ['   '],
    ['+'],
    ['01001234'],
    ['01312345678'],
    ['1312345678'],
    ['+201312345678'],
    ['+202345678901'],
    ['+20100123456'],
    ['+2010012345678'],
    ['2001001234567'],
    ['+97150'],
    ['+9715012345678901'],
    ['0100123456x'],
    ['01001234567+'],
    ['++201001234567'],
    ['010 0123 4567 ext 9'],
    ['01'],
    ['0'],
  ])('rejects %j with InvalidPhone', (raw) => {
    expect(() => EgyptianPhone.parse(raw)).toThrow(InvalidPhone);
  });

  it('never puts the raw input in the error', () => {
    try {
      EgyptianPhone.parse('0131234567');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPhone);
      expect((error as InvalidPhone).message).not.toContain('0131234567');
      expect((error as InvalidPhone).code).toBe('InvalidPhone');
    }
  });

  it('exposes the phone kinds as a Zod enum', () => {
    expect(PhoneKind.options).toEqual(['mobile', 'landline', 'foreign']);
  });
});
