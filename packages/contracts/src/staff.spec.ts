import { describe, expect, it } from 'vitest';
import {
  CreateStaffRequest,
  StaffErrorCode,
  StaffListQuery,
  UpdateMeRequest,
  UpdateStaffRequest,
} from './staff.js';

const valid = { name: 'Sam', email: 'sam@example.com', role: 'staff' } as const;

describe('CreateStaffRequest field rules (AC-12)', () => {
  it('trims text, lowercases the email and uppercases the staff code', () => {
    const parsed = CreateStaffRequest.parse({
      name: '  Sam Ali ',
      email: '  Sam@Example.COM ',
      role: 'admin',
      phone: ' +20 100 123 4567 ',
      staffCode: ' ab12 ',
      language: ' ar ',
    });

    expect(parsed).toEqual({
      name: 'Sam Ali',
      email: 'sam@example.com',
      role: 'admin',
      phone: '+20 100 123 4567',
      staffCode: 'AB12',
      language: 'ar',
    });
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name over 100 characters', { name: 'x'.repeat(101) }],
    ['a bad email', { email: 'sam@' }],
    ['an unknown role', { role: 'owner' }],
    ['a phone under 5 characters', { phone: '1234' }],
    ['a phone over 30 characters', { phone: '1'.repeat(31) }],
    ['a phone with letters', { phone: '555-ABCD' }],
    ['a staff code over 20 characters', { staffCode: 'x'.repeat(21) }],
    ['a blank staff code', { staffCode: '  ' }],
  ])('rejects %s', (_name, change) => {
    expect(CreateStaffRequest.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it('needs a name, an email and a role', () => {
    for (const key of ['name', 'email', 'role'] as const) {
      const { [key]: _removed, ...rest } = valid;
      expect(CreateStaffRequest.safeParse(rest).success).toBe(false);
    }
  });
});

describe('UpdateStaffRequest (AC-15)', () => {
  it('accepts a partial change, and turns empty text into a cleared field', () => {
    expect(UpdateStaffRequest.parse({})).toEqual({});
    expect(UpdateStaffRequest.parse({ phone: '', staffCode: '', language: '' })).toEqual({
      phone: null,
      staffCode: null,
      language: null,
    });
  });

  it('still checks what is given', () => {
    expect(UpdateStaffRequest.safeParse({ phone: '12' }).success).toBe(false);
    expect(UpdateStaffRequest.safeParse({ role: 'root' }).success).toBe(false);
  });
});

describe('StaffListQuery (AC-15)', () => {
  it('defaults the page to 50 and caps it at 100', () => {
    expect(StaffListQuery.parse({}).limit).toBe(50);
    expect(StaffListQuery.parse({ limit: '100' }).limit).toBe(100);
    expect(StaffListQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(StaffListQuery.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('only knows the three statuses', () => {
    expect(StaffListQuery.safeParse({ status: 'invited' }).success).toBe(true);
    expect(StaffListQuery.safeParse({ status: 'banned' }).success).toBe(false);
  });
});

describe('UpdateMeRequest (AC-19)', () => {
  it('accepts a name, phone and language, trimmed, and turns empty text into a cleared field', () => {
    expect(
      UpdateMeRequest.parse({ name: ' Sam ', phone: ' +20 100 123 4567 ', language: ' ar ' }),
    ).toEqual({
      name: 'Sam',
      phone: '+20 100 123 4567',
      language: 'ar',
    });
    expect(UpdateMeRequest.parse({ phone: '', language: '' })).toEqual({
      phone: null,
      language: null,
    });
    expect(UpdateMeRequest.parse({})).toEqual({});
  });

  it('cannot clear a name, and checks the other fields', () => {
    expect(UpdateMeRequest.safeParse({ name: '   ' }).success).toBe(false);
    expect(UpdateMeRequest.safeParse({ phone: '12' }).success).toBe(false);
  });

  it.each(['email', 'role', 'staffCode', 'banned', 'mustChangePassword'])(
    'refuses %s rather than ignoring it',
    (field) => {
      expect(UpdateMeRequest.safeParse({ name: 'Sam', [field]: 'x' }).success).toBe(false);
    },
  );
});

describe('StaffErrorCode', () => {
  it('lists the self action refusal next to the self disable one (AC-17, AC-18, AC-20)', () => {
    expect(StaffErrorCode.options).toEqual(expect.arrayContaining(['SELF_DISABLE', 'SELF_ACTION']));
  });
});

describe('StaffPhone digits (spec 0004 AC-18)', () => {
  it('stores Arabic-Indic and Extended Arabic-Indic digits as Western digits', () => {
    for (const phone of ['٠١٠١٢٣٤٥٦٧٨', '۰۱۰۱۲۳۴۵۶۷۸']) {
      expect(CreateStaffRequest.parse({ ...valid, phone }).phone).toBe('01012345678');
    }
  });

  it('still refuses letters and keeps its message', () => {
    const result = CreateStaffRequest.safeParse({ ...valid, phone: 'abc12345' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Digits, + and spaces only');
  });
});
