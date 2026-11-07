import { describe, expect, it } from 'vitest';
import { AccessErrorCode } from './access.js';
import {
  CreatePartnerUserRequest,
  PartnerAccessRequest,
  PartnerUserErrorCode,
  PartnerUserListQuery,
  UpdatePartnerUserRequest,
} from './partner-users.js';

const ACCOUNT = '0190c0de-0000-7000-8000-0000000000aa';

describe('partner user contracts (spec 0008, AC-12 and AC-15)', () => {
  it('creates a login with a partner account and the staff field rules, no hats and no cost', () => {
    const parsed = CreatePartnerUserRequest.parse({
      name: '  Nour  ',
      email: ' Nour@Example.COM ',
      partnerAccountId: ACCOUNT,
      phone: '٠١٠٠ ١٢٣ ٤٥٦٧',
    });

    expect(parsed).toEqual({
      name: 'Nour',
      email: 'nour@example.com',
      partnerAccountId: ACCOUNT,
      phone: '0100 123 4567',
    });
    expect(CreatePartnerUserRequest.safeParse({ name: 'N', email: 'n@example.com' }).success).toBe(
      false,
    );
  });

  it('refuses a partner account, hats or cost in the details edit, and clears a phone with empty text', () => {
    expect(UpdatePartnerUserRequest.safeParse({ partnerAccountId: ACCOUNT }).success).toBe(false);
    expect(UpdatePartnerUserRequest.safeParse({ hats: ['partner'] }).success).toBe(false);
    expect(UpdatePartnerUserRequest.safeParse({ costView: true }).success).toBe(false);
    expect(UpdatePartnerUserRequest.parse({ phone: '' })).toEqual({ phone: null });
  });

  it('moves a login with the account, the updatedAt read before and an optional reason', () => {
    expect(
      PartnerAccessRequest.parse({
        partnerAccountId: ACCOUNT,
        updatedAt: '2026-11-06T10:00:00.123456Z',
        reason: '  ',
      }),
    ).toEqual({ partnerAccountId: ACCOUNT, updatedAt: '2026-11-06T10:00:00.123456Z' });
    expect(PartnerAccessRequest.safeParse({ partnerAccountId: ACCOUNT }).success).toBe(false);
  });

  it('pages at most 100 rows and filters by a partner account id', () => {
    expect(PartnerUserListQuery.parse({})).toEqual({ limit: 50 });
    expect(PartnerUserListQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(PartnerUserListQuery.safeParse({ partnerAccountId: 'nope' }).success).toBe(false);
  });

  it('names UNKNOWN_PARTNER_ACCOUNT among the stable codes', () => {
    expect(PartnerUserErrorCode.options).toContain('UNKNOWN_PARTNER_ACCOUNT');
    expect(AccessErrorCode.options).toContain('UNKNOWN_PARTNER_ACCOUNT');
  });
});
