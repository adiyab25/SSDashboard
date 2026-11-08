import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { JOB_SCHEMA } from '../job-schema.js';
import type { QueueDeclaration } from './job-declarations.js';

/**
 * What the process's one pg-boss client does: `send` in the api (no workers, no schedules, no
 * maintenance, a pool of 2) and `work` in the worker (workers, cron schedules, and maintenance).
 */
export type JobBossRole = 'send' | 'work';

/** The injection token of the role, set by `JobsModule.forApi()` or `forWorker()`. */
export const JOB_BOSS_ROLE = Symbol('JOB_BOSS_ROLE');

/** How long a start waits for a database connection before it fails (security review S5). */
export const JOB_CONNECT_TIMEOUT_MS = 5_000;

/** The worker's pool: its handful of queues poll one at a time, so a few connections do. */
export const WORKER_JOB_POOL_SIZE = 5;

/** The pg-boss options of a role: the app role, the `pgboss` schema it never creates. */
export function jobBossOptions(env: Env, role: JobBossRole): ConstructorOptions {
  const shared = {
    connectionString: env.DATABASE_URL,
    schema: JOB_SCHEMA,
    // The application role cannot create schemas; the migration made this one for it.
    createSchema: false,
    connectionTimeoutMillis: JOB_CONNECT_TIMEOUT_MS,
  };
  return role === 'send'
    ? { ...shared, max: 2, supervise: false, schedule: false }
    : { ...shared, max: WORKER_JOB_POOL_SIZE };
}

/**
 * The one pg-boss client of a process (spec 0009, `JobsModule`): started once, on first use, and
 * started again by the next use after a failed start; each queue is created (idempotently) once
 * per process. Every queue of the api and the worker goes through it, so the worker opens one
 * pool for all its jobs. It never logs job data.
 */
@Injectable()
export class JobBoss implements OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private started: Promise<PgBoss> | undefined;
  private readonly queues = new Map<string, Promise<void>>();

  /** Takes the env (database URL) and the process's role. */
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JOB_BOSS_ROLE) readonly role: JobBossRole,
  ) {}

  /** The started client; throws when it cannot start (the next call tries again). */
  start(): Promise<PgBoss> {
    this.started ??= (async () => {
      const boss = new PgBoss(jobBossOptions(this.env, this.role));
      boss.on('error', (error: Error) => this.logger.error(`Job queue error: ${error.message}`));
      try {
        await boss.start();
      } catch (error) {
        // A failed start still holds a pool and timers: stop it before the next try makes another
        // (code review m3, finding 3).
        await boss.stop({ graceful: false }).catch(() => undefined);
        throw error;
      }
      return boss;
    })().catch((error: unknown) => {
      this.started = undefined;
      throw error;
    });
    return this.started;
  }

  /** Creates the queue once per process (pg-boss keeps an existing one as it is). */
  async ensureQueue(queue: QueueDeclaration): Promise<PgBoss> {
    const boss = await this.start();
    let created = this.queues.get(queue.name);
    if (!created) {
      created = boss.createQueue(queue.name, { ...queue.options }).catch((error: unknown) => {
        this.queues.delete(queue.name);
        throw error;
      });
      this.queues.set(queue.name, created);
    }
    await created;
    return boss;
  }

  /** Stops the client if it ever started, letting jobs in progress finish. */
  async onApplicationShutdown(): Promise<void> {
    const boss = await this.started?.catch(() => undefined);
    await boss?.stop({ graceful: true });
  }
}
