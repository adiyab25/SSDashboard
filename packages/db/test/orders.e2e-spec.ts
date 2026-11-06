import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0002, orders child (build plan item 13): the database guards on stores, channels,
// connections, outbound commands, orders, order lines, and order events. One migrated scratch
// database for the file; each test makes its own rows.
describe('stores, channels, connections, and orders (AC-18, AC-21, AC-23, AC-35)', () => {
  let name: string;
  let owner: pg.Client;
  let app: pg.Client;
  let mainStore: string;
  let manualChannel: string;
  let counter = 0;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    app = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await app.connect();
    await app.query(`SET ROLE ${APP_ROLE}`);
    mainStore = (await one<{ id: string }>("SELECT id FROM stores WHERE code = 'MAIN'")).id;
    manualChannel = (await one<{ id: string }>("SELECT id FROM channels WHERE code = 'manual'")).id;
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

  /** Inserts one row from a column map and returns its id. */
  async function insert(
    table: string,
    row: Record<string, unknown>,
    client: pg.Client = owner,
  ): Promise<string> {
    const columns = Object.keys(row);
    const params = columns.map((_, index) => `$${index + 1}`);
    const inserted = await one<{ id: string }>(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${params.join(', ')}) RETURNING id`,
      Object.values(row),
      client,
    );
    return inserted.id;
  }

  function next(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  async function makeStore(kind: 'shopify' | 'internal' = 'shopify'): Promise<string> {
    return insert('stores', {
      code: next('ST'),
      name: { en: 'Store' },
      public_name: { en: 'Store' },
      kind,
    });
  }

  /** A valid COD sale: 1,000.00 of lines plus 50.00 shipping, all collected by the courier. */
  function sale(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      store_id: mainStore,
      channel_id: manualChannel,
      order_number: next('ORD'),
      type: 'sale',
      placed_at: '2026-01-15T10:00:00Z',
      fulfillment_state: 'new',
      cash_state: 'unpaid',
      outcome: 'open',
      payment_method: 'cod',
      lines_gross_amount: '1000.00',
      shipping_charged_amount: '50.00',
      total_amount: '1050.00',
      cod_expected_amount: '1050.00',
      cod_due_amount: '1050.00',
      ...overrides,
    };
  }

  /** A gifted order: nothing charged, nothing to collect, with a reason. */
  function gift(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return sale({
      type: 'gifted',
      cash_state: 'nothing_to_collect',
      payment_method: 'none',
      lines_gross_amount: '0',
      shipping_charged_amount: '0',
      total_amount: '0',
      cod_expected_amount: '0',
      cod_due_amount: '0',
      gift_reason_code: 'influencer',
      ...overrides,
    });
  }

  /** A valid line of one piece at 1,000.00 gross with 14% VAT. */
  function line(orderId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    counter += 1;
    return {
      order_id: orderId,
      position: counter,
      title: 'Linen shirt',
      quantity: 1,
      unit_price: '1000.00',
      discount_amount: '0',
      net_amount: '877.19',
      tax_rate: '14.00',
      tax_amount: '122.81',
      gross_amount: '1000.00',
      ...overrides,
    };
  }

  describe('stores and channels', () => {
    it('seeds the internal MAIN store and the manual channel that lands in it', async () => {
      const store = await one<{ kind: string; en: string; ar: string }>(
        "SELECT kind, name->>'en' AS en, name->>'ar' AS ar FROM stores WHERE code = 'MAIN'",
      );
      expect(store.kind).toBe('internal');
      expect(store.en).not.toBe('');
      expect(store.ar).not.toBe('');
      const channel = await one<{ kind: string; default_store_id: string }>(
        "SELECT kind, default_store_id FROM channels WHERE code = 'manual'",
      );
      expect(channel).toEqual({ kind: 'manual', default_store_id: mainStore });
    });

    it('stores #1001 in two stores and refuses a second #1001 in one store', async () => {
      const first = await makeStore();
      const second = await makeStore();
      await insert('orders', sale({ store_id: first, order_number: '#1001' }));
      await insert('orders', sale({ store_id: second, order_number: '#1001' }));

      await expect(
        insert('orders', sale({ store_id: first, order_number: '#1001' })),
      ).rejects.toThrow(/orders_store_number_unique/);
    });
  });

  describe('connections (AC-18)', () => {
    it('refuses a Shopify connection without a store', async () => {
      await expect(insert('connections', { provider: 'shopify', label: 'Shop' })).rejects.toThrow(
        /connections_shopify_needs_store/,
      );
    });

    it('refuses a second Shopify connection on one store', async () => {
      const store = await makeStore();
      await insert('connections', { provider: 'shopify', label: 'Shop', store_id: store });

      await expect(
        insert('connections', { provider: 'shopify', label: 'Again', store_id: store }),
      ).rejects.toThrow(/connections_shopify_store_unique/);
    });

    it('inserts a Bosta connection with and without a store, and a gateway connection', async () => {
      const store = await makeStore();
      await insert('connections', { provider: 'bosta', label: 'Bosta all stores' });
      await insert('connections', { provider: 'bosta', label: 'Bosta one store', store_id: store });
      await insert('connections', { provider: 'gateway', label: 'Paymob' });
      // A carrier on a store with a Shopify connection is not a second Shopify connection.
      await insert('connections', { provider: 'shopify', label: 'Shop', store_id: store });
      await insert('connections', { provider: 'bosta', label: 'Bosta again', store_id: store });
    });
  });

  describe('outbound commands (AC-35)', () => {
    async function command(overrides: Record<string, unknown>): Promise<string> {
      const connection = await insert('connections', { provider: 'bosta', label: 'Bosta' });
      return insert('outbound_commands', {
        connection_id: connection,
        kind: 'shopify.order_edit',
        linked_type: 'order',
        linked_id: '018f0000-0000-7000-8000-000000000001',
        payload: {},
        idempotency_key: next('cmd'),
        ...overrides,
      });
    }

    it('refuses a resolved command without a resolution, and a resolution before resolved', async () => {
      await expect(command({ sync_state: 'resolved' })).rejects.toThrow(
        /outbound_commands_resolution_when_resolved/,
      );
      await expect(command({ sync_state: 'failed', resolution: 'retried' })).rejects.toThrow(
        /outbound_commands_resolution_when_resolved/,
      );
      await command({
        sync_state: 'resolved',
        resolution: 'fixed_in_provider',
        resolved_at: '2026-01-15T10:00:00Z',
      });
    });

    it('sets resolved_at exactly when the command is resolved', async () => {
      await expect(command({ sync_state: 'resolved', resolution: 'retried' })).rejects.toThrow(
        /outbound_commands_resolved_at_when_resolved/,
      );
      await expect(
        command({ sync_state: 'failed', resolved_at: '2026-01-15T10:00:00Z' }),
      ).rejects.toThrow(/outbound_commands_resolved_at_when_resolved/);
    });

    it('refuses a negative attempt count', async () => {
      await expect(command({ attempts: -1 })).rejects.toThrow(
        /outbound_commands_attempts_not_negative/,
      );
    });

    it('refuses DELETE and TRUNCATE from the application role, which resolves instead', async () => {
      const id = await command({ sync_state: 'failed', failure_reason: 'timeout' });

      await expect(app.query('DELETE FROM outbound_commands WHERE id = $1', [id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query('TRUNCATE outbound_commands')).rejects.toThrow(/permission denied/);
      await app.query(
        "UPDATE outbound_commands SET sync_state = 'resolved', resolution = 'retried', resolved_at = now() WHERE id = $1",
        [id],
      );
    });

    it('keeps an idempotency key unique', async () => {
      const key = next('cmd');
      await command({ idempotency_key: key });

      await expect(command({ idempotency_key: key })).rejects.toThrow(
        /outbound_commands_idempotency_key_unique/,
      );
    });
  });

  describe('orders (AC-21, AC-23)', () => {
    it('lets the application role insert an order, a line, and an event', async () => {
      const orderId = await insert('orders', sale(), app);
      await insert('order_lines', line(orderId), app);
      await insert(
        'order_events',
        {
          order_id: orderId,
          machine: 'fulfillment',
          to_state: 'new',
          actor_type: 'system_job',
          occurred_at: '2026-01-15T10:00:00Z',
        },
        app,
      );
    });

    it('refuses a gifted order with a line gross or a shipping charge, or without a reason', async () => {
      await expect(
        insert(
          'orders',
          gift({
            lines_gross_amount: '500.00',
            total_amount: '500.00',
            cod_expected_amount: '500.00',
          }),
        ),
      ).rejects.toThrow(/orders_gifted_total_zero/);
      await expect(
        insert(
          'orders',
          gift({
            shipping_charged_amount: '50.00',
            total_amount: '50.00',
            cod_expected_amount: '50.00',
          }),
        ),
      ).rejects.toThrow(/orders_gifted_total_zero/);
      // Even a total left at 0 by mistake does not hide a charged line.
      await expect(insert('orders', gift({ lines_gross_amount: '500.00' }))).rejects.toThrow(
        /orders_gifted_total_zero|orders_total_is_lines_plus_shipping/,
      );
      await expect(insert('orders', gift({ gift_reason_code: null }))).rejects.toThrow(
        /orders_gifted_total_zero/,
      );
    });

    it('takes a gifted line at its retail price with an equal discount', async () => {
      const orderId = await insert('orders', gift());

      await insert(
        'order_lines',
        line(orderId, {
          unit_price: '500.00',
          discount_amount: '500.00',
          net_amount: '0',
          tax_amount: '0',
          gross_amount: '0',
        }),
      );
    });

    it('needs original_order_id exactly on an exchange replacement', async () => {
      const original = await insert('orders', sale());
      await expect(insert('orders', sale({ type: 'exchange_replacement' }))).rejects.toThrow(
        /orders_replacement_has_original/,
      );
      await expect(insert('orders', sale({ original_order_id: original }))).rejects.toThrow(
        /orders_replacement_has_original/,
      );
      await insert('orders', sale({ type: 'exchange_replacement', original_order_id: original }));
    });

    it('needs a relation exactly when a related order is named', async () => {
      const duplicate = await insert('orders', sale());
      await expect(insert('orders', sale({ related_order_id: duplicate }))).rejects.toThrow(
        /orders_related_order_pair/,
      );
      await expect(
        insert('orders', sale({ related_order_relation: 'duplicate_of' })),
      ).rejects.toThrow(/orders_related_order_pair/);
      await insert(
        'orders',
        sale({ related_order_id: duplicate, related_order_relation: 'duplicate_of' }),
      );
    });

    it('refuses a cod_expected_amount that is not total minus prepaid minus credit', async () => {
      await expect(insert('orders', sale({ cod_expected_amount: '1000.00' }))).rejects.toThrow(
        /orders_cod_expected/,
      );
      await insert(
        'orders',
        sale({
          prepaid_amount: '200.00',
          prepaid_method: 'instapay',
          credit_applied_amount: '300.00',
          cod_expected_amount: '550.00',
        }),
      );
    });

    it('refuses a negative amount', async () => {
      await expect(insert('orders', sale({ cod_collected_amount: '-1.00' }))).rejects.toThrow(
        /orders_amounts_not_negative/,
      );
    });

    it('keeps the shipping shares within the shipping charge', async () => {
      await expect(
        insert(
          'orders',
          sale({
            credit_applied_amount: '100.00',
            shipping_credit_applied_amount: '60.00',
            cod_expected_amount: '950.00',
          }),
        ),
      ).rejects.toThrow(/orders_shipping_shares_within_charge/);
    });

    it('refuses a refused order without a reason', async () => {
      await expect(insert('orders', sale({ fulfillment_state: 'refused' }))).rejects.toThrow(
        /orders_refused_has_reason/,
      );
      await insert('orders', sale({ fulfillment_state: 'refused', refused_reason_code: 'size' }));
    });

    it('sets prepaid_method exactly when something was prepaid', async () => {
      await expect(
        insert('orders', sale({ prepaid_amount: '100.00', cod_expected_amount: '950.00' })),
      ).rejects.toThrow(/orders_prepaid_method_when_prepaid/);
      await expect(insert('orders', sale({ prepaid_method: 'instapay' }))).rejects.toThrow(
        /orders_prepaid_method_when_prepaid/,
      );
    });
  });

  describe('checks added at the build (review and security m3)', () => {
    it('refuses a total that is not lines gross plus shipping', async () => {
      await expect(
        insert('orders', sale({ total_amount: '1000.00', cod_expected_amount: '1000.00' })),
      ).rejects.toThrow(/orders_total_is_lines_plus_shipping/);
    });

    it.each(['ship_to_phone', 'ship_to_phone_alt'])(
      'refuses a %s that is not E.164 and takes one that is',
      async (column) => {
        await expect(insert('orders', sale({ [column]: '01001234567' }))).rejects.toThrow(
          new RegExp(`orders_${column}_e164`),
        );
        await insert('orders', sale({ [column]: '+201001234567' }));
      },
    );

    it('caps the raw contact phone at 64 characters', async () => {
      await expect(insert('orders', sale({ contact_phone_raw: '1'.repeat(65) }))).rejects.toThrow(
        /orders_contact_phone_raw_length/,
      );
      await insert('orders', sale({ contact_phone_raw: '1'.repeat(64) }));
    });

    it('refuses a cancelled order without a reason', async () => {
      await expect(insert('orders', sale({ fulfillment_state: 'cancelled' }))).rejects.toThrow(
        /orders_cancelled_has_reason/,
      );
      await insert(
        'orders',
        sale({ fulfillment_state: 'cancelled', cancel_reason_code: 'customer_cancelled' }),
      );
    });

    it('takes only the known refusal reasons', async () => {
      await expect(
        insert('orders', sale({ fulfillment_state: 'refused', refused_reason_code: 'too_late' })),
      ).rejects.toThrow(/orders_refused_reason_known/);
      await insert('orders', sale({ fulfillment_state: 'refused', refused_reason_code: 'other' }));
    });

    it.each([
      ['orders', 'cancel_reason_code', 'orders_cancel_reason_code_shape'],
      ['orders', 'refused_reason_code', 'orders_refused_reason_code_shape'],
      ['orders', 'gift_reason_code', 'orders_gift_reason_code_shape'],
      ['order_lines', 'cancel_reason_code', 'order_lines_cancel_reason_code_shape'],
      ['order_events', 'reason_code', 'order_events_reason_code_shape'],
    ])('refuses a typed note in %s.%s', async (table, column, constraint) => {
      const note = 'Customer Mona said no';
      const orderId = await insert('orders', sale());
      const rows: Record<string, Record<string, unknown>> = {
        orders: sale({ [column]: note }),
        order_lines: line(orderId, { line_state: 'cancelled', [column]: note }),
        order_events: {
          order_id: orderId,
          machine: 'fulfillment',
          to_state: 'new',
          actor_type: 'system_job',
          occurred_at: '2026-01-15T10:00:00Z',
          [column]: note,
        },
      };

      await expect(insert(table, rows[table] ?? {})).rejects.toThrow(new RegExp(constraint));
    });
  });

  describe('order events (AC-19, AC-20)', () => {
    function event(orderId: string, overrides: Record<string, unknown>): Record<string, unknown> {
      return {
        order_id: orderId,
        machine: 'fulfillment',
        to_state: 'confirmed',
        from_state: 'new',
        actor_type: 'system_job',
        occurred_at: '2026-01-15T10:00:00Z',
        ...overrides,
      };
    }

    it('takes only states of the event machine, in to_state and from_state', async () => {
      const orderId = await insert('orders', sale());
      await expect(insert('order_events', event(orderId, { to_state: 'shiped' }))).rejects.toThrow(
        /order_events_to_state_of_machine/,
      );
      // A cash state on the fulfillment machine, and the reverse.
      await expect(insert('order_events', event(orderId, { to_state: 'unpaid' }))).rejects.toThrow(
        /order_events_to_state_of_machine/,
      );
      await expect(
        insert(
          'order_events',
          event(orderId, { machine: 'cash', to_state: 'shipped', from_state: null }),
        ),
      ).rejects.toThrow(/order_events_to_state_of_machine/);
      await expect(
        insert('order_events', event(orderId, { from_state: 'remitted' })),
      ).rejects.toThrow(/order_events_from_state_of_machine/);
      await insert('order_events', event(orderId, { from_state: null, to_state: 'new' }));
      await insert(
        'order_events',
        event(orderId, {
          machine: 'cash',
          from_state: 'unpaid',
          to_state: 'collected_by_carrier',
          amount: '1050.00',
          actor_type: 'carrier',
        }),
      );
    });

    it('takes an amount only on a cash event, never below 0', async () => {
      const orderId = await insert('orders', sale());
      await expect(insert('order_events', event(orderId, { amount: '10.00' }))).rejects.toThrow(
        /order_events_amount_on_cash_only/,
      );
      await expect(
        insert(
          'order_events',
          event(orderId, {
            machine: 'cash',
            from_state: 'unpaid',
            to_state: 'collected_by_carrier',
            amount: '-1.00',
          }),
        ),
      ).rejects.toThrow(/order_events_amount_on_cash_only/);
    });

    it('names the person who moved an order', async () => {
      const orderId = await insert('orders', sale());
      await expect(
        insert('order_events', event(orderId, { actor_type: 'person' })),
      ).rejects.toThrow(/order_events_person_has_actor/);
      const user = await insert('users', { name: 'Agent', email: `${next('agent')}@example.test` });
      await insert('order_events', event(orderId, { actor_type: 'person', actor_id: user }));
    });
  });

  describe('order lines (AC-21)', () => {
    it('refuses a line whose prepaid and credit shares exceed its gross', async () => {
      const orderId = await insert('orders', sale());

      await expect(
        insert(
          'order_lines',
          line(orderId, { prepaid_amount: '600.00', credit_applied_amount: '400.01' }),
        ),
      ).rejects.toThrow(/order_lines_shares_within_gross/);
      await insert(
        'order_lines',
        line(orderId, { prepaid_amount: '600.00', credit_applied_amount: '400.00' }),
      );
    });

    it('refuses a gross that is not net plus tax', async () => {
      const orderId = await insert('orders', sale());

      await expect(insert('order_lines', line(orderId, { tax_amount: '122.80' }))).rejects.toThrow(
        /order_lines_gross_is_net_plus_tax/,
      );
    });

    it('needs a cancel reason exactly on a cancelled line', async () => {
      const orderId = await insert('orders', sale());

      await expect(
        insert('order_lines', line(orderId, { line_state: 'cancelled' })),
      ).rejects.toThrow(/order_lines_cancel_reason_when_cancelled/);
      await expect(
        insert('order_lines', line(orderId, { cancel_reason_code: 'out_of_stock' })),
      ).rejects.toThrow(/order_lines_cancel_reason_when_cancelled/);
      await insert(
        'order_lines',
        line(orderId, { line_state: 'cancelled', cancel_reason_code: 'edit_removal' }),
      );
    });

    it('refuses a quantity of 0 and a second line at one position', async () => {
      const orderId = await insert('orders', sale());
      await expect(insert('order_lines', line(orderId, { quantity: 0 }))).rejects.toThrow(
        /order_lines_quantity_positive/,
      );
      await insert('order_lines', line(orderId, { position: 1 }));

      await expect(insert('order_lines', line(orderId, { position: 1 }))).rejects.toThrow(
        /order_lines_order_position_unique/,
      );
    });
  });

  describe('the operating day (AC-17)', () => {
    async function dayOf(instant: string): Promise<string> {
      return (
        await one<{ day: string }>(
          "SELECT to_char(ssd_operating_day($1::timestamptz), 'YYYY-MM-DD') AS day",
          [instant],
        )
      ).day;
    }

    it('stamps an order from placed_at and an event from occurred_at, ignoring what a writer passes', async () => {
      const placed = '2026-01-15T22:30:00Z'; // 00:30 on the 16th in Cairo
      const occurred = '2026-01-16T21:59:59Z';
      const orderId = await insert(
        'orders',
        sale({ placed_at: placed, operating_day: '1999-01-01' }),
      );
      await insert('order_events', {
        order_id: orderId,
        machine: 'cash',
        to_state: 'unpaid',
        actor_type: 'import',
        occurred_at: occurred,
        operating_day: '1999-01-01',
      });

      const order = await one<{ day: string }>(
        "SELECT to_char(operating_day, 'YYYY-MM-DD') AS day FROM orders WHERE id = $1",
        [orderId],
      );
      const event = await one<{ day: string }>(
        "SELECT to_char(operating_day, 'YYYY-MM-DD') AS day FROM order_events WHERE order_id = $1",
        [orderId],
      );
      expect(order.day).toBe(await dayOf(placed));
      expect(event.day).toBe(await dayOf(occurred));
      // 00:30 local on the 16th belongs to the 16th, not the UTC date of the 15th.
      expect(order.day).toBe('2026-01-16');
    });

    it('restamps an order when placed_at changes', async () => {
      const orderId = await insert('orders', sale({ placed_at: '2026-01-15T10:00:00Z' }));
      await owner.query("UPDATE orders SET placed_at = '2026-01-20T10:00:00Z' WHERE id = $1", [
        orderId,
      ]);

      const order = await one<{ day: string }>(
        "SELECT to_char(operating_day, 'YYYY-MM-DD') AS day FROM orders WHERE id = $1",
        [orderId],
      );
      expect(order.day).toBe('2026-01-20');
    });

    it('refuses to change an order operating day without changing placed_at, for every role', async () => {
      const orderId = await insert('orders', sale({ placed_at: '2026-01-15T10:00:00Z' }));
      const restate = "UPDATE orders SET operating_day = '1999-01-01' WHERE id = $1";

      await expect(owner.query(restate, [orderId])).rejects.toThrow(
        /orders_operating_day_follows_placed_at/,
      );
      await expect(app.query(restate, [orderId])).rejects.toThrow(
        /orders_operating_day_follows_placed_at/,
      );
      await expect(
        owner.query(
          "UPDATE orders SET placed_at = placed_at, operating_day = '1999-01-01' WHERE id = $1",
          [orderId],
        ),
      ).rejects.toThrow(/orders_operating_day_follows_placed_at/);
      // Any other change leaves the day alone.
      await app.query("UPDATE orders SET courier_note = 'Ring twice' WHERE id = $1", [orderId]);
      const order = await one<{ day: string }>(
        "SELECT to_char(operating_day, 'YYYY-MM-DD') AS day FROM orders WHERE id = $1",
        [orderId],
      );
      expect(order.day).toBe('2026-01-15');
    });
  });
});
