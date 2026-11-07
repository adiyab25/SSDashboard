import type { AuditEntryDetail, AuditEntryListResponse } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { auditDiffFor, serializeAuditDetail, serializeAuditPage } from './audit-cost-fields.js';

const entry = {
  id: '00000000-0000-4000-8000-000000000001',
  recordedAt: '2026-11-06T10:00:00.000000Z',
  operatingDay: '2026-11-06',
  correlationId: '00000000-0000-4000-8000-000000000002',
  actor: {
    kind: 'person' as const,
    userId: '00000000-0000-4000-8000-000000000003',
    ref: null,
    hat: 'manager',
    jobId: null,
  },
  actorName: null,
  action: 'stock_receipt.voided',
  record: { type: 'stock_receipt', id: '00000000-0000-4000-8000-000000000004', label: 'R-1' },
  before: { status: 'posted', referenceValue: '100.00', lines: [{ sku: 'A', unitCost: '5.00' }] },
  after: { status: 'voided', avgUnitCost: '4.00' },
  personalFields: [],
  reason: 'wrong count',
  undone: false,
  canUndo: false,
};
const page: AuditEntryListResponse = { items: [entry], nextCursor: null };

describe('serializeAuditPage (spec 0008 AC-6, spec 0010 security model)', () => {
  it('removes every cost field from the diffs, at any depth, for a reader without cost.view', () => {
    const shown = serializeAuditPage(page, { has: () => false });
    expect(shown.items[0]?.before).toEqual({ status: 'posted', lines: [{ sku: 'A' }] });
    expect(shown.items[0]?.after).toEqual({ status: 'voided' });
    expect(shown.items[0]?.reason).toBe('wrong count');
  });

  it('keeps the page unchanged for a reader with cost.view', () => {
    expect(serializeAuditPage(page, { has: (p) => p === 'cost.view' })).toBe(page);
  });

  it('keeps a missing diff null and never mutates the page', () => {
    const creation = { ...entry, before: null };
    const shown = serializeAuditPage({ items: [creation], nextCursor: 'x' }, { has: () => false });
    expect(shown.items[0]?.before).toBeNull();
    expect(shown.nextCursor).toBe('x');
    expect(entry.before.referenceValue).toBe('100.00');
  });
});

describe('serializeAuditDetail (spec 0008 AC-6, spec 0010 AC-12)', () => {
  const detail: AuditEntryDetail = {
    ...entry,
    changes: [
      { field: 'status', before: 'posted', after: 'voided', personal: false },
      { field: 'referenceValue', before: '100.00', after: null, personal: false },
      { field: 'avgUnitCost', before: null, after: '4.00', personal: false },
      { field: 'lines', before: [{ sku: 'A', unitCost: '5.00' }], after: null, personal: false },
    ],
  };

  it('drops cost changes and strips cost keys inside the kept ones without cost.view', () => {
    const shown = serializeAuditDetail(detail, { has: () => false });
    expect(shown.before).toEqual({ status: 'posted', lines: [{ sku: 'A' }] });
    expect(shown.after).toEqual({ status: 'voided' });
    expect(shown.changes).toEqual([
      { field: 'status', before: 'posted', after: 'voided', personal: false },
      { field: 'lines', before: [{ sku: 'A' }], after: null, personal: false },
    ]);
    expect(detail.changes).toHaveLength(4);
  });

  it('keeps the detail unchanged with cost.view', () => {
    expect(serializeAuditDetail(detail, { has: (p) => p === 'cost.view' })).toBe(detail);
  });
});

describe('auditDiffFor (the export cells)', () => {
  it('strips cost keys without cost.view, keeps them with it, and keeps null', () => {
    expect(auditDiffFor(entry.before, false)).toEqual({ status: 'posted', lines: [{ sku: 'A' }] });
    expect(auditDiffFor(entry.before, true)).toBe(entry.before);
    expect(auditDiffFor(null, false)).toBeNull();
  });
});
