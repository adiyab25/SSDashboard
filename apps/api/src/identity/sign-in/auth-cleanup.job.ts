import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import { defineQueue } from '../../platform/jobs/job-declarations.js';
import { JobRegistry } from '../../platform/jobs/job-registry.js';
import { LOCKOUT } from './sign-in-lockout.js';

/**
 * How long a cleanup run may take before pg-boss treats it as failed and lets the next one
 * start.
 */
export const AUTH_CLEANUP_EXPIRY_SECONDS = 600;

/**
 * The queue of the nightly sign in cleanup, owned by the core capability `identity.cleanup`
 * (spec 0009, *Module registry*); one run at a time.
 */
export const AUTH_CLEANUP_JOB = defineQueue({
  name: 'auth.cleanup',
  capability: 'identity.cleanup',
  options: { policy: 'singleton', expireInSeconds: AUTH_CLEANUP_EXPIRY_SECONDS },
});

/** The pg-boss queue that carries the nightly sign in cleanup job. */
export const AUTH_CLEANUP_QUEUE = AUTH_CLEANUP_JOB.name;

/** The key of its nightly schedule. */
export const AUTH_CLEANUP_SCHEDULE_KEY = 'nightly';

/** Rate limit counters older than this are of no use: Better Auth's windows are far shorter. */
const RATE_LIMIT_KEEP_MS = 24 * 60 * 60 * 1000;

/** How many rows one cleanup run removed from each table, logged after the run. */
export interface AuthCleanupCounts {
  sessions: number;
  verifications: number;
  signInAttempts: number;
  signInSlots: number;
  rateLimits: number;
}

/**
 * Deletes expired sign in rows nightly in the `worker` entry point (spec 0005, AC-22). Its queue,
 * schedule on `AUTH_CLEANUP_CRON`, and handler are declared through the platform `JobRegistry`
 * (spec 0009, AC-10); the `ModuleJobSupervisor` registers the schedule in the current `timezone`
 * setting and runs the handler behind the module gate.
 */
@Injectable()
export class AuthCleanupJob implements OnModuleInit {
  private readonly logger = new Logger('AuthCleanup');
  private readonly db: Database;

  /** Takes the env (cron), the app database connection, and the job registry. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) connection: DatabaseConnection,
    @Inject(JobRegistry) private readonly jobs: JobRegistry,
  ) {
    this.db = connection.db;
  }

  /** Declares the queue, the nightly schedule, and the handler. */
  onModuleInit(): void {
    this.jobs.declareQueue(AUTH_CLEANUP_JOB);
    this.jobs.declareSchedule({
      queue: AUTH_CLEANUP_QUEUE,
      key: AUTH_CLEANUP_SCHEDULE_KEY,
      capability: AUTH_CLEANUP_JOB.capability,
      cron: this.env.AUTH_CLEANUP_CRON,
    });
    this.jobs.declareHandler({
      queue: AUTH_CLEANUP_QUEUE,
      capability: AUTH_CLEANUP_JOB.capability,
      handle: () => this.run(),
    });
  }

  /** Cleans up once and logs how many rows went, by table. */
  async run(): Promise<AuthCleanupCounts> {
    const counts = await this.cleanup();
    this.logger.log(
      `Removed ${counts.sessions} sessions, ${counts.verifications} tokens, ` +
        `${counts.signInAttempts} sign in counters, ${counts.signInSlots} sign in slots, ` +
        `${counts.rateLimits} rate limit counters.`,
    );
    return { ...counts };
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
    // Every request gives its slot back, so normally there are none: these are from requests
    // that died, and already hold no place (AC-3).
    const signInSlots = await count(sql`
      DELETE FROM sign_in_slots
       WHERE created_at <= clock_timestamp() - make_interval(secs => ${LOCKOUT.slotSeconds}::int)`);
    const rateLimits = await count(sql`
      DELETE FROM rate_limits
       WHERE last_request < (extract(epoch FROM now()) * 1000)::bigint - ${RATE_LIMIT_KEEP_MS}::bigint`);
    return { sessions, verifications, signInAttempts, signInSlots, rateLimits };
  }
}
