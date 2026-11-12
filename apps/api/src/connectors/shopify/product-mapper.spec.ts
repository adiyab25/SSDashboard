import { ChannelProductInput } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { readShopifyFixture } from '../../../test/shopify-fixture-fetch.js';
import {
  assembleBulkProduct,
  hasOnlyDefaultOption,
  mapShopifyProduct,
  parseProductOfVariant,
  parseShopifyProductPage,
  parseShopifyVariantsPage,
  priceOf,
  productLabelOf,
  ShopifyProductMappingError,
  weightInGrams,
  type ShopifyProduct,
} from './product-mapper.js';

const STORE = '0b6e8f9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const STYLE = '1c7f9a0b-2d3e-4f5a-9b0c-1d2e3f4a5b6c';
const VARIANT = '2d8a0b1c-3e4f-4a5b-8c1d-2e3f4a5b6c7d';

/** The answer body's `data` of a fixture file. */
function dataOf(file: string): unknown {
  const body = readShopifyFixture(file).response.body as { data: unknown };
  return body.data;
}

/** The first page of the three variants product, joined with its second page. */
function threeVariants(): ShopifyProduct {
  const page = parseShopifyProductPage(dataOf('product-three-variants/01-product-read.json'));
  if (!page) throw new Error('no product');
  const next = parseShopifyVariantsPage(
    dataOf('product-three-variants/02-product-variants-page.json'),
    page.product.id,
  );
  if (!next) throw new Error('no page');
  return { ...page.product, variants: [...page.product.variants, ...next.variants] };
}

/** The error a call throws, for its code. */
function thrown(call: () => unknown): ShopifyProductMappingError {
  try {
    call();
  } catch (error) {
    if (error instanceof ShopifyProductMappingError) return error;
    throw error;
  }
  throw new Error('nothing thrown');
}

describe('parseShopifyProductPage and parseShopifyVariantsPage (spec 0015 task 8, AC-16)', () => {
  it('reads a product with its first variants and the cursor of the next page', () => {
    const page = parseShopifyProductPage(dataOf('product-three-variants/01-product-read.json'));
    expect(page?.product.id).toBe('gid://shopify/Product/2220000081001');
    expect(page?.product.variants).toHaveLength(3);
    expect(page?.nextCursor).toBe('fixture-variants-p1-1');
  });

  it('answers null for a product Shopify no longer has', () => {
    expect(parseShopifyProductPage(dataOf('product-three-variants/07-product-read.json'))).toBe(
      null,
    );
  });

  it('reads the next page and ends at the last one', () => {
    const next = parseShopifyVariantsPage(
      dataOf('product-three-variants/02-product-variants-page.json'),
      'gid://shopify/Product/2220000081001',
    );
    expect(next?.variants.map((variant) => variant.sku)).toEqual([null]);
    expect(next?.nextCursor).toBe(null);
  });

  it('refuses a page of another product and a page that promises more without a cursor', () => {
    const data = dataOf('product-three-variants/02-product-variants-page.json');
    expect(thrown(() => parseShopifyVariantsPage(data, 'gid://shopify/Product/1')).code).toBe(
      'PRODUCT_UNREADABLE',
    );
    const page = structuredClone(dataOf('product-three-variants/01-product-read.json')) as {
      product: { variants: { pageInfo: { endCursor: string | null } } };
    };
    page.product.variants.pageInfo.endCursor = null;
    expect(thrown(() => parseShopifyProductPage(page)).code).toBe('VARIANTS_TRUNCATED');
  });

  it('refuses another shape with field paths only, never a value', () => {
    const error = thrown(() => parseShopifyProductPage({ product: { id: 'x', title: 7 } }));
    expect(error.code).toBe('PRODUCT_UNREADABLE');
    expect(error.message).not.toContain('7');
  });

  it("reads a variant's product id, and null for a variant Shopify no longer has", () => {
    expect(
      parseProductOfVariant(dataOf('order-product-first/02-product-of-variant-read.json')),
    ).toBe('gid://shopify/Product/2220000081002');
    expect(parseProductOfVariant({ productVariant: null })).toBe(null);
  });
});

