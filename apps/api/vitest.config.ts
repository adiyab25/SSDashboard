import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Spec 0015 AC-26: the refusing fetch, so no test can reach Shopify (test/shopify-fixture-fetch.ts).
    setupFiles: ['./test/shopify-fixture-setup.ts'],
  },
});
