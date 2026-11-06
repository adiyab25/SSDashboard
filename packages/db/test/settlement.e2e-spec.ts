import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0002, settlement child (build plan item 15): the database guards on settlement accounts,
// periods, period events, statements, lines, and match rows. Importing, matching, and closing are
// features 22, 23, and 43. One migrated scratch database for the file; each test makes its own rows.
describe('the settlement primitive (AC-25, AC-33)', () => {
  let name: string;
  let owner: pg.Client;
  let app: pg.Client;
  let order: string;
  let orderLine: string;
  let otherOrder: string;
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
    order = (
      await one<{ id: string }>(
        `INSERT INTO orders (store_id, channel_id, order_number, placed_at, fulfillment_state, cash_state, outcome, payment_method)
         VALUES ((SELECT id FROM stores WHERE code = 'MAIN'), (SELECT id FROM channels WHERE code = 'manual'),
                 'SET-1', now(), 'new', 'nothing_to_collect', 'open', 'none') RETURNING id`,
      )
    ).id;
    otherOrder = (
      await one<{ id: string }>(
        `INSERT INTO orders (store_id, channel_id, order_number, placed_at, fulfillment_state, cash_state, outcome, payment_method)
         VALUES ((SELECT id FROM stores WHERE code = 'MAIN'), (SELECT id FROM channels WHERE code = 'manual'),
                 'SET-2', now(), 'new', 'nothing_to_collect', 'open', 'none') RETURNING id`,
      )
    ).id;
    orderLine = (
      await one<{ id: string }>(
        `INSERT INTO order_lines (order_id, position, title, quantity, unit_price, net_amount, tax_rate, tax_amount, gross_amount)
         VALUES ($1, 1, 'Linen shirt', 1, 0, 0, 14, 0, 0) RETURNING id`,
        [order],
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

  /** Inserts one row from a column map and returns its id. */
  async function insert(
    table: string,
    row: Record<string, unknown>,
    client: pg.Client = owner,
  ): Promise<string> {
    const columns = Object.keys(row);
    const params = columns.map((_, index) => `$${index + 1}`);
    return (
      await one<{ id: string }>(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${params.join(', ')}) RETURNING id`,
        Object.values(row),
        client,
      )
    ).id;
  }

  function next(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  const connection = () => insert('connections', { provider: 'bosta', label: next('Bosta') });
  const partner = () =>
    insert('parties', { code: next('P'), name: 'Showroom', is_consignment_partner: true });
  const carrierAccount = async () =>
    insert('settlement_accounts', {
      code: next('BOSTA'),
      name: { en: 'Bosta' },
      owner_type: 'carrier',
      owner_connection_id: await connection(),
    });
  const statement = (accountId: string, overrides: Record<string, unknown> = {}) =>
    insert('settlement_statements', {
      account_id: accountId,
      kind: 'carrier_file',
      external_reference: next('cycle'),
      ...overrides,
    });
  const line = (accountId: string, statementId: string, overrides: Record<string, unknown> = {}) =>
    insert('settlement_lines', {
      account_id: accountId,
      statement_id: statementId,
      line_kind: 'cod_collected',
      amount: '1050.00',
      external_line_ref: '1',
      occurred_on: '2026-11-03',
      tracking_number: next('TRK'),
      ...overrides,
    });
  const period = (accountId: string, startsOn: string, endsOn: string) =>
    insert('settlement_periods', { account_id: accountId, starts_on: startsOn, ends_on: endsOn });

  describe('accounts', () => {
    it('refuses a carrier account with a party, and a partner account with a connection', async () => {
      await expect(
        insert('settlement_accounts', {
          code: next('A'),
          name: { en: 'x' },
          owner_type: 'carrier',
          owner_connection_id: await connection(),
          owner_party_id: await partner(),
        }),
      ).rejects.toThrow(/settlement_accounts_owner_matches_type/);
      await expect(
        insert('settlement_accounts', {
          code: next('A'),
          name: { en: 'x' },
          owner_type: 'consignment_partner',
          owner_connection_id: await connection(),
        }),
      ).rejects.toThrow(/settlement_accounts_owner_matches_type/);
      await expect(
        insert('settlement_accounts', {
          code: next('A'),
          name: { en: 'x' },
          owner_type: 'gateway',
        }),
      ).rejects.toThrow(/settlement_accounts_owner_matches_type/);
    });

    it('accepts a partner account with its party, and keeps one live account per owner', async () => {
      const party = await partner();
      const first = await insert('settlement_accounts', {
        code: next('P'),
        name: { en: 'Showroom' },
        owner_type: 'consignment_partner',
        owner_party_id: party,
      });
      const again = {
        code: next('P'),
        name: { en: 'Showroom' },
        owner_type: 'consignment_partner',
        owner_party_id: party,
      };
      await expect(insert('settlement_accounts', again)).rejects.toThrow(
        /settlement_accounts_live_party_unique/,
      );

      await owner.query('UPDATE settlement_accounts SET archived_at = now() WHERE id = $1', [
        first,
      ]);
      await insert('settlement_accounts', again);
    });

    it("fixes an account's owner for life (SettlementOwnerFixed)", async () => {
      const account = await carrierAccount();

      await expect(
        app.query('UPDATE settlement_accounts SET owner_connection_id = $2 WHERE id = $1', [
          account,
          await connection(),
        ]),
      ).rejects.toThrow(/SettlementOwnerFixed/);
      await expect(
        owner.query(
          "UPDATE settlement_accounts SET owner_type = 'consignment_partner', owner_connection_id = NULL, owner_party_id = $2 WHERE id = $1",
          [account, await partner()],
        ),
      ).rejects.toThrow(/SettlementOwnerFixed/);
      await app.query(
        'UPDATE settlement_accounts SET name = \'{"en": "Bosta Cairo"}\' WHERE id = $1',
        [account],
      );
    });

    it('keeps one live account per connection', async () => {
      const owned = await connection();
      const row = { name: { en: 'x' }, owner_type: 'carrier', owner_connection_id: owned };
      await insert('settlement_accounts', { code: next('C'), ...row });

      await expect(insert('settlement_accounts', { code: next('C'), ...row })).rejects.toThrow(
        /settlement_accounts_live_connection_unique/,
      );
    });
  });

  describe('periods', () => {
    it('refuses two overlapping periods for one account, and lets two accounts share dates', async () => {
      const account = await carrierAccount();
      const other = await carrierAccount();
      await period(account, '2026-11-01', '2026-11-30');

      await expect(period(account, '2026-11-30', '2026-12-31')).rejects.toThrow(
        /settlement_periods_no_overlap/,
      );
      await period(account, '2026-12-01', '2026-12-31');
      await period(other, '2026-11-01', '2026-11-30');
    });

    it('refuses dates out of order', async () => {
      await expect(period(await carrierAccount(), '2026-11-30', '2026-11-01')).rejects.toThrow(
        /settlement_periods_dates_in_order/,
      );
    });

    const statusOf = async (id: string) =>
      (await one<{ status: string }>('SELECT status FROM settlement_periods WHERE id = $1', [id]))
        .status;
    const event = (id: string, row: Record<string, unknown>) =>
      insert('settlement_period_events', { period_id: id, actor_type: 'rule', ...row }, app);

    it("refuses to change a closed period's dates (PeriodClosed), and allows it after a revoke event", async () => {
      const id = await period(await carrierAccount(), '2026-11-01', '2026-11-30');
      await event(id, { action: 'closed', evidence: { statement_total: '1050.00' } });
      expect(await statusOf(id)).toBe('closed');

      await expect(
        app.query("UPDATE settlement_periods SET ends_on = '2026-11-29' WHERE id = $1", [id]),
      ).rejects.toThrow(/PeriodClosed/);

      await event(id, { action: 'revoked', reason: 'Bosta resent the cash cycle' });
      expect(await statusOf(id)).toBe('open');
      await app.query("UPDATE settlement_periods SET ends_on = '2026-11-29' WHERE id = $1", [id]);
    });

    it('keeps the status to its latest event (security review MJ2)', async () => {
      const id = await period(await carrierAccount(), '2026-11-01', '2026-11-30');

      await expect(
        app.query("UPDATE settlement_periods SET status = 'closed' WHERE id = $1", [id]),
      ).rejects.toThrow(/settlement_periods_status_follows_events/);
      await event(id, { action: 'closed', evidence: { statement_total: '0.00' } });
      await expect(
        app.query("UPDATE settlement_periods SET status = 'open' WHERE id = $1", [id]),
      ).rejects.toThrow(/settlement_periods_status_follows_events/);
      await expect(
        owner.query("UPDATE settlement_periods SET status = 'open' WHERE id = $1", [id]),
      ).rejects.toThrow(/settlement_periods_status_follows_events/);
      await expect(
        insert('settlement_periods', {
          account_id: await carrierAccount(),
          starts_on: '2026-11-01',
          ends_on: '2026-11-30',
          status: 'closed',
        }),
      ).rejects.toThrow(/settlement_periods_status_follows_events/);
      expect(await statusOf(id)).toBe('closed');
    });

    it("fixes a period's account for life", async () => {
      const id = await period(await carrierAccount(), '2026-11-01', '2026-11-30');

      await expect(
        app.query('UPDATE settlement_periods SET account_id = $2 WHERE id = $1', [
          id,
          await carrierAccount(),
        ]),
      ).rejects.toThrow(/settlement_periods_account_fixed/);
    });

    it('never deletes a period, for the application role or the owner', async () => {
      const id = await period(await carrierAccount(), '2026-11-01', '2026-11-30');

      await expect(app.query('DELETE FROM settlement_periods WHERE id = $1', [id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        owner.query('DELETE FROM settlement_periods WHERE id = $1', [id]),
      ).rejects.toThrow(/settlement_periods_never_deleted/);
      await expect(owner.query('TRUNCATE settlement_periods CASCADE')).rejects.toThrow(
        /settlement_periods_never_deleted|append only/,
      );
    });

    it('finds a line imported before its period by occurred_on (derived, never stored)', async () => {
      const account = await carrierAccount();
      const lineId = await line(account, await statement(account), { occurred_on: '2026-11-03' });
      const periodId = await period(account, '2026-11-01', '2026-11-30');

      const found = await one<{ id: string }>(
        `SELECT p.id FROM settlement_lines l JOIN settlement_periods p
           ON p.account_id = l.account_id AND l.occurred_on BETWEEN p.starts_on AND p.ends_on
         WHERE l.id = $1`,
        [lineId],
      );
      expect(found.id).toBe(periodId);
      const columns = await owner.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'settlement_lines' AND column_name = 'period_id'",
      );
      expect(columns.rowCount).toBe(0);
    });
  });

  describe('period events', () => {
    it('refuses a revoke without a reason, and accepts a close and a revoke with one', async () => {
      const id = await period(await carrierAccount(), '2026-11-01', '2026-11-30');
      const event = { period_id: id, actor_type: 'rule' };

      await expect(
        insert('settlement_period_events', { ...event, action: 'revoked' }),
      ).rejects.toThrow(/settlement_period_events_revoke_has_reason/);
      await expect(
        insert('settlement_period_events', { ...event, action: 'revoked', reason: '  ' }),
      ).rejects.toThrow(/settlement_period_events_revoke_has_reason/);
      await insert('settlement_period_events', {
        ...event,
        action: 'closed',
        evidence: { total: '1050.00' },
      });
      await insert(
        'settlement_period_events',
        { ...event, action: 'revoked', reason: 'Bosta resent the file' },
        app,
      );
    });

    it('refuses a person without an actor', async () => {
      const id = await period(await carrierAccount(), '2026-11-01', '2026-11-30');

      await expect(
        insert('settlement_period_events', {
          period_id: id,
          action: 'closed',
          evidence: { statement_total: '0.00' },
          actor_type: 'person',
        }),
      ).rejects.toThrow(/settlement_period_events_person_has_actor/);
    });

    it('refuses a close without evidence (security review n1)', async () => {
      const id = await period(await carrierAccount(), '2026-11-01', '2026-11-30');

      await expect(
        insert('settlement_period_events', { period_id: id, action: 'closed', actor_type: 'rule' }),
      ).rejects.toThrow(/settlement_period_events_close_has_evidence/);
    });
  });

  describe('statements and lines', () => {
    it('refuses a line twice in one statement, and lets a corrected statement reuse line number 1', async () => {
      const account = await carrierAccount();
      const first = await statement(account, { external_reference: 'cycle-77' });
      await line(account, first, { external_line_ref: '1' });

      await expect(line(account, first, { external_line_ref: '1' })).rejects.toThrow(
        /settlement_lines_statement_ref_unique/,
      );
      const corrected = await statement(account, {
        external_reference: 'cycle-77',
        sha256: 'b'.repeat(64),
        supersedes_statement_id: first,
      });
      await line(account, corrected, { external_line_ref: '1' });
    });

    it('keeps one statement per reference and checksum, an absent checksum included', async () => {
      const account = await carrierAccount();
      await statement(account, { external_reference: 'cycle-88' });

      await expect(statement(account, { external_reference: 'cycle-88' })).rejects.toThrow(
        /settlement_statements_reference_unique/,
      );
    });

    it('supersedes a statement at most once and orders its covered days', async () => {
      const account = await carrierAccount();
      const first = await statement(account);
      await statement(account, { supersedes_statement_id: first });

      await expect(statement(account, { supersedes_statement_id: first })).rejects.toThrow(
        /settlement_statements_supersedes_unique/,
      );
      await expect(
        statement(account, { covers_from: '2026-11-05', covers_to: '2026-11-04' }),
      ).rejects.toThrow(/settlement_statements_covers_in_order/);
      // A partner's explicit "no sales" for a range: a statement with days and no lines.
      await statement(account, {
        kind: 'partner_upload',
        covers_from: '2026-11-04',
        covers_to: '2026-11-04',
      });
    });

    it("refuses superseding another account's statement, or itself (security review m4)", async () => {
      const account = await carrierAccount();
      const other = await carrierAccount();

      await expect(
        statement(account, { supersedes_statement_id: await statement(other) }),
      ).rejects.toThrow(/foreign key/);
      const id = '0192f7a0-0000-7000-8000-0000000005e1';
      await expect(statement(account, { id, supersedes_statement_id: id })).rejects.toThrow(
        /settlement_statements_not_superseding_self/,
      );
    });

    it("refuses an other_fee line without the carrier's fee name", async () => {
      const account = await carrierAccount();
      const statementId = await statement(account);

      await expect(
        line(account, statementId, { line_kind: 'other_fee', amount: '-5.00' }),
      ).rejects.toThrow(/settlement_lines_other_fee_has_code/);
      await line(account, statementId, {
        line_kind: 'other_fee',
        amount: '-5.00',
        fee_code: 'Insurance',
        external_line_ref: '2',
      });
    });

    it("refuses a line on another account's statement", async () => {
      const account = await carrierAccount();
      const other = await carrierAccount();

      await expect(line(account, await statement(other))).rejects.toThrow(/foreign key/);
    });
  });

  describe('match rows', () => {
    async function newLine(): Promise<string> {
      const account = await carrierAccount();
      return line(account, await statement(account));
    }
    const match = (lineId: string, row: Record<string, unknown>) =>
      insert('settlement_line_matches', { line_id: lineId, matched_by_type: 'rule', ...row });

    it.each([
      [
        'matched without an order or variant',
        { result: 'matched' },
        'settlement_line_matches_matched_has_target',
      ],
      [
        'accounted without a code',
        { result: 'accounted' },
        'settlement_line_matches_account_code_when_accounted',
      ],
      [
        'an account code on a matched row',
        { result: 'matched', order_id: 'ORDER', account_code: 'payment_received' },
        'settlement_line_matches_account_code_when_accounted',
      ],
      [
        'unmatched without a reason',
        { result: 'unmatched' },
        'settlement_line_matches_reason_when_unmatched',
      ],
      [
        'cleared without a reason',
        { result: 'cleared' },
        'settlement_line_matches_reason_when_unmatched',
      ],
      [
        'a person without an actor',
        { result: 'unmatched', reason_code: 'amount_differs', matched_by_type: 'person' },
        'settlement_line_matches_person_has_actor',
      ],
      [
        'a typed note as the rule code',
        { result: 'matched', order_id: 'ORDER', rule_code: 'Matched by Sara' },
        'settlement_line_matches_rule_code_shape',
      ],
      [
        'an order line without its order',
        { result: 'unmatched', reason_code: 'amount_differs', order_line_id: 'LINE' },
        'settlement_line_matches_line_needs_order',
      ],
      [
        'an order line of another order',
        { result: 'matched', order_id: 'OTHER_ORDER', order_line_id: 'LINE' },
        'foreign key',
      ],
    ])('refuses %s', async (_case, row, constraint) => {
      const ids: Record<string, string> = {
        ORDER: order,
        OTHER_ORDER: otherOrder,
        LINE: orderLine,
      };
      const values = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === 'string' && value in ids ? ids[value] : value,
        ]),
      );

      await expect(match(await newLine(), values)).rejects.toThrow(new RegExp(constraint));
    });

    it('keeps the history: match, unmatch with a reason, match again, each superseding once', async () => {
      const lineId = await newLine();
      const first = await match(lineId, {
        result: 'matched',
        order_id: order,
        rule_code: 'tracking_and_amount',
      });
      const second = await match(lineId, {
        result: 'unmatched',
        reason_code: 'amount_differs',
        supersedes_match_id: first,
      });
      await match(lineId, {
        result: 'accounted',
        account_code: 'carrier_compensation',
        supersedes_match_id: second,
      });

      await expect(
        match(lineId, {
          result: 'unmatched',
          reason_code: 'not_yet_matched',
          supersedes_match_id: first,
        }),
      ).rejects.toThrow(/settlement_line_matches_extends_chain/);
    });

    it('refuses a second row that supersedes nothing', async () => {
      const lineId = await newLine();
      await match(lineId, { result: 'matched', order_id: order });

      await expect(
        match(lineId, { result: 'unmatched', reason_code: 'amount_differs' }),
      ).rejects.toThrow(/settlement_line_matches_extends_chain/);
    });

    it('refuses superseding a row that is not the head', async () => {
      const lineId = await newLine();
      const first = await match(lineId, { result: 'matched', order_id: order });
      await match(lineId, {
        result: 'unmatched',
        reason_code: 'amount_differs',
        supersedes_match_id: first,
      });

      await expect(
        match(lineId, { result: 'matched', order_id: order, supersedes_match_id: first }),
      ).rejects.toThrow(/settlement_line_matches_extends_chain/);
    });

    it("refuses superseding another line's row", async () => {
      const lineId = await newLine();
      const otherLine = await newLine();
      await match(lineId, { result: 'matched', order_id: order });
      const foreign = await match(otherLine, { result: 'matched', order_id: order });

      await expect(
        match(lineId, { result: 'matched', order_id: order, supersedes_match_id: foreign }),
      ).rejects.toThrow(/foreign key/);
    });

    it('keeps accounted terminal (security review n2)', async () => {
      const lineId = await newLine();
      const accounted = await match(lineId, {
        result: 'accounted',
        account_code: 'payment_received',
      });

      await expect(
        match(lineId, {
          result: 'unmatched',
          reason_code: 'not_yet_matched',
          supersedes_match_id: accounted,
        }),
      ).rejects.toThrow(/settlement_line_matches_accounted_terminal/);
    });
  });

  describe('append only (AC-33)', () => {
    it.each([
      [
        'settlement_statements',
        'UPDATE settlement_statements SET external_reference = $2 WHERE id = $1',
      ],
      ['settlement_lines', 'UPDATE settlement_lines SET external_line_ref = $2 WHERE id = $1'],
      [
        'settlement_line_matches',
        'UPDATE settlement_line_matches SET reason_code = $2 WHERE id = $1',
      ],
      ['settlement_period_events', 'UPDATE settlement_period_events SET reason = $2 WHERE id = $1'],
    ])('refuses UPDATE and DELETE on %s', async (table, update) => {
      const account = await carrierAccount();
      const statementId = await statement(account);
      const lineId = await line(account, statementId);
      const ids: Record<string, string> = {
        settlement_statements: statementId,
        settlement_lines: lineId,
        settlement_line_matches: await insert('settlement_line_matches', {
          line_id: lineId,
          result: 'unmatched',
          reason_code: 'not_yet_matched',
          matched_by_type: 'rule',
        }),
        settlement_period_events: await insert('settlement_period_events', {
          period_id: await period(account, '2026-11-01', '2026-11-30'),
          action: 'closed',
          evidence: { statement_total: '1050.00' },
          actor_type: 'rule',
        }),
      };
      const id = ids[table];

      for (const [statementText, params] of [
        [update, [id, 'x']],
        [`DELETE FROM ${table} WHERE id = $1`, [id]],
      ] as const) {
        await expect(app.query(statementText, [...params])).rejects.toThrow(/permission denied/);
        await expect(owner.query(statementText, [...params])).rejects.toThrow(/append only/);
      }
    });
  });
});
