import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabase, type DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * The Nest injection token for the app database connection (the restricted `ssdashboard_app`
 * role).
 */
export const DATABASE = Symbol('DATABASE');

/** Global module that opens the app role's connection pool and closes it on shutdown. */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: Env): DatabaseConnection => createDatabase(env.DATABASE_URL),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  /** Takes the connection so shutdown can close its pool. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Ends the pool, waiting for queries in flight, so the process exits cleanly. */
  async onApplicationShutdown(): Promise<void> {
    await this.connection.pool.end();
  }
}
