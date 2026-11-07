import { describe, expect, it } from 'vitest';
import { STAFF_HATS, inCatalogOrder, startingCostView } from './cost-prefill';

describe('startingCostView (spec 0008, AC-7)', () => {
  const fresh = { storedHats: [], storedCostView: false, canChange: true } as const;

  it('starts on for manager and operations and off for the other staff hats', () => {
    expect(startingCostView({ ...fresh, hats: ['manager'] })).toBe(true);
    expect(startingCostView({ ...fresh, hats: ['operations'] })).toBe(true);
    expect(startingCostView({ ...fresh, hats: ['support'] })).toBe(false);
    expect(startingCostView({ ...fresh, hats: ['warehouse'] })).toBe(false);
    expect(startingCostView({ ...fresh, hats: ['media_buyer'] })).toBe(false);
    expect(startingCostView({ ...fresh, hats: [] })).toBe(false);
  });

  it('looks only at the hats being added; a hat already worn keeps the stored grant', () => {
    expect(
      startingCostView({
        hats: ['operations', 'warehouse'],
        storedHats: ['operations'],
        storedCostView: false,
        canChange: true,
      }),
    ).toBe(false);
    expect(
      startingCostView({
        hats: ['support', 'warehouse'],
        storedHats: ['warehouse'],
        storedCostView: false,
        canChange: true,
      }),
    ).toBe(false);
    expect(
      startingCostView({
        hats: ['operations', 'warehouse'],
        storedHats: ['warehouse'],
        storedCostView: false,
        canChange: true,
      }),
    ).toBe(true);
  });

  it('never takes away a stored grant by ticking a hat that starts off', () => {
    expect(
      startingCostView({
        hats: ['warehouse', 'support'],
        storedHats: ['warehouse'],
        storedCostView: true,
        canChange: true,
      }),
    ).toBe(true);
  });

  it('keeps the stored grant whatever is ticked when the person may not change cost', () => {
    expect(
      startingCostView({
        hats: ['manager'],
        storedHats: [],
        storedCostView: false,
        canChange: false,
      }),
    ).toBe(false);
    expect(
      startingCostView({
        hats: ['support'],
        storedHats: ['support'],
        storedCostView: true,
        canChange: false,
      }),
    ).toBe(true);
  });
});

describe('STAFF_HATS and inCatalogOrder', () => {
  it('offers the five staff hats in catalog order and never partner', () => {
    expect(STAFF_HATS).toEqual(['support', 'operations', 'warehouse', 'manager', 'media_buyer']);
  });

  it('sorts a ticked set into catalog order', () => {
    expect(inCatalogOrder(['manager', 'support', 'warehouse'])).toEqual([
      'support',
      'warehouse',
      'manager',
    ]);
  });
});
