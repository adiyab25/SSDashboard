import { describe, expect, it } from 'vitest';
import {
  AccessHolding,
  AccessRequest,
  COST_FIELD_KEYS,
  COST_VIEW_DEFAULT,
  ExternalHat,
  GrantablePermission,
  Hat,
  HAT_AUDIENCE,
  HAT_PERMISSIONS,
  InternalHat,
  Permission,
  PERMISSIONS,
  permissionsFor,
  StaffHat,
} from './access.js';

// Spec 0008, the permission matrix (AC-1, AC-6, AC-8): the rules every later change to the matrix
// must keep.
describe('the permission matrix', () => {
  it('has exactly six hats, four internal and two external (AC-1)', () => {
    expect(InternalHat.options).toEqual(['support', 'operations', 'warehouse', 'manager']);
    expect(ExternalHat.options).toEqual(['media_buyer', 'partner']);
    expect(Hat.options).toHaveLength(6);
  });

  it('gives no hat cost.view: it is an extra grant only (AC-6)', () => {
    for (const hat of Hat.options) expect(HAT_PERMISSIONS[hat], hat).not.toContain('cost.view');
    expect(GrantablePermission.options).toEqual(['cost.view']);
  });

  it('gives no external hat a permission that reaches personal data (AC-8)', () => {
    for (const hat of ExternalHat.options) {
      const personal = HAT_PERMISSIONS[hat].filter(
        (permission) => PERMISSIONS[permission].personal,
      );
      expect(personal, hat).toEqual([]);
    }
  });

  it('gives the manager every staff permission but cost.view', () => {
    const staffPermissions = Permission.options.filter(
      (permission) => PERMISSIONS[permission].audience === 'staff' && permission !== 'cost.view',
    );

    expect([...HAT_PERMISSIONS.manager].sort()).toEqual([...staffPermissions].sort());
  });

  it('uses every permission in some hat, except cost.view', () => {
    const used = new Set(Hat.options.flatMap((hat) => HAT_PERMISSIONS[hat]));
    const unused = Permission.options.filter((permission) => !used.has(permission));

    expect(unused).toEqual(['cost.view']);
  });

  it('gives each hat only permissions of its own audience, without repeats', () => {
    for (const hat of Hat.options) {
      const permissions = HAT_PERMISSIONS[hat];
      expect(new Set(permissions).size, hat).toBe(permissions.length);
      for (const permission of permissions) {
        expect(PERMISSIONS[permission].audience, `${hat} ${permission}`).toBe(HAT_AUDIENCE[hat]);
      }
    }
  });

  it('holds the media buyer to campaigns.view and the partner to its own two (AC-8, AC-9)', () => {
    expect(HAT_PERMISSIONS.media_buyer).toEqual(['campaigns.view']);
    expect(HAT_PERMISSIONS.partner).toEqual(['partner.view_own', 'partner.submit_sales']);
    expect(HAT_AUDIENCE.partner).toBe('partner');
    expect(HAT_AUDIENCE.media_buyer).toBe('staff');
  });

  it('starts the cost switch on for manager and operations only (AC-7)', () => {
    const on = Object.entries(COST_VIEW_DEFAULT)
      .filter(([, value]) => value)
      .map(([hat]) => hat);

    expect(on.sort()).toEqual(['manager', 'operations']);
    expect(Object.keys(COST_VIEW_DEFAULT)).not.toContain('partner');
  });

  it('names the cost fields of spec 0006 answers and the style page cost of spec 0012', () => {
    expect([...COST_FIELD_KEYS].sort()).toEqual(
      [
        'avgUnitCost',
        'lineTotal',
        'referenceValue',
        'totalCost',
        'totalValue',
        'unitCost',
        'cost',
      ].sort(),
    );
  });
});

