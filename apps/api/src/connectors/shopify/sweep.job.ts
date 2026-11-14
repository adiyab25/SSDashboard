import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { z } from 'zod';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Transaction } from '../../database/sql.js';
import { JobSender } from '../../platform/jobs/job-sender.js';
import {
  PROCESSED_INBOX_SUBJECTS,
  PROCESSED_INBOX_TOPICS,
  SHOPIFY_ORDER_TOPICS,
} from '../hooks/shopify-hook-payload.js';
import { SyncRuns, type RunPosition, type SyncRunRow } from '../sync-runs/sync-runs.js';
import { ConnectionAccess } from './connection-access.js';
import { ConnectorBudget } from './connector-budget.js';
import { ConnectorClock } from './connector-clock.js';
import {
  connectionGroup,
  CONNECTOR_SHOPIFY_QUEUE,
  BACKFILL_JOB_PRIORITY,
  INBOX_JOB_PRIORITY,
  SWEEP_JOB_PRIORITY,
  type ShopifyJobData,
} from './connector-shopify.queue.js';
import {
  ShopifyClient,
  ShopifyClientError,
  type ShopifyConnectionAccess,
} from './shopify-client.js';
import {
  ORDERS_SWEEP,
  ORDERS_SWEEP_OPERATION,
  PRODUCTS_SWEEP,
  PRODUCTS_SWEEP_OPERATION,
  SWEEP_PAGE_EXPECTED_COST,
  updatedSinceFilter,
} from './shopify-queries.js';
import { isStorableText, StorableShopifyId } from './storable-text.js';

/** The overlap a sweep reads behind its watermark (the reference brand's safety margin). */
export const SWEEP_OVERLAP_MS = 10 * 60_000;

/** A connection whose last successful orders sweep is older than this is `SWEEP_LATE` (AC-18). */
export const SWEEP_LATE_AFTER_MINUTES = 15;

/** An unfinished sweep run older than this is given up (`SWEEP_STALLED`) and a new one starts. */
export const SWEEP_STALLED_AFTER_MS = 15 * 60_000;

/** Sweep retries of one failed order per operating day (AC-8). */
export const SWEEP_RETRIES_PER_DAY = 3;

/**
 * The n-th retry of a failed order in an operating day waits at least n times this long after the
 * previous attempt (the failed event's `processed_at`): 1 hour, then 2, then 3, so the 3 retries
 * spread over the day instead of three sweeps in 15 minutes (code review minor).
 */
export const SWEEP_RETRY_SPACING_HOURS = 1;

/**
 * A `received` event with no attempt yet is sent its job again after this long (its webhook job
 * was lost, the connection was paused, or its keys were refused): a queued job ahead of it would
 * have run by then.
 */
export const RESEND_AFTER_MINUTES = 15;

/**
 * A `received` event whose read was retried is sent its job again only after this long: longer
 * than the queue's whole retry window (at most about 3 h 31 min), so a job still retrying is never
 * doubled.
 */
export const RESEND_RETRIED_AFTER_HOURS = 4;

/** The most events one sweep sends again. */
const RESEND_LIMIT = 200;

/** The topic a sweep's order row carries, so the one inbox path reads it back (AC-7). */
export const SWEEP_ORDER_TOPIC = 'orders/updated';

/** The topic a sweep's or backfill's product row carries, read back by the one product path (task 8). */
export const SWEEP_PRODUCT_TOPIC = 'products/update';

/**
 * One sweep page. The ids and the page cursor are stored (the inbox row, the run's position), so
 * each must be storable text (`StorableShopifyId`): a broken answer fails the page as
 * `INVALID_RESPONSE` instead of failing at the database.
 */
const SweepPage = z.object({
  nodes: z.array(
    z.object({ id: StorableShopifyId.max(100), updatedAt: z.iso.datetime({ offset: true }) }),
  ),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().max(1000).refine(isStorableText).nullable(),
  }),
});
const OrdersSweepAnswer = z.object({ orders: SweepPage });
const ProductsSweepAnswer = z.object({ products: SweepPage });

/** Which sweep: orders every 5 minutes, products every 30 (AC-18). */
export type SweepKind = 'orders' | 'products';

