import { existsSync } from 'node:fs';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  /** The application role's connection (`ssdashboard_app`), used by the api and worker. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** The owner role's connection, used only by the `migrate` entry point. */
  MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  /** Deploy only: `migrate` gives the application role a login with this password. */
  APP_DB_PASSWORD: z.string().min(1).optional(),
  /** Comma separated extension package names, loaded at startup. */
  EXTENSIONS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  /** When the nightly ledger reconciliation runs (`worker`), in the `timezone` setting. */
  LEDGER_RECONCILE_CRON: z
    .string()
    .regex(/^\S+( \S+){4}$/, 'A 5 field cron expression, like "0 2 * * *"')
    .default('0 2 * * *'),
  /**
   * The browser facing address (spec 0005): the auth base URL, the trusted origin, the
   * cookie `Secure` flag, and the links in emails. A trailing slash is dropped.
   */
  PUBLIC_URL: z
    .url({ protocol: /^https?$/ })
    .transform((value) => value.replace(/\/+$/, ''))
    .refine((value) => new URL(value).pathname === '/', 'PUBLIC_URL must not have a path'),
  /**
   * Signs sessions and encrypts two factor secrets. Rotating it signs everyone out and makes
   * every enrolled two factor secret and backup code unreadable.
   */
  BETTER_AUTH_SECRET: z.string().min(32, 'At least 32 characters'),
  /** The release version, set in the app image. */
  APP_VERSION: z.string().default('0.0.0-dev'),
  /** The install's name shown in the back office header. Blank counts as unset. */
  CLIENT_DISPLAY_NAME: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(80))
    .optional()
    .transform((value) => value || 'SSDashboard'),
});

export type Env = z.infer<typeof EnvSchema>;

// Local development reads the repo root `.env`. Installs get env vars from Compose.
const DEV_ENV_FILE = new URL('../../../../.env', import.meta.url);

/** Parses process.env once at startup and stops the process if anything required is missing. */
export function loadEnv(): Env {
  if (process.env.NODE_ENV !== 'production' && existsSync(DEV_ENV_FILE)) {
    process.loadEnvFile(DEV_ENV_FILE);
  }
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error(`Invalid environment:\n${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  return result.data;
}
