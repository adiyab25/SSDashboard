import {
  AUDIT_ACTIONS,
  isAuditActionCode,
  type AuditEntryDetail,
  type AuditEntryListResponse,
  type AuditEntryView,
} from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import {
  auditDiffFor,
  COST_ENTRY_ACTIONS,
  auditDiffsFor,
  exportMayHaveHeldCostEntries,
  isCostKey,
  serializeAuditDetail,
  serializeAuditEntry,
  serializeAuditPage,
} from './audit-cost-fields.js';

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
      { field: 'status', kind: 'changed', before: 'posted', after: 'voided', personal: false },
      { field: 'referenceValue', kind: 'removed', before: '100.00', after: null, personal: false },
      { field: 'avgUnitCost', kind: 'added', before: null, after: '4.00', personal: false },
      {
        field: 'lines',
        kind: 'removed',
        before: [{ sku: 'A', unitCost: '5.00' }],
        after: null,
        personal: false,
      },
    ],
  };

  it('drops cost changes and strips cost keys inside the kept ones without cost.view', () => {
    const shown = serializeAuditDetail(detail, { has: () => false });
    expect(shown.before).toEqual({ status: 'posted', lines: [{ sku: 'A' }] });
    expect(shown.after).toEqual({ status: 'voided' });
    expect(shown.changes).toEqual([
      { field: 'status', kind: 'changed', before: 'posted', after: 'voided', personal: false },
      { field: 'lines', kind: 'removed', before: [{ sku: 'A' }], after: null, personal: false },
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

// Spec 0012 AC-17, the owner's ruling of 2026-11-11 "Hide whole entry": a cost record's entry
// is hidden whole from a reader without cost.view (the readers filter it out in SQL), so the
// serializers no longer touch its reason.
describe('cost entries (cost_record.recorded)', () => {
  it('lists cost_record.recorded as the one cost entry action, a registered code', () => {
    expect(COST_ENTRY_ACTIONS).toEqual(['cost_record.recorded']);
    for (const action of COST_ENTRY_ACTIONS) expect(isAuditActionCode(action)).toBe(true);
  });

  // Guard (security review L1): the list is derived from the registry flag, and any action whose
  // proof is the cost e2e must carry the flag, so a new cost action cannot leak unflagged.
  it('derives the list from the registry flag, and flags every action proven by the cost e2e', () => {
    const flagged = Object.entries(AUDIT_ACTIONS)
      .filter(([, definition]) => 'costEntry' in definition)
      .map(([code]) => code);
    expect(COST_ENTRY_ACTIONS).toEqual(flagged);
    for (const [code, definition] of Object.entries(AUDIT_ACTIONS)) {
      if (definition.proof === 'apps/api/test/cost.e2e-spec.ts') {
        expect(COST_ENTRY_ACTIONS, code).toContain(code);
      }
    }
  });

  it('keeps the reason of every entry the reader is shown', () => {
    const costEntry = { ...entry, action: 'cost_record.recorded', reason: 'Invoice found late' };
    expect(serializeAuditEntry(costEntry, { has: () => false }).reason).toBe('Invoice found late');
    expect(serializeAuditDetail({ ...costEntry, changes: [] }, { has: () => true }).reason).toBe(
      'Invoice found late',
    );
  });
});

// Security review AS34: the undo answers one entry through `serializeAuditEntry`.
describe('serializeAuditEntry (the undo answer, spec 0010 AC-14)', () => {
  it('strips cost fields from one entry without cost.view and keeps it whole with it', () => {
    const shown = serializeAuditEntry(entry, { has: () => false });
    expect(shown.before).toEqual({ status: 'posted', lines: [{ sku: 'A' }] });
    expect(shown.after).toEqual({ status: 'voided' });
    expect(shown.reason).toBe('wrong count');
    expect(entry.before.referenceValue).toBe('100.00');
    expect(serializeAuditEntry(entry, { has: (p) => p === 'cost.view' })).toBe(entry);
  });
});

// Security review AS30 and review M4R8: a diff is whatever JSON its writer built, so a cost key
// is matched in any spelling the route sweep's `normalKey` treats as the same, and inside JSON
// text a diff stores as a string.
describe('cost keys in any spelling and inside JSON text', () => {
  it('knows a cost key by case and separators, and nothing else', () => {
    for (const key of [
      'unitCost',
      'unit_cost',
      'UnitCost',
      'UNIT-COST',
      'unit cost',
      'total_value',
      // Spec 0012, AC-16: the style page's `cost` object joined COST_FIELD_KEYS.
      'cost',
      'Cost',
    ]) {
      expect(isCostKey(key), key).toBe(true);
    }
    for (const key of ['costs', 'unit', 'price', 'unitCostNote', 'costView'])
      expect(isCostKey(key), key).toBe(false);
  });

  it('strips snake and pascal case cost keys at any depth', () => {
    expect(
      auditDiffFor(
        { status: 'posted', unit_cost: '5.00', lines: [{ sku: 'A', LineTotal: '9.00' }] },
        false,
      ),
    ).toEqual({ status: 'posted', lines: [{ sku: 'A' }] });
  });

  it('strips cost keys inside JSON text and writes it back as JSON, leaving other text alone', () => {
    const diff = {
      lines: '[{"unitCost":"7.00","qty":2}]',
      payload: ' {"order":{"total_cost":"9.00","ref":"A1"}} ',
      note: '{not json',
      plain: 'unitCost is a word here',
      clean: '{"qty":1}',
    };

    expect(auditDiffFor(diff, false)).toEqual({
      lines: '[{"qty":2}]',
      payload: '{"order":{"ref":"A1"}}',
      note: '{not json',
      plain: 'unitCost is a word here',
      clean: '{"qty":1}',
    });
    expect(auditDiffFor(diff, true)).toBe(diff);
  });

  it('drops a detail change whose field is a cost key in any spelling', () => {
    const detail: AuditEntryDetail = {
      ...entry,
      before: { unit_cost: '5.00' },
      after: { unit_cost: '6.00' },
      changes: [
        { field: 'unit_cost', kind: 'changed', before: '5.00', after: '6.00', personal: false },
        {
          field: 'payload',
          kind: 'added',
          before: null,
          after: '{"UnitCost":"6.00","qty":1}',
          personal: false,
        },
      ],
    };

    expect(serializeAuditDetail(detail, { has: () => false }).changes).toEqual([
      { field: 'payload', kind: 'added', before: null, after: '{"qty":1}', personal: false },
    ]);
  });
});

// Security review M1, the lead's ruling of 2026-11-11: a holder's export stays visible (who and
// when), but its filter and rows are redacted for a reader without cost.view when the export
// could have held a cost entry (a cost action filter, or none).
describe('a cost.view holder audit.exported entry', () => {
  const exported = (after: Record<string, unknown>): AuditEntryView => ({
    ...entry,
    action: 'audit.exported',
    record: { type: 'audit_entry', id: '00000000-0000-4000-8000-000000000009', label: null },
    before: null,
    after,
    reason: 'quarterly review',
  });
  const noCost = { has: () => false };

  it('decides from the cost marker and the action filter', () => {
    const held = { costVisible: true, rows: 3 };
    expect(exportMayHaveHeldCostEntries({ ...held, dayFrom: '2026-11-01' })).toBe(true);
    expect(exportMayHaveHeldCostEntries({ ...held, action: 'cost_record.recorded' })).toBe(true);
    expect(exportMayHaveHeldCostEntries({ ...held, action: 'style.updated' })).toBe(false);
    // A non-holder's export, and a legacy one with no marker, never held a cost entry.
    expect(exportMayHaveHeldCostEntries({ rows: 3 })).toBe(false);
    expect(exportMayHaveHeldCostEntries({ costVisible: false, rows: 3 })).toBe(false);
    expect(exportMayHaveHeldCostEntries(null)).toBe(false);
  });

  it('redacts filter and rows on every serializer, keeping who, when, and the reason', () => {
    const open = exported({ dayFrom: '2026-11-01', rows: 17, costVisible: true });
    const shownEntry = serializeAuditEntry(open, noCost);
    expect(shownEntry.after).toEqual({ redacted: true });
    expect(shownEntry.reason).toBe('quarterly review');
    expect(shownEntry.actor).toEqual(open.actor);
    expect(serializeAuditPage({ items: [open], nextCursor: null }, noCost).items[0]?.after).toEqual(
      {
        redacted: true,
      },
    );
    const detail = serializeAuditDetail(
      {
        ...open,
        changes: [
          { field: 'rows', kind: 'added', before: null, after: 17, personal: false },
          { field: 'dayFrom', kind: 'added', before: null, after: '2026-11-01', personal: false },
        ],
      },
      noCost,
    );
    expect(detail.after).toEqual({ redacted: true });
    expect(detail.changes).toEqual([
      { field: 'redacted', kind: 'added', before: null, after: true, personal: false },
    ]);
    expect(auditDiffsFor(open, false).after).toEqual({ redacted: true });
  });

  it('keeps an export filtered to another action complete, and everything for a holder', () => {
    const other = exported({ action: 'style.updated', rows: 4, costVisible: true });
    expect(serializeAuditEntry(other, noCost).after).toEqual({
      action: 'style.updated',
      rows: 4,
      costVisible: true,
    });
    const open = exported({ rows: 17, costVisible: true });
    expect(serializeAuditEntry(open, { has: () => true })).toBe(open);
    expect(auditDiffsFor(open, true).after).toEqual({ rows: 17, costVisible: true });
    const nonHolder = exported({ rows: 9 });
    expect(serializeAuditEntry(nonHolder, noCost).after).toEqual({ rows: 9 });
  });
});
