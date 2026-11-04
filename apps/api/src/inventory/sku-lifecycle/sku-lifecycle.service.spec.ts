import { ConflictException } from '@nestjs/common';
import type { DatabaseConnection } from '@ssdashboard/db';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogService } from '../../catalog/catalog.service.js';
import type { LedgerService, StockUsage } from '../ledger/ledger.service.js';
import { SkuLifecycleController } from './sku-lifecycle.controller.js';
import { SkuLifecycleService } from './sku-lifecycle.service.js';

const ID = '00000000-0000-7000-8000-000000000001';
const response = { setHeader: vi.fn() } as unknown as Response;

/** A service whose transaction runs the work on a stub; the ledger and catalog are mocks. */
function harness(usage: Partial<StockUsage>, code = 'OLD-1') {
  const tx = { execute: vi.fn(() => Promise.resolve({ rows: [] })) };
  const connection = {
    db: { transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx) },
  } as unknown as DatabaseConnection;
  const flags: StockUsage = {
    hasBalance: false,
    onHandNonZero: false,
    activeReserved: false,
    ...usage,
  };
  const ledger = {
    lockForArchive: vi.fn(() => Promise.resolve({ id: ID, archived: false })),
    usage: vi.fn(() => Promise.resolve(new Map([[ID, flags]]))),
  };
  const catalog = {
    getSku: vi.fn(() => Promise.resolve({})),
    getSkus: vi.fn(() => Promise.resolve(new Map([[ID, { code }]]))),
    setCode: vi.fn(() => Promise.resolve({ code: 'NEW-1' })),
    setArchived: vi.fn(() => Promise.resolve({ status: 'archived' })),
  };
  const service = new SkuLifecycleService(
    connection,
    ledger as unknown as LedgerService,
    catalog as unknown as CatalogService,
  );
  return { service, ledger, catalog, controller: new SkuLifecycleController(service) };
}

async function codeOf(run: Promise<unknown>): Promise<unknown> {
  const error: unknown = await run.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictException);
  return ((error as ConflictException).getResponse() as { code: string }).code;
}

describe('SkuLifecycleService', () => {
  it('refuses to archive while stock is on hand or reserved (AC-3)', async () => {
    for (const usage of [{ onHandNonZero: true }, { activeReserved: true }]) {
      const { controller, catalog, ledger } = harness({ hasBalance: true, ...usage });
      expect(await codeOf(controller.archive(ID, response))).toBe('STOCK_ON_HAND');
      expect(ledger.lockForArchive).toHaveBeenCalledBefore(ledger.usage);
      expect(catalog.setArchived).not.toHaveBeenCalled();
    }
  });

  it('archives a SKU whose balances are all 0', async () => {
    const { service, catalog } = harness({ hasBalance: true });
    await service.archive(ID);
    expect(catalog.setArchived).toHaveBeenCalledWith(expect.anything(), ID, true);
  });

  it('locks the code once a balance exists, unless it is unchanged (AC-2)', async () => {
    const locked = harness({ hasBalance: true });
    const body = { sku: 'NEW-1', updatedAt: 't' };
    expect(await codeOf(locked.controller.changeCode(ID, body, response))).toBe('CODE_LOCKED');
    expect(locked.catalog.setCode).not.toHaveBeenCalled();

    const same = harness({ hasBalance: true }, 'NEW-1');
    await same.service.changeCode(ID, 'NEW-1', 't');
    expect(same.catalog.setCode).toHaveBeenCalled();

    const fresh = harness({});
    await fresh.service.changeCode(ID, 'NEW-1', 't');
    expect(fresh.catalog.setCode).toHaveBeenCalledWith(expect.anything(), ID, 'NEW-1', 't');
  });

  it('reports usage for the code field and the archive button', async () => {
    expect(await harness({}).service.usage(ID)).toEqual({ codeLocked: false, canArchive: true });
    expect(await harness({ hasBalance: true, onHandNonZero: true }).service.usage(ID)).toEqual({
      codeLocked: true,
      canArchive: false,
    });
  });
});
