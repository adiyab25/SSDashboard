import { existsSync } from 'node:fs';
import { z } from 'zod';

/** A value that may be left blank in .env: blank counts as unset. */
const optionalText = z
  .string()
  .transform((value) => value.trim() || undefined)
  .optional();

const EnvSchema = z
  .object({
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
    /** When the nightly sign in cleanup runs (`worker`), in the `timezone` setting. */
    AUTH_CLEANUP_CRON: z
      .string()
      .regex(/^\S+( \S+){4}$/, 'A 5 field cron expression, like "0 3 * * *"')
      .default('0 3 * * *'),
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
    /**
     * How email leaves the install (spec 0005): `none`,
     * `smtp` or `postmark`. With `none` (the default) no email is attempted anywhere, and an admin
     * hands over temporary passwords instead.
     */
    MAIL_DRIVER: z.enum(['none', 'smtp', 'postmark']).default('none'),
    /** The sender address, like "ERP <no-reply@client.com>". Required unless the driver is none. */
    MAIL_FROM: optionalText,
    SMTP_HOST: optionalText,
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    /** `starttls` upgrades a plain connection, `tls` is TLS from the start, `none` stays plain. */
    SMTP_SECURITY: z.enum(['starttls', 'tls', 'none']).default('starttls'),
    SMTP_USER: optionalText,
    SMTP_PASSWORD: optionalText,
    /** The Postmark server token. The sender must be verified in Postmark before the first send. */
    POSTMARK_SERVER_TOKEN: optionalText,
    /** The release version, set in the app image. */
    APP_VERSION: z.string().default('0.0.0-dev'),
    /** The install's name shown in the back office header. Blank counts as unset. */
    CLIENT_DISPLAY_NAME: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(80))
      .optional()
      .transform((value) => value || 'SSDashboard'),
  })
  .superRefine((env, ctx) => {
    const need = (name: string, present: boolean, why: string) => {
      if (!present) ctx.addIssue({ code: 'custom', path: [name], message: why });
    };
    if (env.MAIL_DRIVER === 'none') return;
    need(
      'MAIL_FROM',
      env.MAIL_FROM !== undefined,
      `Required when MAIL_DRIVER is ${env.MAIL_DRIVER}`,
    );
    if (env.MAIL_DRIVER === 'smtp') {
      need('SMTP_HOST', env.SMTP_HOST !== undefined, 'Required when MAIL_DRIVER is smtp');
      const both = (env.SMTP_USER === undefined) === (env.SMTP_PASSWORD === undefined);
      need('SMTP_USER', both, 'SMTP_USER and SMTP_PASSWORD are set together or not at all');
    } else {
      need(
        'POSTMARK_SERVER_TOKEN',
        env.POSTMARK_SERVER_TOKEN !== undefined,
        'Required when MAIL_DRIVER is postmark',
      );
    }
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
