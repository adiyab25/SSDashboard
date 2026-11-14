import { MAX_CHANNEL_VARIANTS } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { readShopifyFixture } from '../../../test/shopify-fixture-fetch.js';
import { ProductSync } from './product-sync.js';
import { PRODUCT_VARIANTS_PAGE_OPERATION } from './shopify-queries.js';
import type { ShopifyConnectionAccess } from './shopify-client.js';

// Spec 0015 task 8, AC-16: the paged read of a product with up to 2,048 variants. The page size
// is 100 here (a recorded builder deviation from AC-16's 250, cost limit), so 2,048 variants take
// 21 requests. The Shopify client is a stub that serves generated synthetic pages; nothing here
// reaches Shopify.

const PRODUCT = 'gid://shopify/Product/2220000081001';
const PAGE = 100;
const ACCESS = {} as unknown as ShopifyConnectionAccess;

interface Request {
  operationName: string;
  variables: { id: string; after?: string };
}

/** The first recorded variant, cloned as the `n`th synthetic variant (a unique SKU and size). */
function variantNode(n: number): unknown {
  const body = readShopifyFixture('product-three-variants/01-product-read.json').response.body as {
    data: { product: { variants: { nodes: Record<string, unknown>[] } } };
  };
  const template = body.data.product.variants.nodes[0] as Record<string, unknown>;
  return {
    ...template,
    id: `gid://shopify/ProductVariant/${9000000 + n}`,
    sku: `SYN-${n}`,
    selectedOptions: [{ name: 'Size', value: `V${n}` }],
    inventoryItem: {
      ...(template['inventoryItem'] as Record<string, unknown>),
      id: `gid://shopify/InventoryItem/${9000000 + n}`,
    },
  };
}

/** A stub client serving `total` variants in pages of `PAGE`, recording every request. */
function stubClient(total: number, options: { vanishAfterPage?: number } = {}) {
  const requests: Request[] = [];
  const template = readShopifyFixture('product-three-variants/01-product-read.json').response
    .body as { data: { product: Record<string, unknown> } };
  const slice = (from: number) => {
    const to = Math.min(from + PAGE, total);
    const nodes = Array.from({ length: to - from }, (_, i) => variantNode(from + i));
    return {
      nodes,
      pageInfo: { hasNextPage: to < total, endCursor: to < total ? `cursor-${to}` : 'end' },
    };
  };
  const client = {
    request: (_access: unknown, request: Request) => {
      requests.push(request);
      const after = request.variables.after;
      const from = after === undefined ? 0 : Number(after.split('-')[1]);
      if (after !== undefined && options.vanishAfterPage === from / PAGE) {
        return Promise.resolve({ data: { product: null }, warnings: [] });
      }
      const variants = slice(from);
      const product =
        after === undefined ? { ...template.data.product, variants } : { id: PRODUCT, variants };
      return Promise.resolve({ data: { product }, warnings: [] });
    },
  };
  const sync = new ProductSync(
    {} as never,
    client as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { sync, requests };
}

describe('ProductSync.read variant paging (spec 0015 task 8, AC-16)', () => {
  it('reads a 2,048 variant product in 21 requests of 100, keeping every variant once, in order', async () => {
    const { sync, requests } = stubClient(MAX_CHANNEL_VARIANTS);
    const answer = await sync.read(ACCESS, PRODUCT);
    const variants = answer.value?.variants ?? [];
    expect(variants).toHaveLength(MAX_CHANNEL_VARIANTS);
    expect(new Set(variants.map((variant) => variant.id)).size).toBe(MAX_CHANNEL_VARIANTS);
    expect(variants[0]?.sku).toBe('SYN-0');
    expect(variants.at(-1)?.sku).toBe(`SYN-${MAX_CHANNEL_VARIANTS - 1}`);
    expect(requests).toHaveLength(Math.ceil(MAX_CHANNEL_VARIANTS / PAGE));
    expect(
      requests.filter((r) => r.operationName === PRODUCT_VARIANTS_PAGE_OPERATION),
    ).toHaveLength(20);
    // Each page asks after the cursor the page before answered.
    expect(requests.slice(1).map((r) => r.variables.after)).toEqual(
      Array.from({ length: 20 }, (_, i) => `cursor-${(i + 1) * PAGE}`),
    );
  });

  it('refuses a product of 2,049 variants as VARIANTS_TRUNCATED, never mapping a partial list', async () => {
    const { sync } = stubClient(MAX_CHANNEL_VARIANTS + 1);
    await expect(sync.read(ACCESS, PRODUCT)).rejects.toMatchObject({ code: 'VARIANTS_TRUNCATED' });
  });

  it('reads a product of exactly one page and a product of 101 variants (the page boundary)', async () => {
    const one = stubClient(PAGE);
    expect((await one.sync.read(ACCESS, PRODUCT)).value?.variants).toHaveLength(PAGE);
    expect(one.requests).toHaveLength(1);
    const over = stubClient(PAGE + 1);
    expect((await over.sync.read(ACCESS, PRODUCT)).value?.variants).toHaveLength(PAGE + 1);
    expect(over.requests).toHaveLength(2);
  });

  it('answers no product when Shopify deletes it between two pages', async () => {
    const { sync } = stubClient(350, { vanishAfterPage: 2 });
    expect((await sync.read(ACCESS, PRODUCT)).value).toBeNull();
  });
});
