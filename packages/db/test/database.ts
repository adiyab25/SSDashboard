import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// The e2e suites need the dev database (deploy/compose.dev.yaml). They read
// DATABASE_URL from the environment or the repo root `.env`, like the api does.
const ROOT_ENV = new URL('../../../.env', import.meta.url);

export function adminUrl(): string {
  if (!process.env.MIGRATION_DATABASE_URL && existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
  // Scratch databases are created by the owner role; DATABASE_URL is the application role.
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url)
    throw new Error('Set MIGRATION_DATABASE_URL (or create the root .env) to run the e2e tests.');
  return url;
}

export async function withAdmin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Creates an empty, uniquely named database and returns its URL. */
export async function createScratchDatabase(): Promise<{ name: string; url: string }> {
  const name = `ssd_test_${randomBytes(4).toString('hex')}`;
  await withAdmin((client) => client.query(`CREATE DATABASE ${name}`));
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

export async function dropScratchDatabase(name: string): Promise<void> {
  await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}
