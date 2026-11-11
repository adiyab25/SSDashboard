import type { Permission, StyleDetail } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { serializeStyleDetail } from './styles.service.js';

const variant = (id: string, cost: StyleDetail['variants'][number]['cost']) => ({
  id,
  code: `SKU-${id.slice(-1)}`,
  options: [],
  price: '250.00',
  archived: false,
  barcodes: [],
  cost,
});

const detail: StyleDetail = {
  id: '00000000-0000-7000-8000-000000000001',
  code: 'TEE',
  name: { en: 'Tee' },
  description: null,
  season: null,
  productGroup: { id: '00000000-0000-7000-8000-000000000002', code: 'MAIN', name: { en: 'Main' } },
  tags: [],
  productType: null,
  brand: null,
  archived: false,
  updatedAt: '2026-11-09T00:00:00.000000Z',
  options: [],
  variants: [
    variant('00000000-0000-7000-8000-00000000000a', {
      status: 'set',
      unitCost: '120.0000',
      costBasis: 'estimate',
      effectiveFrom: '2026-03-01',
      inheritedFrom: 'style',
    }),
    variant('00000000-0000-7000-8000-00000000000b', { status: 'not_set' }),
  ],
};

const holding = (...held: Permission[]) => ({ has: (p: Permission) => held.includes(p) });

// Spec 0012, AC-12 and AC-16: the StyleDetail serializer on Access.
describe('serializeStyleDetail', () => {
  it('keeps every variant cost for a caller holding cost.view', () => {
    expect(serializeStyleDetail(detail, holding('stock.view', 'cost.view'))).toBe(detail);
  });

  it('leaves no cost key on any variant without cost.view, and keeps the rest', () => {
    const served = serializeStyleDetail(detail, holding('stock.view'));

    expect(served.variants.map((row) => Object.keys(row))).toEqual([
      ['id', 'code', 'options', 'price', 'archived', 'barcodes'],
      ['id', 'code', 'options', 'price', 'archived', 'barcodes'],
    ]);
    expect(JSON.stringify(served)).not.toContain('unitCost');
    expect(served.code).toBe('TEE');
  });
});
