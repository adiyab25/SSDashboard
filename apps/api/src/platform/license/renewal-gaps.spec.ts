import type { LicensePhase } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { localDate } from '../settings/settings.service.js';
import { renewalsOf, type CheckPhases, type RecordedLicense } from './renewal-gaps.js';

// Spec 0009, AC-19: which renewals the supervisor backfills, and from which lapse.

const DAY = 24 * 60 * 60 * 1000;
const localDay = (instant: string) => localDate(new Date(instant), 'Africa/Cairo');

/** A check whose Operations phase is `operations` (Warehouse active throughout). */
const check = (seq: number, checkedAt: string, operations: LicensePhase): CheckPhases => ({
  seq: String(seq),
  checkedAt,
  operations,
  warehouse: 'active',
});

const first: RecordedLicense = {
  terms: { bundles: ['operations'], operationsExpiresOn: '2027-03-31', warehouseExpiresOn: null },
  recordedSeq: '1',
};
const renewal: RecordedLicense = {
  terms: { bundles: ['operations'], operationsExpiresOn: '2028-03-31', warehouseExpiresOn: null },
  recordedSeq: '5',
};
const checks = [
  check(1, '2027-03-01T08:00:00Z', 'expiring'),
  check(2, '2027-04-08T08:00:00Z', 'grace'),
  check(3, '2027-04-15T06:00:00Z', 'wind_down'),
  check(4, '2027-04-18T06:00:00Z', 'off'),
  check(5, '2027-05-20T08:00:00Z', 'active'),
];

describe('renewalsOf (AC-19)', () => {
  it('finds a renewal out of off with the lapse it renewed from', () => {
    const now = Date.parse('2027-05-20T09:00:00Z');
    expect(renewalsOf(checks, [first, renewal], { now, windowMs: 30 * DAY, localDay })).toEqual([
      { bundle: 'operations', seq: '5', at: '2027-05-20T08:00:00Z', lapsesOn: '2027-04-15' },
    ]);
  });

  it('ignores a renewal older than the window', () => {
    const now = Date.parse('2027-07-01T09:00:00Z');
    expect(renewalsOf(checks, [first, renewal], { now, windowMs: 30 * DAY, localDay })).toEqual([]);
  });

  it('backfills nothing for a renewal from grace: nothing stopped', () => {
    const fromGrace = [
      check(1, '2027-04-08T08:00:00Z', 'grace'),
      check(2, '2027-04-10T08:00:00Z', 'active'),
    ];
    const graceRenewal = { ...renewal, recordedSeq: '2' };
    const now = Date.parse('2027-04-10T09:00:00Z');
    expect(
      renewalsOf(fromGrace, [first, graceRenewal], { now, windowMs: 30 * DAY, localDay }),
    ).toEqual([]);
  });

  it('ignores a move back without a lapse behind it (a clock set back)', () => {
    // The clock ran ahead into the wind down, then was set back into grace: no new license, and
    // the old lapse day is after the check's own day.
    const setBack = [
      check(1, '2027-04-15T06:00:00Z', 'wind_down'),
      check(2, '2027-04-10T08:00:00Z', 'grace'),
    ];
    const now = Date.parse('2027-04-10T09:00:00Z');
    expect(renewalsOf(setBack, [first], { now, windowMs: 30 * DAY, localDay })).toEqual([]);
  });

  it('reads the lapse from the licenses recorded before the renewing check only', () => {
    // Without the first license the bundle was never licensed before: no gap to backfill.
    const now = Date.parse('2027-05-20T09:00:00Z');
    expect(renewalsOf(checks, [renewal], { now, windowMs: 30 * DAY, localDay })).toEqual([]);
  });
});
