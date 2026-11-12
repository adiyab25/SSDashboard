import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it } from 'vitest';
import type { OrderTransactions } from '../../orders/order-transactions.js';
import type { JobSender } from '../../platform/jobs/job-sender.js';
import type { SyncRuns } from '../sync-runs/sync-runs.js';
import type { ConnectionAccess } from './connection-access.js';
import type { ExchangeByEdit } from './exchange-by-edit.js';
import { HourlyCheckJob } from './hourly-check.job.js';
import type { ShopifyClient } from './shopify-client.js';

// Code review Major 3 of the sync jobs (spec 0015 task 12, F1): an error that is not Shopify's
// still ends the hourly check's run `failed`, then is thrown for pg-boss to retry. Fakes only.

const CONNECTION = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

describe('HourlyCheckJob: a run always ends (code review Major 3)', () => {
  it('ends the run failed INTERNAL_ERROR on a database error and throws it', async () => {
    const finished: Record<string, unknown>[] = [];
    const runs = {
      start: async () => Promise.resolve('run-1'),
      finish: async (_executor: unknown, _runId: string, end: Record<string, unknown>) => {
        finished.push(end);
        await Promise.resolve();
      },
    } as unknown as SyncRuns;
    const access = {
      open: async () =>
        Promise.resolve({ connection: { id: CONNECTION }, access: { connectionId: CONNECTION } }),
    } as unknown as ConnectionAccess;
    const failure = new Error('connection terminated');
    const shopify = {
      request: async () => Promise.reject(failure),
    } as unknown as ShopifyClient;
    const job = new HourlyCheckJob(
      { db: {} } as unknown as DatabaseConnection,
      { PUBLIC_URL: 'https://erp.fixture.example' },
      access,
      shopify,
      {} as JobSender,
      runs,
      {} as OrderTransactions,
      {} as ExchangeByEdit,
    );
    await expect(job.check(CONNECTION, 'job-1')).rejects.toBe(failure);
    expect(finished).toEqual([{ status: 'failed', cost: 0, errorCode: 'INTERNAL_ERROR' }]);
  });
});