/** Per sweep kind: its run kind, watermark column, query, inbox subject, and topic. */
const SWEEPS = {
  orders: {
    runKind: 'sweep_orders',
    jobKind: 'sweep_orders',
    watermark: 'orders_swept_through',
    operationName: ORDERS_SWEEP_OPERATION,
    query: ORDERS_SWEEP,
    answer: (data: unknown) => OrdersSweepAnswer.safeParse(data),
    subject: 'order',
    entity: 'order',
    topic: SWEEP_ORDER_TOPIC,
  },
  products: {
    runKind: 'sweep_products',
    jobKind: 'sweep_products',
    watermark: 'products_swept_through',
    operationName: PRODUCTS_SWEEP_OPERATION,
    query: PRODUCTS_SWEEP,
    answer: (data: unknown) => {
      const parsed = ProductsSweepAnswer.safeParse(data);
      return parsed.success
        ? { success: true as const, data: { orders: parsed.data.products } }
        : { success: false as const };
    },
    subject: 'product',
    entity: 'product',
    topic: SWEEP_PRODUCT_TOPIC,
  },
} as const;

/** How one sweep job ended: codes and counts only. */
export interface SweepOutcome {
  readonly skipped?: string;
  readonly status?: 'succeeded' | 'partial' | 'failed';
  readonly code?: string | null;
  readonly found?: number;
  readonly recorded?: number;
}

/** An instant minus the sweep overlap, as the whole second UTC text Shopify's search takes. */
export function sweepFrom(watermarkIso: string): string {
  const from = new Date(Date.parse(watermarkIso) - SWEEP_OVERLAP_MS);
  return `${from.toISOString().slice(0, 19)}Z`;
}

