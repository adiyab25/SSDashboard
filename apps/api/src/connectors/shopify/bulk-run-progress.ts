import { Inject, Injectable, Logger } from '@nestjs/common';
import { type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import type { Transaction } from '../../database/sql.js';
import { JobSender } from '../../platform/jobs/job-sender.js';
import { SyncRuns, type RunPosition, type SyncRunRow } from '../sync-runs/sync-runs.js';
import { BulkResultUnreadable } from './bulk-jsonl.js';
import type { BulkStep } from './bulk-runner.js';
import { ConnectorBudget } from './connector-budget.js';
import {
  BACKFILL_JOB_PRIORITY,
  connectionGroup,
  CONNECTOR_SHOPIFY_QUEUE,
  CONNECTOR_SHOPIFY_RETRY,
  type ShopifyJobData,
} from './connector-shopify.queue.js';
import { ShopifyRejectedError, ShopifyTransientError } from './shopify-client.js';

/** The job kinds that drive a bulk run step by step. */
export type BulkJobKind = 'gateway_scan' | 'backfill';

/** How one bulk run job ended: codes and counts only, the job's output. */
export interface BulkJobOutcome {
  readonly skipped?: string;
  readonly step?: BulkStep['kind'] | 'paged';
  readonly status?: 'running' | 'partial' | 'succeeded' | 'failed';
  readonly code?: string | null;
}

/**
 * Moves a gateway scan or backfill run after one chunk (spec 0015 task 12, AC-17, AC-25): `wait`
 * records the bulk operation and sends the next job after the poll wait (30 seconds,
 * `ConnectorBudget`); `more` records the line reached, turns the run `partial`, and sends the next
 * job at once; `refused` and `failed` finish the run `failed` with a code. Every next job carries
 * the run and the step it expects, sent in the transaction that records the position, so a crash
 * between the two leaves neither. It also turns the errors of a chunk into the run's end:
 * `BULK_RESULT_UNREADABLE`, a Shopify refusal's code, and a transient error's code on the queue's
 * last retry (earlier ones are thrown, so pg-boss retries the same step).
 */
@Injectable()
export class BulkRunProgress {
  private readonly logger = new Logger('ShopifyBulkRun');

  /** Takes the database, the runs, the job sender, and the budget. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(SyncRuns) private readonly runs: SyncRuns,
    @Inject(JobSender) private readonly jobs: JobSender,
    @Inject(ConnectorBudget) private readonly budget: ConnectorBudget,
  ) {}

  /** Records a `wait`, `more`, `refused`, or `failed` step (see the class); `done` is the caller's. */
  async advance(
    jobKind: BulkJobKind,
    run: SyncRunRow,
    position: RunPosition,
    step: Exclude<BulkStep, { kind: 'done' }>,
    counts: Record<string, unknown>,
    cost: number,
  ): Promise<BulkJobOutcome> {
    switch (step.kind) {
      case 'wait':
      case 'more': {
        const next: RunPosition = {
          ...position,
          step: position.step + 1,
          bulkId: step.position.bulkId,
          line: step.position.line,
        };
        const status = step.kind === 'more' ? 'partial' : 'running';
        await this.next(jobKind, run, next, counts, cost, status, step.kind === 'wait');
        return { step: step.kind, status };
      }
      case 'refused':
        await this.runs.finish(this.connection.db, run.id, {
          status: 'failed',
          counts: { ...counts, refusedCodes: [...step.codes] },
          cost,
          errorCode: 'BULK_QUERY_REFUSED',
        });
        return { step: 'refused', status: 'failed', code: 'BULK_QUERY_REFUSED' };
      case 'failed':
        await this.runs.finish(this.connection.db, run.id, {
          status: 'failed',
          counts,
          cost,
          errorCode: step.code,
        });
        return { step: 'failed', status: 'failed', code: step.code };
    }
  }

  /**
   * Records a position and sends the run's next job in one transaction (`afterPoll`: after the
   * poll wait). `tx` lets a caller add its own writes to the same transaction.
   */
  async next(
    jobKind: BulkJobKind,
    run: SyncRunRow,
    position: RunPosition,
    counts: Record<string, unknown>,
    cost: number,
    status: 'running' | 'partial',
    afterPoll: boolean,
    tx?: Transaction,
  ): Promise<void> {
    const work = async (t: Transaction) => {
      await this.runs.progress(t, run.id, { position, counts, cost, status });
      await this.send(t, jobKind, run.connectionId, run.id, position.step, afterPoll);
    };
    await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    if (tx) await work(tx);
    else await this.connection.db.transaction(work);
  }

  /** Sends one step job of a run through the caller's transaction. */
  async send(
    tx: Transaction,
    jobKind: BulkJobKind,
    connectionId: string,
    runId: string,
    step: number,
    afterPoll: boolean,
  ): Promise<void> {
    const data: ShopifyJobData = { kind: jobKind, connectionId, runId, step };
    await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
      ...connectionGroup(connectionId),
      priority: BACKFILL_JOB_PRIORITY,
      ...(afterPoll && { startAfter: this.budget.bulkPollSeconds }),
    });
  }

  /**
   * Ends a run on a chunk's error, or throws it for pg-boss to retry (see the class). `retryCount`
   * is the pg-boss attempt.
   */
  async failed(
    run: SyncRunRow,
    error: unknown,
    counts: Record<string, unknown>,
    cost: number,
    retryCount: number,
  ): Promise<BulkJobOutcome> {
    let code: string | null = null;
    if (error instanceof BulkResultUnreadable) code = 'BULK_RESULT_UNREADABLE';
    else if (error instanceof ShopifyRejectedError) code = error.code;
    else if (
      error instanceof ShopifyTransientError &&
      retryCount >= CONNECTOR_SHOPIFY_RETRY.retryLimit
    ) {
      code = error.code;
    }
    if (code === null) throw error;
    await this.runs.finish(this.connection.db, run.id, {
      status: 'failed',
      counts,
      cost,
      errorCode: code,
    });
    this.logger.warn(
      `bulk run=${run.id} kind=${run.kind} connection=${run.connectionId} failed=${code}`,
    );
    return { status: 'failed', code };
  }
}
