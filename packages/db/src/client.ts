import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

/** The typed Drizzle handle over the full schema, used by every module's repositories. */
export type Database = NodePgDatabase<typeof schema>;

/** A Drizzle handle plus the pool behind it, so the owner of the connection can close it. */
export interface DatabaseConnection {
  db: Database;
  pool: pg.Pool;
}

/**
 * Thrown at api and worker start when the session's `ssd.tenant_id` (which fills every row's
 * `tenant_id`) is unset or differs from the `install` row (security review S3). A role or session
 * setting beats the database setting `migrate` stored, so without this check a forged setting
 * would stamp every new row with another tenant. The process must stop; never catch and continue.
 */
export class SessionTenantMismatch extends Error {
  readonly code = 'SessionTenantMismatch';
  /** The tenant id in the `install` row. */
  readonly installed: string | null;
  /** The tenant id the session would stamp on new rows; null when unset. */
  readonly session: string | null;

  /** Names both ids (tenant ids are not personal data), so the operator sees which one is wrong. */
  constructor(installed: string | null, session: string | null) {
    super(
      `This connection's ssd.tenant_id (${session ?? 'unset'}) does not match the install row (${installed ?? 'missing'}). Check the app role's settings (ALTER ROLE ... RESET ssd.tenant_id).`,
    );
    this.name = 'SessionTenantMismatch';
    this.installed = installed;
    this.session = session;
  }
}

/** Anything that runs one query: a pool, or one connection of it. */
type Queryable = Pick<pg.ClientBase, 'query'>;

/**
 * Checks that the tenant new rows will be stamped with is the install's tenant, and throws
 * `SessionTenantMismatch` otherwise. Given a pool it checks one of its connections; given one
 * connection, that connection. The api and worker call it at start (`DatabaseModule`), and
 * `createDatabase` runs it on every new connection when asked (`onTenantMismatch`). It only reads.
 */
export async function assertSessionTenant(target: Queryable): Promise<void> {
  const { rows } = await target.query<{ session: string | null; installed: string | null }>(
    `SELECT nullif(current_setting('ssd.tenant_id', true), '') AS session,
            (SELECT id::text FROM public.install LIMIT 1) AS installed`,
  );
  const session = rows[0]?.session?.toLowerCase() ?? null;
  const installed = rows[0]?.installed ?? null;
  if (session === null || installed === null || session !== installed) {
    throw new SessionTenantMismatch(installed, session);
  }
}

/** How `createDatabase` opens its pool. */
export interface CreateDatabaseOptions {
  /** Most connections the pool opens; 10 when unset. */
  max?: number;
  /**
   * When set, every new connection checks its session tenant (`assertSessionTenant`) before it
   * serves any query, and a mismatch calls this, then fails the query that asked for the
   * connection (security review S10). The api and worker pass a handler that stops the process,
   * so a database that was unreachable at start (when the start check could not run) is still
   * checked before any row is written. Never pass a handler that carries on.
   */
  onTenantMismatch?: (error: SessionTenantMismatch) => void;
  /**
   * TCP keepalive on every connection, so a connection the network silently dropped (a half open
   * socket) errors instead of waiting forever. Off when unset (pg's default). The api's
   * `LISTEN` connection turns it on.
   */
  keepAlive?: boolean;
  /**
   * With `keepAlive`, how long a connection may sit idle before the first keepalive probe is sent
   * (the socket's `setKeepAlive` initial delay). After that the operating system's own probe
   * interval and count decide when a dead peer is declared and the connection errors.
   */
  keepAliveInitialDelayMillis?: number;
  /** How long to wait for a new connection before failing it; no limit when unset (pg's default). */
  connectionTimeoutMillis?: number;
}

/** Opens a pooled connection for the given URL. The api and worker pass the app role URL; only migrate uses the owner URL. */
export function createDatabase(
  connectionString: string,
  options: CreateDatabaseOptions = {},
): DatabaseConnection {
  const { onTenantMismatch } = options;
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    ...(options.keepAlive !== undefined && { keepAlive: options.keepAlive }),
    ...(options.keepAliveInitialDelayMillis !== undefined && {
      keepAliveInitialDelayMillis: options.keepAliveInitialDelayMillis,
    }),
    ...(options.connectionTimeoutMillis !== undefined && {
      connectionTimeoutMillis: options.connectionTimeoutMillis,
    }),
    // pg-pool awaits this hook and only hands the connection out once it resolves; a rejection
    // ends the connection and fails the waiting query with the same error (pg-pool 3.14
    // `newClient`; @types/pg types the hook as returning void, hence the rule exception).
    ...(onTenantMismatch && {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      onConnect: async (client: pg.ClientBase) => {
        try {
          await assertSessionTenant(client);
        } catch (error) {
          if (error instanceof SessionTenantMismatch) onTenantMismatch(error);
          throw error;
        }
      },
    }),
  });
  // An idle client loses its connection when PostgreSQL restarts or goes away. The pool already
  // discards that client; without a listener the 'error' event would crash the process.
  pool.on('error', (error) => {
    console.error(`Idle database client error: ${error.message}`);
  });
  return { db: drizzle(pool, { schema }), pool };
}
