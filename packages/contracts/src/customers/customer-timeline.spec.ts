import { describe, expect, it } from 'vitest';
import { COST_FIELD_KEYS, permissionsFor, type Hat, type Permission } from '../access.js';
import {
  CUSTOMER_TIMELINE_KINDS,
  CustomerTimelineEntry,
  CustomerTimelineKind,
  CustomerTimelineQuery,
  timelineLens,
} from './customer-timeline.js';
import { suggestedRiskFlag } from './customer-views.js';

/** A lens over exactly these permissions. */
const lensOf = (permissions: readonly Permission[]) => {
  const held = new Set(permissions);
  return timelineLens((permission) => held.has(permission));
};
/** A lens over a hat's permissions, as the matrix builds them. */
const hatLens = (hat: Hat) => lensOf(permissionsFor([hat], []));

describe('CUSTOMER_TIMELINE_KINDS (spec 0014 AC-15)', () => {
  it('declares a permission for every kind and every guarded field', () => {
    for (const kind of CustomerTimelineKind.options) {
      expect(CUSTOMER_TIMELINE_KINDS[kind].needs).toBeTruthy();
    }
    expect(CUSTOMER_TIMELINE_KINDS.order.needs).toBe('orders.view');
    expect(CUSTOMER_TIMELINE_KINDS.merge.guarded).toEqual({
      undoable: 'customers.merge',
      audit: 'audit.read',
    });
  });

  it('gives a viewer with customers.view but not orders.view no order entry', () => {
    const lens = lensOf(['customers.view']);

    expect(lens.kinds).not.toContain('order');
    expect(lens.kinds).toEqual(['merge', 'unmerge', 'phone_added', 'channel_id_added', 'flag']);
    expect(lens.shows('merge', 'undoable')).toBe(false);
    expect(lens.shows('merge', 'audit')).toBe(false);
  });

  it('shows support Undo but no audit link, and the manager both', () => {
    const support = hatLens('support');
    const manager = hatLens('manager');

    expect(support.kinds).toEqual(CustomerTimelineKind.options);
    expect(support.shows('merge', 'undoable')).toBe(true);
    expect(support.shows('merge', 'audit')).toBe(false);
    expect(support.shows('unmerge', 'audit')).toBe(false);
    expect(manager.shows('merge', 'undoable')).toBe(true);
    expect(manager.shows('merge', 'audit')).toBe(true);
    expect(manager.shows('unmerge', 'audit')).toBe(true);
    expect(manager.shows('unmerge', 'undoable')).toBe(false);
  });

  it('gives the warehouse, the media buyer, and the partner no customer entry', () => {
    expect(hatLens('warehouse').kinds).toEqual(['order']);
    expect(hatLens('media_buyer').kinds).toEqual([]);
    expect(hatLens('partner').kinds).toEqual([]);
    expect(lensOf([]).shows('merge', 'undoable')).toBe(false);
  });

  it('never lets an unknown field through', () => {
    expect(hatLens('manager').shows('order', 'unitCost')).toBe(false);
    expect(hatLens('manager').shows('merge', 'toString')).toBe(false);
  });

  it('carries no cost field key in any entry shape', () => {
    const keys = CustomerTimelineEntry.options.flatMap((option) => Object.keys(option.shape));
    for (const key of COST_FIELD_KEYS) expect(keys).not.toContain(key);
  });
});

describe('CustomerTimelineQuery', () => {
  it('defaults the limit to 25 and splits the kinds', () => {
    expect(CustomerTimelineQuery.parse({})).toEqual({ limit: 25 });
    expect(CustomerTimelineQuery.parse({ kinds: 'order,flag', limit: '50' })).toEqual({
      limit: 50,
      kinds: ['order', 'flag'],
    });
  });

  it('refuses a limit outside 1 to 50, an unknown kind, and an unknown key', () => {
    expect(CustomerTimelineQuery.safeParse({ limit: '51' }).success).toBe(false);
    expect(CustomerTimelineQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(CustomerTimelineQuery.safeParse({ kinds: 'order,credit' }).success).toBe(false);
    expect(CustomerTimelineQuery.safeParse({ kinds: '' }).success).toBe(false);
    expect(CustomerTimelineQuery.safeParse({ page: '2' }).success).toBe(false);
  });
});

describe('suggestedRiskFlag (spec 0014 AC-13)', () => {
  const thresholds = { refusalsToSuggest: 2, returnsToSuggest: 2 };

  it('checks refusals first, then returns, and suggests nothing for a flagged customer', () => {
    expect(suggestedRiskFlag({ refusals: 2, returns: 5 }, thresholds, false)).toBe('refuser');
    expect(suggestedRiskFlag({ refusals: 1, returns: 2 }, thresholds, false)).toBe('returner');
    expect(suggestedRiskFlag({ refusals: 1, returns: 1 }, thresholds, false)).toBeNull();
    expect(suggestedRiskFlag({ refusals: 9, returns: 9 }, thresholds, true)).toBeNull();
    expect(
      suggestedRiskFlag(
        { refusals: 2, returns: 0 },
        { refusalsToSuggest: 3, returnsToSuggest: 2 },
        false,
      ),
    ).toBeNull();
  });
});
