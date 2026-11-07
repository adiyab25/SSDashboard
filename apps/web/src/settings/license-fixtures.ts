import type { LicenseNotice, LicenseSummary, RecordedLicenseView } from '@ssdashboard/contracts';

/** A recorded Warehouse license with no expiry plus an Operations year, for the license specs. */
export const recordedLicense: RecordedLicenseView = {
  id: '00000000-0000-4000-8000-0000000000a1',
  licenseId: 'SSD-2026-0001',
  bundles: ['warehouse', 'operations'],
  warehouseExpiresOn: null,
  operationsExpiresOn: '2027-11-07',
  issuedOn: '2026-11-07',
  source: 'file',
  recordedAt: '2026-11-07T10:00:00.000Z',
};

/** A summary of an install with both plans active, no problem, and no notice. */
export const activeSummary: LicenseSummary = {
  bundles: [
    {
      bundle: 'warehouse',
      phase: 'active',
      perpetual: true,
      expiresOn: null,
      daysLeft: null,
      lapsesAt: null,
    },
    {
      bundle: 'operations',
      phase: 'active',
      perpetual: false,
      expiresOn: '2027-11-07',
      daysLeft: 365,
      lapsesAt: '2027-11-21T22:00:00.000Z',
    },
  ],
  lastCheck: {
    checkedAt: '2026-11-07T10:00:00.000Z',
    trigger: 'api_start',
    outcome: 'valid',
    clockBehind: false,
  },
  licenses: [recordedLicense],
  notices: [],
};

/** A summary of an install that has no license recorded at all. */
export const emptySummary: LicenseSummary = {
  bundles: [
    {
      bundle: 'warehouse',
      phase: 'not_licensed',
      perpetual: false,
      expiresOn: null,
      daysLeft: null,
      lapsesAt: null,
    },
    {
      bundle: 'operations',
      phase: 'not_licensed',
      perpetual: false,
      expiresOn: null,
      daysLeft: null,
      lapsesAt: null,
    },
  ],
  lastCheck: null,
  licenses: [],
  notices: [],
};

/** One manager notice for Operations; pass what differs from "expiring in 10 days". */
export function operationsNotice(overrides: Partial<LicenseNotice> = {}): LicenseNotice {
  return {
    bundle: 'operations',
    phase: 'expiring',
    level: 'info',
    expiresOn: '2026-11-17',
    daysLeft: 10,
    lapsesOn: '2026-12-02',
    lapsesAt: '2026-12-01T22:00:00.000Z',
    windDownEndsOn: '2027-01-31',
    ...overrides,
  };
}
