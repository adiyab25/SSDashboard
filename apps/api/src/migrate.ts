import { runMigrations, setAppRoleLogin } from '@ssdashboard/db';
import { loadMigrateEnv } from './config/env.js';

// Entry point: `migrate`. Applies pending migrations as the owner role, then exits.
// Compose starts the api only after this exits successfully. It validates only its own variables
// (MIGRATION_DATABASE_URL required), never the api's auth and mail settings, which its
// container does not receive (test/compose-env.spec.ts).
const env = loadMigrateEnv();
try {
  await runMigrations(env.MIGRATION_DATABASE_URL, {
    tenantId: env.TENANT_ID,
    appRole: env.APP_DB_ROLE,
  });
  // The application role gets its login here, so each install sets it from its own secret.
  if (env.APP_DB_PASSWORD) {
    // The role is the one the database stored on its first run; a different APP_DB_ROLE already threw.
    await setAppRoleLogin(env.MIGRATION_DATABASE_URL, env.APP_DB_PASSWORD);
  }
  console.log('Migrations applied.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
}
