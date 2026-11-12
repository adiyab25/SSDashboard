import { describe, expect, it } from 'vitest';
import { pickCostRecord, selectCost, type CostRecordCandidate } from './cost-selection.js';

const VARIANT = 'v-1';
let sequence = 0;
const record = (over: Partial<CostRecordCandidate>): CostRecordCandidate => ({
  id: `0000-${String((sequence += 1)).padStart(4, '0')}`,
  variantId: null,
  unitCost: '120.0000',
  costBasis: 'factory_invoice',
  effectiveFrom: '2026-03-01',
  recordedAt: '2026-02-01T10:00:00.000000',
  ...over,
});

// The worked example of spec 0002 (catalog child, Cost lookup).
const worked = [
  record({ unitCost: '120.0000', effectiveFrom: '2026-03-01' }),
  record({ variantId: VARIANT, unitCost: '130.0000', effectiveFrom: '2026-04-01' }),
  record({ unitCost: '140.0000', effectiveFrom: '2027-03-01', costBasis: 'production_run' }),
];

describe('selectCost', () => {
  it.each([
    ['2026-03-15', '120.0000'],
    ['2026-05-01', '130.0000'],
    ['2027-03-02', '140.0000'],
  ])('costs %s at %s (the worked example)', (day, cost) => {
    expect(selectCost(worked, day)).toMatchObject({ status: 'set', unitCost: cost });
  });

  it('returns the basis with the cost, so a margin on an estimate can say so', () => {
    expect(selectCost(worked, '2027-03-02')).toEqual({
      status: 'set',
      unitCost: '140.0000',
      costBasis: 'production_run',
    });
    expect(selectCost([record({ costBasis: 'estimate' })], '2026-03-01')).toMatchObject({
      costBasis: 'estimate',
    });
  });

  it('lets a correction (same day, later recorded) replace a mistyped record', () => {
    const records = [
      record({ unitCost: '12.0000' }),
      record({ unitCost: '120.0000', recordedAt: '2026-02-02T10:00:00.000000' }),
    ];
    expect(selectCost(records, '2026-03-01')).toMatchObject({ unitCost: '120.0000' });
    expect(selectCost([...records].reverse(), '2026-03-01')).toMatchObject({
      unitCost: '120.0000',
    });
  });

  it('lets a variant override win a tie on the day, even against a later recorded style record', () => {
    const records = [
      record({
        variantId: VARIANT,
        unitCost: '130.0000',
        recordedAt: '2026-02-01T00:00:00.000000',
      }),
      record({ unitCost: '999.0000', recordedAt: '2026-02-09T00:00:00.000000' }),
    ];
    expect(selectCost(records, '2026-03-01')).toMatchObject({ unitCost: '130.0000' });
  });

  it('breaks a tie on the same day and recordedAt by the greatest id, in either order', () => {
    const low = record({ id: 'a-1', unitCost: '10.0000' });
    const high = record({ id: 'b-2', unitCost: '20.0000' });
    expect(selectCost([low, high], '2026-03-01')).toMatchObject({ unitCost: '20.0000' });
    expect(selectCost([high, low], '2026-03-01')).toMatchObject({ unitCost: '20.0000' });
  });

  it('is not set before the first record and with no record, never zero', () => {
    expect(selectCost(worked, '2026-02-28')).toEqual({ status: 'not_set' });
    expect(selectCost([], '2026-03-01')).toEqual({ status: 'not_set' });
  });
});

// Spec 0012, AC-12: `costForMany` reads the chosen record itself (its date, and style or override).
describe('pickCostRecord', () => {
  it('picks the record selectCost decides by, so the two never disagree', () => {
    for (const day of ['2026-02-28', '2026-03-15', '2026-05-01', '2027-03-02']) {
      const picked = pickCostRecord(worked, day);
      expect(selectCost(worked, day)).toEqual(
        picked
          ? { status: 'set', unitCost: picked.unitCost, costBasis: picked.costBasis }
          : { status: 'not_set' },
      );
    }
  });

  it('names the override on its day and the style record otherwise', () => {
    expect(pickCostRecord(worked, '2026-05-01')).toMatchObject({
      variantId: VARIANT,
      effectiveFrom: '2026-04-01',
    });
    expect(pickCostRecord(worked, '2027-03-02')).toMatchObject({
      variantId: null,
      effectiveFrom: '2027-03-01',
    });
    expect(pickCostRecord([], '2026-03-01')).toBeUndefined();
  });
});
