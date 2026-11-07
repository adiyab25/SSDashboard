import { describe, expect, it } from 'vitest';
import { licenseNoticeLevel } from './license-api.js';
import {
  addDays,
  bundleEntitlement,
  bundlePhase,
  bundleStanding,
  daysBetween,
  isLicensedNow,
  type BundlePhaseInput,
  type RecordedLicenseTerms,
  type WindDownInput,
} from './license-phase.js';

// Spec 0009, AC-15 and *Bundle phases*: the exhaustive boundary table for both bundles, the wind
// down's early end and pickup window, sticky `off`, and the union rule of AC-20.

const EXPIRY = '2027-03-31';
const LAPSE = '2027-04-15'; // expiry plus 15

const operations = (expiresOn = EXPIRY): RecordedLicenseTerms => ({
  bundles: ['operations'],
  operationsExpiresOn: expiresOn,
  warehouseExpiresOn: null,
});
const warehouse = (expiresOn: string | null = EXPIRY): RecordedLicenseTerms => ({
  bundles: ['warehouse'],
  operationsExpiresOn: null,
  warehouseExpiresOn: expiresOn,
});
const windDown = (over: Partial<WindDownInput> = {}): WindDownInput => ({
  days: 60,
  pickupDays: 3,
  openPreLapseItems: 1,
  endedOn: null,
  ...over,
});
const input = (
  today: string,
  licenses: RecordedLicenseTerms[],
  over: Partial<WindDownInput> = {},
): BundlePhaseInput => ({ today, licenses, windDown: windDown(over) });

describe('date arithmetic', () => {
  it('adds days across months and years', () => {
    expect(addDays(EXPIRY, 15)).toBe(LAPSE);
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetween('2027-03-01', EXPIRY)).toBe(30);
    expect(daysBetween(EXPIRY, '2027-03-01')).toBe(-30);
  });
});

describe('bundlePhase (AC-15), the boundary table for both bundles', () => {
  // [label, today, operations phase, warehouse phase]; Operations has one open pre lapse item.
  const table: [string, string, string, string][] = [
    ['31 days before expiry', addDays(EXPIRY, -31), 'active', 'active'],
    ['30 days before expiry', addDays(EXPIRY, -30), 'expiring', 'expiring'],
    ['7 days before expiry', addDays(EXPIRY, -7), 'expiring', 'expiring'],
    ['expiry day, 0 days left', EXPIRY, 'expiring', 'expiring'],
    ['grace day 1', addDays(EXPIRY, 1), 'grace', 'grace'],
    ['grace day 14', addDays(EXPIRY, 14), 'grace', 'grace'],
    ['the lapse day', LAPSE, 'wind_down', 'off'],
    ['the last wind down day', addDays(LAPSE, 59), 'wind_down', 'off'],
    ['the wind down length passed', addDays(LAPSE, 60), 'off', 'off'],
    ['long after', addDays(LAPSE, 400), 'off', 'off'],
  ];

  it.each(table)('%s', (_label, today, operationsPhase, warehousePhase) => {
    const licenses = [operations(), warehouse()];
    expect(bundlePhase('operations', input(today, licenses))).toBe(operationsPhase);
    expect(bundlePhase('warehouse', input(today, licenses))).toBe(warehousePhase);
  });

  it('gives days left, the lapse day, and the wind down end', () => {
    const standing = bundleStanding('operations', input(EXPIRY, [operations()]));
    expect(standing).toEqual({
      bundle: 'operations',
      phase: 'expiring',
      perpetual: false,
      expiresOn: EXPIRY,
      daysLeft: 0,
      lapsesOn: LAPSE,
      windDownEndsOn: addDays(LAPSE, 60),
    });
    const grace = bundleStanding('warehouse', input(addDays(EXPIRY, 3), [warehouse()]));
    expect(grace).toMatchObject({ phase: 'grace', daysLeft: -3, windDownEndsOn: null });
  });

  it('is not_licensed with no recorded license for the bundle', () => {
    expect(bundlePhase('operations', input(EXPIRY, []))).toBe('not_licensed');
    expect(bundlePhase('warehouse', input(EXPIRY, [operations()]))).toBe('not_licensed');
    expect(bundlePhase('operations', input(EXPIRY, [warehouse(null)]))).toBe('not_licensed');
  });

  it('keeps a Warehouse license with no expiry active for ever', () => {
    const standing = bundleStanding('warehouse', input('2099-01-01', [warehouse(null)]));
    expect(standing).toMatchObject({
      phase: 'active',
      perpetual: true,
      expiresOn: null,
      daysLeft: null,
    });
  });

  it('never gives Warehouse wind_down', () => {
    for (let day = -40; day <= 500; day += 1) {
      expect(bundlePhase('warehouse', input(addDays(EXPIRY, day), [warehouse()]))).not.toBe(
        'wind_down',
      );
    }
  });
});

