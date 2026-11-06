import { defineConfig } from 'vitest/config';

/**
 * The scale suite alone: `test/scale.e2e-spec.ts` seeds the spec 0002 load (and the spec 0010 audit
 * load) and takes tens of minutes. It runs only through `pnpm --filter @ssdashboard/api test:scale`
 * and the `scale` CI job; `vitest.config.e2e.ts` excludes it so `test:e2e` stays fast.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/scale.e2e-spec.ts'],
    // One suite, one seeded database: no parallelism to tune.
    maxWorkers: 1,
    hookTimeout: 90_000,
    // Seeding millions of rows is slow by design; the CI job's own timeout is the limit.
    testTimeout: 3_600_000,
  },
});
