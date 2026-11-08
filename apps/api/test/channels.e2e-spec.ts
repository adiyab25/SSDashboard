import { sql } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelsError } from '../src/channels/channels.errors.js';
import { ChannelsService } from '../src/channels/channels.service.js';
import type { ConnectionStoreSource } from '../src/channels/connection-store-source.js';
import { ledgerHarness, type LedgerHarness } from './ledger.js';

// Spec 0015 task 2 (AC-1): ChannelsService against PostgreSQL, run as the application role like
// production. Connections are planted as the owner, the way the connectors module will write them.
describe('ChannelsService', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let channels: ChannelsService;
  let counter = 0;

  beforeAll(async () => {
    h = await ledgerHarness();
    channels = new ChannelsService(h.app);
  });

  afterAll(async () => {
    await h?.close();
  });

  const code = (prefix: string) => `${prefix}-${(counter += 1)}`;

  async function createStore(
    storeCode: string,
    name: { en?: string; ar?: string } = { en: 'Essentials', ar: 'إسنشيالز' },
  ) {
    return h.app.db.transaction((tx) => channels.createShopifyStore(tx, { code: storeCode, name }));
  }

  it('reads the seeded internal store and manual channel by id and in the lists', async () => {
    const [main] = await channels.listStores({ kind: 'internal' });
    const [manual] = await channels.listChannels({ kinds: ['manual'] });

    expect(main).toMatchObject({ code: 'MAIN', kind: 'internal', archived: false });
    expect(main?.name.en).toBe('Main store');
    expect(manual).toMatchObject({ code: 'manual', kind: 'manual', defaultStoreId: main?.id });

    expect(await channels.stores([main?.id as string])).toEqual([main]);
    expect(await channels.channels([manual?.id as string])).toEqual([manual]);
  });

  it('creates a Shopify store and its own channel with the same code and name', async () => {
    const storeCode = code('SHOP');
    const made = await createStore(storeCode);

    const [store] = await channels.stores([made.storeId]);
    const [channel] = await channels.channels([made.channelId]);
    expect(store).toEqual({
      id: made.storeId,
      code: storeCode,
      name: { en: 'Essentials', ar: 'إسنشيالز' },
      publicName: { en: 'Essentials', ar: 'إسنشيالز' },
      kind: 'shopify',
      archived: false,
    });
    expect(channel).toEqual({
      id: made.channelId,
      code: storeCode,
      name: { en: 'Essentials', ar: 'إسنشيالز' },
      kind: 'shopify',
      defaultStoreId: made.storeId,
      archived: false,
    });
  });

  it('keeps a separate public name when one is given', async () => {
    const made = await h.app.db.transaction((tx) =>
      channels.createShopifyStore(tx, {
        code: code('PUB'),
        name: { en: 'Back name' },
        publicName: { en: 'Front name' },
      }),
    );

    const [store] = await channels.stores([made.storeId]);
    expect(store?.name).toEqual({ en: 'Back name' });
    expect(store?.publicName).toEqual({ en: 'Front name' });
  });

  it('lists the new store only under its own kind, and the channel only under its kinds', async () => {
    const made = await createStore(code('KIND'));

    expect((await channels.listStores({ kind: 'shopify' })).map((s) => s.id)).toContain(
      made.storeId,
    );
    expect((await channels.listStores({ kind: 'internal' })).map((s) => s.id)).not.toContain(
      made.storeId,
    );
    expect((await channels.listChannels({ kinds: ['shopify'] })).map((c) => c.id)).toContain(
      made.channelId,
    );
    expect(
      (await channels.listChannels({ kinds: ['manual', 'whatsapp'] })).map((c) => c.id),
    ).not.toContain(made.channelId);
    const everything = await channels.listChannels();
    expect(everything.map((c) => c.id)).toContain(made.channelId);
  });

  it('refuses a store code in use and leaves nothing behind when the caller rolls back', async () => {
    const storeCode = code('TAKEN');
    await createStore(storeCode);
    const before = (await channels.listStores()).length;

    const attempt = h.app.db.transaction((tx) =>
      channels.createShopifyStore(tx, { code: storeCode, name: { en: 'Again' } }),
    );
    await expect(attempt).rejects.toBeInstanceOf(ChannelsError);
    await expect(attempt).rejects.toMatchObject({ code: 'STORE_CODE_TAKEN' });
    expect((await channels.listStores()).length).toBe(before);
  });

  it('refuses the code of an existing channel, and rolls back the store it just made', async () => {
    const before = (await channels.listStores()).length;

    await h.owner.pool.query(
      "INSERT INTO channels (code, name, kind) VALUES ('CLASH', '{\"en\": \"Clash\"}', 'whatsapp')",
    );
    // CLASH is a channel code with no store of that code: the store insert succeeds, the channel clashes.
    await expect(
      h.app.db.transaction((tx) =>
        channels.createShopifyStore(tx, { code: 'CLASH', name: { en: 'Clash' } }),
      ),
    ).rejects.toMatchObject({ code: 'STORE_CODE_TAKEN' });
    expect((await channels.listStores()).length).toBe(before);
  });

  it('reads inside the caller transaction before it commits', async () => {
    const storeCode = code('TX');
    await h.app.db.transaction(async (tx) => {
      const made = await channels.createShopifyStore(tx, { code: storeCode, name: { en: 'Tx' } });

      expect((await channels.stores([made.storeId], tx)).map((s) => s.code)).toEqual([storeCode]);
      expect(await channels.stores([made.storeId])).toEqual([]);
    });
  });

  it('keeps an archived store readable by id but out of the lists', async () => {
    const made = await createStore(code('OLD'));
    await h.owner.pool.query('UPDATE stores SET archived_at = now() WHERE id = $1', [made.storeId]);
    await h.owner.pool.query('UPDATE channels SET archived_at = now() WHERE id = $1', [
      made.channelId,
    ]);

    expect((await channels.stores([made.storeId]))[0]?.archived).toBe(true);
    expect((await channels.channels([made.channelId]))[0]?.archived).toBe(true);
    expect((await channels.listStores()).map((s) => s.id)).not.toContain(made.storeId);
    expect((await channels.listChannels()).map((c) => c.id)).not.toContain(made.channelId);
  });

  it('leaves unknown ids out', async () => {
    expect(await channels.stores(['018f0000-0000-7000-8000-000000000001'])).toEqual([]);
    expect(await channels.channels(['018f0000-0000-7000-8000-000000000001'])).toEqual([]);
  });

  it('refuses a store code that is not upper case letters, digits, underscore or hyphen', async () => {
    for (const bad of ['shop', 'SHOP 1', '-SHOP', 'A'.repeat(33), 'متجر', '']) {
      await expect(
        h.app.db.transaction((tx) =>
          channels.createShopifyStore(tx, { code: bad, name: { en: 'X' } }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STORE_INPUT' });
    }
    await createStore('A'.repeat(32));
  });

  it('trims the names and keeps only en and ar', async () => {
    const made = await h.app.db.transaction((tx) =>
      channels.createShopifyStore(tx, {
        code: code('TRIM'),
        name: { en: '  Padded  ', ar: ' ', extra: 'dropped' } as { en?: string; ar?: string },
      }),
    );

    const [store] = await channels.stores([made.storeId]);
    expect(store?.name).toEqual({ en: 'Padded' });
    expect(store?.publicName).toEqual({ en: 'Padded' });
  });

  describe('renameStore', () => {
    it('sets the store names and its channel name, and keeps the code', async () => {
      const storeCode = code('REN');
      const made = await createStore(storeCode, { en: 'Old' });

      await h.app.db.transaction((tx) =>
        channels.renameStore(tx, made.storeId, {
          name: { en: ' Essentials ', ar: 'إسنشيالز' },
          publicName: { en: 'Public' },
        }),
      );

      const [store] = await channels.stores([made.storeId]);
      const [channel] = await channels.channels([made.channelId]);
      expect(store).toMatchObject({
        code: storeCode,
        name: { en: 'Essentials', ar: 'إسنشيالز' },
        publicName: { en: 'Public' },
      });
      expect(channel).toMatchObject({
        code: storeCode,
        name: { en: 'Essentials', ar: 'إسنشيالز' },
      });
    });

    it('defaults the public name to the name, and refuses a name with no language', async () => {
      const made = await createStore(code('REN'));

      await h.app.db.transaction((tx) =>
        channels.renameStore(tx, made.storeId, { name: { ar: 'اسم' } }),
      );
      expect((await channels.stores([made.storeId]))[0]?.publicName).toEqual({ ar: 'اسم' });
      await expect(
        h.app.db.transaction((tx) => channels.renameStore(tx, made.storeId, { name: { en: ' ' } })),
      ).rejects.toMatchObject({ code: 'INVALID_STORE_INPUT' });
    });

    it('refuses an unknown store and never renames the internal store', async () => {
      const [main] = await channels.listStores({ kind: 'internal' });

      await expect(
        h.app.db.transaction((tx) =>
          channels.renameStore(tx, '018f0000-0000-7000-8000-000000000001', { name: { en: 'X' } }),
        ),
      ).rejects.toMatchObject({ code: 'STORE_NOT_FOUND' });
      await expect(
        h.app.db.transaction((tx) =>
          channels.renameStore(tx, main?.id as string, { name: { en: 'Renamed' } }),
        ),
      ).rejects.toMatchObject({ code: 'STORE_NOT_FOUND' });
      expect(main?.name.en).toBe('Main store');
    });
  });

  describe('storeLabelsByConnection', () => {
    const unknownConnection = '018f0000-0000-7000-8000-000000000001';
    let service: ChannelsService;

    /** Stands in for connectors: answers every connection with a store, ignoring the ids asked, like a careless source. */
    const source: ConnectionStoreSource = {
      async storeIdsByConnection(_ids, executor) {
        const { rows } = await executor.execute<{ id: string; store_id: string }>(
          sql`SELECT id, store_id FROM connections WHERE store_id IS NOT NULL`,
        );
        return rows.map((row) => ({ connectionId: row.id, storeId: row.store_id }));
      },
    };

    async function connect(storeId: string): Promise<string> {
      const { rows } = await h.owner.pool.query<{ id: string }>(
        `INSERT INTO connections (provider, label, store_id, shop_domain)
         VALUES ('shopify', 'Shop', $1, $2) RETURNING id`,
        [storeId, `${code('lbl')}.myshopify.com`],
      );
      return rows[0]?.id as string;
    }

    beforeAll(() => {
      service = new ChannelsService(h.app);
    });

    it('will not answer before the connectors module registered its source', async () => {
      await expect(service.storeLabelsByConnection(['c'])).rejects.toMatchObject({
        code: 'CONNECTION_STORES_NOT_REGISTERED',
      });
      service.registerConnectionStores(source);
    });

    it('answers by store code, names both languages, and leaves out what was not asked', async () => {
      const zed = await createStore(code('LBLZ'), { en: 'Zed', ar: 'زد' });
      const alpha = await createStore(code('LBLA'), { en: 'Alpha' });
      const other = await createStore(code('LBLO'), { en: 'Other' });
      const zedConnection = await connect(zed.storeId);
      const alphaConnection = await connect(alpha.storeId);
      await connect(other.storeId);

      const labels = await service.storeLabelsByConnection([
        zedConnection,
        alphaConnection,
        unknownConnection,
      ]);

      expect(labels.map((l) => l.connectionId)).toEqual([alphaConnection, zedConnection]);
      expect(labels[1]).toMatchObject({
        storeId: zed.storeId,
        storeName: { en: 'Zed', ar: 'زد' },
      });
      expect(labels[0]?.storeCode).toMatch(/^LBLA-/);
    });

    it('still labels a connection whose store is archived', async () => {
      const old = await createStore(code('LBLX'), { en: 'Archived' });
      const connection = await connect(old.storeId);
      await h.owner.pool.query('UPDATE stores SET archived_at = now() WHERE id = $1', [
        old.storeId,
      ]);

      expect(await service.storeLabelsByConnection([connection])).toEqual([
        expect.objectContaining({ connectionId: connection, storeName: { en: 'Archived' } }),
      ]);
    });
  });
});
