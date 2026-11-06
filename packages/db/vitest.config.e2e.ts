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
    // Each file migrates its own scratch database, and the baseline runs as one transaction that
    // holds about 1,400 locks until it commits (measured on the merged baseline, audit included).
    // The server's lock table is shared and holds about max_locks_per_transaction (64) times
    // max_connections (100), so a dozen files migrating at once ran out of shared memory. Three at
    // a time, like the api suite, stays well inside it.
    maxWorkers: 3,
  },
});
