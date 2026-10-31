import { defineConfig } from 'drizzle-kit';

// The only migration history in the repo. `generate` needs no database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
