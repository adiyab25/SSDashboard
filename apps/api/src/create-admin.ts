import { parseArgs } from 'node:util';
import { createDatabase } from '@ssdashboard/db';
import { createFirstAdmin } from './auth/first-admin.js';
import { resetAdminPassword } from './auth/reset-admin.js';
import { loadEnv } from './config/env.js';

// Entry point: `create-admin`. Makes the first admin, prints a temporary password once, and exits.
//   node dist/create-admin.js --email <email> --name <name>
// Break glass (mail off, every admin locked out): a new temporary password for an existing admin.
//   node dist/create-admin.js --reset-password --email <email>
// The password goes to the terminal only. Do not capture the output or send it to a log driver.
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    'reset-password': { type: 'boolean' },
  },
});

const USAGE = [
  'Usage:',
  '  node dist/create-admin.js --email <email> --name <name>',
  '  node dist/create-admin.js --reset-password --email <email>',
].join('\n');

const resetMode = values['reset-password'] === true;
const { email, name } = values;
function usageExit(): never {
  console.error(USAGE);
  process.exit(1);
}
if (!email || (resetMode && name !== undefined)) usageExit();

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL, { max: 1 });
try {
  if (resetMode) {
    const result = await resetAdminPassword(db, { email });
    if (!result.reset) {
      console.error(result.message);
      process.exitCode = 1;
    } else {
      // One audit line, no password and no email text.
      console.error(
        JSON.stringify({
          event: 'auth.admin_break_glass_reset',
          targetId: result.userId,
          actor: 'cli',
          at: new Date().toISOString(),
        }),
      );
      console.log(`Password reset: ${result.email}. Sessions ended and lockout cleared.`);
      console.log(
        `Temporary password (shown once, change it at next sign in): ${result.temporaryPassword}`,
      );
    }
  } else {
    if (!name) usageExit();
    const result = await createFirstAdmin(db, { email, name });
    if (!result.created) {
      console.error(result.message);
      process.exitCode = 1;
    } else {
      console.log(`Admin created: ${email}`);
      console.log(
        `Temporary password (shown once, change it at first sign in): ${result.temporaryPassword}`,
      );
    }
  }
} finally {
  await pool.end();
}
