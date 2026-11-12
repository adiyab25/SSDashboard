import { describe, expect, it } from 'vitest';
import {
  ChannelProductInput,
  ChannelProductResult,
  ChannelUnlinkInput,
  MAX_CHANNEL_VARIANTS,
  type ChannelVariantInput,
} from '../src/index.js';

const STORE = '0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B';

const variant = (n: number, values: string[] = ['M']): ChannelVariantInput => ({
  externalVariantId: `gid://shopify/ProductVariant/${n}`,
  variantId: null,
  sku: `TEE-${n}`,
  optionValues: values,
  price: '250',
  compareAtPrice: null,
  barcode: null,
  weightGrams: 200,
  requiresShipping: true,
  tracked: true,
});

const product = (overrides: Partial<ChannelProductInput> = {}): ChannelProductInput => ({
  storeId: STORE,
  externalProductId: 'gid://shopify/Product/1',
  styleId: null,
  handle: 'round-tee',
  title: ' Round Tee ',
  productType: null,
  vendor: null,
  tags: [' summer ', 'summer', '', 'cotton'],
  options: [{ name: 'Size', values: ['M'] }],
  variants: [variant(1)],
  ...overrides,
});

// Spec 0012 milestone 4 (AC-14): the channel upsert contract spec 0015's connector sends.
describe('ChannelProductInput', () => {
  it('takes a product, lowercases the store id, trims the title, and cleans the tags', () => {
    const parsed = ChannelProductInput.parse(product());

    expect(parsed.storeId).toBe(STORE.toLowerCase());
    expect(parsed.title).toBe('Round Tee');
    expect(parsed.tags).toEqual(['summer', 'cotton']);
  });

  it('takes a Default Title product as no options and no option values', () => {
    expect(
      ChannelProductInput.safeParse(product({ options: [], variants: [variant(1, [])] })).success,
    ).toBe(true);
  });

  it('holds 1 to 2,048 variants, 0 to 3 options, and a title of 1 to 200 characters', () => {
    const many = Array.from({ length: MAX_CHANNEL_VARIANTS + 1 }, (_, i) => variant(i));
    const four = Array.from({ length: 4 }, (_, i) => ({ name: `O${i}`, values: ['x'] }));

    expect(ChannelProductInput.safeParse(product({ variants: [] })).success).toBe(false);
    expect(ChannelProductInput.safeParse(product({ variants: many })).success).toBe(false);
    expect(
      ChannelProductInput.safeParse(product({ variants: many.slice(0, MAX_CHANNEL_VARIANTS) }))
        .success,
    ).toBe(true);
    expect(
      ChannelProductInput.safeParse(
        product({ options: four, variants: [variant(1, ['x', 'x', 'x', 'x'])] }),
      ).success,
    ).toBe(false);
    expect(ChannelProductInput.safeParse(product({ title: ' ' })).success).toBe(false);
    expect(ChannelProductInput.safeParse(product({ title: 'x'.repeat(201) })).success).toBe(false);
  });

  it('refuses a variant without one value per option, repeated external ids, and bad money', () => {
    expect(ChannelProductInput.safeParse(product({ variants: [variant(1, [])] })).success).toBe(
      false,
    );
    expect(
      ChannelProductInput.safeParse(product({ variants: [variant(1), variant(1, ['L'])] })).success,
    ).toBe(false);
    expect(
      ChannelProductInput.safeParse(product({ variants: [{ ...variant(1), price: '1.999' }] }))
        .success,
    ).toBe(false);
    expect(
      ChannelProductInput.safeParse(product({ variants: [{ ...variant(1), price: '-5.00' }] }))
        .success,
    ).toBe(false);
  });

  it('takes a missing or malformed SKU, which the catalog answers as needs_sku or invalid_sku', () => {
    expect(
      ChannelProductInput.safeParse(
        product({
          variants: [
            { ...variant(1), sku: null },
            { ...variant(2), sku: 'BAD SKU!' },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  // Security review M1: PostgreSQL refuses U+0000 in text and jsonb, so one would abort the
  // caller's transaction; bidi overrides make text render unlike its bytes.
  it('refuses a NUL or another control character, and bidi overrides, in channel text', () => {
    const parses = (overrides: Partial<ChannelProductInput>) =>
      ChannelProductInput.safeParse(product(overrides)).success;

    expect(parses({ title: 'Round\u0000Tee' })).toBe(false);
    expect(parses({ options: [{ name: 'Size', values: ['M\u0000'] }] })).toBe(false);
    expect(
      parses({
        options: [{ name: 'Size', values: ['M'] }],
        variants: [variant(1, ['M\u0000'])],
      }),
    ).toBe(false);
    expect(parses({ tags: ['summer\u0000'] })).toBe(false);
    expect(parses({ title: 'Round\u0007Tee' })).toBe(false);
    expect(parses({ handle: 'round\u007Ftee' })).toBe(false);
    expect(parses({ vendor: 'Brand\u202E' })).toBe(false);
    expect(parses({ productType: '\u2066Tops' })).toBe(false);
    expect(parses({ variants: [{ ...variant(1), sku: 'TEE\u0000' }] })).toBe(false);
    expect(parses({ variants: [{ ...variant(1), barcode: '622\u2069' }] })).toBe(false);
    // Whitespace trimmed around a text, and Arabic text, still parse.
    expect(parses({ title: 'Round Tee\n' })).toBe(true);
    expect(parses({ title: 'قميص أسود' })).toBe(true);
  });
});

describe('ChannelProductResult and ChannelUnlinkInput', () => {
  it('names each variant outcome', () => {
    const result = {
      styleId: null,
      styleOutcome: 'unchanged',
      variants: [{ externalVariantId: 'gid://1', variantId: null, outcome: 'needs_sku' }],
    };
    expect(ChannelProductResult.parse(result)).toEqual(result);
    expect(
      ChannelProductResult.safeParse({
        ...result,
        variants: [{ ...result.variants[0], outcome: 'archived' }],
      }).success,
    ).toBe(false);
  });

  it('takes style and variant ids, lowercased', () => {
    expect(ChannelUnlinkInput.parse({ styleIds: [STORE], variantIds: [] })).toEqual({
      styleIds: [STORE.toLowerCase()],
      variantIds: [],
    });
  });
});
