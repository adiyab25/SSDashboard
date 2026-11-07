import { describe, expect, it } from 'vitest';
import { AUDIT_RECORD_LABEL_PATTERN } from '../audit/audit-record-types.js';
import { LicenseEnvelope, LicensePayload } from './license-envelope.js';

// Spec 0009, AC-14 (amended for D18): the strict payload and envelope shapes.

const base = {
  format: 1,
  licenseId: 'SSD-2026-0001',
  clientCode: 'dev',
  tenantId: '01937f3a-0000-7000-8000-000000000001',
  bundles: ['warehouse', 'operations'],
  operationsExpiresOn: '2027-11-07',
  issuedOn: '2026-11-07',
};

describe('LicensePayload (AC-14)', () => {
  it('takes both bundles with the Operations expiry and an optional Warehouse expiry', () => {
    expect(LicensePayload.safeParse(base).success).toBe(true);
    expect(LicensePayload.safeParse({ ...base, warehouseExpiresOn: '2027-02-07' }).success).toBe(
      true,
    );
  });

  it('needs the Operations expiry exactly when Operations is granted', () => {
    const { operationsExpiresOn: _, ...withoutExpiry } = base;
    expect(LicensePayload.safeParse(withoutExpiry).success).toBe(false);
    expect(LicensePayload.safeParse({ ...base, bundles: ['warehouse'] }).success).toBe(false);
  });

  it('allows a Warehouse expiry only with the Warehouse bundle', () => {
    expect(
      LicensePayload.safeParse({
        ...base,
        bundles: ['operations'],
        warehouseExpiresOn: '2027-02-07',
      }).success,
    ).toBe(false);
  });

  it('refuses unknown fields, a repeated bundle, an empty grant, and another format', () => {
    expect(LicensePayload.safeParse({ ...base, price: 100 }).success).toBe(false);
    expect(
      LicensePayload.safeParse({ ...base, bundles: ['operations', 'operations'] }).success,
    ).toBe(false);
    expect(LicensePayload.safeParse({ ...base, bundles: [] }).success).toBe(false);
    expect(LicensePayload.safeParse({ ...base, format: 2 }).success).toBe(false);
    expect(LicensePayload.safeParse({ ...base, bundles: ['core'] }).success).toBe(false);
  });

  it('caps every license date to 2000 to 2100 (security review M2-4)', () => {
    for (const day of ['9999-12-31', '2101-01-01', '1999-12-31']) {
      expect(LicensePayload.safeParse({ ...base, operationsExpiresOn: day }).success).toBe(false);
      expect(LicensePayload.safeParse({ ...base, warehouseExpiresOn: day }).success).toBe(false);
      expect(LicensePayload.safeParse({ ...base, issuedOn: day }).success).toBe(false);
    }
    expect(LicensePayload.safeParse({ ...base, operationsExpiresOn: '2100-12-31' }).success).toBe(
      true,
    );
    expect(LicensePayload.safeParse({ ...base, issuedOn: '2000-01-01' }).success).toBe(true);
  });

  it('keeps a license id that fits the audit label shape, never a sentence', () => {
    expect(AUDIT_RECORD_LABEL_PATTERN.test(base.licenseId)).toBe(true);
    expect(LicensePayload.safeParse({ ...base, licenseId: 'Ahmed Mohamed' }).success).toBe(false);
  });
});

describe('LicenseEnvelope (AC-14)', () => {
  it('takes a key id, a base64url payload, and a signature, nothing else', () => {
    const envelope = { keyId: 'dev-1', payload: 'eyJ9', signature: 'abc_-' };
    expect(LicenseEnvelope.safeParse(envelope).success).toBe(true);
    expect(LicenseEnvelope.safeParse({ ...envelope, note: 'x' }).success).toBe(false);
    expect(LicenseEnvelope.safeParse({ ...envelope, payload: 'eyJ9=' }).success).toBe(false);
    expect(LicenseEnvelope.safeParse({ ...envelope, keyId: '../etc' }).success).toBe(false);
  });
});
