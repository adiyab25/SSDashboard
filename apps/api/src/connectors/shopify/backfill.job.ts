import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { z } from 'zod';
import { DATABASE } from '../../database/database.module.js';
import type { Executor, Transaction } from '../../database/sql.js';
import { JobSender } from '../../platform/jobs/job-sender.js';
import { SyncRuns, type RunPosition, type SyncRunRow } from '../sync-runs/sync-runs.js';
import { assembleBulkOrder, type BulkObject } from './bulk-jsonl.js';
import { BulkRunProgress, type BulkJobOutcome } from './bulk-run-progress.js';
import { BulkRunner } from './bulk-runner.js';
import { ConnectionAccess } from './connection-access.js';
import { ConnectorBudget } from './connector-budget.js';
import { ConnectorClock } from './connector-clock.js';
import {
  BACKFILL_JOB_PRIORITY,
  connectionGroup,
  CONNECTOR_SHOPIFY_QUEUE,
  type ShopifyJobData,
} from './connector-shopify.queue.js';
import { searchInstant } from './gateway-scan.job.js';
import { InboxJob, type InboxOutcome } from './inbox.job.js';
import {
  ShopifyClient,
  ShopifyTransientError,
  type ShopifyConnectionAccess,
} from './shopify-client.js';
import {
  createdSinceFilter,
  ORDERS_BACKFILL_PAGE,
  ORDERS_BACKFILL_PAGE_EXPECTED_COST,
  ORDERS_BACKFILL_PAGE_OPERATION,
  ordersBulkQuery,
  PRODUCTS_BULK_QUERY,
} from './shopify-queries.js';
import { isStorableText } from './storable-text.js';
import { SWEEP_ORDER_TOPIC, SWEEP_PRODUCT_TOPIC } from './sweep.job.js';

/** The days of orders before the go live instant the backfill reads (Q-13.2). */
export const BACKFILL_DAYS = 60;

/** The job name a backfilled order's `system_job` actors carry (security review L4). */
export const BACKFILL_JOB_NAME = 'connectors.shopify.backfill';

/** The topic a backfill's order row carries, so the one inbox path applies it (AC-7). */
export const BACKFILL_ORDER_TOPIC = 'orders/create';

const ORDER_GID = /^gid:\/\/shopify\/Order\/[0-9]{1,20}$/;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[0-9]{1,20}$/;

const PageAnswer = z.object({
  orders: z.object({
    nodes: z.array(z.record(z.string(), z.unknown())),
    // The cursor is stored in the run's position, so it must be storable text.
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().max(1000).refine(isStorableText).nullable(),
    }),
  }),
});

