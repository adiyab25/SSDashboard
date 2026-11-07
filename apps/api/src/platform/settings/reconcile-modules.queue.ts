import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from '@ssdashboard/db';
import { fromDrizzle, PgBoss } from 'pg-boss';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { Transaction } from '../../database/sql.js';
import { JOB_SCHEMA } from '../job-schema.js';

/**
 * The queue of the job that brings module jobs and schedules in line with the settings (spec
 * 0009, AC-3, AC-12). Every settings write enqueues one in its own transaction. Until milestone 3
 * builds the module job supervisor, its handler does nothing.
 */
export const RECONCILE_MODULES_QUEUE = 'platform.reconcile_modules';

/**
 * `short`: at most one job waits, so a burst of changes queues one reconcile, not one per change
 * (a second send while one waits is refused by pg-boss and returns null, which is fine).
 */
export const RECONCILE_MODULES_QUEUE_OPTIONS = { policy: 'short', retryLimit: 2 } as const;

/** How long the producer waits for a database connection before giving up a start. */
export const PRODUCER_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Puts the reconcile job on the queue from the api, inside the caller's transaction, through
 * pg-boss's Drizzle adapter (`fromDrizzle`): the job exists if and only if the settings change
 * commits. A send only client with a pool of 2: no scheduling and no maintenance, which stay with
 * the worker. It starts at bootstrap, with a 5 second connect timeout, so the first write never
 * starts pg-boss while it holds a settings row lock (security review S5); a start that fails is
 * logged and tried again by the next write. Unlike the mail producer it never swallows an
 * enqueue error: a failed enqueue rolls the change back.
 */
@Injectable()
export class ReconcileModulesProducer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ReconcileModules');
  private started: Promise<PgBoss> | undefined;

  /** Takes the env for the database URL the send only client connects to. */
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Starts the send client before the first request; a failure is only logged. */
  async onApplicationBootstrap(): Promise<void> {
    await this.boss().catch((error: unknown) =>
      this.logger.warn(
        `Could not start the reconcile queue client: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /** Enqueues one reconcile job through `tx`; throws when the queue cannot take it. */
  async enqueueIn(tx: Transaction): Promise<void> {
    const boss = await this.boss();
    await boss.send(RECONCILE_MODULES_QUEUE, {}, { db: fromDrizzle(tx, sql) });
  }

  private boss(): Promise<PgBoss> {
    this.started ??= (async () => {
      const boss = new PgBoss({
        connectionString: this.env.DATABASE_URL,
        schema: JOB_SCHEMA,
        createSchema: false,
        max: 2,
        connectionTimeoutMillis: PRODUCER_CONNECT_TIMEOUT_MS,
        supervise: false,
        schedule: false,
      });
      boss.on('error', (error: Error) => this.logger.error(`Job queue error: ${error.message}`));
      await boss.start();
      await boss.createQueue(RECONCILE_MODULES_QUEUE, { ...RECONCILE_MODULES_QUEUE_OPTIONS });
      return boss;
    })().catch((error: unknown) => {
      // A failed start is retried on the next write instead of being cached for good.
      this.started = undefined;
      throw error;
    });
    return this.started;
  }

  /** Stops the send client if it was ever started, ignoring a start that failed. */
  async onApplicationShutdown(): Promise<void> {
    const boss = await this.started?.catch(() => undefined);
    await boss?.stop({ graceful: true });
  }
}

/**
 * Works the reconcile queue in the `worker` entry point. A no op for now (spec 0009 milestone 1):
 * milestone 3 replaces the handler with the module job supervisor's reconcile.
 */
@Injectable()
export class ReconcileModulesWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ReconcileModules');
  private boss: PgBoss | undefined;

  /** Takes the env for the database URL. */
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Starts the queue and its handler. */
  async onApplicationBootstrap(): Promise<void> {
    const boss = new PgBoss({
      connectionString: this.env.DATABASE_URL,
      schema: JOB_SCHEMA,
      createSchema: false,
      max: 2,
      supervise: false,
      schedule: false,
    });
    boss.on('error', (error: Error) =>
      this.logger.error(`Job queue error: ${error.message}`, error.stack),
    );
    await boss.start();
    this.boss = boss;
    await boss.createQueue(RECONCILE_MODULES_QUEUE, { ...RECONCILE_MODULES_QUEUE_OPTIONS });
    await boss.work(RECONCILE_MODULES_QUEUE, () => Promise.resolve({ reconciled: 'nothing_yet' }));
  }

  /** Stops the queue after letting a run in progress finish. */
  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
