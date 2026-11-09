import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { ConnectorClock } from '../shopify/connector-clock.js';

/** Processed, ignored, and echo inbox rows are kept this many days (spec 0015 AC-6). */
export const INBOX_KEEP_DAYS = 90;

/** Failed inbox rows are kept this many days (AC-6). */
export const FAILED_INBOX_KEEP_DAYS = 180;

/** Finished sync runs are kept this many days (AC-6). */
export const SYNC_RUN_KEEP_DAYS = 90;

/** Rows deleted per statement, so no delete holds its locks for long. */
export const PURGE_BATCH = 1_000;

/** How long one purge run may work before it leaves the rest for the next night. */
export const PURGE_MAX_MILLIS = 120_000;

/** How many rows one purge deleted, per kind. */
export interface PurgeOutcome {
  readonly inboundEvents: number;
  readonly failedInboundEvents: number;
  readonly syncRuns: number;
}

/**
 * The inbox purge of spec 0015 task 12 (AC-6), the `inbox_purge` kind of the `connector-shopify`
 * queue, run by the `connector-inbox-purge` schedule at 04:00 in the install time zone under the
 * capability `connectors.inbox`. It deletes, in batches of 1,000:
 *
 * - inbox rows `processed`, `ignored`, `ignored_unlicensed`, or `echo` received more than 90 days
 *   ago;
 * - inbox rows `failed` received more than 180 days ago (a `received` row is never purged: it still
 *   waits for its job or the sweep);
 * - finished sync runs started more than 90 days ago, except the newest finished run of each
 *   connection and kind (the screen's last check, the gateway names the backfill checks, and the
 *   connect check's protected data flag read it) and a run a connection names as its first push
 *   preview (`stock_push_preview_run_id`).
 *
 * The app role may delete these rows (`connection_sync_runs` and `inbound_events` follow the
 * default privileges of migration 0002; neither is append only). It stops after 2 minutes, leaving
 * the rest for the next night. Ages are judged by the database clock.
 */
@Injectable()
export class InboxPurgeJob {
  private readonly logger = new Logger('ConnectorInboxPurge');

  /** Takes the database and the clock (the time budget only). */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ConnectorClock) private readonly clock: ConnectorClock,
  ) {}

  /** Purges once (see the class). */
  async run(): Promise<PurgeOutcome> {
    const deadline = this.clock.now().getTime() + PURGE_MAX_MILLIS;
    const inboundEvents = await this.batches(
      deadline,
      sql`DELETE FROM inbound_events WHERE id IN (
            SELECT id FROM inbound_events
            WHERE status IN ('processed', 'ignored', 'ignored_unlicensed', 'echo')
              AND received_at < now() - make_interval(days => ${INBOX_KEEP_DAYS})
            LIMIT ${PURGE_BATCH})`,
    );
    const failedInboundEvents = await this.batches(
      deadline,
      sql`DELETE FROM inbound_events WHERE id IN (
            SELECT id FROM inbound_events
            WHERE status = 'failed'
              AND received_at < now() - make_interval(days => ${FAILED_INBOX_KEEP_DAYS})
            LIMIT ${PURGE_BATCH})`,
    );
    const syncRuns = await this.batches(
      deadline,
      sql`DELETE FROM connection_sync_runs WHERE id IN (
            SELECT r.id FROM connection_sync_runs r
            WHERE r.finished_at IS NOT NULL
              AND r.started_at < now() - make_interval(days => ${SYNC_RUN_KEEP_DAYS})
              AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.stock_push_preview_run_id = r.id)
              AND EXISTS (SELECT 1 FROM connection_sync_runs n
                          WHERE n.connection_id = r.connection_id AND n.kind = r.kind
                            AND n.finished_at IS NOT NULL
                            AND (n.started_at, n.id) > (r.started_at, r.id))
            LIMIT ${PURGE_BATCH})`,
    );
    this.logger.log(
      `inbox purge inbound_events=${inboundEvents} failed=${failedInboundEvents} sync_runs=${syncRuns}`,
    );
    return { inboundEvents, failedInboundEvents, syncRuns };
  }

  /** Runs one delete until it deletes less than a batch or the time is up; answers the total. */
  private async batches(deadline: number, statement: SQL): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await this.connection.db.execute(statement);
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < PURGE_BATCH || this.clock.now().getTime() >= deadline) return total;
    }
  }
}
