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

  it('locks the party row FOR SHARE when it answers, so an archive cannot slip past a bind', async () => {
    const { accounts } = withRows([]);
    const { tx, execute } = executor([{ found: 1 }]);

    await accounts.isConsignmentPartner(ID, tx);
    await accounts.holdsRole(ID, 'is_wholesale_customer', tx);

    const texts = (execute.mock.calls as unknown as Array<[{ queryChunks: unknown[] }]>).map(
      ([query]) =>
        query.queryChunks
          .map((chunk) =>
            chunk && typeof chunk === 'object' && 'value' in chunk ? chunk.value : '',
          )
          .flat()
          .join(''),
    );
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text).toMatch(/FOR SHARE\s*$/);
  });

  it('answers whether a party holds a role, and no for a malformed id without a query', async () => {
    const { accounts } = withRows([]);
    const yes = executor([{ ok: true }]);
    const no = executor([{ ok: false }]);
    const none = executor([]);

    await expect(accounts.holdsRole(ID, 'is_consignment_partner', yes.tx)).resolves.toBe(true);
    await expect(accounts.holdsRole(ID, 'is_consignment_partner', no.tx)).resolves.toBe(false);
    await expect(accounts.holdsRole(ID, 'is_consignment_partner', none.tx)).resolves.toBe(false);
    await expect(accounts.holdsRole('x', 'is_consignment_partner', yes.tx)).resolves.toBe(false);
    expect(yes.execute).toHaveBeenCalledTimes(1);
  });

  it('lists the accounts as id, code and name only, never a contact detail', async () => {
    const { accounts } = withRows([
      { id: ID, code: 'P1', name: 'Partner One', contact: { phone: '+20 100 000 0000' } },
    ]);

    await expect(accounts.list()).resolves.toEqual([{ id: ID, code: 'P1', name: 'Partner One' }]);
  });
});
