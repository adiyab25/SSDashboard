import { existsSync } from 'node:fs';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
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
  /** The release version, set in the app image. */
  APP_VERSION: z.string().default('0.0.0-dev'),
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
