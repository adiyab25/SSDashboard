import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it } from 'vitest';
import type { JobSender } from '../../platform/jobs/job-sender.js';
import { firstPosition, type SyncRunRow, type SyncRuns } from '../sync-runs/sync-runs.js';
import { BulkResultUnreadable } from './bulk-jsonl.js';
import { BulkRunProgress, lastRetryCodeOf } from './bulk-run-progress.js';
import type { BulkRunner } from './bulk-runner.js';
import type { ConnectionAccess } from './connection-access.js';
import { ConnectorBudget } from './connector-budget.js';
import { ConnectorClock } from './connector-clock.js';
import { CONNECTOR_SHOPIFY_RETRY } from './connector-shopify.queue.js';
import { GATEWAY_SCAN_MAX_NAMES, GatewayScanJob } from './gateway-scan.job.js';
import { ShopifyOrderMappingError } from './order-mapper.js';
import { ShopifyRejectedError, ShopifyTransientError } from './shopify-client.js';

// Code review Major 3 and security review L3 of the sync jobs (spec 0015 task 12, F1): a run is
// never left `running` by an error that is not Shopify's, and a gateway scan past 100 names says
// so. Pure: the runs, the runner, and the database are fakes.

const RUN: SyncRunRow = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  connectionId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
  kind: 'gateway_scan',
  status: 'running',
  startedAt: '2026-11-05T09:00:00.000000Z',
  finished: false,
  movedAt: '2026-11-05T09:00:00.000000Z',
  errorCode: null,
  watermarkFrom: null,
  position: firstPosition(),
  counts: {},
};

/** A `SyncRuns` fake that keeps every finish. */
function fakeRuns() {
  const finished: { runId: string; end: Record<string, unknown> }[] = [];
  const runs = {
    read: async () => Promise.resolve(RUN),
    finish: async (_executor: unknown, runId: string, end: Record<string, unknown>) => {
      finished.push({ runId, end });
      await Promise.resolve();
    },
  } as unknown as SyncRuns;
  return { runs, finished };
}

const DB = { db: {} } as unknown as DatabaseConnection;
const LAST = CONNECTOR_SHOPIFY_RETRY.retryLimit;

describe('BulkRunProgress.failed (code review Major 3)', () => {
  const progress = (runs: SyncRuns) =>
    new BulkRunProgress(DB, runs, {} as JobSender, new ConnectorBudget());

  it('throws any error before the last retry, except an unreadable result or a refusal', async () => {
    const { runs, finished } = fakeRuns();
    const error = new Error('database went away');
    await expect(progress(runs).failed(RUN, error, {}, 0, LAST - 1)).rejects.toBe(error);
    expect(finished).toEqual([]);
    await progress(runs).failed(RUN, new BulkResultUnreadable(3), {}, 0, 0);
    await progress(runs).failed(RUN, new ShopifyRejectedError('ACCESS_DENIED'), {}, 0, 0);
    expect(finished.map((f) => f.end['errorCode'])).toEqual([
      'BULK_RESULT_UNREADABLE',
      'ACCESS_DENIED',
    ]);
  });

  it('ends the run failed on the last retry for any error: INTERNAL_ERROR, a domain code, or the transient code', async () => {
    const { runs, finished } = fakeRuns();
    expect(await progress(runs).failed(RUN, new Error('bug'), { n: 1 }, 5, LAST)).toEqual({
      status: 'failed',
      code: 'INTERNAL_ERROR',
    });
    await progress(runs).failed(RUN, new ShopifyTransientError('TIMEOUT'), {}, 0, LAST);
    await progress(runs).failed(RUN, new ShopifyOrderMappingError('NO_OPEN_LINES'), {}, 0, LAST);
    expect(finished.map((f) => [f.end['status'], f.end['errorCode']])).toEqual([
      ['failed', 'INTERNAL_ERROR'],
      ['failed', 'TIMEOUT'],
      ['failed', 'NO_OPEN_LINES'],
    ]);
    expect(lastRetryCodeOf('not an error')).toBe('INTERNAL_ERROR');
  });
});

describe('GatewayScanJob (security review L3)', () => {
  it('keeps 100 names and records gatewayNamesTruncated once more were seen', async () => {
    const { runs, finished } = fakeRuns();
    const access = {
      open: async () =>
        Promise.resolve({
          connection: { id: RUN.connectionId },
          access: { connectionId: RUN.connectionId },
        }),
    } as unknown as ConnectionAccess;
    const runner = {
      step: async (
        _access: unknown,
        _position: unknown,
        _query: string,
        onObject: (object: { root: Record<string, unknown> }) => Promise<void>,
      ) => {
        for (let n = 0; n < GATEWAY_SCAN_MAX_NAMES + 5; n += 1) {
          await onObject({
            root: { paymentGatewayNames: [`Gateway ${String(n).padStart(3, '0')}`] },
          });
        }
        return { kind: 'done', position: { bulkId: null, line: 0 } };
      },
    } as unknown as BulkRunner;
    const job = new GatewayScanJob(
      DB,
      runs,
      access,
      runner,
      {} as BulkRunProgress,
      new ConnectorClock(),
    );
    expect(await job.run({ connectionId: RUN.connectionId, runId: RUN.id, step: 0 })).toEqual({
      step: 'done',
      status: 'succeeded',
    });
    const counts = finished[0]?.end['counts'] as Record<string, unknown>;
    expect(counts['gatewayNames']).toHaveLength(GATEWAY_SCAN_MAX_NAMES);
    expect(counts['gatewayNamesTruncated']).toBe(true);
    expect(counts['orders']).toBe(GATEWAY_SCAN_MAX_NAMES + 5);
  });
});
