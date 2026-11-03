import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Every suite starts real api (and worker) processes against its own scratch database, each
    // holding a connection pool. Too many at once reach the server's connection limit.
    maxWorkers: 3,
  },
});
