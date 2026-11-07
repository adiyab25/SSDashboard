import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Hat } from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { createScratchDatabase, dropScratchDatabase, freePort, giveHats } from './support.js';

/** The password every person {@link InProcessApi.addPerson} plants signs in with. */
export const PLANTED_PASSWORD = 'Correct-Horse-1';

/** One answer of the api, its body parsed as JSON (`null` when empty). */
export interface Reply {
  status: number;
  body: unknown;
  headers: Headers;
}

/** A person planted straight in the database. */
export interface PlantedPerson {
  id: string;
  email: string;
}

/** The real `AppModule` running in this process on its own scratch database. */
export interface InProcessApi {
  app: NestExpressApplication;
  /** The api's `PUBLIC_URL`, `http://127.0.0.1:<port>`. */
  base: string;
  /** A pool on the scratch database as its owner, for planting rows and reading them back. */
  owner: DatabaseConnection;
  /**
   * Calls the api with the cookie (if any), the staff Origin, a fresh client address (so Better
   * Auth's per address limits never trip a suite) and a JSON body when one is given.
   */
  call(
    cookie: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Reply>;
  /**
   * Plants a person who has signed in before (status active), with these hats and, for the
   * partner hat, this partner account, and the {@link PLANTED_PASSWORD}.
   */
  addPerson(
    hats: readonly Hat[],
    options?: { costView?: boolean; partnerAccountId?: string; email?: string },
  ): Promise<PlantedPerson>;
  /** Signs in through Better Auth and returns the session cookie; throws when it fails. */
  signIn(email: string, password?: string): Promise<string>;
  /** Plants a party and returns its id (a consignment partner unless told otherwise). */
  addParty(
    code: string,
    options?: { consignment?: boolean; supplier?: boolean; archived?: boolean },
  ): Promise<string>;
  /** Closes the app and the pool, drops the scratch database, and restores the env. */
  close(): Promise<void>;
}

/**
 * Starts the real `AppModule` in this process on a fresh scratch database as the app role, with
 * mail off (`MAIL_DRIVER=none`, so a new person gets a temporary password), so a suite can read
 * the Nest module graph and listen to events. `configure` may override providers.
 *
 * `LICENSE_FILE` is set here too, blank (`none_configured`) unless `options.licenseFile` names
 * a file, so no suite depends on the license the root `.env` points at (the dev bootstrap
 * license, which this production mode refuses). A worker booted after the api reads the same env.
 */
export async function startInProcessApi(
  configure?: (builder: ReturnType<typeof Test.createTestingModule>) => void,
  options: { licenseFile?: string } = {},
): Promise<InProcessApi> {
  const savedEnv = { ...process.env };
  const scratch = await createScratchDatabase();
  await runMigrations(scratch.url);
  const owner = createDatabase(scratch.url, { max: 3 });
  const appUrl = new URL(scratch.url);
  appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: appUrl.toString(),
    PUBLIC_URL: base,
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    MAIL_DRIVER: 'none',
    PORT: String(port),
    LICENSE_FILE: options.licenseFile ?? '',
  });
  const builder = Test.createTestingModule({ imports: [AppModule] });
  configure?.(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app);
  await app.listen(port, '127.0.0.1');
  const hash = await hashPassword(PLANTED_PASSWORD);
  let counter = 0;

  const call: InProcessApi['call'] = async (cookie, method, path, body, headers = {}) => {
    counter += 1;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        origin: base,
        'x-forwarded-for': `198.19.${Math.floor(counter / 250) % 250}.${(counter % 250) + 1}`,
        ...(cookie && { cookie }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };

  return {
    app,
    base,
    owner,
    call,
    async addPerson(hats, options = {}) {
      counter += 1;
      const email =
        options.email ?? `person${counter}.${randomBytes(3).toString('hex')}@example.com`;
      const { rows } = await owner.pool.query<{ id: string }>(
        `INSERT INTO users (name, email, last_sign_in_at) VALUES ($1, $2, now()) RETURNING id`,
        [`Planted Person ${counter}`, email],
      );
      const id = rows[0]?.id as string;
      await owner.pool.query(
        `INSERT INTO accounts (user_id, provider_id, account_id, password)
         VALUES ($1::uuid, 'credential', $1::text, $2)`,
        [id, hash],
      );
      await giveHats(
        owner.pool,
        id,
        { hats, costView: options.costView ?? false },
        options.partnerAccountId ?? null,
      );
      return { id, email };
    },
    async signIn(email, password = PLANTED_PASSWORD) {
      const reply = await call(undefined, 'POST', '/api/auth/sign-in/email', { email, password });
      const found = reply.headers.getSetCookie().find((c) => c.includes('session_token'));
      if (!found) throw new Error(`sign in failed with ${reply.status}`);
      return found.split(';')[0] as string;
    },
    async addParty(code, options = {}) {
      const { rows } = await owner.pool.query<{ id: string }>(
        `INSERT INTO parties (code, name, is_consignment_partner, is_supplier, archived_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() END) RETURNING id`,
        [
          code,
          `Party ${code}`,
          options.consignment ?? true,
          options.supplier ?? false,
          options.archived ?? false,
        ],
      );
      return rows[0]?.id as string;
    },
    async close() {
      await app.close();
      await owner.pool.end();
      await dropScratchDatabase(scratch.name);
      process.env = savedEnv;
    },
  };
}