/** A count from a run's counts, 0 when absent. */
function countOf(counts: Record<string, unknown>, key: string): number {
  const value = counts[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The sweeps of spec 0015 task 12 (AC-8, AC-18, *Backfill, go live, and sweeps*), run by the
 * `connector-shopify` worker:
 *
 * - `tick` (the `shopify-orders-sweep` and `shopify-products-sweep` schedules, every 5 and 30
 *   minutes) sends one sweep job per live connection (active, health `ok` or `degraded`, with the
 *   sweep's watermark set: the first backfill sets it, so a connection still being set up is not
 *   swept), in its group at priority 10, at most one per connection per 5 minutes. The orders tick
 *   first marks every live connection whose last successful orders sweep is older than 15 minutes
 *   `degraded` `SWEEP_LATE` (only from `ok`: a degraded code never overwrites another).
 * - `sweep` reads the objects updated since the watermark minus 10 minutes, 250 a page, oldest
 *   change first, selecting ids and update times only. Each one newer than the version the app last
 *   applied (and not already waiting in the inbox at that version) becomes an inbox row
 *   (`source = 'sweep'`, dedupe `sweep:<gid>:<updatedAt>`) with its inbox job (priority 20),
 *   which reads the order or product back through the one mapper (products: task 8). A chunk ends after 60 seconds or 3,000 points
 *   (`ConnectorBudget`): the run turns `partial` with its page cursor and the next job continues
 *   it. When the last page is read the orders sweep also adds a retry row
 *   (`sweep-retry:<gid>:<updatedAt>:<attempt>`) for each order whose latest event is `failed`, at
 *   most 3 a day per order by the operating day (`ssd_operating_day`, in SQL), and sends again the
 *   job of every event left `received` with no job (see `RESEND_AFTER_MINUTES`); then the run
 *   succeeds, the watermark moves to the newest `updatedAt` seen (never back), and for orders
 *   `last_sweep_at` moves and `SWEEP_LATE` clears.
 * - A Shopify error ends the run `failed` with its code and is not retried: the next tick sweeps
 *   again, and `SWEEP_LATE` shows a sweep that keeps failing.
 *
 * Never reads, stores, or logs a customer's data: rows hold the topic, the gid, and the update
 * time only (AC-6).
 */
@Injectable()
export class SweepJob {
  private readonly logger = new Logger('ShopifySweep');

  /** Takes the database, the connection access, the client, the job sender, runs, clock, budget. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ConnectionAccess) private readonly access: ConnectionAccess,
    @Inject(ShopifyClient) private readonly shopify: ShopifyClient,
    @Inject(JobSender) private readonly jobs: JobSender,
    @Inject(SyncRuns) private readonly runs: SyncRuns,
    @Inject(ConnectorClock) private readonly clock: ConnectorClock,
    @Inject(ConnectorBudget) private readonly budget: ConnectorBudget,
  ) {}

  /** The scheduled fan out (see the class): one sweep job per live connection. */
  async tick(kind: SweepKind): Promise<{ readonly connections: number }> {
    const sweep = SWEEPS[kind];
    if (kind === 'orders') {
      await this.connection.db.execute(sql`
        UPDATE connections
        SET health = 'degraded', health_reason = 'SWEEP_LATE', health_changed_at = now(),
            updated_at = now()
        WHERE provider = 'shopify' AND status = 'active' AND health = 'ok'
          AND orders_swept_through IS NOT NULL
          AND (last_sweep_at IS NULL
               OR last_sweep_at < now() - make_interval(mins => ${SWEEP_LATE_AFTER_MINUTES}))`);
    }
    const { rows } = await this.connection.db.execute<{ id: string }>(sql`
      SELECT id FROM connections
      WHERE provider = 'shopify' AND status = 'active' AND health IN ('ok', 'degraded')
        AND ${sql.raw(sweep.watermark)} IS NOT NULL
      ORDER BY created_at, id`);
    if (rows.length > 0) await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    for (const row of rows) {
      const data: ShopifyJobData = { kind: sweep.jobKind, connectionId: row.id };
      await this.jobs.send(CONNECTOR_SHOPIFY_QUEUE, data, {
        ...connectionGroup(row.id),
        priority: SWEEP_JOB_PRIORITY,
        singletonKey: `${sweep.jobKind}:${row.id}`,
        singletonSeconds: 300,
      });
    }
    return { connections: rows.length };
  }

  /**
   * One sweep chunk of a connection (see the class): a new sweep, or with `runId` and `step` the
   * continuation of a partial one (a job whose step the run moved past is skipped).
   */
  async sweep(
    kind: SweepKind,
    data: { connectionId: string; runId?: string; step?: number },
  ): Promise<SweepOutcome> {
    const sweep = SWEEPS[kind];
    const opened = await this.access.open(data.connectionId);
    if ('skipped' in opened) return { skipped: opened.skipped };
    const watermark =
      kind === 'orders'
        ? opened.connection.ordersSweptThrough
        : opened.connection.productsSweptThrough;

    let run: SyncRunRow | null;
    if (data.runId !== undefined) {
      run = await this.runs.read(this.connection.db, data.runId);
      if (!run || run.finished || run.position.step !== data.step) return { skipped: 'DUPLICATE' };
    } else {
      if (watermark === null) return { skipped: 'NOT_LIVE' };
      const open = await this.runs.unfinished(this.connection.db, data.connectionId, [
        sweep.runKind,
      ]);
      if (open) {
        if (Date.parse(open.startedAt) > this.clock.now().getTime() - SWEEP_STALLED_AFTER_MS) {
          return { skipped: 'SWEEP_RUNNING' };
        }
        await this.runs.finish(this.connection.db, open.id, {
          status: 'failed',
          errorCode: 'SWEEP_STALLED',
        });
      }
      const from = sweepFrom(watermark);
      const runId = await this.runs.start(this.connection.db, {
        connectionId: data.connectionId,
        kind: sweep.runKind,
        watermarkFrom: from,
        counts: { found: 0, recorded: 0 },
      });
      run = await this.runs.read(this.connection.db, runId);
      if (!run) return { skipped: 'RUN_MISSING' };
    }
    return this.chunk(kind, run, opened.access);
  }

  /** Reads pages until the end or the chunk budget, recording what is newer. */
  private async chunk(
    kind: SweepKind,
    run: SyncRunRow,
    access: ShopifyConnectionAccess,
  ): Promise<SweepOutcome> {
    const sweep = SWEEPS[kind];
    const from = run.watermarkFrom ? `${run.watermarkFrom.slice(0, 19)}Z` : null;
    if (from === null) {
      await this.runs.finish(this.connection.db, run.id, {
        status: 'failed',
        errorCode: 'NO_WATERMARK',
      });
      return { status: 'failed', code: 'NO_WATERMARK' };
    }
    const deadline = this.clock.now().getTime() + this.budget.chunkMillis;
    const counts = { ...run.counts };
    let found = countOf(counts, 'found');
    let recorded = countOf(counts, 'recorded');
    let newest = typeof counts['newest'] === 'string' ? counts['newest'] : null;
    let after = run.position.after;
    let cost = 0;
    try {
      await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
      for (;;) {
        const answer = await this.shopify.request(access, {
          operationName: sweep.operationName,
          query: sweep.query,
          variables: { query: updatedSinceFilter(from), after },
          expectedCost: SWEEP_PAGE_EXPECTED_COST,
        });
        cost += answer.cost?.actualQueryCost ?? 0;
        const parsed = sweep.answer(answer.data);
        if (!parsed.success) throw new SweepAnswerUnreadable();
        const { nodes, pageInfo } = parsed.data.orders;
        found += nodes.length;
        recorded += await this.record(kind, run.connectionId, nodes);
        for (const node of nodes) {
          const at = new Date(node.updatedAt).toISOString();
          if (newest === null || at > newest) newest = at;
        }
        if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
        after = pageInfo.endCursor;
        if (this.clock.now().getTime() >= deadline || cost >= this.budget.chunkPoints) {
          const position: RunPosition = { ...run.position, step: run.position.step + 1, after };
          const next = { ...counts, found, recorded, newest };
          await this.connection.db.transaction(async (tx) => {
            await this.runs.progress(tx, run.id, {
              position,
              counts: next,
              cost,
              status: 'partial',
            });
            const data: ShopifyJobData = {
              kind: sweep.jobKind,
              connectionId: run.connectionId,
              runId: run.id,
              step: position.step,
            };
            await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
              ...connectionGroup(run.connectionId),
              priority: SWEEP_JOB_PRIORITY,
            });
          });
          this.logger.log(
            `sweep ${kind} connection=${run.connectionId} run=${run.id} partial found=${found} recorded=${recorded} cost=${cost}`,
          );
          return { status: 'partial', found, recorded };
        }
      }
    } catch (error) {
      const code =
        error instanceof ShopifyClientError
          ? error.code
          : error instanceof SweepAnswerUnreadable
            ? 'INVALID_RESPONSE'
            : null;
      if (code === null) throw error;
      await this.runs.finish(this.connection.db, run.id, {
        status: 'failed',
        counts: { ...counts, found, recorded },
        cost,
        errorCode: code,
      });
      this.logger.warn(`sweep ${kind} connection=${run.connectionId} run=${run.id} failed=${code}`);
      return { status: 'failed', code, found, recorded };
    }

    const extra = kind === 'orders' ? await this.retryAndResend(run.connectionId) : {};
    await this.connection.db.transaction(async (tx) => {
      await this.runs.finish(tx, run.id, {
        status: 'succeeded',
        counts: { ...counts, found, recorded, newest, ...extra },
        cost,
        watermarkTo: newest,
      });
      if (kind === 'orders') {
        await tx.execute(sql`
          UPDATE connections
          SET orders_swept_through = greatest(orders_swept_through, ${newest}::timestamptz),
              last_sweep_at = now(),
              health = CASE WHEN health = 'degraded' AND health_reason = 'SWEEP_LATE'
                            THEN 'ok'::connection_health ELSE health END,
              health_changed_at = CASE WHEN health = 'degraded' AND health_reason = 'SWEEP_LATE'
                                       THEN now() ELSE health_changed_at END,
              health_reason = CASE WHEN health = 'degraded' AND health_reason = 'SWEEP_LATE'
                                   THEN NULL ELSE health_reason END,
              updated_at = now()
          WHERE id = ${run.connectionId}::uuid`);
      } else {
        await tx.execute(sql`
          UPDATE connections
          SET products_swept_through = greatest(products_swept_through, ${newest}::timestamptz),
              updated_at = now()
          WHERE id = ${run.connectionId}::uuid`);
      }
    });
    this.logger.log(
      `sweep ${kind} connection=${run.connectionId} run=${run.id} succeeded found=${found} recorded=${recorded} cost=${cost}`,
    );
    return { status: 'succeeded', found, recorded };
  }

  /**
   * Records one page in one transaction: every object newer than its mapping's applied version and
   * not already `received` at that version becomes an inbox row with its inbox job.
   * Answers how many rows were added.
   */
  private async record(
    kind: SweepKind,
    connectionId: string,
    nodes: readonly { id: string; updatedAt: string }[],
  ): Promise<number> {
    if (nodes.length === 0) return 0;
    const sweep = SWEEPS[kind];
    return this.connection.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ external_id: string; version: string | null }>(sql`
        SELECT external_id,
               to_char(external_version AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
        FROM connection_external_ids
        WHERE connection_id = ${connectionId}::uuid AND entity = ${sweep.entity}::external_entity
          AND external_id = ANY(${pgArray(nodes.map((node) => node.id))}::text[])`);
      const applied = new Map(rows.map((row) => [row.external_id, row.version]));
      let added = 0;
      for (const node of nodes) {
        const version = new Date(node.updatedAt).toISOString();
        const known = applied.get(node.id);
        if (known && Date.parse(known) >= Date.parse(version)) continue;
        const payload = { topic: sweep.topic, id: node.id, updatedAt: version };
        const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO inbound_events (connection_id, source, topic, dedupe_key, subject_type,
                                      subject_external_id, subject_version, payload)
          SELECT ${connectionId}::uuid, 'sweep', ${sweep.topic}, ${`sweep:${node.id}:${version}`},
                 ${sweep.subject}::inbound_subject, ${node.id}, ${version}::timestamptz,
                 ${JSON.stringify(payload)}::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM inbound_events w
            WHERE w.connection_id = ${connectionId}::uuid
              AND w.subject_type = ${sweep.subject}::inbound_subject
              AND w.subject_external_id = ${node.id} AND w.status = 'received'
              AND w.subject_version >= ${version}::timestamptz)
          ON CONFLICT ON CONSTRAINT inbound_events_dedupe_unique DO NOTHING
          RETURNING id`);
        const eventId = inserted.rows[0]?.id;
        if (!eventId) continue;
        added += 1;
        await this.sendInbox(tx, connectionId, eventId);
      }
      return added;
    });
  }

  /**
   * The end of an orders sweep (AC-8): a retry row for each order whose latest event is `failed`
   * (at most `SWEEP_RETRIES_PER_DAY` a day per order by the operating day, `ssd_operating_day` in
   * SQL; the n-th waits `SWEEP_RETRY_SPACING_HOURS` times n after the previous attempt), each with
   * its inbox job; then the job of every event left `received` with no job sent again
   * (`RESEND_AFTER_MINUTES`, `RESEND_RETRIED_AFTER_HOURS`), at most one resend per event an hour.
   * The resend scan filters on the processed subject types first, so the partial index on
   * (connection, subject type, received at) skips inventory and bulk rows cheaply; product rows
   * (task 8) are resent too, which also picks up the ones recorded before task 8 gave them a job.
   * Answers the counts.
   */
  private async retryAndResend(
    connectionId: string,
  ): Promise<{ readonly retried: number; readonly resent: number }> {
    const retried = await this.connection.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{
        gid: string;
        version: string;
        attempt: number;
        due: boolean;
      }>(sql`
        SELECT f.subject_external_id AS gid,
               to_char(coalesce(f.subject_version, f.received_at) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS version,
               (SELECT count(*)::int FROM inbound_events r
                WHERE r.connection_id = f.connection_id AND r.subject_type = 'order'
                  AND r.subject_external_id = f.subject_external_id AND r.source = 'sweep'
                  AND left(r.dedupe_key, 12) = 'sweep-retry:'
                  AND ssd_operating_day(r.received_at) = ssd_operating_day(now())) + 1 AS attempt,
               coalesce(f.processed_at, f.received_at) <= now() - make_interval(
                 hours => ${SWEEP_RETRY_SPACING_HOURS} * (
                   (SELECT count(*)::int FROM inbound_events r
                    WHERE r.connection_id = f.connection_id AND r.subject_type = 'order'
                      AND r.subject_external_id = f.subject_external_id AND r.source = 'sweep'
                      AND left(r.dedupe_key, 12) = 'sweep-retry:'
                      AND ssd_operating_day(r.received_at) = ssd_operating_day(now())) + 1)) AS due
        FROM inbound_events f
        WHERE f.connection_id = ${connectionId}::uuid AND f.status = 'failed'
          AND f.subject_type = 'order' AND f.subject_external_id IS NOT NULL
          AND f.topic = ANY(${pgArray([...SHOPIFY_ORDER_TOPICS])}::text[])
          AND NOT EXISTS (
            SELECT 1 FROM inbound_events l
            WHERE l.connection_id = f.connection_id AND l.subject_type = 'order'
              AND l.subject_external_id = f.subject_external_id
              AND (l.received_at, l.id) > (f.received_at, f.id))`);
      let added = 0;
      for (const row of rows) {
        if (row.attempt > SWEEP_RETRIES_PER_DAY || !row.due) continue;
        const dedupe = `sweep-retry:${row.gid}:${row.version}:${row.attempt}`;
        const payload = { topic: SWEEP_ORDER_TOPIC, id: row.gid, updatedAt: row.version };
        const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO inbound_events (connection_id, source, topic, dedupe_key, subject_type,
                                      subject_external_id, subject_version, payload)
          VALUES (${connectionId}::uuid, 'sweep', ${SWEEP_ORDER_TOPIC}, ${dedupe}, 'order',
                  ${row.gid}, ${row.version}::timestamptz, ${JSON.stringify(payload)}::jsonb)
          ON CONFLICT ON CONSTRAINT inbound_events_dedupe_unique DO NOTHING
          RETURNING id`);
        const eventId = inserted.rows[0]?.id;
        if (!eventId) continue;
        added += 1;
        await this.sendInbox(tx, connectionId, eventId);
      }
      return added;
    });

    const { rows: stuck } = await this.connection.db.execute<{ id: string; reread: boolean }>(sql`
      SELECT id, left(dedupe_key, 16) = 'backfill-reread:' AS reread FROM inbound_events
      WHERE connection_id = ${connectionId}::uuid
        AND subject_type = ANY(${pgArray([...PROCESSED_INBOX_SUBJECTS])}::inbound_subject[])
        AND status = 'received'
        AND topic = ANY(${pgArray([...PROCESSED_INBOX_TOPICS])}::text[])
        AND ((attempts = 0 AND left(dedupe_key, 16) <> 'backfill-reread:'
              AND received_at < now() - make_interval(mins => ${RESEND_AFTER_MINUTES}))
             OR received_at < now() - make_interval(hours => ${RESEND_RETRIED_AFTER_HOURS}))
      ORDER BY received_at
      LIMIT ${RESEND_LIMIT}`);
    let resent = 0;
    for (const row of stuck) {
      const data: ShopifyJobData = { kind: 'inbox', connectionId, eventId: row.id };
      const id = await this.jobs.send(CONNECTOR_SHOPIFY_QUEUE, data, {
        ...connectionGroup(connectionId),
        // A D12 re-read whose job was lost keeps the backfill's low priority (lead ruling F2).
        priority: row.reread ? BACKFILL_JOB_PRIORITY : INBOX_JOB_PRIORITY,
        singletonKey: `resend:${row.id}`,
        singletonSeconds: 3_600,
      });
      if (id !== null) resent += 1;
    }
    return { retried, resent };
  }

  /** Sends one inbox event's job through the caller's transaction. */
  private async sendInbox(tx: Transaction, connectionId: string, eventId: string): Promise<void> {
    const data: ShopifyJobData = { kind: 'inbox', connectionId, eventId };
    await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
      ...connectionGroup(connectionId),
      priority: INBOX_JOB_PRIORITY,
    });
  }
}

/** A sweep page Shopify answered in a shape it did not promise (a transient `INVALID_RESPONSE`). */
class SweepAnswerUnreadable extends Error {
  constructor() {
    super('INVALID_RESPONSE');
    this.name = 'SweepAnswerUnreadable';
  }
}
