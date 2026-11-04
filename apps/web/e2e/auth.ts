import { existsSync } from 'node:fs';

/** The admin the suite seeds and signs in as. A test account in the dev database only. */
export const E2E_ADMIN = {
  name: 'E2E Admin',
  email: 'e2e-admin@example.com',
  password: 'E2e-Password-1',
} as const;

/** Where the global setup saves the signed in cookie. Git ignored. */
export const STORAGE_STATE = 'e2e/.auth/admin.json';

/** The owner connection to the dev database, for seeding test rows. */
export function ownerDatabaseUrl(): string {
  const rootEnv = new URL('../../../.env', import.meta.url);
  if (!process.env.MIGRATION_DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL (or create the root .env) to seed rows.');
  assertLocalDatabase(url);
  return url;
}

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

/**
 * The suite seeds an admin with a published test password, so it must never point at a real
 * database. Only local hosts (and the dev compose service, `postgres`) pass, unless
 * `E2E_ALLOW_REMOTE_SEED=1` says otherwise.
 */
export function assertLocalDatabase(url: string, allowRemote = process.env.E2E_ALLOW_REMOTE_SEED) {
  if (allowRemote === '1') return;
  let host: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^\[|\]$/g, '');
    // pg lets a `?host=` or `?hostaddr=` query parameter override the hostname.
    for (const key of ['host', 'hostaddr']) {
      if (parsed.searchParams.has(key)) {
        throw new Error(
          `Refusing to seed: the e2e database URL carries a "${key}" parameter that overrides its host. Remove it, or set E2E_ALLOW_REMOTE_SEED=1 to override.`,
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
    throw new Error('The e2e database URL is not a valid URL; refusing to seed.');
  }
  if (!LOCAL_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `Refusing to seed the e2e admin into database host "${host}". Use a local database, or set E2E_ALLOW_REMOTE_SEED=1 to override.`,
    );
  }
}
