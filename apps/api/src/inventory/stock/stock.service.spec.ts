import type { SkuMovement } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { Access } from '../../platform/access/access.js';
import { serializeMovement } from './stock.service.js';

const accessOf = (hats: string[], grants: string[]) =>
  new Access({
    userId: '00000000-0000-7000-8000-000000000009',
    hats,
    grants,
    partnerAccountId: null,
  });

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

describe('serializeMovement (AC-11, spec 0008 AC-6)', () => {
  it('keeps unit cost and value for a caller with cost.view, whatever the hat', () => {
    expect(serializeMovement(movement, accessOf(['warehouse'], ['cost.view']))).toEqual(movement);
  });

  it('leaves both fields out without cost.view, even for a manager', () => {
    expect(serializeMovement(movement, accessOf(['manager'], []))).not.toHaveProperty('unitCost');
    const forStaff = serializeMovement(movement, accessOf(['warehouse'], []));
    expect(forStaff).not.toHaveProperty('unitCost');
    expect(forStaff).not.toHaveProperty('totalCost');
    expect(forStaff).toMatchObject({ quantity: 10, source: { number: 'SR-2026-000001' } });
  });
});
