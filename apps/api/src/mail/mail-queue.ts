import { Inject, Injectable, Logger } from '@nestjs/common';
import { defineQueue } from '../platform/jobs/job-declarations.js';
import { JobSender } from '../platform/jobs/job-sender.js';
import type { MailKind } from './mail-templates.js';

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

/**
 * The queue of one job per email, owned by the core capability `mail.send` (spec 0009, *Module
 * registry*).
 */
export const MAIL_JOB = defineQueue({
  name: 'mail.send',
  capability: 'mail.send',
  options: { ...MAIL_QUEUE_OPTIONS },
});

/** The pg-boss queue that carries one job per email to send. */
export const MAIL_QUEUE = MAIL_JOB.name;

/**
 * Puts mail jobs on the queue from the api, through the api's one send only pg-boss client
 * (`JobSender`, a pool of 2: no scheduling and no maintenance, which stay with the worker). A
 * failure to enqueue is logged and swallowed, so a mail problem never fails the request that
 * caused it.
 */
@Injectable()
export class MailProducer {
  private readonly logger = new Logger('Mail');

  /** Takes the process's job sender. */
  constructor(@Inject(JobSender) private readonly jobs: JobSender) {}

  /** True when the job is queued. */
  async enqueue(job: MailJob): Promise<boolean> {
    try {
      const id = await this.jobs.send(MAIL_JOB, job);
      if (id === null) throw new Error('the queue did not accept the job');
      return true;
    } catch (error) {
      // The job data holds ids only, so it is safe to name; there is no link to leak.
      this.logger.error(`Could not queue a ${job.kind} email for ${job.userId}: ${String(error)}`);
      return false;
    }
  }
}
