import { describe, expect, it } from 'vitest';
import { Access, InvalidAccess } from './access.js';

const USER = '0190c0de-0000-7000-8000-000000000001';

describe('Access', () => {
  it('holds the union of every hat and the grants, sorted (spec 0008, AC-1 and AC-2)', () => {
    const access = new Access({
      userId: USER,
      hats: ['warehouse', 'support'],
      grants: ['cost.view'],
      partnerAccountId: null,
    });

    expect(access.hats).toEqual(['support', 'warehouse']);
    expect(access.permissions).toEqual([...access.permissions].sort());
    expect(access.has('stock.receive')).toBe(true);
    expect(access.has('orders.confirm')).toBe(true);
    expect(access.has('cost.view')).toBe(true);
    expect(access.has('people.manage')).toBe(false);
  });

  it('needs every listed permission, and never passes on an empty list', () => {
    const access = new Access({
      userId: USER,
      hats: ['warehouse'],
      grants: [],
      partnerAccountId: null,
    });

    expect(access.hasAll(['stock.view', 'stock.receive'])).toBe(true);
    expect(access.hasAll(['stock.view', 'stock.correct'])).toBe(false);
    expect(access.hasAll([])).toBe(false);
  });

  it('knows which audience the hats sign in to', () => {
    const staff = new Access({
      userId: USER,
      hats: ['media_buyer'],
      grants: [],
      partnerAccountId: null,
    });
    const none = new Access({ userId: USER, hats: [], grants: [], partnerAccountId: null });

    expect(staff.wearsHatOf('staff')).toBe(true);
    expect(staff.wearsHatOf('partner')).toBe(false);
    expect(none.wearsHatOf('staff')).toBe(false);
  });

  it('refuses a hat or a grant outside the catalog', () => {
    expect(
      () => new Access({ userId: USER, hats: ['owner'], grants: [], partnerAccountId: null }),
    ).toThrow(InvalidAccess);
    expect(
      () => new Access({ userId: USER, hats: [], grants: ['everything'], partnerAccountId: null }),
    ).toThrow(InvalidAccess);
  });

  it('cannot be changed once built', () => {
    const access = new Access({
      userId: USER,
      hats: ['support'],
      grants: [],
      partnerAccountId: null,
    });

    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(access.permissions)).toBe(true);
    expect(() => (access.permissions as string[]).push('cost.view')).toThrow();
  });

  it('names the first hat in catalog order that holds a permission as the acting hat', () => {
    const access = (hats: string[], grants: string[] = []) =>
      new Access({ userId: USER, hats, grants, partnerAccountId: null });

    expect(access(['manager', 'support']).actingHat('people.manage')).toBe('manager');
    expect(access(['warehouse', 'manager']).actingHat('stock.view')).toBe('warehouse');
    // Held only through a grant: the first hat worn; no hat at all: `none`.
    expect(access(['warehouse'], ['cost.view']).actingHat('cost.view')).toBe('warehouse');
    expect(access([]).actingHat('audit.read')).toBe('none');
  });
});
