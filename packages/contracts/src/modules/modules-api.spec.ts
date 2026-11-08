import { describe, expect, it } from 'vitest';
import type { LicenseNotice } from '../license/license-api.js';
import { defineModule } from './module-definition.js';
import { ModuleStateView, moduleStateView, staffNotices } from './modules-api.js';

const MODULES = [
  defineModule({
    key: 'orders',
    bundle: 'core',
    toggle: false,
    requires: [],
    label: 'modules.platform.label',
    description: 'modules.platform.description',
    capabilities: [
      {
        key: 'orders.confirmation_queue',
        bundle: 'operations',
        kind: 'write',
        windDown: 'none',
        workOf: ['orders.confirm'],
        label: 'modules.capabilities.mailSend',
      },
      {
        key: 'orders.returned_to_origin_restock',
        bundle: 'operations',
        kind: 'write',
        windDown: 'until_closed',
        workOf: ['fulfillment.work'],
        label: 'modules.capabilities.mailSend',
      },
    ],
  }),
];

const notice = (over: Partial<LicenseNotice>): LicenseNotice => ({
  bundle: 'operations',
  phase: 'grace',
  level: 'warning',
  expiresOn: '2027-03-31',
  daysLeft: -8,
  lapsesOn: '2027-04-15',
  lapsesAt: '2027-04-14T22:00:00.000000Z',
  windDownEndsOn: '2027-06-14',
  ...over,
});

// Spec 0009, AC-17 and AC-26: the staff notice and the state view of GET /api/platform/modules.
describe('staffNotices (AC-17)', () => {
  const agent = { hats: ['operations'] as const, permissions: ['orders.confirm'] as const };

  it('tells a person whose work stops, from 7 days before the lapse', () => {
    // daysLeft -8 is 7 days before the lapse (expiry plus 15).
    expect(staffNotices(MODULES, [notice({})], agent)).toEqual([
      {
        bundle: 'operations',
        stopsOn: '2027-04-15',
        stopsAt: '2027-04-14T22:00:00.000000Z',
        capabilities: ['orders.confirmation_queue'],
      },
    ]);
  });

  it('says nothing 8 days before the lapse, nor after the wind down', () => {
    expect(staffNotices(MODULES, [notice({ daysLeft: -7 })], agent)).toEqual([]);
    expect(staffNotices(MODULES, [notice({ phase: 'off', daysLeft: -80 })], agent)).toEqual([]);
  });

  it('keeps telling through the wind down', () => {
    expect(
      staffNotices(MODULES, [notice({ phase: 'wind_down', daysLeft: -20 })], agent),
    ).toHaveLength(1);
  });

  it('leaves out work that continues and people whose work does not stop', () => {
    const packer = { hats: ['warehouse'] as const, permissions: ['fulfillment.work'] as const };
    expect(staffNotices(MODULES, [notice({})], packer)).toEqual([]);
  });

  it('never tells a person with only external hats (W8)', () => {
    const partner = { hats: ['partner'] as const, permissions: ['orders.confirm'] as const };
    expect(staffNotices(MODULES, [notice({})], partner)).toEqual([]);
  });
});

describe('moduleStateView (AC-26)', () => {
  it('fills since, before, and reason for each state and parses', () => {
    const views = [
      moduleStateView('a', { state: 'on', since: null }),
      moduleStateView('b', { state: 'limited', before: '2027-01-01T00:00:00Z', reason: 'lapsed' }),
      moduleStateView('c', {
        state: 'read_only',
        reason: 'toggled_off',
        since: '2027-01-01T00:00:00Z',
      }),
      moduleStateView('d', { state: 'off', reason: 'not_licensed', since: null }),
    ];
    expect(views).toEqual([
      { key: 'a', state: 'on', since: null, before: null, reason: null },
      { key: 'b', state: 'limited', since: null, before: '2027-01-01T00:00:00Z', reason: 'lapsed' },
      {
        key: 'c',
        state: 'read_only',
        since: '2027-01-01T00:00:00Z',
        before: null,
        reason: 'toggled_off',
      },
      { key: 'd', state: 'off', since: null, before: null, reason: 'not_licensed' },
    ]);
    for (const view of views) expect(ModuleStateView.parse(view)).toEqual(view);
  });
});
