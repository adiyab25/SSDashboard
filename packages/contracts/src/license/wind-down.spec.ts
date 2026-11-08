import { describe, expect, it } from 'vitest';
import { actsOnEvent, BackfillGap } from '../modules/backfill.js';
import { defineModule } from '../modules/module-definition.js';
import type { LicenseNotice } from './license-api.js';
import {
  capabilitiesStoppingAt,
  licenseDayNotice,
  licenseNoticeWork,
  noticeInDailyReport,
} from './license-notice-work.js';
import { hookDecision, inCarrierScope } from './wind-down-scope.js';
import { WindDownReport, windDownDaysLeft } from './wind-down-report.js';

// Spec 0009 milestone 4 (AC-17, AC-18, AC-27, tasks 21 and 22): the wind down scope, the hook
// rule, the step watermark, the day notice, and the reduced report contract.

/** A lapse at 2027-04-15 00:00 in Cairo (UTC+2) with a pickup window of 3 days. */
const CUT = {
  cutAt: '2027-04-14T22:00:00.000000Z',
  pickupWindowEndsAt: '2027-04-17T22:00:00.000000Z',
};

describe('inCarrierScope (AC-18, D5)', () => {
  it('follows a delivery the carrier created before the lapse, whenever it was discovered', () => {
    expect(
      inCarrierScope({ carrierCreatedAt: '2027-04-14T21:50:00Z', orderConfirmedAt: null }, CUT),
    ).toBe(true);
  });

  it('follows a delivery created inside the pickup window for an order confirmed before the lapse', () => {
    const facts = {
      carrierCreatedAt: '2027-04-15T07:00:00Z',
      orderConfirmedAt: '2027-04-14T18:00:00Z',
    };
    expect(inCarrierScope(facts, CUT)).toBe(true);
  });

  it('drops a delivery created after the pickup window, or for an order confirmed after the lapse', () => {
    expect(
      inCarrierScope(
        { carrierCreatedAt: '2027-04-18T07:00:00Z', orderConfirmedAt: '2027-04-14T18:00:00Z' },
        CUT,
      ),
    ).toBe(false);
    expect(
      inCarrierScope(
        { carrierCreatedAt: '2027-04-15T07:00:00Z', orderConfirmedAt: '2027-04-15T06:00:00Z' },
        CUT,
      ),
    ).toBe(false);
    expect(
      inCarrierScope({ carrierCreatedAt: '2027-04-15T07:00:00Z', orderConfirmedAt: null }, CUT),
    ).toBe(false);
  });
});

describe('hookDecision (AC-18, task 21)', () => {
  const limited = { state: 'limited', before: CUT.cutAt, reason: 'lapsed' } as const;

  it('processes every event of an on capability and none of a stopped one', () => {
    expect(hookDecision({ state: 'on', since: null }, undefined, null)).toBe('process');
    expect(
      hookDecision(
        { state: 'read_only', reason: 'lapsed', since: null },
        { openedAt: '2020-01-01T00:00:00Z' },
        null,
      ),
    ).toBe('ignored_unlicensed');
    expect(
      hookDecision({ state: 'off', reason: 'not_licensed', since: null }, undefined, null),
    ).toBe('ignored_unlicensed');
  });

  it('processes only in scope events of a limited capability', () => {
    const inScope = {
      carrierCreatedAt: '2027-04-15T07:00:00Z',
      orderConfirmedAt: '2027-04-14T18:00:00Z',
    };
    const later = {
      carrierCreatedAt: '2027-04-19T07:00:00Z',
      orderConfirmedAt: '2027-04-14T18:00:00Z',
    };
    expect(hookDecision(limited, inScope, CUT.pickupWindowEndsAt)).toBe('process');
    expect(hookDecision(limited, later, CUT.pickupWindowEndsAt)).toBe('ignored_unlicensed');
    expect(hookDecision(limited, { openedAt: '2027-04-14T21:59:59Z' }, null)).toBe('process');
    expect(hookDecision(limited, { openedAt: CUT.cutAt }, null)).toBe('ignored_unlicensed');
    expect(hookDecision(limited, undefined, null)).toBe('ignored_unlicensed');
    // Without a window the cut itself closes it.
    expect(hookDecision(limited, inScope, null)).toBe('ignored_unlicensed');
  });
});

