import { describe, expect, it } from 'vitest';
import { selectCostRule, type CostRuleCandidate } from './cost-rule-selection.js';

let sequence = 0;
const row = (over: Partial<CostRuleCandidate>): CostRuleCandidate => ({
  id: `0000-${String((sequence += 1)).padStart(4, '0')}`,
  status: 'set',
  value: '2.5000',
  effectiveFrom: '2026-03-01',
  recordedAt: '2026-03-01T10:00:00.000000',
  ...over,
});

// Spec 0002, catalog child, "Per order cost rules" (AC-32).
describe('selectCostRule', () => {
  const seeded = row({ status: 'not_set', value: null, effectiveFrom: '2026-01-10' });

  it('is not set on a fresh install, never zero', () => {
    expect(selectCostRule([seeded], '2026-02-01')).toEqual({ status: 'not_set' });
  });

  it('is not set with no row, and before the first row', () => {
    expect(selectCostRule([], '2026-03-01')).toEqual({ status: 'not_set' });
    expect(selectCostRule([seeded], '2026-01-09')).toEqual({ status: 'not_set' });
  });

  it('is set from the effective day of a set row, and not set the day before', () => {
    const rows = [seeded, row({ value: '2.5000', effectiveFrom: '2026-03-01' })];

    expect(selectCostRule(rows, '2026-03-01')).toEqual({ status: 'set', value: '2.5000' });
    expect(selectCostRule(rows, '2026-12-31')).toEqual({ status: 'set', value: '2.5000' });
    expect(selectCostRule(rows, '2026-02-28')).toEqual({ status: 'not_set' });
  });

  it('lets a later recorded row on the same day win, in either order', () => {
    const first = row({ value: '25.0000', recordedAt: '2026-03-01T10:00:00.000000' });
    const fix = row({ value: '2.5000', recordedAt: '2026-03-01T11:00:00.000000' });

    expect(selectCostRule([first, fix], '2026-03-01')).toEqual({ status: 'set', value: '2.5000' });
    expect(selectCostRule([fix, first], '2026-03-01')).toEqual({ status: 'set', value: '2.5000' });
  });

  it('lets a later not_set row unset a rule', () => {
    const rows = [
      row({ value: '2.5000', effectiveFrom: '2026-03-01' }),
      row({ status: 'not_set', value: null, effectiveFrom: '2026-06-01' }),
    ];

    expect(selectCostRule(rows, '2026-05-31')).toEqual({ status: 'set', value: '2.5000' });
    expect(selectCostRule(rows, '2026-06-01')).toEqual({ status: 'not_set' });
  });

  it('breaks a tie on the day and recordedAt by the greatest id', () => {
    const low = row({ id: 'a-1', value: '1.0000' });
    const high = row({ id: 'b-2', value: '2.0000' });

    expect(selectCostRule([low, high], '2026-03-01')).toEqual({ status: 'set', value: '2.0000' });
    expect(selectCostRule([high, low], '2026-03-01')).toEqual({ status: 'set', value: '2.0000' });
  });

  it('answers a set zero as set, distinct from not set', () => {
    expect(selectCostRule([row({ value: '0.0000' })], '2026-03-01')).toEqual({
      status: 'set',
      value: '0.0000',
    });
  });
});
