import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CostService } from '../src/catalog/cost.service.js';
import { fixtures, ledgerHarness, posting, type LedgerHarness } from './ledger.js';

// Spec 0002, A12 (AC-30): the cost lookup against PostgreSQL, with the spec's worked example.
describe('CostService.costFor', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let costs: CostService;
  let make: ReturnType<typeof fixtures>;

  beforeAll(async () => {
    h = await ledgerHarness();
    costs = new CostService(h.app);
    make = fixtures(h.owner);
  });

  afterAll(async () => {
    await h?.close();
  });

  async function record(
    variantId: string,
    row: { override?: boolean; cost: string; from: string; basis?: string },
  ): Promise<void> {
    await h.owner.pool.query(
      `INSERT INTO cost_records (product_id, variant_id, season_id, cost_basis, unit_cost, effective_from)
       SELECT product_id, CASE WHEN $2::boolean THEN id END,
              (SELECT id FROM seasons WHERE code = 'CORE'), $3::cost_basis, $4, $5
       FROM product_variants WHERE id = $1`,
      [variantId, row.override ?? false, row.basis ?? 'factory_invoice', row.cost, row.from],
    );
  }

  it('follows the worked example: style 120, variant override 130, next season 140', async () => {
    const variantId = await make.variant();
    await record(variantId, { cost: '120.0000', from: '2026-03-01' });
    await record(variantId, { override: true, cost: '130.0000', from: '2026-04-01' });
    await record(variantId, { cost: '140.0000', from: '2027-03-01', basis: 'production_run' });

    expect(await costs.costFor(variantId, '2026-03-15')).toEqual({
      status: 'set',
      unitCost: '120.0000',
      costBasis: 'factory_invoice',
    });
    expect(await costs.costFor(variantId, '2026-05-01')).toMatchObject({ unitCost: '130.0000' });
    expect(await costs.costFor(variantId, '2027-03-02')).toEqual({
      status: 'set',
      unitCost: '140.0000',
      costBasis: 'production_run',
    });
    expect(await costs.costFor(variantId, '2026-02-28')).toEqual({ status: 'not_set' });
  });

  it('lets a later record on the same day correct a mistyped one, and labels an estimate', async () => {
    const variantId = await make.variant();
    await record(variantId, { cost: '12.0000', from: '2026-03-01', basis: 'estimate' });
    await record(variantId, { cost: '120.0000', from: '2026-03-01', basis: 'estimate' });

    expect(await costs.costFor(variantId, '2026-03-01')).toEqual({
      status: 'set',
      unitCost: '120.0000',
      costBasis: 'estimate',
    });
  });

  it('is not set for a style with no record, and a new record never changes a posted movement', async () => {
    const variantId = await make.variant();
    const locationId = await make.location();
    expect(await costs.costFor(variantId, '2026-03-01')).toEqual({ status: 'not_set' });

    const posted = await h.ledger.post(
      posting([{ variantId, locationId, quantity: 2, unitCost: '50.0000' }], {
        sourceType: 'opening_balance',
      }),
    );
    await record(variantId, { cost: '75.0000', from: '2026-01-01' });

    const { rows } = await h.owner.pool.query<{ unit_cost: string }>(
      'SELECT unit_cost FROM stock_movements WHERE id = $1',
      [posted.movements[0]?.id],
    );
    expect(rows[0]?.unit_cost).toBe('50.0000');
  });

  it('is not set for a variant that does not exist', async () => {
    expect(await costs.costFor('00000000-0000-7000-8000-000000000000', '2026-03-01')).toEqual({
      status: 'not_set',
    });
  });
});