describe('actsOnEvent, the step watermark (AC-27)', () => {
  it('acts only when on, and only on events at or after since', () => {
    const since = '2027-05-01T10:00:00.123456Z';
    expect(actsOnEvent({ state: 'on', since }, '2027-05-01T10:00:00.123456Z')).toBe(true);
    expect(actsOnEvent({ state: 'on', since }, '2027-05-01T10:00:00.123455Z')).toBe(false);
    expect(actsOnEvent({ state: 'on', since: null }, '2000-01-01T00:00:00Z')).toBe(true);
    expect(
      actsOnEvent({ state: 'limited', before: since, reason: 'lapsed' }, '2020-01-01T00:00:00Z'),
    ).toBe(false);
    expect(actsOnEvent({ state: 'read_only', reason: 'lapsed', since: null }, since)).toBe(false);
  });
});

const MODULES = [
  defineModule({
    key: 'carrier',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'carrier.queue',
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'carrier.sweep',
        bundle: 'operations',
        kind: 'read',
        windDown: 'pre_lapse',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'carrier.close_out',
        bundle: 'operations',
        kind: 'write',
        windDown: 'until_closed',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'carrier.counts',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'carrier.report',
        bundle: 'warehouse',
        kind: 'read',
        windDown: 'pre_lapse',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'carrier.receive',
        bundle: 'warehouse',
        kind: 'write',
        windDown: 'until_closed',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'carrier.core',
        bundle: 'core',
        kind: 'read',
        windDown: 'none',
        workOf: [],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
];

const notice = (over: Partial<LicenseNotice>): LicenseNotice => ({
  bundle: 'operations',
  phase: 'expiring',
  level: 'info',
  expiresOn: '2027-03-31',
  daysLeft: 30,
  lapsesOn: '2027-04-15',
  lapsesAt: '2027-04-14T22:00:00.000000Z',
  windDownEndsOn: '2027-06-14',
  ...over,
});

describe('the day notice (AC-17, task 22)', () => {
  it('is in the daily report on days 30, 14, and 7 before expiry and every grace and wind down day', () => {
    const days = [31, 30, 29, 15, 14, 13, 8, 7, 6, 0].filter((daysLeft) =>
      noticeInDailyReport(notice({ daysLeft })),
    );
    expect(days).toEqual([30, 14, 7]);
    expect(noticeInDailyReport(notice({ phase: 'grace', daysLeft: -3 }))).toBe(true);
    expect(noticeInDailyReport(notice({ phase: 'wind_down', daysLeft: -40 }))).toBe(true);
    expect(noticeInDailyReport(notice({ phase: 'off', daysLeft: -90 }))).toBe(false);
  });

  it('names what stops at an Operations lapse and what continues until when', () => {
    expect(licenseNoticeWork(MODULES, notice({}))).toEqual({
      stops: ['carrier.queue'],
      continues: [
        { capability: 'carrier.sweep', until: 'wind_down_end', untilOn: '2027-06-14' },
        { capability: 'carrier.close_out', until: 'open_items_closed', untilOn: null },
      ],
    });
  });

  it('stops Warehouse pre lapse work too, since Warehouse has no wind down', () => {
    expect(
      licenseNoticeWork(MODULES, notice({ bundle: 'warehouse', windDownEndsOn: null })),
    ).toEqual({
      stops: ['carrier.counts', 'carrier.report'],
      continues: [{ capability: 'carrier.receive', until: 'open_items_closed', untilOn: null }],
    });
  });

  it('keeps every field of the manager notice', () => {
    const day = licenseDayNotice(MODULES, notice({ daysLeft: 14 }));
    expect(day).toMatchObject({ ...notice({ daysLeft: 14 }), inReport: true });
  });
});

describe('the reduced wind down report (AC-18, task 22)', () => {
  it('parses a report and counts the days left, never below zero', () => {
    const report = {
      phase: 'wind_down',
      lapsedAt: '2027-04-14T22:00:00.000000Z',
      windDownEndsOn: '2027-06-14',
      windDownDaysLeft: windDownDaysLeft('2027-06-14', '2027-05-15'),
      expectedCash: { count: 3, amount: '1250.50' },
      failed: [{ area: 'carrier.sweep', count: 1 }],
      final: false,
    };
    expect(WindDownReport.parse(report).windDownDaysLeft).toBe(30);
    expect(windDownDaysLeft('2027-06-14', '2027-07-01')).toBe(0);
    expect(
      WindDownReport.safeParse({ ...report, failed: [{ area: 'Free text', count: 1 }] }).success,
    ).toBe(false);
  });
});

describe('the wind down scope at its edges (AC-18, D5)', () => {
  it('drops a delivery created exactly at the cut or exactly at the end of the pickup window', () => {
    expect(inCarrierScope({ carrierCreatedAt: CUT.cutAt, orderConfirmedAt: null }, CUT)).toBe(
      false,
    );
    expect(
      inCarrierScope(
        { carrierCreatedAt: CUT.pickupWindowEndsAt, orderConfirmedAt: '2027-04-14T18:00:00Z' },
        CUT,
      ),
    ).toBe(false);
    expect(
      inCarrierScope(
        {
          carrierCreatedAt: '2027-04-17T21:59:59.999999Z',
          orderConfirmedAt: '2027-04-14T18:00:00Z',
        },
        CUT,
      ),
    ).toBe(true);
  });

  it('drops a delivery whose order was confirmed exactly at the cut', () => {
    expect(
      inCarrierScope(
        { carrierCreatedAt: '2027-04-15T07:00:00Z', orderConfirmedAt: CUT.cutAt },
        CUT,
      ),
    ).toBe(false);
  });

  it('reads instants with an offset by the moment they name', () => {
    // 23:59 in Cairo on the 14th is before the cut; 00:30 on the 15th is after it.
    expect(
      inCarrierScope(
        { carrierCreatedAt: '2027-04-14T23:59:00+02:00', orderConfirmedAt: null },
        CUT,
      ),
    ).toBe(true);
    expect(
      inCarrierScope(
        { carrierCreatedAt: '2027-04-15T00:30:00+02:00', orderConfirmedAt: null },
        CUT,
      ),
    ).toBe(false);
  });

  it('never follows a delivery whose instants cannot be read', () => {
    expect(inCarrierScope({ carrierCreatedAt: 'not a time', orderConfirmedAt: null }, CUT)).toBe(
      false,
    );
    expect(
      inCarrierScope(
        { carrierCreatedAt: 'not a time', orderConfirmedAt: '2027-04-14T18:00:00Z' },
        CUT,
      ),
    ).toBe(false);
    expect(
      inCarrierScope(
        { carrierCreatedAt: '2027-04-15T07:00:00Z', orderConfirmedAt: 'garbage' },
        CUT,
      ),
    ).toBe(false);
  });
});

describe('BackfillGap (AC-27)', () => {
  it('parses a gap with its cause and refuses a bad one', () => {
    const gap = { from: CUT.cutAt, to: '2027-05-20T08:00:00.000000Z', cause: 'renewed' };
    expect(BackfillGap.parse(gap)).toEqual(gap);
    expect(BackfillGap.safeParse({ ...gap, cause: 'later' }).success).toBe(false);
    expect(BackfillGap.safeParse({ ...gap, from: '2027-04-15T00:00:00' }).success).toBe(false);
    expect(BackfillGap.safeParse({ from: gap.from, to: gap.to }).success).toBe(false);
  });
});

describe('the report and the notice at their edges (AC-17, AC-18)', () => {
  it('counts 0 days left on the last wind down day and 1 the day before', () => {
    expect(windDownDaysLeft('2027-06-14', '2027-06-14')).toBe(0);
    expect(windDownDaysLeft('2027-06-14', '2027-06-13')).toBe(1);
  });

  it('refuses a report with a negative, fractional, or unreadable number', () => {
    const report = {
      phase: 'wind_down',
      lapsedAt: CUT.cutAt,
      windDownEndsOn: '2027-06-14',
      windDownDaysLeft: 3,
      expectedCash: { count: 1, amount: '10.00' },
      failed: [],
      final: false,
    };
    expect(WindDownReport.safeParse(report).success).toBe(true);
    expect(WindDownReport.safeParse({ ...report, windDownDaysLeft: -1 }).success).toBe(false);
    expect(WindDownReport.safeParse({ ...report, windDownDaysLeft: 1.5 }).success).toBe(false);
    expect(
      WindDownReport.safeParse({ ...report, expectedCash: { count: -1, amount: '10.00' } }).success,
    ).toBe(false);
    expect(
      WindDownReport.safeParse({ ...report, expectedCash: { count: 1, amount: '10.005' } }).success,
    ).toBe(false);
    expect(
      WindDownReport.safeParse({ ...report, failed: [{ area: 'carrier.sweep', count: 0 }] })
        .success,
    ).toBe(false);
  });

  it('stops pre lapse work of an Operations notice that carries no wind down day', () => {
    expect(licenseNoticeWork(MODULES, notice({ windDownEndsOn: null }))).toEqual({
      stops: ['carrier.queue', 'carrier.sweep'],
      continues: [{ capability: 'carrier.close_out', until: 'open_items_closed', untilOn: null }],
    });
  });
});

describe('capabilitiesStoppingAt, the one list of what stops (AC-17)', () => {
  const withPush = [
    ...MODULES,
    defineModule({
      key: 'push',
      bundle: 'core',
      toggle: false,
      requires: [],
      label: 'modules.platform.label',
      description: 'modules.platform.description',
      capabilities: [
        {
          key: 'push.stock',
          bundle: 'warehouse',
          kind: 'write',
          windDown: 'none',
          requiresOneOf: ['carrier.queue'],
          workOf: [],
          label: 'modules.capabilities.mailSend',
        },
        {
          key: 'push.mixed',
          bundle: 'warehouse',
          kind: 'write',
          windDown: 'none',
          requiresOneOf: ['carrier.queue', 'carrier.core'],
          workOf: [],
          label: 'modules.capabilities.mailSend',
        },
        {
          key: 'push.waiting',
          bundle: 'core',
          kind: 'write',
          windDown: 'none',
          requiresOneOf: [],
          workOf: [],
          label: 'modules.capabilities.mailSend',
        },
      ],
    }),
  ];

  it('adds a capability of another bundle whose every source is in the lapsing bundle', () => {
    expect(capabilitiesStoppingAt(withPush, 'operations', true)).toEqual([
      'carrier.queue',
      'push.stock',
    ]);
    expect(licenseNoticeWork(withPush, notice({})).stops).toEqual(['carrier.queue', 'push.stock']);
  });

  it('keeps one whose other source runs, and one that never had a source', () => {
    const stops = capabilitiesStoppingAt(withPush, 'operations', true);
    expect(stops).not.toContain('push.mixed');
    expect(stops).not.toContain('push.waiting');
  });
});

describe('the day notice once the lapse is past its wind down (web review H1)', () => {
  it('stops pre lapse work in off after an early end, though its last day is still ahead', () => {
    expect(
      licenseNoticeWork(
        MODULES,
        notice({ phase: 'off', daysLeft: -20, windDownEndsOn: '2027-06-14' }),
      ),
    ).toEqual({
      stops: ['carrier.queue', 'carrier.sweep'],
      continues: [{ capability: 'carrier.close_out', until: 'open_items_closed', untilOn: null }],
    });
  });

  it('stops pre lapse work in off after the full length, its last day past', () => {
    expect(
      licenseNoticeWork(
        MODULES,
        notice({ phase: 'off', daysLeft: -90, windDownEndsOn: '2027-06-14' }),
      ),
    ).toEqual({
      stops: ['carrier.queue', 'carrier.sweep'],
      continues: [{ capability: 'carrier.close_out', until: 'open_items_closed', untilOn: null }],
    });
    expect(
      licenseDayNotice(MODULES, notice({ phase: 'off', windDownEndsOn: '2027-06-14' })),
    ).toMatchObject({
      inReport: false,
      stops: ['carrier.queue', 'carrier.sweep'],
    });
  });

  it('stops Warehouse pre lapse work at a Warehouse lapse, keeping only until closed work', () => {
    expect(
      licenseNoticeWork(
        MODULES,
        notice({ bundle: 'warehouse', phase: 'off', windDownEndsOn: null }),
      ),
    ).toEqual({
      stops: ['carrier.counts', 'carrier.report'],
      continues: [{ capability: 'carrier.receive', until: 'open_items_closed', untilOn: null }],
    });
  });

  it('keeps pre lapse work continuing while the wind down runs', () => {
    expect(
      licenseNoticeWork(MODULES, notice({ phase: 'wind_down', windDownEndsOn: '2027-06-14' }))
        .continues[0],
    ).toEqual({ capability: 'carrier.sweep', until: 'wind_down_end', untilOn: '2027-06-14' });
  });
});
