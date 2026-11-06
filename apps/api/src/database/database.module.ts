import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  assertSessionTenant,
  createDatabase,
  SessionTenantMismatch,
  type DatabaseConnection,
} from '@ssdashboard/db';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * The Nest injection token for the app database connection (the restricted `ssdashboard_app`
 * role).
 */
export const DATABASE = Symbol('DATABASE');

/**
 * What the api and worker do when a new database connection would stamp another tenant than the
 * `install` row (security review S10): log it and stop the process with exit code 1. The pool
 * calls it before that connection serves any query, so it also covers a database that was
 * unreachable at start, when the start check could only log. Never make it carry on.
 */
export function stopOnTenantMismatch(error: SessionTenantMismatch): never {
  new Logger('DatabaseModule').error(`${error.name}: ${error.message}`);
  process.exit(1);
}

/**
 * Global module that opens the app role's connection pool, refuses to start when the pool's
 * sessions would stamp another tenant than the install row (`SessionTenantMismatch`, security
 * review S3), checks every later new connection the same way and stops the process on a mismatch
 * (S10), and closes the pool on shutdown. The api and the worker both import it.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: Env): DatabaseConnection =>
        createDatabase(env.DATABASE_URL, { onTenantMismatch: stopOnTenantMismatch }),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationBootstrap, OnApplicationShutdown {
  /** Takes the connection so shutdown can close its pool. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  private readonly logger = new Logger(DatabaseModule.name);

  /**
   * Checks the session tenant once, before the api listens or the worker takes a job, and lets
   * `SessionTenantMismatch` stop the process. A database that cannot be reached at start is not a
   * mismatch: the api still starts and reports itself degraded (the health check), so that error
   * is logged, never thrown; the pool then checks each connection it opens once the database is
   * back (`stopOnTenantMismatch`), before any query runs on it. It must never swallow
   * `SessionTenantMismatch`.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await assertSessionTenant(this.connection.pool);
    } catch (error) {
      if (error instanceof SessionTenantMismatch) throw error;
      this.logger.warn(
        `Could not check the session tenant at start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Ends the pool, waiting for queries in flight, so the process exits cleanly. */
  async onApplicationShutdown(): Promise<void> {
    await this.connection.pool.end();
  }
}
