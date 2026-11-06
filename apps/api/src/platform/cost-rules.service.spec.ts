import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import { assertOperatingDay, InvalidOperatingDay } from './cost-rule-selection.js';
import { CostRulesService } from './cost-rules.service.js';

describe('assertOperatingDay', () => {
  it.each(['2026-11-06', '2028-02-29', '2026-12-31', '0001-01-01'])('accepts %s', (day) => {
    expect(() => assertOperatingDay(day)).not.toThrow();
  });

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-1-1',
    '6/11/2026',
    '',
    '2026-11-06T00:00:00Z',
    ' 2026-11-06',
  ])('refuses %j with InvalidOperatingDay', (day) => {
    expect(() => assertOperatingDay(day)).toThrow(InvalidOperatingDay);
  });
});

describe('CostRulesService.ruleFor', () => {
  it('refuses a day that is not a calendar date before it queries', async () => {
    const execute = vi.fn();
    const service = new CostRulesService({ db: { execute } } as unknown as DatabaseConnection);

    await expect(service.ruleFor('cod_fee_percent', '2026-02-30')).rejects.toBeInstanceOf(
      InvalidOperatingDay,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
