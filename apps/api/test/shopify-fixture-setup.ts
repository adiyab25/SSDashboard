import { afterEach } from 'vitest';
import { installShopifyFixtureFetch, resetShopifyScenarios } from './shopify-fixture-fetch.js';

// Spec 0015 AC-26: every api test file, unit, e2e, and scale, runs with the refusing fetch, so no
// test can reach Shopify. A test loads recordings with `useShopifyScenarios(...)`; they are dropped
// after each test. Listed in `setupFiles` of each vitest config of this workspace.
installShopifyFixtureFetch();
afterEach(() => {
  resetShopifyScenarios();
});
