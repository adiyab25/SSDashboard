import { parseArgs } from 'node:util';
import { createDatabase } from '@ssdashboard/db';
import { createFirstAdmin } from './auth/first-admin.js';
import { loadEnv } from './config/env.js';

// Entry point: `create-admin`. Makes the first admin, prints a temporary password once, and exits.
//   node dist/create-admin.js --email <email> --name <name>
// The password goes to the terminal only. Do not capture the output or send it to a log driver.
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
  },
});

if (!values.email || !values.name) {
  console.error('Usage: node dist/create-admin.js --email <email> --name <name>');
  process.exit(1);
}

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL, { max: 1 });
try {
  const result = await createFirstAdmin(db, { email: values.email, name: values.name });
  if (!result.created) {
    console.error(result.message);
    process.exitCode = 1;
  } else {
    console.log(`Admin created: ${values.email}`);
    console.log(
      `Temporary password (shown once, change it at first sign in): ${result.temporaryPassword}`,
    );
  }
} finally {
  await pool.end();
}