describe('mapShopifyProduct (Inbound processing item 6, spec 0012 Follow-up)', () => {
  it('maps every field the catalog takes, with the ids the connector map holds', () => {
    const input = mapShopifyProduct(threeVariants(), {
      storeId: STORE,
      styleId: STYLE,
      variantIds: new Map([['gid://shopify/ProductVariant/7770000081012', VARIANT]]),
    });
    expect(input).toMatchObject({
      storeId: STORE,
      externalProductId: 'gid://shopify/Product/2220000081001',
      styleId: STYLE,
      handle: 'fixture-linen-shirt',
      title: 'Fixture Linen Shirt',
      productType: 'Shirts',
      vendor: 'Fixture Brand',
      tags: ['fixture', 'summer'],
      options: [{ name: 'Size', values: ['S', 'M', 'L', 'XL'] }],
    });
    expect(input.variants.map((variant) => [variant.sku, variant.variantId])).toEqual([
      ['PX-LIN-S', null],
      ['PX-LIN-M', VARIANT],
      ['PX-LIN-L', null],
      [null, null],
    ]);
    expect(input.variants[0]).toMatchObject({
      externalVariantId: 'gid://shopify/ProductVariant/7770000081011',
      optionValues: ['S'],
      price: '650.00',
      compareAtPrice: null,
      barcode: null,
      weightGrams: 250,
      requiresShipping: true,
      tracked: true,
    });
    // The catalog's own schema takes it as is.
    expect(() => ChannelProductInput.parse(input)).not.toThrow();
  });

  it('converts kilograms, ounces, and pounds to whole grams, and keeps no weight as null', () => {
    const grams = mapShopifyProduct(threeVariants(), {
      storeId: STORE,
      styleId: null,
      variantIds: new Map(),
    }).variants.map((variant) => variant.weightGrams);
    expect(grams).toEqual([250, 300, 340, null]);
    expect(weightInGrams({ unit: 'POUNDS', value: 1 })).toBe(454);
    expect(weightInGrams({ unit: 'STONES', value: 1 })).toBe(null);
    expect(weightInGrams({ unit: 'GRAMS', value: -1 })).toBe(null);
  });

  it("sends Shopify's lone Default Title option as no option at all", () => {
    const product: ShopifyProduct = {
      ...threeVariants(),
      options: [{ name: 'Title', position: 1, values: ['Default Title'] }],
      variants: [
        {
          ...threeVariants().variants[0]!,
          selectedOptions: [{ name: 'Title', value: 'Default Title' }],
        },
      ],
    };
    expect(hasOnlyDefaultOption(product)).toBe(true);
    const input = mapShopifyProduct(product, {
      storeId: STORE,
      styleId: null,
      variantIds: new Map(),
    });
    expect(input.options).toEqual([]);
    expect(input.variants[0]?.optionValues).toEqual([]);
  });

  it('orders options by position and each variant by option, and refuses a missing value', () => {
    const base = threeVariants();
    const product: ShopifyProduct = {
      ...base,
      options: [
        { name: 'Color', position: 2, values: ['Blue'] },
        { name: 'Size', position: 1, values: ['S'] },
      ],
      variants: [
        {
          ...base.variants[0]!,
          selectedOptions: [
            { name: 'Color', value: 'Blue' },
            { name: 'Size', value: 'S' },
          ],
        },
      ],
    };
    const input = mapShopifyProduct(product, {
      storeId: STORE,
      styleId: null,
      variantIds: new Map(),
    });
    expect(input.options.map((option) => option.name)).toEqual(['Size', 'Color']);
    expect(input.variants[0]?.optionValues).toEqual(['S', 'Blue']);
    const missing = { ...product, variants: [{ ...product.variants[0]!, selectedOptions: [] }] };
    expect(
      thrown(() =>
        mapShopifyProduct(missing, { storeId: STORE, styleId: null, variantIds: new Map() }),
      ).code,
    ).toBe('OPTIONS_UNREADABLE');
  });

  it('strips control and direction characters the catalog refuses, and drops empty texts', () => {
    const product: ShopifyProduct = {
      ...threeVariants(),
      title: 'Linen‮ Shirt\u0007',
      productType: '',
      vendor: ' ',
      tags: ['\u0000', 'summer'],
    };
    const input = mapShopifyProduct(product, {
      storeId: STORE,
      styleId: null,
      variantIds: new Map(),
    });
    expect(input).toMatchObject({ title: 'Linen Shirt', productType: null, vendor: null });
    expect(input.tags).toEqual(['summer']);
    expect(() => ChannelProductInput.parse(input)).not.toThrow();
    expect(
      thrown(() =>
        mapShopifyProduct(
          { ...product, handle: '\u0007' },
          { storeId: STORE, styleId: null, variantIds: new Map() },
        ),
      ).code,
    ).toBe('PRODUCT_UNREADABLE');
  });
});

describe('priceOf', () => {
  it('keeps at most 2 decimals, dropping only zeros, and never rounds money', () => {
    expect(priceOf('650.00', 'p')).toBe('650.00');
    expect(priceOf('650.0', 'p')).toBe('650.0');
    expect(priceOf('650', 'p')).toBe('650');
    expect(priceOf('650.500', 'p')).toBe('650.5');
    expect(priceOf(null, 'p')).toBe(null);
    expect(thrown(() => priceOf('650.555', 'p')).code).toBe('PRICE_UNREADABLE');
    expect(thrown(() => priceOf('-1.00', 'p')).code).toBe('PRICE_UNREADABLE');
  });
});

describe('assembleBulkProduct (the products backfill, AC-17)', () => {
  it("gives a bulk product the read back's shape, its variant lines as its variants", () => {
    const product = assembleBulkProduct({
      root: { ...threeVariants(), variants: undefined },
      children: threeVariants().variants.map((variant) => ({ ...variant })),
      line: 0,
    });
    expect(product.variants).toHaveLength(4);
    expect(product.handle).toBe('fixture-linen-shirt');
  });

  it('refuses a child that is not a variant', () => {
    const error = thrown(() =>
      assembleBulkProduct({
        root: { ...threeVariants(), variants: undefined },
        children: [{ id: 'gid://shopify/LineItem/1' }],
        line: 0,
      }),
    );
    expect(error.code).toBe('PRODUCT_UNREADABLE');
  });
});

describe('productLabelOf', () => {
  it('labels an event with the handle, cut to 64 characters', () => {
    expect(productLabelOf({ handle: 'fixture-linen-shirt' })).toBe('fixture-linen-shirt');
    expect(productLabelOf({ handle: 'x'.repeat(80) })).toHaveLength(64);
  });
});
