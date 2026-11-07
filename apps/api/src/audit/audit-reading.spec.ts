import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import type { StaffDirectory } from '../identity/staff/staff-directory.js';
import { AuditReadForbidden } from './audit.errors.js';
import { csvCell, csvLine, exportCells, exportFileName } from './audit-export.service.js';
import { AuditQueryService, fieldChanges, type EntryRow } from './audit-query.service.js';

const ID = '01937f3a-0000-7000-8000-000000000001';

function row(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: ID,
    recorded_at: '2026-11-07T10:00:00.000001Z',
    operating_day: '2026-11-07',
    correlation_id: ID,
    actor_kind: 'person',
    actor_user_id: ID,
    actor_ref: null,
    actor_hat: 'admin',
    job_id: null,
    action: 'sku.code_changed',
    record_type: 'sku',
    record_id: ID,
    record_label: 'TEE-NEW',
    before: { code: 'TEE-OLD', archived: false },
    after: { code: 'TEE-NEW', address: '[REDACTED]' },
    personal_fields: ['address'],
    reason: null,
    ...overrides,
  };
}

// Spec 0010, milestone 3: the detail diff, the history panel's permission, and the CSV cells.
describe('audit reading (spec 0010, milestone 3)', () => {
  it('lists every changed field once, in stored order, with the personal ones marked', () => {
    expect(fieldChanges(row())).toEqual([
      { field: 'code', before: 'TEE-OLD', after: 'TEE-NEW', personal: false },
      { field: 'archived', before: false, after: null, personal: false },
      { field: 'address', before: null, after: '[REDACTED]', personal: true },
    ]);
    expect(
      fieldChanges(
        row({
          before: null,
          after: { customer: { name: 'x' } },
          personal_fields: ['customer.name'],
        }),
      ),
    ).toEqual([{ field: 'customer', before: null, after: { name: 'x' }, personal: true }]);
  });

  it('refuses the record history to a viewer without the read permission, before any read', async () => {
    const execute = vi.fn();
    const reader = new AuditQueryService(
      { db: { execute } } as unknown as DatabaseConnection,
      { namesByIds: vi.fn() } as unknown as StaffDirectory,
    );

    await expect(
      reader.forRecord({ id: ID, role: 'staff' }, 'sku', ID, undefined, 50),
    ).rejects.toBeInstanceOf(AuditReadForbidden);
    expect(execute).not.toHaveBeenCalled();
  });

  it('quotes every cell, doubles inner quotes, and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    for (const formula of ['=1+1', '+1', '-X', '@SUM(A1)']) {
      expect(csvCell(formula)).toBe(`"'${formula}"`);
    }
    expect(csvLine(['a', 'b'])).toBe('"a","b"\r\n');
  });

  it('names the file from the day range and fills the columns in order', () => {
    expect(exportFileName({ dayFrom: '2026-11-01', dayTo: '2026-11-07' })).toBe(
      'audit-2026-11-01-2026-11-07.csv',
    );
    expect(exportCells(row(), '2026-11-07T12:00:00.000001', 'Mona')).toEqual([
      '2026-11-07T12:00:00.000001',
      '2026-11-07',
      'person',
      'Mona',
      'admin',
      'sku.code_changed',
      'SKU code changed',
      'sku',
      ID,
      'TEE-NEW',
      null,
      { code: 'TEE-OLD', archived: false },
      { code: 'TEE-NEW', address: '[REDACTED]' },
      'address',
      ID,
      ID,
    ]);
    const system = exportCells(
      row({ actor_kind: 'carrier', actor_user_id: null, actor_ref: 'bosta', action: 'x.y' }),
      't',
      null,
    );
    expect(system[3]).toBe('bosta');
    expect(system[6]).toBe('x.y');
  });
});
