import { createDatabase } from '@ssdashboard/db';
import { CREATE_ADMIN_USAGE, parseCreateAdminArgs } from './auth/create-admin-args.js';
import { createFirstAdmin } from './auth/first-admin.js';
import { breakGlassReset } from './auth/reset-admin.js';
import { loadEnv } from './config/env.js';
import { pgErrorCode } from './database/pg-error.js';

// Entry point: `create-admin`. Makes the first admin, prints a temporary password once, and exits.
//   node dist/create-admin.js --email <email> --name <name>
// Break glass (mail off, every admin locked out): a new temporary password for an existing admin.
//   node dist/create-admin.js --reset-password --email <email>
// Break glass (authenticator and backup codes lost): removes an existing admin's two factor.
//   node dist/create-admin.js --reset-two-factor --email <email>
// Both reset flags together run in one transaction.
// The password goes to the terminal only. Do not capture the output or send it to a log driver.
const command = parseCreateAdminArgs(process.argv.slice(2));
if (command.kind === 'usage') {
  console.error(CREATE_ADMIN_USAGE);
  process.exit(1);
}

/** One audit line per mode on stderr, written after the commit: no email, code or password. */
function audit(event: string, targetId: string): void {
  console.error(JSON.stringify({ event, targetId, actor: 'cli', at: new Date().toISOString() }));
}

const env = loadEnv();
// Review R22: the connection checks its session tenant before it serves any query, like the api and
// worker pool, so a forged ssd.tenant_id never stamps the admin's rows. The message names tenant ids
// only (no personal data).
const { db, pool } = createDatabase(env.DATABASE_URL, {
  max: 1,
  onTenantMismatch: (error) => {
    console.error(`create-admin failed: ${error.name}: ${error.message}`);
    process.exit(1);
  },
});
try {
  switch (command.kind) {
    case 'reset': {
      const result = await breakGlassReset(
        db,
        { email: command.email },
        { password: command.password, twoFactor: command.twoFactor },
      );
      if (!result.reset) {
        console.error(result.message);
        process.exitCode = 1;
        break;
      }
      if (command.password) audit('auth.admin_break_glass_reset', result.userId);
      if (command.twoFactor) {
        audit('auth.admin_break_glass_two_factor_reset', result.userId);
        console.log(
          `Two factor reset: ${result.email}. Sign in with the password alone, then set up two factor again.`,
        );
      }
      if (command.password) {
        console.log(`Password reset: ${result.email}. Sessions ended and lockout cleared.`);
        console.log(
          `Temporary password (shown once, change it at next sign in): ${result.temporaryPassword}`,
        );
      } else {
        console.log('Sessions ended, pending two factor sign ins cancelled and lockout cleared.');
      }
      break;
    }
    case 'create': {
      const result = await createFirstAdmin(db, { email: command.email, name: command.name });
      if (!result.created) {
        console.error(result.message);
        process.exitCode = 1;
      } else {
        console.log(`Admin created: ${command.email}`);
        console.log(
          `Temporary password (shown once, change it at first sign in): ${result.temporaryPassword}`,
        );
      }
      break;
    }
  }
} catch (error) {
  // One fixed line. A Drizzle error's message holds the query params (the email, a password hash).
  console.error(`create-admin failed: ${pgErrorCode(error) ?? 'database error'}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
