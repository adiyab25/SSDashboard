import { defineConfig } from 'vitest/config';

// Needs the dev database (deploy/compose.dev.yaml). Each test uses its own scratch database.
export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
  },
});
