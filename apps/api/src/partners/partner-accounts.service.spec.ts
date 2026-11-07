import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import { PartnerAccounts } from './partner-accounts.service.js';

/** The executor a caller passes, as the service sees it. */
type Executor = Parameters<PartnerAccounts['isConsignmentPartner']>[1];
const executor = (rows: unknown[]) => {
  const execute = vi.fn(() => Promise.resolve({ rows }));
  return { tx: { execute } as unknown as Executor, execute };
};

const ID = '0190c0de-0000-7000-8000-0000000000aa';

function withRows(rows: Array<Record<string, unknown>>) {
  const execute = vi.fn(() => Promise.resolve({ rows }));
  const connection = { db: { execute } } as unknown as DatabaseConnection;
  return { accounts: new PartnerAccounts(connection), execute };
}

describe('PartnerAccounts (spec 0008, AC-9 and AC-15)', () => {
  it('answers whether an id is a consignment partner through the caller’s executor', async () => {
    const { accounts, execute } = withRows([]);
    const { tx, execute: txExecute } = executor([{ found: 1 }]);

    await expect(accounts.isConsignmentPartner(ID, tx)).resolves.toBe(true);
    expect(txExecute).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers no for an id that matches no consignment partner', async () => {
    const { accounts } = withRows([]);
    const { tx } = executor([]);

    await expect(accounts.isConsignmentPartner(ID, tx)).resolves.toBe(false);
  });

  it('answers no for a malformed id without asking the database', async () => {
    const { accounts } = withRows([]);
    const { tx, execute } = executor([]);

    await expect(accounts.isConsignmentPartner('not-an-id', tx)).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('lists the accounts as id, code and name only, never a contact detail', async () => {
    const { accounts } = withRows([
      { id: ID, code: 'P1', name: 'Partner One', contact: { phone: '+20 100 000 0000' } },
    ]);

    await expect(accounts.list()).resolves.toEqual([{ id: ID, code: 'P1', name: 'Partner One' }]);
  });
});