/** A Shopify instant as UTC ISO text, or null when it is not one. */
function instantOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** A count from a run's counts, 0 when absent. */
function countOf(counts: Record<string, unknown>, key: string): number {
  const value = counts[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The first backfill of spec 0015 task 12 (AC-17, *Backfill, go live, and sweeps*, *Contract with
 * feature 15 and spec 0013 at go live*), the `backfill` kind of the `connector-shopify` queue, one
 * job per step of a run that `POST /api/connections/:id/backfill` started (it also set the
 * connection's `go_live_at`):
 *
 * 1. `backfill_products`: a bulk read of every product with the read back's fields and its
 *    variants (`PRODUCTS_BULK_QUERY`); each product is one inbox row (`source = 'backfill'`,
 *    subject `product`, dedupe `backfill:<bulk operation id>:<gid>`) applied at once by
 *    `InboxJob.applyProductRead` (task 8: `applyProduct`, the variant mappings with their
 *    inventory item ids, the attention events), as `connectors.shopify.backfill`, with no second
 *    read; its counts are `objects`, `recorded`, `applied`, and `failed`. When it ends,
 *    `products_swept_through` is set
 *    (the run's start: the products sweep continues from there) and the orders run starts.
 * 2. `backfill_orders`: a bulk read of every order created from `go_live_at` minus 60 days with the
 *    read back's fields (`ordersBulkQuery`). Each order (`assembleBulkOrder`) becomes an inbox row
 *    (`source = 'backfill'`, dedupe `backfill:<bulk operation id>:<gid>`) and is applied at once by
 *    `InboxJob.applyRead`, the same unit of work and mapper as a webhook, with no second read: the
 *    mapper reads `go_live_at`, so an open order placed before it enters `confirmed`
 *    (`go_live_import`, actor `system_job`), a later one as a live `new` order, and a closed one
 *    with its found states (actor `import` with this run's id). If Shopify refuses the bulk
 *    selection (`DiscountApplication` is no `Node`), the run falls back to paged reads of one order
 *    each (`ORDERS_BACKFILL_PAGE`, about 871 points: `ORDER_READ`'s 869 plus 2 for the
 *    connection), dedupe `backfill:<run id>:<gid>`. When it ends, `orders_swept_through` is set
 *    (the run's start) and `last_sweep_at` moves: the backfill read every order up to then, so the
 *    orders sweep takes over. Each order's `system_job` actors carry `connectors.shopify.backfill`
 *    (security review L4); a backfill read coalesces no webhook event and moves `last_order_at`
 *    only to the greatest order `createdAt` seen.
 * 3. After the orders run succeeds, every imported order still open gets one budgeted read back
 *    (lead decision D12): an inbox row (`source = 'backfill'`, dedupe `backfill-reread:<gid>`)
 *    with its job, so its sales history, left unread by the bulk selection, is netted. Closed
 *    imported orders are never read again: their netting does not matter.
 *
 * A failed or stalled run resumes from its recorded position when the route is called again with
 * the same go live instant (lead decision D11, `ConnectionsService.startBackfill`).
 *
 * A chunk stops after its budget (`ConnectorBudget`) between two orders and records the JSONL line
 * (or page cursor) reached, so the next chunk resumes there; an order already recorded and no
 * longer `received` is never applied twice, and one still `received` (a crash in the middle) is
 * applied again. No line of the result is stored and no file is written.
 */
@Injectable()
export class BackfillJob {
  private readonly logger = new Logger('ShopifyBackfill');

  /** Takes the database, runs, access, the bulk runner and its progress, the client, inbox, clock, budget. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(SyncRuns) private readonly runs: SyncRuns,
    @Inject(ConnectionAccess) private readonly access: ConnectionAccess,
    @Inject(BulkRunner) private readonly runner: BulkRunner,
    @Inject(BulkRunProgress) private readonly progress: BulkRunProgress,
    @Inject(ShopifyClient) private readonly shopify: ShopifyClient,
    @Inject(InboxJob) private readonly inbox: InboxJob,
    @Inject(ConnectorClock) private readonly clock: ConnectorClock,
    @Inject(ConnectorBudget) private readonly budget: ConnectorBudget,
    @Inject(JobSender) private readonly jobs: JobSender,
  ) {}

  /** Runs one step of a backfill run (see the class); a stale step is skipped. */
  async run(
    data: { connectionId: string; runId: string; step: number },
    jobId: string,
    retryCount = 0,
  ): Promise<BulkJobOutcome> {
    const run = await this.runs.read(this.connection.db, data.runId);
    if (
      !run ||
      (run.kind !== 'backfill_products' && run.kind !== 'backfill_orders') ||
      run.connectionId !== data.connectionId ||
      run.finished ||
      run.position.step !== data.step
    ) {
      return { skipped: 'DUPLICATE' };
    }
    const opened = await this.access.open(data.connectionId);
    if ('skipped' in opened) {
      await this.runs.finish(this.connection.db, run.id, {
        status: 'failed',
        errorCode: opened.skipped,
      });
      return { status: 'failed', code: opened.skipped };
    }
    if (run.kind === 'backfill_products') {
      return this.products(run, opened.access, jobId, retryCount);
    }
    const goLiveAt = opened.connection.goLiveAt;
    if (goLiveAt === null) {
      await this.runs.finish(this.connection.db, run.id, {
        status: 'failed',
        errorCode: 'NO_GO_LIVE',
      });
      return { status: 'failed', code: 'NO_GO_LIVE' };
    }
    const since = searchInstant(new Date(Date.parse(goLiveAt) - BACKFILL_DAYS * 86_400_000));
    return this.orders(run, opened.access, since, jobId, retryCount);
  }

  /** One chunk of the products run (step 1 of the class). */
  private async products(
    run: SyncRunRow,
    access: ShopifyConnectionAccess,
    jobId: string,
    retryCount: number,
  ): Promise<BulkJobOutcome> {
    const tally = {
      objects: countOf(run.counts, 'objects'),
      recorded: countOf(run.counts, 'recorded'),
      applied: countOf(run.counts, 'applied'),
      failed: countOf(run.counts, 'failed'),
    };
    const counts = () => ({ ...run.counts, ...tally });
    const cost = { points: 0 };
    try {
      const step = await this.runner.step(
        access,
        { bulkId: run.position.bulkId, line: run.position.line },
        PRODUCTS_BULK_QUERY,
        async (object) => {
          tally.objects += 1;
          const outcome = await this.applyProduct(
            run,
            run.position.bulkId ?? run.id,
            object,
            jobId,
          );
          if (outcome === null) return;
          tally.recorded += 1;
          if (outcome.status === 'failed') tally.failed += 1;
          else if (outcome.status) tally.applied += 1;
        },
        cost,
      );
      if (step.kind !== 'done') {
        return await this.progress.advance(
          'backfill',
          run,
          run.position,
          step,
          counts(),
          cost.points,
        );
      }
      await this.connection.db.transaction(async (tx) => {
        await this.runs.finish(tx, run.id, {
          status: 'succeeded',
          counts: counts(),
          cost: cost.points,
        });
        await tx.execute(sql`
          UPDATE connections
          SET products_swept_through = coalesce(products_swept_through, ${run.startedAt}::timestamptz),
              updated_at = now()
          WHERE id = ${run.connectionId}::uuid`);
        const ordersRun = await this.runs.start(tx, {
          connectionId: run.connectionId,
          kind: 'backfill_orders',
          counts: { goLiveAt: run.counts['goLiveAt'] ?? null, productsRunId: run.id },
        });
        await this.progress.send(tx, 'backfill', run.connectionId, ordersRun, 0, false);
      });
      this.logger.log(
        `backfill products run=${run.id} objects=${tally.objects} applied=${tally.applied} failed=${tally.failed}`,
      );
      return { step: 'done', status: 'succeeded' };
    } catch (error) {
      return this.progress.failed(run, error, counts(), cost.points, retryCount);
    }
  }

  /** One chunk of the orders run (step 2 of the class), bulk or paged. */
  private async orders(
    run: SyncRunRow,
    access: ShopifyConnectionAccess,
    since: string,
    jobId: string,
    retryCount: number,
  ): Promise<BulkJobOutcome> {
    const tally = {
      objects: countOf(run.counts, 'objects'),
      recorded: countOf(run.counts, 'recorded'),
      applied: countOf(run.counts, 'applied'),
      failed: countOf(run.counts, 'failed'),
      skipped: countOf(run.counts, 'skipped'),
    };
    const counts = (extra: Record<string, unknown> = {}) => ({
      ...run.counts,
      ...tally,
      since,
      mode: run.position.mode,
      ...extra,
    });
    const cost = { points: 0 };
    const handle = async (
      prefix: string,
      order: Record<string, unknown> | null,
      root: Readonly<Record<string, unknown>>,
    ) => {
      tally.objects += 1;
      const outcome = await this.applyOrder(run, prefix, order, root, jobId);
      if (outcome === null) tally.skipped += 1;
      else if (outcome.status === 'failed') tally.failed += 1;
      else if (outcome.status) tally.applied += 1;
      else tally.skipped += 1;
    };
    try {
      if (run.position.mode === 'paged') {
        return await this.pagedChunk(run, access, since, handle, counts, cost);
      }
      const step = await this.runner.step(
        access,
        { bulkId: run.position.bulkId, line: run.position.line },
        ordersBulkQuery(since),
        async (object: BulkObject) => {
          await handle(run.position.bulkId ?? run.id, assembleBulkOrder(object), object.root);
        },
        cost,
      );
      if (step.kind === 'refused') {
        // Shopify refused the nested selection (spec 0015 Risk): paged reads from the start.
        const position: RunPosition = {
          ...run.position,
          step: run.position.step + 1,
          mode: 'paged',
          bulkId: null,
          line: 0,
          after: null,
        };
        await this.progress.next(
          'backfill',
          run,
          position,
          counts({ mode: 'paged', bulkRefusedCodes: [...step.codes] }),
          cost.points,
          'running',
          false,
        );
        return { step: 'paged', status: 'running' };
      }
      if (step.kind !== 'done') {
        return await this.progress.advance(
          'backfill',
          run,
          run.position,
          step,
          counts(),
          cost.points,
        );
      }
      return await this.finishOrders(run, counts(), cost.points);
    } catch (error) {
      return this.progress.failed(run, error, counts(), cost.points, retryCount);
    }
  }

  /** One chunk of the paged fallback: one order a page until the end or the budget. */
  private async pagedChunk(
    run: SyncRunRow,
    access: ShopifyConnectionAccess,
    since: string,
    handle: (
      prefix: string,
      order: Record<string, unknown> | null,
      root: Readonly<Record<string, unknown>>,
    ) => Promise<void>,
    counts: () => Record<string, unknown>,
    cost: { points: number },
  ): Promise<BulkJobOutcome> {
    const deadline = this.clock.now().getTime() + this.budget.chunkMillis;
    let after = run.position.after;
    for (;;) {
      const answer = await this.shopify.request(access, {
        operationName: ORDERS_BACKFILL_PAGE_OPERATION,
        query: ORDERS_BACKFILL_PAGE,
        variables: { query: createdSinceFilter(since), after },
        expectedCost: ORDERS_BACKFILL_PAGE_EXPECTED_COST,
      });
      cost.points += answer.cost?.actualQueryCost ?? 0;
      const parsed = PageAnswer.safeParse(answer.data);
      if (!parsed.success) throw new ShopifyTransientError('INVALID_RESPONSE');
      for (const node of parsed.data.orders.nodes) await handle(run.id, node, node);
      const { hasNextPage, endCursor } = parsed.data.orders.pageInfo;
      if (!hasNextPage || !endCursor) return this.finishOrders(run, counts(), cost.points);
      after = endCursor;
      if (this.clock.now().getTime() >= deadline || cost.points >= this.budget.chunkPoints) {
        const position: RunPosition = { ...run.position, step: run.position.step + 1, after };
        await this.progress.next(
          'backfill',
          run,
          position,
          counts(),
          cost.points,
          'partial',
          false,
        );
        return { step: 'more', status: 'partial' };
      }
    }
  }

  /** The end of the orders run: the run succeeds and the orders sweep takes over. */
  private async finishOrders(
    run: SyncRunRow,
    counts: Record<string, unknown>,
    cost: number,
  ): Promise<BulkJobOutcome> {
    await this.jobs.prepare(CONNECTOR_SHOPIFY_QUEUE);
    const rereads = await this.connection.db.transaction(async (tx) => {
      const queued = await this.queueRereads(tx, run.connectionId);
      await this.runs.finish(tx, run.id, {
        status: 'succeeded',
        counts: { ...counts, rereadsQueued: queued },
        cost,
      });
      await tx.execute(sql`
        UPDATE connections
        SET orders_swept_through = coalesce(orders_swept_through, ${run.startedAt}::timestamptz),
            last_sweep_at = now(), updated_at = now()
        WHERE id = ${run.connectionId}::uuid`);
      return queued;
    });
    this.logger.log(
      `backfill orders run=${run.id} connection=${run.connectionId} objects=${String(counts['objects'])} applied=${String(counts['applied'])} failed=${String(counts['failed'])} rereads=${rereads}`,
    );
    return { step: 'done', status: 'succeeded' };
  }

  /**
   * The budgeted read back of lead decision D12, in the run's closing transaction: one inbox row
   * (`source = 'backfill'`, topic `orders/updated`, dedupe `backfill-reread:<gid>`, so a redone
   * backfill queues none twice) and its job for each order mapping of the connection whose sales
   * history is still unread (`salesHistoryTruncated`, the bulk import) and that the `import`
   * actor did not create (a closed order before go live is never read again). The jobs go at the
   * backfill's low priority, behind webhook and sweep jobs, and each read is paced by the
   * client's throttle (about 869 points an order). Answers how many were queued.
   */
  private async queueRereads(tx: Transaction, connectionId: string): Promise<number> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbound_events (connection_id, source, topic, dedupe_key, subject_type,
                                  subject_external_id, subject_version, payload)
      SELECT m.connection_id, 'backfill', ${SWEEP_ORDER_TOPIC}, 'backfill-reread:' || m.external_id,
             'order', m.external_id, m.external_version,
             jsonb_build_object('topic', ${SWEEP_ORDER_TOPIC}::text, 'id', m.external_id,
                                'updatedAt', to_char(m.external_version AT TIME ZONE 'UTC',
                                                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      FROM connection_external_ids m
      WHERE m.connection_id = ${connectionId}::uuid AND m.entity = 'order'
        AND m.local_id IS NOT NULL AND m.removed_at IS NULL
        AND m.state->>'salesHistoryTruncated' = 'true'
        AND coalesce(m.state->>'imported', 'false') <> 'true'
      ON CONFLICT ON CONSTRAINT inbound_events_dedupe_unique DO NOTHING
      RETURNING id`);
    for (const row of rows) {
      const data: ShopifyJobData = { kind: 'inbox', connectionId, eventId: row.id };
      await this.jobs.sendIn(tx, CONNECTOR_SHOPIFY_QUEUE, data, {
        ...connectionGroup(connectionId),
        priority: BACKFILL_JOB_PRIORITY,
      });
    }
    return rows.length;
  }

  /**
   * Records one order's inbox row and applies it through `InboxJob.applyRead`. Answers the inbox
   * outcome, or null when the object is not an order or its row is already past `received`.
   */
  private async applyOrder(
    run: SyncRunRow,
    prefix: string,
    order: Record<string, unknown> | null,
    root: Readonly<Record<string, unknown>>,
    jobId: string,
  ): Promise<InboxOutcome | null> {
    const gid = root['id'];
    if (typeof gid !== 'string' || !ORDER_GID.test(gid)) return null;
    const eventId = await this.record(
      this.connection.db,
      run.connectionId,
      `backfill:${prefix}:${gid}`,
      'order',
      BACKFILL_ORDER_TOPIC,
      gid,
      instantOf(root['updatedAt']),
    );
    if (eventId === null) return null;
    // An order whose children could not be placed is handed over empty: the mapper refuses it and
    // the event fails with its code, so the sweep's retry reads it back whole.
    return this.inbox.applyRead(
      { connectionId: run.connectionId, eventId },
      { order: order ?? {} },
      jobId,
      run.id,
      BACKFILL_JOB_NAME,
    );
  }

  /**
   * Records one product's inbox row and applies it through `InboxJob.applyProductRead` (task 8),
   * the same unit and mapper as a webhook's read back, with no second read. Answers the inbox
   * outcome, or null when the object is not a product or its row is already past `received`.
   */
  private async applyProduct(
    run: SyncRunRow,
    prefix: string,
    object: BulkObject,
    jobId: string,
  ): Promise<InboxOutcome | null> {
    const gid = object.root['id'];
    if (typeof gid !== 'string' || !PRODUCT_GID.test(gid)) return null;
    const eventId = await this.record(
      this.connection.db,
      run.connectionId,
      `backfill:${prefix}:${gid}`,
      'product',
      SWEEP_PRODUCT_TOPIC,
      gid,
      instantOf(object.root['updatedAt']),
    );
    if (eventId === null) return null;
    return this.inbox.applyProductRead(
      { connectionId: run.connectionId, eventId },
      object,
      jobId,
      BACKFILL_JOB_NAME,
    );
  }

  /**
   * Inserts one backfill row (minimized payload: topic, gid, update time; AC-6). Answers the id of
   * a row still `received` (new, or left by a crash), or null when it already ended.
   */
  private async record(
    executor: Executor,
    connectionId: string,
    dedupe: string,
    subject: 'order' | 'product',
    topic: string,
    gid: string,
    version: string | null,
  ): Promise<string | null> {
    const payload = { topic, id: gid, updatedAt: version };
    const inserted = await executor.execute<{ id: string }>(sql`
      INSERT INTO inbound_events (connection_id, source, topic, dedupe_key, subject_type,
                                  subject_external_id, subject_version, payload)
      VALUES (${connectionId}::uuid, 'backfill', ${topic}, ${dedupe}, ${subject}::inbound_subject,
              ${gid}, ${version}::timestamptz, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT ON CONSTRAINT inbound_events_dedupe_unique DO NOTHING
      RETURNING id`);
    const id = inserted.rows[0]?.id;
    if (id) return id;
    const { rows } = await executor.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM inbound_events
      WHERE connection_id = ${connectionId}::uuid AND dedupe_key = ${dedupe}`);
    const row = rows[0];
    return row && row.status === 'received' ? row.id : null;
  }
}
