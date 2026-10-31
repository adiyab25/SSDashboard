import { runMigrations } from '@ssdashboard/db';
import { loadEnv } from './config/env.js';

// Entry point: `migrate`. Applies pending migrations, then exits.
// Compose starts the api only after this exits successfully.
const env = loadEnv();
try {
  await runMigrations(env.DATABASE_URL);
  console.log('Migrations applied.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
}
