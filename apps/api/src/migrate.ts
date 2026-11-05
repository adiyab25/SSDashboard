import { runMigrations, setAppRoleLogin } from '@ssdashboard/db';
import { loadEnv } from './config/env.js';

// Entry point: `migrate`. Applies pending migrations as the owner role, then exits.
// Compose starts the api only after this exits successfully.
const env = loadEnv();
if (!env.MIGRATION_DATABASE_URL) {
  console.error('Invalid environment:\n✖ MIGRATION_DATABASE_URL is required to migrate');
  process.exit(1);
}
try {
  await runMigrations(env.MIGRATION_DATABASE_URL, {
    tenantId: env.TENANT_ID,
    appRole: env.APP_DB_ROLE,
  });
  // The application role gets its login here, so each install sets it from its own secret.
  if (env.APP_DB_PASSWORD) {
    await setAppRoleLogin(env.MIGRATION_DATABASE_URL, env.APP_DB_PASSWORD, env.APP_DB_ROLE);
  }
  console.log('Migrations applied.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
}
