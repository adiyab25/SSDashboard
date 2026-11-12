import { CUSTOMER_PROFILE_GUARDED_FIELDS, timelineLens } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { Access } from '../../platform/access/access.js';

/** An `Access` as identity's session guard builds it, for these hats and grants. */
const access = (hats: string[], grants: string[] = []) =>
  new Access({
    userId: '00000000-0000-4000-8000-000000000001',
    hats,
    grants,
    partnerAccountId: null,
  });
const lensOf = (viewer: Access) => timelineLens((permission) => viewer.has(permission));

// Spec 0014 AC-15: the lens over built `Access` objects, as the timeline service asks it.
describe('the customer timeline lens over built Access sets', () => {
  it('gives each staff hat that sees customers every kind, with Undo, and the audit link only to the manager', () => {
    for (const hat of ['support', 'operations', 'manager']) {
      const lens = lensOf(access([hat]));
      expect(lens.kinds, hat).toEqual([
        'order',
        'merge',
        'unmerge',
        'phone_added',
        'channel_id_added',
        'flag',
      ]);
      expect(lens.shows('merge', 'undoable'), hat).toBe(true);
      expect(lens.shows('merge', 'audit'), hat).toBe(hat === 'manager');
    }
  });

  it('gives no order entry, and no profile order data, to a viewer without orders.view', () => {
    // No hat holds customers.view without orders.view today, so the lens is asked through a
    // narrowed Access: the support hat's permissions less orders.view.
    const support = access(['support']);
    const narrowed = timelineLens(
      (permission) => permission !== 'orders.view' && support.has(permission),
    );

    expect(narrowed.kinds).not.toContain('order');
    expect(narrowed.kinds).toContain('merge');
    expect(support.has(CUSTOMER_PROFILE_GUARDED_FIELDS.signal)).toBe(true);
    expect(CUSTOMER_PROFILE_GUARDED_FIELDS).toEqual({
      signal: 'orders.view',
      orderCount: 'orders.view',
    });
  });

  it('gives the warehouse only order entries and the media buyer and partner nothing', () => {
    expect(lensOf(access(['warehouse'])).kinds).toEqual(['order']);
    expect(lensOf(access(['media_buyer'])).kinds).toEqual([]);
    expect(lensOf(access(['partner'])).kinds).toEqual([]);
  });
});
