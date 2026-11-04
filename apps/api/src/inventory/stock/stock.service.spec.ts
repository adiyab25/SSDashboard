import type { SkuMovement } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { serializeMovement } from './stock.service.js';

const movement: SkuMovement = {
  id: '00000000-0000-7000-8000-000000000001',
  effectiveAt: '2026-11-04T10:00:00.000000Z',
  recordedAt: '2026-11-04T10:00:00.000000Z',
  location: { id: '00000000-0000-7000-8000-000000000002', code: 'WH-1', name: { en: 'Main' } },
  quantity: 10,
  sourceType: 'stock_receipt',
  isReversal: false,
  source: { id: '00000000-0000-7000-8000-000000000003', number: 'SR-2026-000001' },
  postedBy: null,
  unitCost: '5.0000',
  totalCost: '50.00',
};

describe('serializeMovement (AC-11)', () => {
  it('keeps unit cost and value for admins', () => {
    expect(serializeMovement(movement, 'admin')).toEqual(movement);
  });

  it('leaves both fields out for staff', () => {
    const forStaff = serializeMovement(movement, 'staff');
    expect(forStaff).not.toHaveProperty('unitCost');
    expect(forStaff).not.toHaveProperty('totalCost');
    expect(forStaff).toMatchObject({ quantity: 10, source: { number: 'SR-2026-000001' } });
  });
});
