import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../database/sql.js';
import { ConnectorsService } from './connectors.service.js';

const row = {
  id: '01937f3a-0000-7000-8000-000000000001',
  connection_id: '01937f3a-0000-7000-8000-000000000002',
  kind: 'shopify.order_edit',
  sync_state: 'failed',
  failure_reason: 'STEP_OFF',
  queued_at: '2026-11-08T10:00:00.000001Z',
};

/** An executor that answers one row to any query and remembers how often it was asked. */
function fakeExecutor(): { executor: Executor; calls: () => number } {
  let calls = 0;
  const executor = {
    execute: () => {
      calls += 1;
      return Promise.resolve({ rows: [row] });
    },
  } as unknown as Executor;
  return { executor, calls: () => calls };
}

describe('ConnectorsService (stand-in, spec 0015 AC-24)', () => {
  it('answers the open commands of a record in the caller transaction, ids and codes only', async () => {
    const service = new ConnectorsService({} as DatabaseConnection);
    const { executor, calls } = fakeExecutor();

    const open = await service.openCommandsFor('order', row.id, executor);

    expect(calls()).toBe(1);
    expect(open).toEqual([
      {
        id: row.id,
        connectionId: row.connection_id,
        kind: 'shopify.order_edit',
        syncState: 'failed',
        failureReason: 'STEP_OFF',
        queuedAt: row.queued_at,
      },
    ]);
  });

  it('never makes a write back available while no executor is registered', async () => {
    const service = new ConnectorsService({} as DatabaseConnection);

    await expect(service.writeBackAvailable(row.id, 'shopify.order_edit')).resolves.toBe(false);
    await expect(service.writeBackAvailable(row.id, 'shopify.order_cancel')).resolves.toBe(false);
  });

  it('answers the store of a connection in the caller transaction', async () => {
    const service = new ConnectorsService({} as DatabaseConnection);
    const store = '01937f3a-0000-7000-8000-000000000009';
    const executor = {
      execute: () => Promise.resolve({ rows: [{ store_id: store }] }),
    } as unknown as Executor;
    const none = { execute: () => Promise.resolve({ rows: [] }) } as unknown as Executor;

    await expect(service.storeOfConnection(row.connection_id, executor)).resolves.toBe(store);
    await expect(service.storeOfConnection(row.connection_id, none)).resolves.toBeNull();
  });
});
