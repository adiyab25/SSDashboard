import {
  CostRuleRow,
  CostRulesResponse,
  OrderCostRuleKind,
  SettingsListResponse,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CostRulesService } from '../src/platform/cost-rules.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { ledgerHarness, type LedgerHarness } from './ledger.js';

// Spec 0002, catalog child, "Per order cost rules" (AC-32): the seeded not_set rows and the
// lookup against PostgreSQL, with rows written as the application role.
describe('CostRulesService.ruleFor', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let rules: CostRulesService;
  let installDay: string;

  beforeAll(async () => {
    h = await ledgerHarness();
    rules = new CostRulesService(h.app);
    const { rows } = await h.owner.pool.query<{ day: string }>(
      "SELECT to_char(ssd_operating_day(now()), 'YYYY-MM-DD') AS day",
    );
    installDay = rows[0]?.day as string;
  });

  afterAll(async () => {
    await h?.close();
  });

  /** The day `days` after the install's operating day, as `YYYY-MM-DD`. */
  async function dayAfterInstall(days: number): Promise<string> {
    const { rows } = await h.owner.pool.query<{ day: string }>(
      "SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS day",
      [installDay, days],
    );
    return rows[0]?.day as string;
  }

  async function record(kind: string, value: string, effectiveFrom: string): Promise<void> {
    await h.app.pool.query(
      `INSERT INTO order_cost_rules (kind, status, value, effective_from) VALUES ($1, 'set', $2, $3)`,
      [kind, value, effectiveFrom],
    );
  }

  it('seeds one not_set row per kind on the install day, so a fresh install reads all four not set', async () => {
    const { rows } = await h.owner.pool.query<{ kind: string; status: string; day: string }>(
      `SELECT kind, status, to_char(effective_from, 'YYYY-MM-DD') AS day
       FROM order_cost_rules ORDER BY kind`,
    );
    expect(rows).toEqual(
      OrderCostRuleKind.options.map((kind) => ({ kind, status: 'not_set', day: installDay })),
    );

    for (const kind of OrderCostRuleKind.options) {
      expect(await rules.ruleFor(kind, installDay)).toEqual({ status: 'not_set' });
      expect(await rules.ruleFor(kind, await dayAfterInstall(400))).toEqual({
        status: 'not_set',
      });
    }
  });

  it('reads a COD fee of 2.5 as set from its day and not set the day before', async () => {
    const from = await dayAfterInstall(10);
    await record('cod_fee_percent', '2.5', from);

    expect(await rules.ruleFor('cod_fee_percent', from)).toEqual({
      status: 'set',
      value: '2.5000',
    });
    expect(await rules.ruleFor('cod_fee_percent', await dayAfterInstall(30))).toEqual({
      status: 'set',
      value: '2.5000',
    });
    expect(await rules.ruleFor('cod_fee_percent', await dayAfterInstall(9))).toEqual({
      status: 'not_set',
    });
    expect(await rules.ruleFor('gateway_fee_percent', from)).toEqual({ status: 'not_set' });
  });

  it('refuses a percent above 100 and a negative value, and allows packaging above 100 EGP', async () => {
    const from = await dayAfterInstall(20);

    await expect(record('cod_fee_percent', '100.5', from)).rejects.toThrow(
      /order_cost_rules_percent_at_most_100/,
    );
    await expect(record('packaging_per_order', '-1', from)).rejects.toThrow(
      /order_cost_rules_value_not_negative/,
    );
    await expect(
      h.app.pool.query(
        `INSERT INTO order_cost_rules (kind, status, effective_from) VALUES ('packaging_per_order', 'set', $1)`,
        [from],
      ),
    ).rejects.toThrow(/order_cost_rules_value_when_set/);
    await record('packaging_per_order', '150', from);

    expect(await rules.ruleFor('packaging_per_order', from)).toEqual({
      status: 'set',
      value: '150.0000',
    });
  });

  it('lets a later recorded row on the same day win', async () => {
    const from = await dayAfterInstall(40);
    await record('rto_unrestocked_percent', '30', from);
    await record('rto_unrestocked_percent', '3', from);

    expect(await rules.ruleFor('rto_unrestocked_percent', from)).toEqual({
      status: 'set',
      value: '3.0000',
    });
  });

  it('never lets the application role change or remove a rule', async () => {
    await expect(
      h.app.pool.query("UPDATE order_cost_rules SET value = 1 WHERE kind = 'cod_fee_percent'"),
    ).rejects.toThrow(/permission denied/);
    await expect(h.app.pool.query('DELETE FROM order_cost_rules')).rejects.toThrow(
      /permission denied/,
    );
  });
});

