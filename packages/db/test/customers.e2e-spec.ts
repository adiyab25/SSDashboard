import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0002, customers child (build plan item 13): the database guards on customers, their
// phones and external ids, and the merge history. The append only guards on customer_merges are
// in schema.e2e-spec.ts with the other append only tables.
describe('customers by phone (AC-27, AC-28)', () => {
  let name: string;
  let owner: pg.Client;
  let actor: string;
  let counter = 0;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
    actor = await insert('users', { name: 'Agent', email: 'agent@example.test' });
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
  });

  /** Inserts one row from a column map and returns its id. */
  async function insert(table: string, row: Record<string, unknown>): Promise<string> {
    const columns = Object.keys(row);
    const params = columns.map((_, index) => `$${index + 1}`);
    const values =
      columns.length === 0
        ? 'DEFAULT VALUES'
        : `(${columns.join(', ')}) VALUES (${params.join(', ')})`;
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO ${table} ${values} RETURNING id`,
      Object.values(row),
    );
    const inserted = rows[0];
    if (!inserted) throw new Error(`no row inserted into ${table}`);
    return inserted.id;
  }

  const customer = (row: Record<string, unknown> = {}) => insert('customers', row);

  function phone(): string {
    counter += 1;
    return `+2010${String(counter).padStart(8, '0')}`;
  }

  describe('customers', () => {
    it('refuses a customer merged into itself', async () => {
      const id = await customer();

      await expect(
        owner.query('UPDATE customers SET merged_into_id = id WHERE id = $1', [id]),
      ).rejects.toThrow(/customers_not_merged_into_self/);
    });

    it('needs a source exactly when a risk flag is set', async () => {
      await expect(customer({ risk_flag: 'refuser' })).rejects.toThrow(
        /customers_risk_flag_has_source/,
      );
      await expect(customer({ risk_flag_source: 'manual' })).rejects.toThrow(
        /customers_risk_flag_has_source/,
      );
      await customer({ risk_flag: 'fake', risk_flag_source: 'blacklist_import' });
    });
  });

  describe('customer phones', () => {
    it('refuses a second customer with an existing phone', async () => {
      const number = phone();
      await insert('customer_phones', {
        customer_id: await customer(),
        phone_e164: number,
        kind: 'mobile',
      });

      await expect(
        insert('customer_phones', {
          customer_id: await customer(),
          phone_e164: number,
          kind: 'mobile',
        }),
      ).rejects.toThrow(/customer_phones_phone_unique/);
    });

    it.each(['01001234567', '+0201001234567', '+20', '+20 100 123 4567'])(
      'refuses %s, which is not E.164',
      async (raw) => {
        await expect(
          insert('customer_phones', {
            customer_id: await customer(),
            phone_e164: raw,
            kind: 'mobile',
          }),
        ).rejects.toThrow(/customer_phones_e164/);
      },
    );

    it('keeps one primary phone per customer', async () => {
      const id = await customer();
      await insert('customer_phones', {
        customer_id: id,
        phone_e164: phone(),
        kind: 'mobile',
        is_primary: true,
      });
      await insert('customer_phones', { customer_id: id, phone_e164: phone(), kind: 'mobile' });

      await expect(
        insert('customer_phones', {
          customer_id: id,
          phone_e164: phone(),
          kind: 'mobile',
          is_primary: true,
        }),
      ).rejects.toThrow(/customer_phones_one_primary_unique/);
    });
  });

  describe('customer external ids', () => {
    async function issuers(): Promise<{ connection: string; channel: string }> {
      counter += 1;
      const store = await insert('stores', {
        code: `CX-${counter}`,
        name: { en: 'Store' },
        public_name: { en: 'Store' },
        kind: 'shopify',
      });
      const connection = await insert('connections', {
        provider: 'shopify',
        label: 'Shop',
        store_id: store,
      });
      const channel = await insert('channels', {
        code: `partner-${counter}`,
        name: { en: 'Partner' },
        kind: 'consignment_partner',
      });
      return { connection, channel };
    }

    it('needs exactly one of a connection and a channel', async () => {
      const { connection, channel } = await issuers();
      const id = await customer();

      await expect(
        insert('customer_external_ids', {
          customer_id: id,
          kind: 'partner_reference',
          external_id: 'R-1',
        }),
      ).rejects.toThrow(/customer_external_ids_one_issuer/);
      await expect(
        insert('customer_external_ids', {
          customer_id: id,
          kind: 'partner_reference',
          connection_id: connection,
          channel_id: channel,
          external_id: 'R-1',
        }),
      ).rejects.toThrow(/customer_external_ids_one_issuer/);
    });

    it('keeps an external id unique per issuer even though the other issuer is empty', async () => {
      const { connection, channel } = await issuers();
      const other = await issuers();
      const shopify = (customerId: string, connectionId: string) =>
        insert('customer_external_ids', {
          customer_id: customerId,
          kind: 'shopify_customer',
          connection_id: connectionId,
          external_id: '7001',
        });
      await shopify(await customer(), connection);
      // The same id issued by another Shopify store is another customer's id.
      await shopify(await customer(), other.connection);

      await expect(shopify(await customer(), connection)).rejects.toThrow(
        /customer_external_ids_issuer_unique/,
      );
      const partner = (customerId: string) =>
        insert('customer_external_ids', {
          customer_id: customerId,
          kind: 'partner_reference',
          channel_id: channel,
          external_id: 'P-9',
        });
      await partner(await customer());
      await expect(partner(await customer())).rejects.toThrow(
        /customer_external_ids_issuer_unique/,
      );
    });

    it('lets one customer hold two Shopify ids from two stores (one phone, two stores)', async () => {
      const first = await issuers();
      const second = await issuers();
      const id = await customer();
      for (const connection of [first.connection, second.connection]) {
        await insert('customer_external_ids', {
          customer_id: id,
          kind: 'shopify_customer',
          connection_id: connection,
          external_id: '8001',
        });
      }

      const { rows } = await owner.query<{ count: string }>(
        'SELECT count(*) FROM customer_external_ids WHERE customer_id = $1',
        [id],
      );
      expect(rows[0]?.count).toBe('2');
    });
  });

  describe('customer merges', () => {
    async function merge(row: Record<string, unknown> = {}): Promise<string> {
      return insert('customer_merges', {
        action: 'merge',
        survivor_id: await customer(),
        merged_id: await customer(),
        actor_id: actor,
        ...row,
      });
    }

    it('refuses an undo without the merge it undoes, and a merge that names one', async () => {
      const merged = await merge();
      await expect(merge({ action: 'undo' })).rejects.toThrow(/customer_merges_undo_names_merge/);
      await expect(merge({ undoes_merge_id: merged })).rejects.toThrow(
        /customer_merges_undo_names_merge/,
      );
    });

    /** The undo of a merge: the same two customers, pointing at it. */
    async function undoOf(mergeId: string): Promise<Record<string, unknown>> {
      const { rows } = await owner.query<{ survivor_id: string; merged_id: string }>(
        'SELECT survivor_id, merged_id FROM customer_merges WHERE id = $1',
        [mergeId],
      );
      return { action: 'undo', undoes_merge_id: mergeId, ...rows[0] };
    }

    it('undoes a merge at most once', async () => {
      const merged = await merge();
      await merge(await undoOf(merged));

      await expect(merge(await undoOf(merged))).rejects.toThrow(
        /customer_merges_undoes_merge_unique/,
      );
    });

    it('refuses an undo of another pair of customers', async () => {
      const merged = await merge();
      const undo = await undoOf(merged);

      await expect(merge({ ...undo, survivor_id: await customer() })).rejects.toThrow(
        /customer_merges_undo_matches/,
      );
      await expect(merge({ ...undo, merged_id: await customer() })).rejects.toThrow(
        /customer_merges_undo_matches/,
      );
      // The pair swapped is another merge, not this one's undo.
      await expect(
        merge({ ...undo, survivor_id: undo.merged_id, merged_id: undo.survivor_id }),
      ).rejects.toThrow(/customer_merges_undo_matches/);
    });

    it('refuses an undo that points at another undo', async () => {
      const merged = await merge();
      const undo = await undoOf(merged);
      const undoId = await merge(undo);

      await expect(merge({ ...undo, undoes_merge_id: undoId })).rejects.toThrow(
        /customer_merges_undo_matches/,
      );
    });

    it('refuses a merge of a customer into itself', async () => {
      const id = await customer();

      await expect(merge({ survivor_id: id, merged_id: id })).rejects.toThrow(
        /customer_merges_two_customers/,
      );
    });

    it('records the customers a merge repointed', async () => {
      const repointed = [await customer(), await customer()];
      const id = await merge({ repointed_ids: repointed });

      const { rows } = await owner.query<{ repointed_ids: string[] }>(
        'SELECT repointed_ids FROM customer_merges WHERE id = $1',
        [id],
      );
      expect(rows[0]?.repointed_ids).toEqual(repointed);
    });
  });
});
