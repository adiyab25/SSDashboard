import { OrderCostRuleKind } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CostRulesService } from '../src/platform/cost-rules.service.js';
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
