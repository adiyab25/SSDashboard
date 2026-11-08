import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Spec 0015 AC-26: the refusing fetch, so no test can reach Shopify (test/shopify-fixture-fetch.ts).
    setupFiles: ['./test/shopify-fixture-setup.ts'],
    // The scale suite has its own config and CI job (`test:scale`); it never runs here.
    exclude: [...configDefaults.exclude, 'test/scale.e2e-spec.ts'],
    // Every suite starts real api (and worker) processes against its own scratch database, each
    // holding a connection pool. Too many at once reach the server's connection limit.
    maxWorkers: 3,
    // Starting a real api process can take longer than vitest's 10 second default under load.
    hookTimeout: 90_000,
  },
});
