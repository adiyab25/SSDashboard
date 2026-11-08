import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it } from 'vitest';
import type { Transaction } from '../database/sql.js';
import { ChannelsError } from './channels.errors.js';
import { ChannelsService } from './channels.service.js';
import type { ConnectionStoreSource } from './connection-store-source.js';

// These cases never reach the database: each is refused (or answered empty) before a query runs.
// The queries themselves are proven against PostgreSQL in test/channels.e2e-spec.ts.
const unused = {} as DatabaseConnection;
const noTransaction = {} as Transaction;
const source: ConnectionStoreSource = { storeIdsByConnection: () => Promise.resolve([]) };

describe('ChannelsService without a database', () => {
  it('answers nothing for an empty list of ids, kinds, or connections', async () => {
    const service = new ChannelsService(unused);

    expect(await service.stores([])).toEqual([]);
    expect(await service.channels([])).toEqual([]);
    expect(await service.listChannels({ kinds: [] })).toEqual([]);
    expect(await service.storeLabelsByConnection([])).toEqual([]);
  });

  it('refuses a blank store code and a store with no name in any language', async () => {
    const service = new ChannelsService(unused);

    await expect(
      service.createShopifyStore(noTransaction, { code: '  ', name: { en: 'Shop' } }),
    ).rejects.toMatchObject({ code: 'INVALID_STORE_INPUT' });
    await expect(
      service.createShopifyStore(noTransaction, { code: 'SHOP', name: { en: ' ', ar: '' } }),
    ).rejects.toMatchObject({ code: 'INVALID_STORE_INPUT' });
    await expect(
      service.createShopifyStore(noTransaction, {
        code: 'SHOP',
        name: { en: 'Shop' },
        publicName: {},
      }),
    ).rejects.toBeInstanceOf(ChannelsError);
  });

  it('will not answer store labels before the connectors module registered its source', async () => {
    const service = new ChannelsService(unused);

    await expect(service.storeLabelsByConnection(['c1'])).rejects.toMatchObject({
      code: 'CONNECTION_STORES_NOT_REGISTERED',
    });
  });

  it('takes one connection store source and refuses a second', () => {
    const service = new ChannelsService(unused);
    service.registerConnectionStores(source);

    expect(() => service.registerConnectionStores(source)).toThrowError(
      expect.objectContaining({ code: 'CONNECTION_STORES_ALREADY_REGISTERED' }) as Error,
    );
  });
});
