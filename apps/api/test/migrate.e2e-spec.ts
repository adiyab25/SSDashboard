import { afterEach, describe, expect, it } from 'vitest';
import { createScratchDatabase, dropScratchDatabase, run, UNREACHABLE_DB } from './support.js';

describe('migrate entry point (dist/migrate.js)', { timeout: 30_000 }, () => {
  const scratch: string[] = [];

  afterEach(async () => {
    await Promise.all(scratch.splice(0).map(dropScratchDatabase));
  });

  it('applies migrations, prints a confirmation, and exits 0 so Compose starts the api', async () => {
    const db = await createScratchDatabase();
    scratch.push(db.name);

    const result = await run('migrate.js', { DATABASE_URL: db.url });

    expect(result.code).toBe(0);
    expect(result.output).toContain('Migrations applied.');
  });

  it('exits 1 when the database cannot be reached, so the api never starts', async () => {
    const result = await run('migrate.js', { DATABASE_URL: UNREACHABLE_DB });

    expect(result.code).toBe(1);
    expect(result.output).toContain('Migration failed');
  });

  it('exits 1 and names DATABASE_URL when it is missing', async () => {
    const result = await run('migrate.js', {});

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Invalid environment[\s\S]*DATABASE_URL/);
  });
});
