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
  return url;
}
