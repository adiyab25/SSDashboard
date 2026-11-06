import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0002 amendment, feature level verify (2026-11-06): guards on the order, task, settlement,
// and code unique rules that the per table suites reach only through another check or not at all
// (found by listing every CHECK and UNIQUE constraint of the baseline and searching the tests for
// its name). Each case names the constraint it expects, so a dropped guard fails by name. One
// migrated scratch database for the file; every test makes its own rows.
describe('guards the per table suites do not name (AC-18, AC-21, AC-25, AC-26)', () => {
  let name: string;
  let owner: pg.Client;
  let mainStore: string;
  let manualChannel: string;
  let counter = 0;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
    mainStore = (await one<{ id: string }>("SELECT id FROM stores WHERE code = 'MAIN'")).id;
    manualChannel = (await one<{ id: string }>("SELECT id FROM channels WHERE code = 'manual'")).id;
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
  });

  async function one<T extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T> {
    const { rows } = await owner.query<T>(text, values);
    const row = rows[0];
    if (!row) throw new Error(`no row from: ${text}`);
    return row;
  }

  async function insert(table: string, row: Record<string, unknown>): Promise<string> {
    const columns = Object.keys(row);
    const params = columns.map((_, index) => `$${index + 1}`);
    return (
      await one<{ id: string }>(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${params.join(', ')}) RETURNING id`,
        Object.values(row),
      )
    ).id;
  }

  function next(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  describe('code unique rules', () => {
    it('keeps a store code, a channel code, and a settlement account code to one row each', async () => {
      const store = {
        code: next('DUP'),
        name: { en: 'S' },
        public_name: { en: 'S' },
        kind: 'internal',
      };
      await insert('stores', store);
      await expect(insert('stores', store)).rejects.toThrow(/stores_code_unique/);

      const channel = { code: next('DUP'), name: { en: 'C' }, kind: 'manual' };
      await insert('channels', channel);
      await expect(insert('channels', channel)).rejects.toThrow(/channels_code_unique/);

      const account = {
        code: next('DUP'),
        name: { en: 'A' },
        owner_type: 'carrier',
        owner_connection_id: await insert('connections', { provider: 'bosta', label: next('B') }),
      };
      await insert('settlement_accounts', account);
      await expect(
        insert('settlement_accounts', {
          ...account,
          owner_connection_id: await insert('connections', { provider: 'bosta', label: next('B') }),
        }),
      ).rejects.toThrow(/settlement_accounts_code_unique/);
    });
  });

  describe('order lines (AC-21)', () => {
    async function makeOrder(): Promise<string> {
      return insert('orders', {
        store_id: mainStore,
        channel_id: manualChannel,
        order_number: next('ORD'),
        placed_at: '2026-01-15T10:00:00Z',
        fulfillment_state: 'new',
        cash_state: 'unpaid',
        outcome: 'open',
        payment_method: 'cod',
      });
    }

    function line(orderId: string, overrides: Record<string, unknown>): Record<string, unknown> {
      counter += 1;
      return {
        order_id: orderId,
        position: counter,
        title: 'Linen shirt',
        quantity: 1,
        unit_price: '100.00',
        discount_amount: '0',
        net_amount: '100.00',
        tax_rate: '0',
        tax_amount: '0',
        gross_amount: '100.00',
        ...overrides,
      };
    }

    it.each([
      ['unit_price', '-1.00'],
      ['discount_amount', '-1.00'],
      ['net_amount', '-1.00'],
      ['tax_rate', '-1.00'],
      ['tax_amount', '-1.00'],
      ['prepaid_amount', '-1.00'],
      ['credit_applied_amount', '-1.00'],
      ['unit_cost', '-0.0001'],
    ])('refuses a negative %s', async (column, value) => {
      const orderId = await makeOrder();
      await expect(insert('order_lines', line(orderId, { [column]: value }))).rejects.toThrow(
        /order_lines_amounts_not_negative/,
      );
    });

    it('takes a zero or an absent unit cost', async () => {
      const orderId = await makeOrder();
      await insert('order_lines', line(orderId, { unit_cost: '0' }));
      await insert('order_lines', line(orderId, {}));
    });

    // Fixed at the feature 4 close: the schema has a single column self key on
    // split_from_line_id (spec 0002 orders child: `split_from_line_id fk null (self)`), not a
    // composite key on (id, order_id), so a split line on another order is not refused by the
    // database today. The case asserts the key that exists; the cross order guard is a follow up.
    it('refuses a split line whose original line does not exist (the self key)', async () => {
      const first = await makeOrder();
      const parent = await insert('order_lines', line(first, {}));
      await expect(
        insert(
          'order_lines',
          line(first, { split_from_line_id: '0192f7a0-0000-7000-8000-00000000dead' }),
        ),
      ).rejects.toThrow(/order_lines_split_from_line_id_order_lines_id_fk/);
      await insert('order_lines', line(first, { split_from_line_id: parent }));
    });
  });

  describe('tasks (AC-26)', () => {
    function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      counter += 1;
      return {
        type: 'confirmation.call',
        linked_type: 'order',
        linked_id: `0192f7a0-0000-7000-8000-${String(counter).padStart(12, '0')}`,
        owner_hat: 'support',
        created_by_type: 'system_job',
        ...overrides,
      };
    }

    it('refuses a closer on a task that is still open', async () => {
      const person = (
        await one<{ id: string }>(
          "INSERT INTO users (name, email) VALUES ('Closer', 'closer@example.test') RETURNING id",
        )
      ).id;
      await expect(insert('tasks', task({ closed_by: person }))).rejects.toThrow(
        /tasks_closed_by_when_closed/,
      );
      await insert(
        'tasks',
        task({ status: 'cancelled', closed_at: '2026-01-15T10:00:00Z', closed_by: person }),
      );
    });

    it('takes an outcome code only in the lowercase dotted shape', async () => {
      const closed = { status: 'done', closed_at: '2026-01-15T10:00:00Z' };
      for (const bad of ['Not Valid', 'UPPER', '9lead', 'a'.repeat(65)]) {
        await expect(insert('tasks', task({ ...closed, outcome_code: bad }))).rejects.toThrow(
          /tasks_outcome_code_shape/,
        );
      }
      await insert('tasks', task({ ...closed, outcome_code: 'confirmed.by_phone' }));
      await insert('tasks', task({ ...closed, outcome_code: 'a'.repeat(64) }));
    });
  });

  describe('settlement match codes (AC-25)', () => {
    async function makeLine(): Promise<string> {
      const connection = await insert('connections', { provider: 'bosta', label: next('Bosta') });
      const account = await insert('settlement_accounts', {
        code: next('ACC'),
        name: { en: 'A' },
        owner_type: 'carrier',
        owner_connection_id: connection,
      });
      const statement = await insert('settlement_statements', {
        account_id: account,
        kind: 'carrier_file',
        external_reference: next('REF'),
      });
      return insert('settlement_lines', {
        account_id: account,
        statement_id: statement,
        line_kind: 'cod_collected',
        amount: '10.00',
        external_line_ref: next('L'),
        occurred_on: '2026-01-05',
      });
    }

    it('takes a reason code only in the lowercase dotted shape', async () => {
      const lineId = await makeLine();
      await expect(
        insert('settlement_line_matches', {
          line_id: lineId,
          result: 'unmatched',
          reason_code: 'Bad Reason',
          matched_by_type: 'rule',
        }),
      ).rejects.toThrow(/settlement_line_matches_reason_code_shape/);
      await insert('settlement_line_matches', {
        line_id: lineId,
        result: 'unmatched',
        reason_code: 'no_order_yet',
        matched_by_type: 'rule',
      });
    });

    it('takes an account code only in the lowercase dotted shape', async () => {
      const lineId = await makeLine();
      await expect(
        insert('settlement_line_matches', {
          line_id: lineId,
          result: 'accounted',
          account_code: 'Carrier Deposit',
          matched_by_type: 'rule',
        }),
      ).rejects.toThrow(/settlement_line_matches_account_code_shape/);
      await insert('settlement_line_matches', {
        line_id: lineId,
        result: 'accounted',
        account_code: 'carrier_deposit',
        matched_by_type: 'rule',
      });
    });
  });
});
