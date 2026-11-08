import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { z } from 'zod';

const CRON_NAMES = {
  month: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  weekday: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
};
const CRON_FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: CRON_NAMES.month, offset: 1 },
  { min: 0, max: 7, names: CRON_NAMES.weekday, offset: 0 },
];

/**
 * True for a standard 5 field cron expression: each field is a list of `*`, a value or an
 * `a-b` range, with an optional `/step`, inside the field's range. Checked here so a typo is a
 * clean "Invalid environment" message, not a crash inside the scheduler at startup.
 */
function isCron(expression: string): boolean {
  const fields = expression.split(' ');
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const { min, max, names, offset = 0 } = CRON_FIELDS[index] ?? { min: 0, max: 0 };
    const value = (text: string): number | undefined => {
      if (/^\d+$/.test(text)) return Number(text);
      const named = names?.indexOf(text.toLowerCase()) ?? -1;
      return named >= 0 ? named + offset : undefined;
    };
    return field.split(',').every((item) => {
      const match = /^(\*|\w+(?:-\w+)?)(?:\/(\d+))?$/.exec(item);
      if (!match) return false;
      const [, range = '', step] = match;
      if (step !== undefined && Number(step) < 1) return false;
      if (range === '*') return true;
      const bounds = range.split('-').map(value);
      const inRange = (n: number | undefined): n is number =>
        n !== undefined && n >= min && n <= max;
      const [from, to] = bounds;
      if (!inRange(from)) return false;
      return bounds.length === 1 || (inRange(to) && to >= from);
    });
  });
}

const cron = (example: string) =>
  z
    .string()
    .regex(/^\S+( \S+){4}$/, `A 5 field cron expression, like "${example}"`)
    .refine(isCron, `Not a valid 5 field cron expression, like "${example}"`)
    .default(example);

/** A value that may be left blank in .env: blank counts as unset. */
const optionalText = z
  .string()
  .transform((value) => value.trim() || undefined)
  .optional();

/** Compose passes an unset variable as an empty string; treat blank as unset so the default applies. */
const blankIsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );

/**
 * The host name a browser scopes cookies by: lowercased, no port, no trailing dot, so
 * `https://ERP.example.com.:8443` and `http://erp.example.com` are the same cookie host.
 */
const cookieHostname = (url: string): string =>
  new URL(url).hostname.toLowerCase().replace(/\.+$/, '');

/**
 * The 32 bytes of a connector secret key (spec 0015, AC-2), or undefined when the text is not one.
 * Two spellings are accepted: base64 (standard or url safe, padding optional) of exactly 32 bytes,
 * what `pnpm bootstrap` writes, and 64 hex characters, what `deploy/bootstrap.sh` writes for every
 * install secret. The two never overlap: 32 bytes are 43 or 44 base64 characters. Never logs or
 * echoes the text; `connection-secrets.ts` is the only other reader.
 */
export function connectorKeyBytes(text: string): Buffer | undefined {
  const value = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return undefined;
  const bytes = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  return bytes.length === 32 ? bytes : undefined;
}

/** A connector secret key: optional and blank as unset here; the cross field rules require it. */
const connectorKey = blankIsUnset(
  z
    .string()
    .refine(
      (value) => connectorKeyBytes(value) !== undefined,
      '32 random bytes, base64 (openssl rand -base64 32) or 64 hex characters',
    )
    .optional(),
);

/**
 * Every variable any entry point reads, without the cross field rules. The api and worker parse
 * all of it (`EnvSchema`); `migrate` picks its own few (`MigrateEnvSchema`), so each field is
 * defined once.
 */
