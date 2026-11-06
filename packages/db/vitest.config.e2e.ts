import { defineConfig } from 'vitest/config';

// Needs the dev database (deploy/compose.dev.yaml). Each test uses its own scratch database.
export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    // Verify F3 (feature 4 close): the hooks create, migrate, and force drop scratch databases.
    // On a shared, busy dev PostgreSQL a drop or a migrate took over the 10 second default and
    // failed tests that pass alone; 60 seconds leaves room without hiding a real hang.
    hookTimeout: 60_000,
  },
});
