import { Inject, Injectable, Logger } from '@nestjs/common';
import { type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { SyncRuns } from '../sync-runs/sync-runs.js';
import { scannedGatewayNames } from './bulk-jsonl.js';
import { BulkRunProgress, type BulkJobOutcome } from './bulk-run-progress.js';
import { BulkRunner } from './bulk-runner.js';
import { ConnectionAccess } from './connection-access.js';
import { ConnectorClock } from './connector-clock.js';
import { gatewayScanBulkQuery } from './shopify-queries.js';

/** The days of orders the gateway scan reads (the 60 days Shopify lets the app see, Q-13.2). */
export const GATEWAY_SCAN_DAYS = 60;

/** The most distinct gateway names one scan keeps (far above any real store's few). */
export const GATEWAY_SCAN_MAX_NAMES = 100;

/** An instant as the whole second UTC text Shopify's search takes. */
export function searchInstant(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** The strings of a stored list, or none. */
function namesOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * The gateway scan of spec 0015 task 12 (AC-17, review M6), the `gateway_scan` kind of the
 * `connector-shopify` queue, one job per step of a `gateway_scan` sync run that
 * `POST /api/connections/:id/gateway-scan` started: a bulk read (`BulkRunner`) of every order of
 * the last 60 days (by `ConnectorClock`, fixed at the run's first step) selecting only its id and
 * payment gateway names, polled every 30 seconds (or found by the next poll after Shopify's
 * `BULK_OPERATIONS_FINISH`), streamed line by line and never stored. The distinct names, keyed as
 * `config.gatewayMethods` keys them (`gatewayKeyOf`), are kept sorted in the run's
 * `counts.gatewayNames` (at most 100) with `counts.orders`: the Mapping tab lists them, and
 * `POST /api/connections/:id/backfill` refuses with `GATEWAYS_UNMAPPED` while the newest
 * succeeded scan names one with no method. Gateway names are a store's payment providers, never
 * personal data.
 */
@Injectable()
export class GatewayScanJob {
  private readonly logger = new Logger('ShopifyGatewayScan');

  /** Takes the database, runs, access, the bulk runner and its progress, and the clock. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(SyncRuns) private readonly runs: SyncRuns,
    @Inject(ConnectionAccess) private readonly access: ConnectionAccess,
    @Inject(BulkRunner) private readonly runner: BulkRunner,
    @Inject(BulkRunProgress) private readonly progress: BulkRunProgress,
    @Inject(ConnectorClock) private readonly clock: ConnectorClock,
  ) {}

  /** Runs one step of a gateway scan run (see the class); a stale step is skipped. */
  async run(
    data: { connectionId: string; runId: string; step: number },
    retryCount = 0,
  ): Promise<BulkJobOutcome> {
    const run = await this.runs.read(this.connection.db, data.runId);
    if (
      !run ||
      run.kind !== 'gateway_scan' ||
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
    const since =
      run.position.since ??
      searchInstant(new Date(this.clock.now().getTime() - GATEWAY_SCAN_DAYS * 86_400_000));
    const position = { ...run.position, since };
    const names = new Set(namesOf(run.counts['gatewayNames']));
    let orders = typeof run.counts['orders'] === 'number' ? run.counts['orders'] : 0;
    const counts = () => ({
      orders,
      gatewayNames: [...names].sort().slice(0, GATEWAY_SCAN_MAX_NAMES),
      since,
    });
    const cost = { points: 0 };
    try {
      const step = await this.runner.step(
        opened.access,
        { bulkId: position.bulkId, line: position.line },
        gatewayScanBulkQuery(since),
        async (object) => {
          orders += 1;
          for (const name of scannedGatewayNames(object.root)) names.add(name);
          await Promise.resolve();
        },
        cost,
      );
      if (step.kind !== 'done') {
        return await this.progress.advance(
          'gateway_scan',
          run,
          position,
          step,
          counts(),
          cost.points,
        );
      }
      await this.runs.finish(this.connection.db, run.id, {
        status: 'succeeded',
        counts: counts(),
        cost: cost.points,
      });
      this.logger.log(
        `gateway scan run=${run.id} connection=${run.connectionId} orders=${orders} names=${names.size}`,
      );
      return { step: 'done', status: 'succeeded' };
    } catch (error) {
      return this.progress.failed(run, error, counts(), cost.points, retryCount);
    }
  }
}