const EnvFields = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  /** The application role's connection (`ssdashboard_app`), used by the api and worker. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** The owner role's connection, used only by the `migrate` entry point. */
  MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  /** Deploy only: `migrate` gives the application role a login with this password. */
  APP_DB_PASSWORD: z.string().min(1).optional(),
  /**
   * Read by `migrate` only, and only on a database's first run (spec 0002, A2): the tenant id
   * every row is stamped with. Unset, `migrate` generates one. Later runs refuse to start if it
   * differs from the install row.
   */
  TENANT_ID: blankIsUnset(z.uuid().optional()),
  /**
   * Read by `migrate` only: the application role's name. Roles are global to a PostgreSQL
   * server, so each client gets its own (`ssd_<client>_app`). Unset: `ssdashboard_app` (`APP_ROLE` in `@ssdashboard/db`). A plain identifier, so it is safe to quote.
   */
  APP_DB_ROLE: blankIsUnset(
    z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/, 'A lowercase identifier of letters, digits, and underscores')
      .optional(),
  ),
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
  LEDGER_RECONCILE_CRON: cron('0 2 * * *'),
  /** When the nightly sign in cleanup runs (`worker`), in the `timezone` setting. */
  AUTH_CLEANUP_CRON: cron('0 3 * * *'),
  /**
   * The signed license file inside the container (spec 0009, AC-14), read by the api and the
   * worker at start and by the worker's daily check. Optional: unset or blank, every check
   * records `none_configured` and only licenses already recorded (or uploaded) count.
   */
  LICENSE_FILE: blankIsUnset(z.string().min(1).optional()),
  /** When the worker's daily license check runs, in the `timezone` setting (spec 0009). */
  LICENSE_CHECK_CRON: cron('20 0 * * *'),
  /**
   * The browser facing address (spec 0005): the auth base URL, the trusted origin, the
   * cookie `Secure` flag, and the links in emails. A trailing slash is dropped.
   */
  PUBLIC_URL: z
    .url({ protocol: /^https?$/ })
    .transform((value) => value.replace(/\/+$/, ''))
    .refine((value) => new URL(value).pathname === '/', 'PUBLIC_URL must not have a path'),
  /**
   * The path prefix of the staff surface when it shares a host with the portal (spec 0005,
   * AC-31): every staff cookie gets `Path=<STAFF_BASE_PATH>`, and email links are
   * `PUBLIC_URL` + this + the route. Blank or unset means the staff surface is the whole host
   * (`Path=/`). Read by the api (cookies) and the worker (email links).
   */
  STAFF_BASE_PATH: blankIsUnset(
    z
      .string()
      .refine((value) => value.startsWith('/'), 'STAFF_BASE_PATH must start with /')
      .refine((value) => !value.endsWith('/'), 'STAFF_BASE_PATH must not end with /')
      .refine((value) => !value.includes('..'), 'STAFF_BASE_PATH must not contain ..')
      .refine(
        (value) => /^[A-Za-z0-9/._~-]*$/.test(value),
        'STAFF_BASE_PATH may hold only letters, digits, and / . _ ~ -',
      )
      // `//evil.example` would be a protocol relative redirect once the web prefixes links
      // with it, and `/./ops` or `//ops` give a cookie path the browser never matches.
      .refine(
        (value) => /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/.test(value),
        'STAFF_BASE_PATH segments must not be empty or start with a dot',
      )
      .optional(),
  ).transform((value) => value ?? ''),
  /**
   * The public portal's origin (spec 0005, AC-30), when the install has one. Read by the api
   * only: every `/api/auth/*` request that carries this host answers 404, so Better Auth is
   * reachable on the staff host alone. Never a trusted origin. A trailing slash is dropped.
   */
  PORTAL_ORIGIN: blankIsUnset(
    z
      .url({ protocol: /^https?$/ })
      .transform((value) => value.replace(/\/+$/, ''))
      .refine((value) => new URL(value).pathname === '/', 'PORTAL_ORIGIN must not have a path')
      .optional(),
  ),
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
  /** The sender address, like `ERP <no-reply@client.com>`. Required unless the driver is none. */
  MAIL_FROM: optionalText,
  SMTP_HOST: optionalText,
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  /** `starttls` upgrades a plain connection, `tls` is TLS from the start, `none` stays plain. */
  SMTP_SECURITY: z.enum(['starttls', 'tls', 'none']).default('starttls'),
  SMTP_USER: optionalText,
  SMTP_PASSWORD: optionalText,
  /** The Postmark server token. The sender must be verified in Postmark before the first send. */
  POSTMARK_SERVER_TOKEN: optionalText,
  /**
   * Seals each connection's Shopify credentials with AES-256-GCM (spec 0015, AC-2): 32 random
   * bytes, base64 or hex (`connectorKeyBytes`). Read by the api and the worker through
   * `ConnectionSecrets` only. Required when `NODE_ENV` is `production`; elsewhere it may be unset,
   * and sealing or opening then throws `ConnectorSecretKeyMissing`. Losing it makes every stored
   * credential unreadable (the owner types the keys again); rotate it with
   * `CONNECTOR_SECRET_KEY_PREVIOUS` (the re-encrypt job that moves connections to the new key is
   * not built yet, spec 0015 task 12).
   */
  CONNECTOR_SECRET_KEY: connectorKey,
  /**
   * Optional, only during a rotation: the key `CONNECTOR_SECRET_KEY` replaced. Credentials sealed
   * under it still open. The re-encrypt job that moves them to the current key is not built yet
   * (spec 0015 task 12; `ConnectionSecrets.reencrypt` exists), so keep this set, and never clear it
   * while any connection is sealed under the old key: those credentials would become unreadable.
   * Must differ from `CONNECTOR_SECRET_KEY`.
   */
  CONNECTOR_SECRET_KEY_PREVIOUS: connectorKey,
  /**
   * Development and test only (spec 0015, AC-26): the origin of the Shopify fixture replay server,
   * which the Shopify client calls instead of `https://<shop>`. Refused when `NODE_ENV` is
   * `production`. A trailing slash is dropped.
   */
  SHOPIFY_MOCK_ORIGIN: blankIsUnset(
    z
      .url({ protocol: /^https?$/ })
      .transform((value) => value.replace(/\/+$/, ''))
      .refine(
        (value) => new URL(value).pathname === '/',
        'SHOPIFY_MOCK_ORIGIN must not have a path',
      )
      .optional(),
  ),
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

