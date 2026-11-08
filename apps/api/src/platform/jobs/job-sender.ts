import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@ssdashboard/db';
import { fromDrizzle, type SendOptions } from 'pg-boss';
import type { Transaction } from '../../database/sql.js';
import { stampJobData, type QueueDeclaration } from './job-declarations.js';
import { JobBoss } from './job-boss.js';

/**
 * Puts jobs on declared queues, in the api and the worker alike (spec 0009, AC-10): every job's
 * data is stamped with its capability (the queue owner's unless `capability` names another on a
 * shared queue) and its step when one gates it, so the supervisor can cancel exactly a stopped
 * capability's jobs. `sendIn` sends inside the caller's transaction (pg-boss `fromDrizzle`), so the
 * job exists if and only if the caller's change commits. It never logs job data.
 */
@Injectable()
export class JobSender {
  /** Takes the process's one pg-boss client. */
  constructor(@Inject(JobBoss) private readonly jobs: JobBoss) {}

  /** Starts the client and creates the queue, so a later send in a transaction waits for neither. */
  async prepare(queue: QueueDeclaration): Promise<void> {
    await this.jobs.ensureQueue(queue);
  }

  /**
   * Sends one job; resolves to its id, or null when the queue policy refused it (a `short` queue
   * already holding one). Throws when the queue cannot take it.
   */
  async send(
    queue: QueueDeclaration,
    data: object,
    options: SendOptions & { capability?: string; step?: string } = {},
  ): Promise<string | null> {
    const { capability = queue.capability, step, ...send } = options;
    const boss = await this.jobs.ensureQueue(queue);
    return boss.send(queue.name, stampJobData(data, capability, step), send);
  }

  /** `send` through the caller's transaction (`fromDrizzle`). */
  async sendIn(
    tx: Transaction,
    queue: QueueDeclaration,
    data: object,
    options: SendOptions & { capability?: string; step?: string } = {},
  ): Promise<string | null> {
    return this.send(queue, data, { ...options, db: fromDrizzle(tx, sql) });
  }
}
