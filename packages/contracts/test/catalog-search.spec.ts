import { describe, expect, it } from 'vitest';
import { AssignStylesRequest, SkuDetail, SkuListQuery, UpdateStyleRequest } from '../src/index.js';

// Spec 0012, AC-3 and AC-4: the SKU list query and the wider SKU rows.
describe('SkuListQuery', () => {
  const STYLE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

  it('takes a season id or none, a product group, and a style, beside q', () => {
    expect(
      SkuListQuery.parse({
        q: ' black tee ',
        seasonId: 'none',
        productGroupId: STYLE,
        styleId: STYLE,
      }),
    ).toEqual({
      q: 'black tee',
      status: 'active',
      seasonId: 'none',
      productGroupId: STYLE,
      styleId: STYLE,
      limit: 50,
    });
    expect(SkuListQuery.parse({ seasonId: STYLE }).seasonId).toBe(STYLE);
  });

  it('refuses a season that is neither a uuid nor none, and a malformed group or style', () => {
    expect(SkuListQuery.safeParse({ seasonId: 'SS26' }).success).toBe(false);
    expect(SkuListQuery.safeParse({ productGroupId: 'MAIN' }).success).toBe(false);
    expect(SkuListQuery.safeParse({ styleId: '1' }).success).toBe(false);
  });

  it('keeps q between 1 and 100 characters after trimming', () => {
    expect(SkuListQuery.safeParse({ q: '   ' }).success).toBe(false);
    expect(SkuListQuery.safeParse({ q: 'x'.repeat(100) }).success).toBe(true);
    expect(SkuListQuery.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('SkuDetail', () => {
  const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const ref = { id: ID, code: 'MAIN', name: { en: 'Main' } };

  it('carries the style, season, group, options, and barcodes', () => {
    const detail = {
      id: ID,
      productId: ID,
      code: 'TEE-BLK-M',
      name: { en: 'Tee' },
      style: { ...ref, code: 'TEE' },
      season: null,
      productGroup: ref,
      options: [{ name: { en: 'Size', ar: 'المقاس' }, value: { en: 'M' } }],
      price: '10.00',
      archived: false,
      status: 'active',
      updatedAt: '2026-11-08T10:00:00.000000Z',
      barcodes: [{ id: ID, code: '6221234567890' }],
    };
    expect(SkuDetail.parse(detail)).toEqual(detail);
    expect(SkuDetail.safeParse({ ...detail, barcodes: undefined }).success).toBe(false);
  });
});

// Review of spec 0012 milestone 2, minor 5: ids a caller sends are lowercased, so `a` and `A`
// are one style, and the api compares and audits them the way PostgreSQL answers them.
describe('catalog ids in style requests', () => {
  const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const UPPER = ID.toUpperCase();

  it('lowercases style, season, and group ids', () => {
    expect(
      AssignStylesRequest.parse({ styleIds: [UPPER], seasonId: UPPER, productGroupId: UPPER }),
    ).toEqual({ styleIds: [ID], seasonId: ID, productGroupId: ID });
    expect(
      UpdateStyleRequest.parse({
        updatedAt: '2026-11-08T10:00:00.000000Z',
        seasonId: UPPER,
        productGroupId: UPPER,
      }),
    ).toMatchObject({ seasonId: ID, productGroupId: ID });
  });

  it('counts an id and its uppercase twin once in the distinct check', () => {
    expect(AssignStylesRequest.safeParse({ styleIds: [ID, UPPER], seasonId: null }).success).toBe(
      false,
    );
  });
});