const EnvSchema = EnvFields.superRefine((env, ctx) => {
  const need = (name: string, present: boolean, why: string) => {
    if (!present) ctx.addIssue({ code: 'custom', path: [name], message: why });
  };
  // The portal host answers 404 on every auth route, so on the staff host it would lock
  // everyone out (spec 0005, AC-30). Compared by host name: cookies ignore the port, so a
  // portal on the staff name and another port would receive the staff cookie.
  need(
    'PORTAL_ORIGIN',
    env.PORTAL_ORIGIN === undefined ||
      !URL.canParse(env.PORTAL_ORIGIN) ||
      !URL.canParse(env.PUBLIC_URL) ||
      cookieHostname(env.PORTAL_ORIGIN) !== cookieHostname(env.PUBLIC_URL),
    'PORTAL_ORIGIN must be a different host name from PUBLIC_URL',
  );
  // Spec 0015 AC-2: an install never runs without its credentials key; development and test may.
  need(
    'CONNECTOR_SECRET_KEY',
    env.NODE_ENV !== 'production' || env.CONNECTOR_SECRET_KEY !== undefined,
    'Required when NODE_ENV is production',
  );
  need(
    'CONNECTOR_SECRET_KEY_PREVIOUS',
    env.CONNECTOR_SECRET_KEY_PREVIOUS === undefined || env.CONNECTOR_SECRET_KEY !== undefined,
    'Set only together with CONNECTOR_SECRET_KEY',
  );
  need(
    'CONNECTOR_SECRET_KEY_PREVIOUS',
    env.CONNECTOR_SECRET_KEY_PREVIOUS === undefined ||
      env.CONNECTOR_SECRET_KEY === undefined ||
      !connectorKeyBytes(env.CONNECTOR_SECRET_KEY_PREVIOUS)?.equals(
        connectorKeyBytes(env.CONNECTOR_SECRET_KEY) ?? Buffer.alloc(0),
      ),
    'Must differ from CONNECTOR_SECRET_KEY',
  );
  // Spec 0015 AC-26: the replay server never stands in for Shopify on an install.
  need(
    'SHOPIFY_MOCK_ORIGIN',
    env.NODE_ENV !== 'production' || env.SHOPIFY_MOCK_ORIGIN === undefined,
    'Refused when NODE_ENV is production',
  );
  if (env.MAIL_DRIVER === 'none') return;
  need('MAIL_FROM', env.MAIL_FROM !== undefined, `Required when MAIL_DRIVER is ${env.MAIL_DRIVER}`);
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

/**
 * The validated env every provider receives through `ENV`. Derived from `EnvSchema`, so a new
 * variable is typed the moment it is added there.
 */
export type Env = z.infer<typeof EnvSchema>;

/**
 * The one staff origin (spec 0005, AC-30): `PUBLIC_URL` today, `STAFF_ORIGIN` once spec 0007's
 * rename lands. It is the Better Auth base URL, the only trusted origin, the Origin check, the
 * `Secure` flag and the start of every email link, so all of them read it here and a rename
 * changes one line. Never build it from a request header, and never put `PORTAL_ORIGIN` here.
 */
export function staffOrigin(env: Pick<Env, 'PUBLIC_URL'>): string {
  return new URL(env.PUBLIC_URL).origin;
}

/**
 * The staff origin plus `STAFF_BASE_PATH` (spec 0005, AC-31), with no trailing slash: the base
 * every email link appends its route to (`https://erp.example.com/ops`). Never add the route's
 * own leading part here, and never read it from the request.
 */
export function staffBase(env: Pick<Env, 'PUBLIC_URL' | 'STAFF_BASE_PATH'>): string {
  return `${staffOrigin(env)}${env.STAFF_BASE_PATH}`;
}

/**
 * The only variables the `migrate` entry point reads (spec 0002): the owner connection, the
 * application role's name and password, and the first run tenant id. It never gets `PUBLIC_URL`,
 * `BETTER_AUTH_SECRET` or the mail settings, so it must not validate them either: Compose passes
 * `migrate` its own short list (`deploy/compose.yaml`, checked by `test/compose-env.spec.ts`).
 */
const MigrateEnvSchema = EnvFields.pick({
  NODE_ENV: true,
  MIGRATION_DATABASE_URL: true,
  APP_DB_PASSWORD: true,
  TENANT_ID: true,
  APP_DB_ROLE: true,
}).extend({
  // Required here: the same rule as the shared optional field, without the `.optional()`.
  MIGRATION_DATABASE_URL: EnvFields.shape.MIGRATION_DATABASE_URL.unwrap(),
});

/**
 * The validated env of the `migrate` entry point. Derived from the same field definitions as
 * `Env`, so the two can never disagree on a variable's rules.
 */
export type MigrateEnv = z.infer<typeof MigrateEnvSchema>;

// Local development reads the repo root `.env`. Installs get env vars from Compose.
const DEV_ENV_FILE = new URL('../../../../.env', import.meta.url);

/** Loads the dev `.env` outside production, then parses process.env or stops the process. */
function parseOrExit<T extends z.ZodType>(schema: T): z.output<T> {
  if (process.env.NODE_ENV !== 'production' && existsSync(DEV_ENV_FILE)) {
    process.loadEnvFile(DEV_ENV_FILE);
  }
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error(`Invalid environment:
${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  return result.data;
}

/**
 * Parses process.env once at startup for the api, the worker and `create-admin`, and stops the
 * process if anything required is missing. Never call it from `migrate`, which does not receive
 * the auth and mail settings: use `loadMigrateEnv`.
 */
export function loadEnv(): Env {
  return parseOrExit(EnvSchema);
}

/**
 * Parses only the variables `migrate` reads, once at startup, and stops the process with
 * `Invalid environment` if `MIGRATION_DATABASE_URL` is missing or a value is malformed. Never
 * widen it to the api's settings: the `migrate` container must not need app secrets to run.
 */
export function loadMigrateEnv(): MigrateEnv {
  return parseOrExit(MigrateEnvSchema);
}
