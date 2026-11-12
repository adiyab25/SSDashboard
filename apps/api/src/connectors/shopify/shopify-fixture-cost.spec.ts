import { describe, expect, it } from 'vitest';
import {
  listShopifyFixtureFiles,
  readShopifyFixture,
} from '../../../test/shopify-fixture-fetch.js';
import { SHOPIFY_MAX_QUERY_COST } from './shopify-client.js';

/** The named property of an object, or undefined for anything else. */
function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

// Spec 0015 AC-25: page sizes keep every query at or under 900 points; this fails above Shopify's
// 1,000 point single query limit for any recorded (or synthetic) answer, so a query that grew too
// costly is caught before it reaches a store.
describe('the Shopify fixture recordings', () => {
  const files = listShopifyFixtureFiles();

  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s requests at most 1,000 cost points', (file) => {
    const { response } = readShopifyFixture(file);
    const extensions = field(response.body, 'extensions');
    const requested = field(field(extensions, 'cost'), 'requestedQueryCost');

    if (requested !== undefined && requested !== null) {
      expect(typeof requested).toBe('number');
      expect(requested as number).toBeLessThanOrEqual(SHOPIFY_MAX_QUERY_COST);
    }
  });
});