// The permission matrix of spec 0008, written out cell by cell. It pins the data to the spec's
// table: any change to `HAT_PERMISSIONS` or `PERMISSIONS` must change this test in the same
// commit, against the spec, so a matrix edit can never slip in unreviewed.
describe('the permission matrix, cell by cell (spec 0008 table)', () => {
  it('gives each hat exactly these permissions', () => {
    expect(HAT_PERMISSIONS).toEqual({
      support: [
        'orders.view',
        'orders.confirm',
        'customers.view',
        'customers.merge',
        'exchanges.handle',
        'stock.view',
        'tasks.work',
      ],
      operations: [
        'orders.view',
        'orders.confirm',
        'customers.view',
        'customers.merge',
        'exchanges.handle',
        'refunds.approve',
        'fulfillment.work',
        'stock.view',
        'stock.receive',
        'catalog.edit',
        'channels.map',
        'settlement.work',
        'settlement.close',
        'exports.run',
        'partners.manage',
        'tasks.work',
        'tasks.assign',
        'reports.view',
        'campaigns.view',
      ],
      warehouse: [
        'orders.view',
        'fulfillment.work',
        'stock.view',
        'stock.receive',
        'catalog.edit',
        'tasks.work',
      ],
      manager: [
        'orders.view',
        'orders.confirm',
        'orders.gift',
        'customers.view',
        'customers.merge',
        'exchanges.handle',
        'refunds.approve',
        'fulfillment.work',
        'stock.view',
        'stock.receive',
        'stock.correct',
        'catalog.edit',
        'catalog.manage',
        'channels.map',
        'settlement.work',
        'settlement.close',
        'exports.run',
        'partners.manage',
        'tasks.work',
        'tasks.assign',
        'reports.view',
        'campaigns.view',
        'people.manage',
        'settings.manage',
        'audit.read',
        'audit.undo',
        'audit.export',
      ],
      media_buyer: ['campaigns.view'],
      partner: ['partner.view_own', 'partner.submit_sales'],
    });
  });

  it('gives each permission exactly this audience and personal data flag (the P column)', () => {
    const staffP = { audience: 'staff', personal: true };
    const staffOnly = { audience: 'staff', personal: false };
    const partnerOnly = { audience: 'partner', personal: false };

    expect(PERMISSIONS).toEqual({
      'orders.view': staffP,
      'orders.confirm': staffP,
      'orders.gift': staffOnly,
      'customers.view': staffP,
      'customers.merge': staffP,
      'exchanges.handle': staffP,
      'refunds.approve': staffP,
      'fulfillment.work': staffP,
      'stock.view': staffOnly,
      'stock.receive': staffOnly,
      'stock.correct': staffOnly,
      'catalog.edit': staffOnly,
      'catalog.manage': staffOnly,
      'channels.map': staffOnly,
      'settlement.work': staffP,
      'settlement.close': staffOnly,
      'exports.run': staffOnly,
      'partners.manage': staffOnly,
      'tasks.work': staffP,
      'tasks.assign': staffOnly,
      'reports.view': staffOnly,
      'campaigns.view': staffOnly,
      'people.manage': staffOnly,
      'settings.manage': staffOnly,
      'audit.read': staffP,
      'audit.undo': staffP,
      'audit.export': staffP,
      'partner.view_own': partnerOnly,
      'partner.submit_sales': partnerOnly,
      'cost.view': staffOnly,
    });
    expect(Object.keys(PERMISSIONS)).toEqual(Permission.options);
  });

  it('sends each hat to exactly this audience', () => {
    expect(HAT_AUDIENCE).toEqual({
      support: 'staff',
      operations: 'staff',
      warehouse: 'staff',
      manager: 'staff',
      media_buyer: 'staff',
      partner: 'partner',
    });
  });
});

describe('permissionsFor', () => {
  it('is the sorted union of every hat and the grants (AC-1, AC-2)', () => {
    const effective = permissionsFor(['support', 'warehouse'], ['cost.view']);

    expect(effective).toEqual([...effective].sort());
    expect(new Set(effective).size).toBe(effective.length);
    for (const permission of [...HAT_PERMISSIONS.support, ...HAT_PERMISSIONS.warehouse]) {
      expect(effective).toContain(permission);
    }
    expect(effective).toContain('cost.view');
    expect(effective).not.toContain('people.manage');
  });

  it('is empty for a person with no hat and no grant', () => {
    expect(permissionsFor([], [])).toEqual([]);
  });
});

describe('AccessRequest (AC-12)', () => {
  const valid = {
    hats: ['support', 'warehouse'],
    costView: false,
    updatedAt: '2026-11-06T10:00:00.123456Z',
  };

  it('takes the whole new set with the updatedAt read before, and a trimmed optional reason', () => {
    expect(AccessRequest.parse({ ...valid, reason: '  moved to the shop floor ' })).toEqual({
      ...valid,
      reason: 'moved to the shop floor',
    });
    expect(AccessRequest.parse({ ...valid, reason: '   ' }).reason).toBeUndefined();
  });

  it('lets the api judge an empty set and the partner hat, so it answers NO_HAT and HAT_CONFLICT', () => {
    expect(AccessRequest.safeParse({ ...valid, hats: [] }).success).toBe(true);
    expect(AccessRequest.safeParse({ ...valid, hats: ['partner', 'support'] }).success).toBe(true);
  });

  it.each([
    ['an unknown hat', { hats: ['owner'] }],
    ['a hat given twice', { hats: ['support', 'support'] }],
    ['no cost switch', { costView: undefined }],
    ['no updatedAt', { updatedAt: undefined }],
    ['an updatedAt that is not a time', { updatedAt: 'yesterday' }],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }],
  ])('refuses %s', (_name, change) => {
    expect(AccessRequest.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});

describe('StaffHat and AccessHolding', () => {
  it('offers the four internal hats and media_buyer on the staff route, never partner (AC-14)', () => {
    expect(StaffHat.options).toEqual([...InternalHat.options, 'media_buyer']);
  });

  it('holds ids only: hats, the cost grant and the partner account (AC-13)', () => {
    expect(Object.keys(AccessHolding.shape)).toEqual(['hats', 'costView', 'partnerAccountId']);
  });
});

describe('order moves answer the order page (spec 0013 milestone 2, security review L4)', () => {
  it('gives orders.view to every hat that holds orders.confirm or fulfillment.work', () => {
    const missing = Hat.options.filter((hat) => {
      const held = HAT_PERMISSIONS[hat];
      const moves = held.includes('orders.confirm') || held.includes('fulfillment.work');
      return moves && !held.includes('orders.view');
    });

    expect(missing).toEqual([]);
  });
});