// Spec 0009 milestone 5, task 26 (AC-23): the cost rules through the api. A holder of
// `cost.view` reads the rules in force, the history, and the lock date; a holder of both
// `settings.manage` and `cost.view` records a rule with a reason (`cost_rule.recorded`); a rule
// from a day on or before the inventory lock date answers 409 COST_RULE_IN_LOCKED_PERIOD with the
// months it would change, and with `inLockedPeriod` and a reason it is recorded as
// `cost_rule.recorded_in_locked_period`, the lock date untouched.
describe('cost rules through the api (spec 0009, AC-23)', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let costManager: string;
  let manager: string;
  let costReader: string;

  const post = (body: unknown, cookie = costManager) =>
    api.call(cookie, 'POST', '/api/platform/cost-rules', body);
  const read = async (cookie = costManager, query = '') => {
    const reply = await api.call(cookie, 'GET', `/api/platform/cost-rules${query}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return CostRulesResponse.parse(reply.body);
  };
  const entries = async (action: string) =>
    (
      await api.owner.pool.query<{
        record_type: string;
        record_label: string;
        reason: string | null;
        after: Record<string, unknown>;
      }>(
        `SELECT record_type, record_label, reason, after FROM audit_entries
         WHERE action = $1 ORDER BY recorded_at`,
        [action],
      )
    ).rows;

  beforeAll(async () => {
    api = await startInProcessApi();
    costManager = await api.signIn((await api.addPerson(['manager'], { costView: true })).email);
    manager = await api.signIn((await api.addPerson(['manager'])).email);
    costReader = await api.signIn((await api.addPerson(['support'], { costView: true })).email);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('reads every kind not set on a fresh install, with nothing locked yet', async () => {
    const answer = await read();
    expect(answer.current.map((entry) => entry.kind).sort()).toEqual(
      [...OrderCostRuleKind.options].sort(),
    );
    expect(answer.current.every((entry) => entry.rule.status === 'not_set')).toBe(true);
    expect(answer.current.every((entry) => entry.row?.recordedBy === null)).toBe(true);
    expect(answer.history.items).toHaveLength(4);
    expect(answer.lockDate).toBeNull();
    expect(answer.lockDateInvalid).toBe(false);
  });

  it('records a rule with a reason and audits it as cost_rule.recorded', async () => {
    const today = (await read()).today;
    const reply = await post({
      kind: 'cod_fee_percent',
      status: 'set',
      value: '٢٫٥',
      effectiveFrom: today,
      reason: 'Bosta raised the COD fee',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(CostRuleRow.parse(reply.body)).toMatchObject({
      kind: 'cod_fee_percent',
      status: 'set',
      value: '2.5000',
      effectiveFrom: today,
      recordedBy: { name: expect.any(String) as string },
    });
    const answer = await read();
    expect(answer.current.find((entry) => entry.kind === 'cod_fee_percent')?.rule).toEqual({
      status: 'set',
      value: '2.5000',
    });
    expect(answer.history.items[0]?.id).toBe((reply.body as { id: string }).id);
    expect(await entries('cost_rule.recorded')).toEqual([
      {
        record_type: 'order_cost_rule',
        record_label: 'cod_fee_percent',
        reason: 'Bosta raised the COD fee',
        after: { status: 'set', value: '2.5000', effectiveFrom: today },
      },
    ]);
  });

  it('pages the history newest first with a cursor', async () => {
    const first = await read(costManager, '?limit=2');
    expect(first.history.items).toHaveLength(2);
    expect(first.history.nextCursor).not.toBeNull();
    const second = await read(costManager, `?limit=2&cursor=${first.history.nextCursor as string}`);
    expect(second.history.items).toHaveLength(2);
    const third = await read(costManager, `?limit=2&cursor=${second.history.nextCursor as string}`);
    expect(third.history.items).toHaveLength(1);
    expect(third.history.nextCursor).toBeNull();
    const ids = [...first.history.items, ...second.history.items, ...third.history.items].map(
      (row) => row.id,
    );
    expect(new Set(ids).size).toBe(5);
    const bad = await api.call(costManager, 'GET', '/api/platform/cost-rules?cursor=nope');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'INVALID_QUERY' });
  });

  it('refuses a broken rule: a value for not set, none for set, a percent above 100, no reason', async () => {
    const today = (await read()).today;
    const base = { kind: 'gateway_fee_percent', effectiveFrom: today, reason: 'Gateway fee' };
    for (const body of [
      { ...base, status: 'not_set', value: '1' },
      { ...base, status: 'set' },
      { ...base, status: 'set', value: '100.5' },
      { ...base, status: 'set', value: '-1' },
    ]) {
      const reply = await post(body);
      expect(reply.status, JSON.stringify(body)).toBe(422);
      expect(reply.body).toMatchObject({ code: 'SETTING_INVALID' });
    }
    const packaging = await post({
      kind: 'packaging_per_order',
      status: 'set',
      value: '150',
      effectiveFrom: today,
      reason: 'New boxes',
    });
    expect(packaging.status, JSON.stringify(packaging.body)).toBe(201);
    const noReason = await post({ ...base, status: 'set', value: '2', reason: '  ' });
    expect(noReason.status).toBe(422);
    expect(noReason.body).toMatchObject({ code: 'REASON_REQUIRED' });
  });

  it('refuses a rule in the locked period with its months, and records it with the override (D14)', async () => {
    // The lock date row is seeded, so the write sends its instant back.
    const listed = SettingsListResponse.parse(
      (await api.call(manager, 'GET', '/api/settings')).body,
    ).entries.find((entry) => entry.key === 'inventory_lock_date');
    const lock = await api.call(manager, 'PUT', '/api/settings/inventory_lock_date', {
      value: '2026-03-31',
      reason: 'March is closed',
      expectedUpdatedAt: listed?.updatedAt ?? null,
    });
    expect(lock.status, JSON.stringify(lock.body)).toBe(200);
    expect((await read(costReader)).lockDate).toBe('2026-03-31');

    // A later rule of the kind inside the period first, recorded on purpose.
    const later = await post({
      kind: 'rto_unrestocked_percent',
      status: 'set',
      value: '30',
      effectiveFrom: '2026-02-10',
      reason: 'Damaged returns in February',
      inLockedPeriod: true,
    });
    expect(later.status, JSON.stringify(later.body)).toBe(201);

    const refused = await post({
      kind: 'rto_unrestocked_percent',
      status: 'set',
      value: '25',
      effectiveFrom: '2026-01-15',
      reason: 'Damaged returns in January',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'COST_RULE_IN_LOCKED_PERIOD',
      months: ['2026-01', '2026-02'],
    });
    const wholePeriod = await post({
      kind: 'cod_fee_percent',
      status: 'not_set',
      effectiveFrom: '2026-03-31',
      reason: 'Unknown in March',
    });
    expect(wholePeriod.body).toMatchObject({ months: ['2026-03'] });

    const taken = await post({
      kind: 'rto_unrestocked_percent',
      status: 'set',
      value: '25',
      effectiveFrom: '2026-01-15',
      reason: 'Damaged returns in January',
      inLockedPeriod: true,
    });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    const locked = await entries('cost_rule.recorded_in_locked_period');
    expect(locked.map((entry) => entry.reason)).toEqual([
      'Damaged returns in February',
      'Damaged returns in January',
    ]);
    expect(locked[1]?.after).toMatchObject({ effectiveFrom: '2026-01-15', lockDate: '2026-03-31' });
    // The lock date never moved.
    expect((await read()).lockDate).toBe('2026-03-31');
    // A day after the lock date needs no override.
    const after = await post({
      kind: 'gateway_fee_percent',
      status: 'set',
      value: '2.75',
      effectiveFrom: '2026-04-01',
      reason: 'Paymob fee from April',
    });
    expect(after.status, JSON.stringify(after.body)).toBe(201);
  });

  it('fails closed on a corrupt lock date: 409 LOCK_DATE_UNREADABLE, and the read says so', async () => {
    const corrupt = (value: string) =>
      api.owner.pool.query(
        `UPDATE settings SET value = $1::jsonb WHERE key = 'inventory_lock_date'`,
        [value],
      );
    await corrupt('"not a date"');
    try {
      const answer = await read(costReader);
      expect(answer.lockDate).toBeNull();
      expect(answer.lockDateInvalid).toBe(true);
      const refused = await post({
        kind: 'packaging_per_order',
        status: 'set',
        value: '160',
        effectiveFrom: '2026-12-01',
        reason: 'Boxes cost more',
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body).toMatchObject({ code: 'LOCK_DATE_UNREADABLE' });
    } finally {
      await corrupt('"2026-03-31"');
    }
    expect((await read()).lockDateInvalid).toBe(false);
  });

  it('lets a cost.view holder read but not add, and keeps both from a manager without cost', async () => {
    expect((await read(costReader)).current).toHaveLength(4);
    const added = await post(
      {
        kind: 'cod_fee_percent',
        status: 'set',
        value: '3',
        effectiveFrom: '2026-12-01',
        reason: 'Not mine to add',
      },
      costReader,
    );
    expect(added.status).toBe(403);
    expect(added.body).toMatchObject({ code: 'FORBIDDEN' });
    const managerRead = await api.call(manager, 'GET', '/api/platform/cost-rules');
    expect(managerRead.status).toBe(403);
    const managerAdd = await post(
      { kind: 'cod_fee_percent', status: 'not_set', effectiveFrom: '2026-12-01', reason: 'x' },
      manager,
    );
    expect(managerAdd.status).toBe(403);
  });
});
