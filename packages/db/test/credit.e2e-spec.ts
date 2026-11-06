import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0002, customers, credit, and tasks child (build plan item 14): the database guards on the
// customer credit ledger. The locked balance rules are feature 28's (CreditService). One migrated
// scratch database for the file; each test makes its own rows.
describe('the customer credit ledger (AC-24, AC-33)', () => {
  let name: string;
  let url: string;
  let owner: pg.Client;
  let app: pg.Client;
  let customer: string;
  let order: string;
  let orderLine: string;
  let secondLine: string;
  let otherOrder: string;
  let otherCustomer: string;
  let person: string;
  let counter = 0;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    url = db.url;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    app = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await app.connect();
    await app.query(`SET ROLE ${APP_ROLE}`);

    customer = (await one<{ id: string }>('INSERT INTO customers DEFAULT VALUES RETURNING id')).id;
    otherCustomer = (await one<{ id: string }>('INSERT INTO customers DEFAULT VALUES RETURNING id'))
      .id;
    person = (
      await one<{ id: string }>(
        "INSERT INTO users (name, email) VALUES ('Agent', 'agent@example.test') RETURNING id",
      )
    ).id;
    order = (
      await one<{ id: string }>(
        `INSERT INTO orders (store_id, channel_id, order_number, placed_at, fulfillment_state, cash_state,
                             outcome, payment_method, lines_gross_amount, total_amount, cod_expected_amount, cod_due_amount)
         VALUES ((SELECT id FROM stores WHERE code = 'MAIN'), (SELECT id FROM channels WHERE code = 'manual'),
                 'CR-1', '2026-01-15T10:00:00Z', 'delivered', 'unpaid', 'kept', 'cod', 1000, 1000, 1000, 1000)
         RETURNING id`,
      )
    ).id;
    orderLine = (
      await one<{ id: string }>(
        `INSERT INTO order_lines (order_id, position, title, quantity, unit_price, net_amount, tax_rate, tax_amount, gross_amount)
         VALUES ($1, 1, 'Linen shirt', 2, 500, 877.19, 14, 122.81, 1000) RETURNING id`,
        [order],
      )
    ).id;
    secondLine = (
      await one<{ id: string }>(
        `INSERT INTO order_lines (order_id, position, title, quantity, unit_price, net_amount, tax_rate, tax_amount, gross_amount)
         VALUES ($1, 2, 'Linen trousers', 1, 0, 0, 14, 0, 0) RETURNING id`,
        [order],
      )
    ).id;
    otherOrder = (
      await one<{ id: string }>(
        `INSERT INTO orders (store_id, channel_id, order_number, placed_at, fulfillment_state, cash_state, outcome, payment_method)
         VALUES ((SELECT id FROM stores WHERE code = 'MAIN'), (SELECT id FROM channels WHERE code = 'manual'),
                 'CR-2', '2026-01-15T10:00:00Z', 'new', 'nothing_to_collect', 'open', 'none') RETURNING id`,
      )
    ).id;
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await dropScratchDatabase(name);
  });

  async function one<T extends pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
    client: pg.Client = owner,
  ): Promise<T> {
    const { rows } = await client.query<T>(text, values);
    const row = rows[0];
    if (!row) throw new Error(`no row from: ${text}`);
    return row;
  }

  /** A valid 500.00 cod_cash return credit for one unit of the line, unless overridden. */
  function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    counter += 1;
    return {
      posting_id: '0192f7a0-0000-7000-8000-' + String(counter).padStart(12, '0'),
      customer_id: customer,
      kind: 'return_credit',
      funding: 'cod_cash',
      amount: '500.00',
      order_id: order,
      order_line_id: orderLine,
      quantity: 1,
      reason_code: 'size',
      actor_type: 'system_job',
      idempotency_key: `credit-${counter}`,
      request_hash: 'hash-1',
      effective_at: '2026-01-20T10:00:00Z',
      ...overrides,
    };
  }

  /** Inserts one credit entry and returns its id. */
  async function insert(row: Record<string, unknown>, client: pg.Client = owner): Promise<string> {
    const columns = Object.keys(row);
    const params = columns.map((_, index) => `$${index + 1}`);
    return (
      await one<{ id: string }>(
        `INSERT INTO credit_entries (${columns.join(', ')}) VALUES (${params.join(', ')}) RETURNING id`,
        Object.values(row),
        client,
      )
    ).id;
  }

  it('lets the application role post and read an entry, and stamps its operating day', async () => {
    const id = await insert(entry({ effective_at: '2026-01-20T22:30:00Z' }), app);

    const row = await one<{ day: string }>(
      "SELECT to_char(operating_day, 'YYYY-MM-DD') AS day FROM credit_entries WHERE id = $1",
      [id],
      app,
    );
    // 00:30 in Cairo (UTC+2) on the 21st.
    expect(row.day).toBe('2026-01-21');
  });

  describe('table checks', () => {
    it.each([
      [
        'a return credit without a line',
        { order_line_id: null },
        'credit_entries_return_credit_has_line',
      ],
      [
        'a return credit without a quantity',
        { quantity: null },
        'credit_entries_return_credit_has_line',
      ],
      ['a negative return credit', { amount: '-500.00' }, 'credit_entries_sign_by_kind'],
      [
        'a positive order consumption',
        { kind: 'order_consumption', order_line_id: null, quantity: null },
        'credit_entries_sign_by_kind',
      ],
      [
        'goodwill funded cod_cash',
        { kind: 'goodwill', order_line_id: null, quantity: null },
        'credit_entries_bonus_and_goodwill_credit_only',
      ],
      [
        'a retention bonus funded gateway',
        { kind: 'retention_bonus', funding: 'gateway', order_line_id: null, quantity: null },
        'credit_entries_bonus_and_goodwill_credit_only',
      ],
      [
        'a refund payout funded credit_only',
        {
          kind: 'refund_payout',
          funding: 'credit_only',
          amount: '-100.00',
          payout_method: 'instapay_or_transfer',
        },
        'credit_entries_payout_never_credit_only',
      ],
      [
        'a refund payout without a method',
        { kind: 'refund_payout', amount: '-100.00' },
        'credit_entries_payout_method_on_payout',
      ],
      [
        'a payout method on another kind',
        { payout_method: 'gateway_refund' },
        'credit_entries_payout_method_on_payout',
      ],
      ['a zero amount', { amount: '0' }, 'credit_entries_amount_not_zero'],
      [
        'an order consumption without an order',
        { kind: 'order_consumption', amount: '-100.00', order_id: null, order_line_id: null },
        'credit_entries_consumption_has_order',
      ],
      [
        'a consumption release without an order',
        { kind: 'consumption_release', order_id: null, order_line_id: null },
        'credit_entries_consumption_has_order',
      ],
      [
        'a return not collected without an exchange',
        { kind: 'return_not_collected', amount: '-100.00' },
        'credit_entries_not_collected_has_exchange',
      ],
      ['a person without an actor', { actor_type: 'person' }, 'credit_entries_person_has_actor'],
      [
        'a typed note as the reason',
        { reason_code: 'She said so' },
        'credit_entries_reason_code_shape',
      ],
    ])('refuses %s', async (_case, overrides, constraint) => {
      await expect(insert(entry(overrides))).rejects.toThrow(new RegExp(constraint));
    });

    it('accepts each kind with its sign and funding', async () => {
      const exchange = '0192f7a0-0000-7000-8000-00000000e001';
      const accepted: Record<string, unknown>[] = [
        entry(),
        entry({ kind: 'shipping_credit', order_line_id: null, quantity: null, amount: '50.00' }),
        entry({
          kind: 'order_consumption',
          funding: 'credit_only',
          amount: '-200.00',
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'refund_payout',
          amount: '-100.00',
          payout_method: 'carrier_cash_refund',
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'retention_bonus',
          funding: 'credit_only',
          amount: '200.00',
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'goodwill',
          funding: 'credit_only',
          amount: '50.00',
          actor_type: 'person',
          actor_id: person,
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'opening_balance',
          funding: 'credit_only',
          amount: '75.00',
          actor_type: 'import',
          order_id: null,
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'inspection_reversal',
          amount: '-500.00',
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'return_not_collected',
          amount: '-500.00',
          exchange_id: exchange,
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'consumption_release',
          funding: 'credit_only',
          amount: '200.00',
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'debt_payment',
          amount: '300.00',
          order_id: null,
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'adjustment',
          amount: '-10.00',
          order_id: null,
          order_line_id: null,
          quantity: null,
        }),
        entry({
          kind: 'adjustment',
          amount: '10.00',
          order_id: null,
          order_line_id: null,
          quantity: null,
        }),
      ];

      for (const row of accepted) await insert(row);
    });

    it.each([
      [
        'a gateway payout by InstaPay',
        { funding: 'gateway', payout_method: 'instapay_or_transfer' },
      ],
      [
        'a cash payout through the gateway',
        { funding: 'cod_cash', payout_method: 'gateway_refund' },
      ],
      [
        'a transfer payout through the gateway',
        { funding: 'instapay_or_transfer', payout_method: 'gateway_refund' },
      ],
    ])('refuses %s (payout matching)', async (_case, overrides) => {
      const payout = {
        kind: 'refund_payout',
        amount: '-100.00',
        order_line_id: null,
        quantity: null,
      };

      await expect(insert(entry({ ...payout, ...overrides }))).rejects.toThrow(
        /credit_entries_payout_method_matches_funding/,
      );
    });

    it('accepts gateway money back through the gateway, and cash by Bosta or InstaPay', async () => {
      const payout = {
        kind: 'refund_payout',
        amount: '-100.00',
        order_line_id: null,
        quantity: null,
      };

      await insert(entry({ ...payout, funding: 'gateway', payout_method: 'gateway_refund' }));
      await insert(entry({ ...payout, funding: 'cod_cash', payout_method: 'carrier_cash_refund' }));
      await insert(
        entry({
          ...payout,
          funding: 'instapay_or_transfer',
          payout_method: 'instapay_or_transfer',
        }),
      );
    });

    it('keeps a line on its own order', async () => {
      await expect(insert(entry({ order_id: null }))).rejects.toThrow(
        /credit_entries_line_needs_order/,
      );
      await expect(insert(entry({ order_id: otherOrder }))).rejects.toThrow(/foreign key/);
    });

    it('refuses an idempotency key that is not an id shaped key', async () => {
      await expect(insert(entry({ idempotency_key: 'call 0100 123 4567' }))).rejects.toThrow(
        /credit_entries_idempotency_key_shape/,
      );
      await expect(insert(entry({ idempotency_key: 'x'.repeat(201) }))).rejects.toThrow(
        /credit_entries_idempotency_key_shape/,
      );
    });

    it.each([
      ['another posting id', { posting_id: '0192f7a0-0000-7000-8000-00000000ffff' }],
      ['another customer', { customer_id: 'OTHER' }],
      ['another request hash', { request_hash: 'hash-2' }],
    ])('refuses an entry that joins a posting with %s', async (_case, overrides) => {
      const first = entry();
      await insert(first);
      const values = Object.fromEntries(
        Object.entries(overrides).map(([key, value]) => [
          key,
          value === 'OTHER' ? otherCustomer : value,
        ]),
      );

      await expect(
        insert(
          entry({
            posting_id: first.posting_id,
            idempotency_key: first.idempotency_key,
            funding: 'credit_only',
            amount: '100.00',
            ...values,
          }),
        ),
      ).rejects.toThrow(/credit_entries_posting_holds_together/);
    });

    it('keeps one entry per funding in a posting', async () => {
      const first = entry();
      await insert(first);
      const posting = { posting_id: first.posting_id, idempotency_key: first.idempotency_key };

      await insert(entry({ ...posting, funding: 'credit_only', amount: '100.00' }));
      await expect(insert(entry({ ...posting, amount: '1.00' }))).rejects.toThrow(
        /credit_entries_posting_funding_unique/,
      );
    });
  });

  describe('reversals (domain review M2)', () => {
    it('passes a reversal of a return credit with a negative amount (the inverted sign)', async () => {
      const original = await insert(entry());

      await insert(entry({ amount: '-500.00', reverses_entry_id: original }));
    });

    // The mirror trigger runs before the checks, so it is the one that names the refusal.
    it('refuses a reversal with the original sign', async () => {
      const original = await insert(entry());

      await expect(insert(entry({ reverses_entry_id: original }))).rejects.toThrow(
        /credit_entries_reversal_mirrors_original/,
      );
    });

    it('checks the inverted sign even without the trigger', async () => {
      await owner.query('BEGIN');
      try {
        await owner.query(
          'ALTER TABLE credit_entries DISABLE TRIGGER credit_entries_reversal_mirrors_original',
        );
        const original = await insert(entry());

        await expect(insert(entry({ reverses_entry_id: original }))).rejects.toThrow(
          /credit_entries_sign_by_kind/,
        );
      } finally {
        await owner.query('ROLLBACK');
      }
    });

    it('refuses a reversal of a reversal', async () => {
      const original = await insert(entry());
      const reversal = await insert(entry({ amount: '-500.00', reverses_entry_id: original }));

      await expect(insert(entry({ reverses_entry_id: reversal }))).rejects.toThrow(
        /credit_entries_no_reversal_of_reversal/,
      );
    });

    it('reverses an entry at most once', async () => {
      const original = await insert(entry());
      await insert(entry({ amount: '-500.00', reverses_entry_id: original }));

      await expect(
        insert(entry({ amount: '-500.00', reverses_entry_id: original })),
      ).rejects.toThrow(/credit_entries_reverses_entry_unique/);
    });

    it.each([
      ['another funding', { funding: 'gateway' }],
      ['another amount', { amount: '-400.00' }],
      ['another kind', { kind: 'shipping_credit', order_line_id: null, quantity: null }],
    ])('refuses a reversal with %s', async (_case, overrides) => {
      const original = await insert(entry());

      await expect(
        insert(entry({ amount: '-500.00', reverses_entry_id: original, ...overrides })),
      ).rejects.toThrow(/credit_entries_reversal_mirrors_original/);
    });

    it.each([
      ['another customer', { customer_id: 'OTHER_CUSTOMER' }],
      ['another line', { order_line_id: 'SECOND_LINE' }],
      ['another quantity', { quantity: 2 }],
      ['another exchange', { exchange_id: '0192f7a0-0000-7000-8000-00000000e002' }],
    ])(
      'refuses a reversal of a return credit with %s (security review MJ1)',
      async (_case, overrides) => {
        const original = await insert(entry());
        const values = Object.fromEntries(
          Object.entries(overrides).map(([key, value]) => [
            key,
            value === 'OTHER_CUSTOMER'
              ? otherCustomer
              : value === 'SECOND_LINE'
                ? secondLine
                : value,
          ]),
        );

        await expect(
          insert(entry({ amount: '-500.00', reverses_entry_id: original, ...values })),
        ).rejects.toThrow(/credit_entries_reversal_mirrors_original/);
      },
    );

    it('pins a reversal to its original customer by the composite key, even without the trigger', async () => {
      await owner.query('BEGIN');
      try {
        await owner.query(
          'ALTER TABLE credit_entries DISABLE TRIGGER credit_entries_reversal_mirrors_original',
        );
        const original = await insert(entry());

        await expect(
          insert(
            entry({ amount: '-500.00', reverses_entry_id: original, customer_id: otherCustomer }),
          ),
        ).rejects.toThrow(/foreign key/);
      } finally {
        await owner.query('ROLLBACK');
      }
    });

    it('refuses a payout reversal with another payout method', async () => {
      const payout = { kind: 'refund_payout', order_line_id: null, quantity: null };
      const original = await insert(
        entry({ ...payout, amount: '-100.00', payout_method: 'instapay_or_transfer' }),
      );

      await expect(
        insert(
          entry({
            ...payout,
            amount: '100.00',
            payout_method: 'carrier_cash_refund',
            reverses_entry_id: original,
          }),
        ),
      ).rejects.toThrow(/credit_entries_reversal_mirrors_original/);
    });

    it('refuses an entry that reverses itself', async () => {
      const id = '0192f7a0-0000-7000-8000-00000000aaaa';

      await expect(insert(entry({ id, amount: '-500.00', reverses_entry_id: id }))).rejects.toThrow(
        /credit_entries_not_reversing_self/,
      );
    });

    it('reverses a failed payout back to a positive entry with its method', async () => {
      const payout = await insert(
        entry({
          kind: 'refund_payout',
          amount: '-100.00',
          payout_method: 'instapay_or_transfer',
          order_line_id: null,
          quantity: null,
        }),
      );

      await insert(
        entry({
          kind: 'refund_payout',
          amount: '100.00',
          payout_method: 'instapay_or_transfer',
          order_line_id: null,
          quantity: null,
          reverses_entry_id: payout,
        }),
      );
    });
  });

  // Security review S6 and S12, review R6 and R16: two connections as the app role, the second one
  // started while the first one's transaction is still open.
  describe('concurrent writers (S6, S12, R6, R16)', () => {
    async function appClient(): Promise<pg.Client> {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query(`SET ROLE ${APP_ROLE}`);
      return client;
    }

    /** The backend process id of one connection. */
    async function pidOf(client: pg.Client): Promise<number> {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error('no backend pid');
      return pid;
    }

    /**
     * Waits until the session `pid` waits on any lock, or the given promise settles first. Review
     * R20: only that session's waits count, so another suite's lock never answers for it.
     */
    async function blockedOnLock(pending: Promise<unknown>, pid: number): Promise<boolean> {
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      const deadline = Date.now() + 5_000;
      while (!settled && Date.now() < deadline) {
        const { rows } = await owner.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND NOT granted',
          [pid],
        );
        if ((rows[0]?.n ?? 0) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    }

    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

    // The exclusion constraint waits for the first writer's uncommitted entry and then refuses, at
    // every isolation level (REPEATABLE READ included, S12), without a lock per entry (R16).
    it.each(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'])(
      'never commits a posting split by a second %s transaction while the first one is open',
      async (isolation) => {
        const [first, second] = [await appClient(), await appClient()];
        try {
          const original = entry();
          await first.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          await second.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          // Both transactions take their snapshot before either writes.
          await first.query('SELECT 1');
          await second.query('SELECT 1');
          // Read before the second session blocks: a busy client queues every later query.
          const secondPid = await pidOf(second);
          await insert(original, first);

          // Another posting under the same key, on another funding, so the funding unique key
          // does not serialize the two: only the posting guard can see the split.
          const pending = insert(
            entry({
              idempotency_key: original.idempotency_key,
              funding: 'credit_only',
              amount: '100.00',
            }),
            second,
          ).then(() => second.query('COMMIT').then(() => 'committed', message), message);

          expect(await blockedOnLock(pending, secondPid)).toBe(true);
          await first.query('COMMIT');

          expect(await pending).toMatch(
            /credit_entries_posting_holds_together|could not serialize access/,
          );
          const { rows } = await owner.query<{ postings: number }>(
            'SELECT count(DISTINCT posting_id)::int AS postings FROM credit_entries WHERE idempotency_key = $1',
            [original.idempotency_key],
          );
          expect(rows).toEqual([{ postings: 1 }]);
        } finally {
          await second.query('ROLLBACK').catch(() => undefined);
          await first.end();
          await second.end();
        }
      },
    );

    // Review R16: the old guard took one lock per entry until commit and a 20,000 entry insert ran
    // out of shared memory (max_locks_per_transaction 64). The constraint takes none per entry.
    it('writes 20,000 entries in one statement without filling the lock table', async () => {
      const writer = await appClient();
      try {
        const { rowCount } = await writer.query(
          `WITH c AS (INSERT INTO customers (name) SELECT 'Bulk ' || g FROM generate_series(1, 20000) g RETURNING id)
           INSERT INTO credit_entries (posting_id, customer_id, kind, funding, amount, reason_code,
                                       actor_type, idempotency_key, request_hash, effective_at)
           SELECT gen_random_uuid(), c.id, 'opening_balance', 'credit_only', 50, 'opening', 'import',
                  'bulk-' || c.id, 'seed', now()
           FROM c`,
        );
        expect(rowCount).toBe(20_000);
      } finally {
        await writer.end();
      }
    });

    it('refuses a reversal of an original the statement cannot see yet, rather than leave it to the foreign key', async () => {
      const [first, second] = [await appClient(), await appClient()];
      try {
        await first.query('BEGIN');
        const original = await insert(entry(), first);

        await expect(
          insert(entry({ amount: '-500.00', reverses_entry_id: original }), second),
        ).rejects.toThrow(/credit_entries_reverses_existing_entry/);
        await first.query('COMMIT');

        await insert(entry({ amount: '-500.00', reverses_entry_id: original }), second);
      } finally {
        await first.end();
        await second.end();
      }
    });
  });

  describe('append only (AC-33)', () => {
    it('refuses UPDATE and DELETE for the application role and the owner', async () => {
      const id = await insert(entry());

      for (const statement of [
        'UPDATE credit_entries SET amount = 1 WHERE id = $1',
        'DELETE FROM credit_entries WHERE id = $1',
      ]) {
        await expect(app.query(statement, [id])).rejects.toThrow(/permission denied/);
        await expect(owner.query(statement, [id])).rejects.toThrow(/append only/);
      }
    });
  });
});
