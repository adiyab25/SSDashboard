import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { PgBoss } from 'pg-boss';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import { JOB_SCHEMA } from '../../inventory/ledger/reconcile.job.js';
import { SettingsService } from '../../platform/settings.service.js';
import { LOCKOUT } from './sign-in-lockout.js';

/** The pg-boss queue that carries the nightly sign in cleanup job. */
export const AUTH_CLEANUP_QUEUE = 'auth.cleanup';
/**
 * How long a cleanup run may take before pg-boss treats it as failed and lets the next one
 * start.
 */
export const AUTH_CLEANUP_EXPIRY_SECONDS = 600;

/** Rate limit counters older than this are of no use: Better Auth's windows are far shorter. */
const RATE_LIMIT_KEEP_MS = 24 * 60 * 60 * 1000;

/** How many rows one cleanup run removed from each table, logged after the run. */
export interface AuthCleanupCounts {
  sessions: number;
  verifications: number;
  signInAttempts: number;
  rateLimits: number;
}

/** Deletes expired sign in rows nightly in the `worker` entry point (spec 0005, AC-22). */
@Injectable()
export class AuthCleanupJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AuthCleanup');
  private readonly db: Database;
  private boss: PgBoss | undefined;

  /**
   * Takes the env (database URL and cron), the app database connection and the settings service
   * for the timezone.
   */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {
    this.db = connection.db;
  }

  /**
   * Starts the job queue, registers the nightly schedule in the install's timezone, and starts
   * the handler. Runs only in the `worker` entry point.
   */
  async onApplicationBootstrap(): Promise<void> {
    const boss = new PgBoss({
      connectionString: this.env.DATABASE_URL,
      schema: JOB_SCHEMA,
      createSchema: false,
      // One short run a night; the default pool of 10 would be wasted connections.
      max: 2,
    });
    boss.on('error', (error: Error) => this.logger.error(`Job queue error: ${error.message}`));
    await boss.start();
    this.boss = boss;
    await boss.createQueue(AUTH_CLEANUP_QUEUE, {
      policy: 'singleton',
      expireInSeconds: AUTH_CLEANUP_EXPIRY_SECONDS,
    });
    // Read once at startup: a change to the timezone setting applies after a worker restart.
    const { timezone } = await this.settings.read(['timezone']);
    await boss.schedule(AUTH_CLEANUP_QUEUE, this.env.AUTH_CLEANUP_CRON, null, { tz: timezone });
    await boss.work(AUTH_CLEANUP_QUEUE, async () => {
      const counts = await this.cleanup();
      this.logger.log(
        `Removed ${counts.sessions} sessions, ${counts.verifications} tokens, ` +
          `${counts.signInAttempts} sign in counters, ${counts.rateLimits} rate limit counters.`,
      );
      return { ...counts };
    });
  }

  /** Deletes what has expired and keeps everything still live. Safe to run at any time. */
  async cleanup(): Promise<AuthCleanupCounts> {
    const count = async (statement: ReturnType<typeof sql>): Promise<number> =>
      (await this.db.execute(statement)).rowCount ?? 0;

    const sessions = await count(sql`DELETE FROM sessions WHERE expires_at <= now()`);
    const verifications = await count(sql`DELETE FROM verifications WHERE expires_at <= now()`);
    // A counter matters while its window is running or a lock is still in force.
    const signInAttempts = await count(sql`
      DELETE FROM sign_in_attempts
       WHERE (locked_until IS NULL OR locked_until <= now())
         AND window_started_at + make_interval(mins => ${LOCKOUT.windowMinutes}::int) <= now()`);
    const rateLimits = await count(sql`
      DELETE FROM rate_limits
       WHERE last_request < (extract(epoch FROM now()) * 1000)::bigint - ${RATE_LIMIT_KEEP_MS}::bigint`);
    return { sessions, verifications, signInAttempts, rateLimits };
  }

  /**
   * Stops the queue after letting a run in progress finish, so a deploy never cuts a delete in
   * half.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
