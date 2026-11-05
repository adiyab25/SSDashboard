import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { JOB_SCHEMA } from '../inventory/ledger/reconcile.job.js';
import type { MailKind } from './mail-templates.js';

/** The pg-boss queue that carries one job per email to send. */
export const MAIL_QUEUE = 'mail.send';

/**
 * The job holds only these ids (spec 0005, AC-11). The worker reads the token from
 * `verifications` when it sends, so no link ever sits in the queue.
 */
export interface MailJob {
  userId: string;
  kind: MailKind;
  tokenId: string;
}

/** How many times pg-boss retries a failed send before giving up. */
export const MAIL_RETRY_LIMIT = 4;

/**
 * Five tries (the first plus `MAIL_RETRY_LIMIT` retries). The delay starts at 30 seconds, grows,
 * and is capped at 10 minutes, so the whole span stays far under the 1 hour a reset link lives.
 * A job still waiting after an hour is dropped: its link would be expired anyway. pg-boss has one
 * setting for how long finished jobs stay, so completed and failed ones are both kept a day.
 */
export const MAIL_QUEUE_OPTIONS = {
  retryLimit: MAIL_RETRY_LIMIT,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 120,
  retentionSeconds: 3_600,
  deleteAfterSeconds: 86_400,
} as const;

/** Creates the queue if it is missing. Safe to call from the api and the worker alike. */
export async function ensureMailQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(MAIL_QUEUE, { ...MAIL_QUEUE_OPTIONS });
}

/**
 * Puts mail jobs on the queue from the api. It is a send only pg-boss client with a pool of 2
 * connections: no scheduling and no maintenance, which stay with the worker. A failure to
 * enqueue is logged and swallowed, so a mail problem never fails the request that caused it.
 */
@Injectable()
export class MailProducer implements OnApplicationShutdown {
  private readonly logger = new Logger('Mail');
  private started: Promise<PgBoss> | undefined;

  /** Takes the env for the database URL the send only client connects to. */
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** True when the job is queued. */
  async enqueue(job: MailJob): Promise<boolean> {
    try {
      const boss = await this.boss();
      const id = await boss.send(MAIL_QUEUE, job);
      if (id === null) throw new Error('the queue did not accept the job');
      return true;
    } catch (error) {
      // The job data holds ids only, so it is safe to name; there is no link to leak.
      this.logger.error(`Could not queue a ${job.kind} email for ${job.userId}: ${String(error)}`);
      // A failed start is retried on the next request instead of being cached for good.
      this.started = undefined;
      return false;
    }
  }

  private boss(): Promise<PgBoss> {
    this.started ??= (async () => {
      const boss = new PgBoss({
        connectionString: this.env.DATABASE_URL,
        schema: JOB_SCHEMA,
        createSchema: false,
        max: 2,
        supervise: false,
        schedule: false,
      });
      boss.on('error', (error: Error) => this.logger.error(`Job queue error: ${error.message}`));
      await boss.start();
      await ensureMailQueue(boss);
      return boss;
    })();
    return this.started;
  }

  /** Stops the send client if it was ever started, ignoring a start that failed. */
  async onApplicationShutdown(): Promise<void> {
    const boss = await this.started?.catch(() => undefined);
    await boss?.stop({ graceful: true });
  }
}
