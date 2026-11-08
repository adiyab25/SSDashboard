// TEST ONLY. Reads one synthetic Shopify order fixture (`src/connectors/shopify/fixtures/`, API
// version 2026-10) and parses its `response.body.data.order` with the production schema of
// `order-mapper.ts`, so a test maps it with the real mapper. Never imported by `src/`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseShopifyOrder, type ShopifyOrder } from '../src/connectors/shopify/order-mapper.js';

const FIXTURE_DIR = fileURLToPath(new URL('../src/connectors/shopify/fixtures/', import.meta.url));

const FixtureFile = z.object({
  _fixture: z.object({ apiVersion: z.literal('2026-10') }),
  request: z.object({ shopDomain: z.string(), operationName: z.literal('OrderRead') }),
  response: z.object({ body: z.object({ data: z.object({ order: z.unknown() }) }) }),
});

/** One fixture order and the shop it came from. */
export interface ShopifyFixtureOrder {
  readonly shopDomain: string;
  readonly order: ShopifyOrder;
}

/**
 * Reads a fixture, for example `readShopifyOrder('order-created-cod/01-order-read.json')`, and
 * parses its order with `parseShopifyOrder`. Throws when the file is not a 2026-10 `OrderRead`
 * recording or the order does not fit the schema the mapper reads.
 */
export function readShopifyOrder(file: string): ShopifyFixtureOrder {
  const parsed = FixtureFile.parse(
    JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as unknown,
  );
  return {
    shopDomain: parsed.request.shopDomain,
    order: parseShopifyOrder(parsed.response.body.data.order),
  };
}