describe('the Operations wind down (AC-15, AC-18)', () => {
  const at = (sinceLapse: number, over: Partial<WindDownInput>) =>
    bundlePhase('operations', input(addDays(LAPSE, sinceLapse), [operations()], over));

  it('ends early at zero open items once the pickup window has passed', () => {
    expect(at(3, { openPreLapseItems: 0 })).toBe('off');
    expect(at(10, { openPreLapseItems: 0 })).toBe('off');
  });

  it('holds the early end inside the pickup window', () => {
    expect(at(0, { openPreLapseItems: 0 })).toBe('wind_down');
    expect(at(2, { openPreLapseItems: 0 })).toBe('wind_down');
  });

  it('keeps winding down while items are open, until its length passes', () => {
    expect(at(3, { openPreLapseItems: 4 })).toBe('wind_down');
    expect(at(89, { openPreLapseItems: 4, days: 90 })).toBe('wind_down');
    expect(at(90, { openPreLapseItems: 4, days: 90 })).toBe('off');
  });

  it('may end on the lapse day itself when the pickup window is 0 days', () => {
    expect(at(0, { openPreLapseItems: 0, pickupDays: 0 })).toBe('off');
  });

  it('stays off once ended, even with open items again, until a renewal', () => {
    const endedOn = addDays(LAPSE, 3);
    expect(at(10, { openPreLapseItems: 7, endedOn })).toBe('off');
    expect(at(3, { openPreLapseItems: 7, endedOn })).toBe('off');
    // A renewal moves the lapse: the end recorded for the old lapse no longer counts.
    const renewed = [operations(), operations('2028-03-31')];
    expect(
      bundlePhase(
        'operations',
        input(addDays(LAPSE, 10), renewed, { openPreLapseItems: 7, endedOn }),
      ),
    ).toBe('active');
  });

  it('ignores an end recorded before the current lapse', () => {
    expect(at(0, { openPreLapseItems: 1, endedOn: addDays(LAPSE, -1) })).toBe('wind_down');
  });

  it('ignores an end recorded after today, so a clock set ahead never ends it for good', () => {
    // The clock ran 100 days past the lapse and recorded the end; back on the right day, the
    // wind down goes on.
    expect(at(5, { openPreLapseItems: 1, endedOn: addDays(LAPSE, 100) })).toBe('wind_down');
  });

  it('never ends early while no pre_lapse capability is registered (review M2 code 3)', () => {
    expect(at(3, { openPreLapseItems: null })).toBe('wind_down');
    expect(at(59, { openPreLapseItems: null })).toBe('wind_down');
    expect(at(60, { openPreLapseItems: null })).toBe('off');
    expect(at(0, { openPreLapseItems: null, pickupDays: 0 })).toBe('wind_down');
  });
});

describe('the union rule (AC-20)', () => {
  it('lets a later perpetual Warehouse license supersede a pilot one', () => {
    const pilot = warehouse('2027-02-07');
    expect(bundlePhase('warehouse', input('2027-02-15', [pilot]))).toBe('grace');
    expect(bundlePhase('warehouse', input('2027-03-01', [pilot]))).toBe('off');
    expect(
      bundleStanding('warehouse', input('2027-03-01', [pilot, warehouse(null)])),
    ).toMatchObject({
      phase: 'active',
      perpetual: true,
    });
  });

  it('ignores an Operations grant without an expiry, never reading it as perpetual (review M2 code 14)', () => {
    const broken: RecordedLicenseTerms = {
      bundles: ['operations'],
      operationsExpiresOn: null,
      warehouseExpiresOn: null,
    };
    expect(bundleEntitlement('operations', [broken])).toEqual({
      licensed: false,
      perpetual: false,
      expiresOn: null,
    });
    expect(bundleEntitlement('operations', [broken, operations()])).toMatchObject({
      perpetual: false,
      expiresOn: EXPIRY,
    });
  });

  it('counts the latest expiry, so an older license never shortens one', () => {
    const terms = [operations('2028-03-31'), operations('2027-03-31')];
    expect(bundleEntitlement('operations', terms)).toEqual({
      licensed: true,
      perpetual: false,
      expiresOn: '2028-03-31',
    });
  });

  it('adds bundles across licenses', () => {
    const both: RecordedLicenseTerms = {
      bundles: ['warehouse', 'operations'],
      operationsExpiresOn: EXPIRY,
      warehouseExpiresOn: null,
    };
    expect(bundleEntitlement('warehouse', [operations(), both])).toMatchObject({ perpetual: true });
    expect(bundleEntitlement('operations', [both])).toMatchObject({ expiresOn: EXPIRY });
  });
});

describe('licensed now and the notice level', () => {
  it('counts active, expiring, and grace as licensed', () => {
    expect(['active', 'expiring', 'grace'].every((phase) => isLicensedNow(phase as never))).toBe(
      true,
    );
    expect(
      ['not_licensed', 'wind_down', 'off'].some((phase) => isLicensedNow(phase as never)),
    ).toBe(false);
  });

  it('gives info from 30 days, warning from 7 days and in grace, critical from the lapse', () => {
    const level = (today: string) =>
      licenseNoticeLevel(bundleStanding('operations', input(today, [operations()])));
    expect(level(addDays(EXPIRY, -31))).toBeNull();
    expect(level(addDays(EXPIRY, -30))).toBe('info');
    expect(level(addDays(EXPIRY, -8))).toBe('info');
    expect(level(addDays(EXPIRY, -7))).toBe('warning');
    expect(level(addDays(EXPIRY, 5))).toBe('warning');
    expect(level(LAPSE)).toBe('critical');
    expect(level(addDays(LAPSE, 100))).toBe('critical');
    expect(
      licenseNoticeLevel(bundleStanding('warehouse', input(EXPIRY, [warehouse(null)]))),
    ).toBeNull();
  });
});
