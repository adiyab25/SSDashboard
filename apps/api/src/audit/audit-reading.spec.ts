import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import type { StaffDirectory } from '../identity/staff/staff-directory.js';
import { encodeKeyset } from '../platform/keyset-cursor.js';
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
    actor_hat: 'manager',
    job_id: null,
    action: 'sku.code_changed',
    record_type: 'sku',
    record_id: ID,
    record_label: 'TEE-NEW',
    before: { code: 'TEE-OLD', archived: false },
    after: { code: 'TEE-NEW', address: '[REDACTED]' },
    personal_fields: ['address'],
    reason: null,
    undo_action: null,
    ...overrides,
  };
}

// Spec 0010, milestone 3: the detail diff, the history panel's permission, and the CSV cells.
describe('audit reading (spec 0010, milestone 3)', () => {
  it('lists every changed field once, in stored order, with the personal ones marked', () => {
    expect(fieldChanges(row())).toEqual([
      { field: 'code', kind: 'changed', before: 'TEE-OLD', after: 'TEE-NEW', personal: false },
      { field: 'archived', kind: 'removed', before: false, after: null, personal: false },
      { field: 'address', kind: 'added', before: null, after: '[REDACTED]', personal: true },
    ]);
    expect(
      fieldChanges(
        row({
          before: null,
          after: { customer: { name: 'x' } },
          personal_fields: ['customer.name'],
        }),
      ),
    ).toEqual([
      { field: 'customer', kind: 'added', before: null, after: { name: 'x' }, personal: true },
    ]);
  });

  // Review M3R12: a stored null is a side that holds the field, not a missing side.
  it('tells an explicit null from a field one side does not hold', () => {
    const changes = fieldChanges(
      row({ before: { note: null }, after: { note: 'set', tag: null }, personal_fields: [] }),
    );

    expect(changes).toEqual([
      { field: 'note', kind: 'changed', before: null, after: 'set', personal: false },
      { field: 'tag', kind: 'added', before: null, after: null, personal: false },
    ]);
  });

  it('refuses the record history to a viewer without the read permission, before any read', async () => {
    const execute = vi.fn();
    const reader = new AuditQueryService(
      { db: { execute } } as unknown as DatabaseConnection,
      { namesByIds: vi.fn() } as unknown as StaffDirectory,
    );

    await expect(
      reader.forRecord(
        { userId: ID, has: () => false, actingHat: () => 'warehouse' },
        'sku',
        ID,
        undefined,
        50,
      ),
    ).rejects.toBeInstanceOf(AuditReadForbidden);
    expect(execute).not.toHaveBeenCalled();
  });

  it('leaves cost fields out of the record history for a viewer without cost.view (spec 0008 AC-6)', async () => {
    const costly = row({
      before: { code: 'TEE-OLD', unitCost: '5.00' },
      after: { code: 'TEE-NEW', lines: [{ avgUnitCost: '4.00', qty: 1 }] },
      personal_fields: [],
    });
    const historyFor = async (cost: boolean) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({ rows: [costly] })
        .mockResolvedValueOnce({ rows: [] });
      const reader = new AuditQueryService(
        { db: { execute } } as unknown as DatabaseConnection,
        { namesByIds: vi.fn(() => Promise.resolve(new Map())) } as unknown as StaffDirectory,
      );
      const viewer = {
        userId: ID,
        has: (permission: string) =>
          permission === 'audit.read' || (cost && permission === 'cost.view'),
        actingHat: () => 'manager',
      };
      return reader.forRecord(viewer, 'sku', ID, undefined, 50);
    };

    const hidden = await historyFor(false);
    expect(hidden.items[0]?.before).toEqual({ code: 'TEE-OLD' });
    expect(hidden.items[0]?.after).toEqual({ code: 'TEE-NEW', lines: [{ qty: 1 }] });
    const shown = await historyFor(true);
    expect(shown.items[0]?.before).toEqual({ code: 'TEE-OLD', unitCost: '5.00' });
  });

  // Security review AS29: every public reader guards itself, so another module that calls one
  // with a support agent's access gets 403, never the trail or its costs.
  it('refuses the list, the detail, the view, and the export reads without their permission, before any read', async () => {
    const execute = vi.fn();
    const reader = new AuditQueryService(
      { db: { execute } } as unknown as DatabaseConnection,
      { namesByIds: vi.fn() } as unknown as StaffDirectory,
    );
    // Holds everything but the permission each reader needs.
    const without = (missing: string) => ({ has: (permission: string) => permission !== missing });
    const query = { dayFrom: '2026-11-01', dayTo: '2026-11-07' };
    const key = { at: '2026-11-07T10:00:00.000001Z', id: ID };

    await expect(reader.list({ limit: 50 }, without('audit.read'))).rejects.toBeInstanceOf(
      AuditReadForbidden,
    );
    await expect(reader.get(ID, without('audit.read'))).rejects.toBeInstanceOf(AuditReadForbidden);
    await expect(reader.view(ID, without('audit.read'))).rejects.toBeInstanceOf(AuditReadForbidden);
    await expect(reader.exportBound(query, without('audit.export'))).rejects.toBeInstanceOf(
      AuditReadForbidden,
    );
    await expect(reader.exportSize(query, without('audit.export'), key, 10)).rejects.toBeInstanceOf(
      AuditReadForbidden,
    );
    await expect(
      reader.exportBatches(query, without('audit.export'), 'UTC', key, 1_000, 10).next(),
    ).rejects.toBeInstanceOf(AuditReadForbidden);
    expect(execute).not.toHaveBeenCalled();
  });

  it('leaves cost fields out of the list, the detail, the view, and the export rows without cost.view', async () => {
    const costly = row({
      before: { code: 'TEE-OLD', unit_cost: '5.00' },
      after: { code: 'TEE-NEW', payload: '{"lines":[{"UnitCost":"4.00","qty":1}]}' },
      personal_fields: [],
    });
    const readerOf = () => {
      // Every select answers the costed row, and the undone lookup finds nothing.
      const execute = vi.fn((query: unknown) =>
        Promise.resolve({
          rows: sqlText(query).includes('undoes_entry_id = ANY') ? [] : [costly],
        }),
      );
      return new AuditQueryService(
        { db: { execute } } as unknown as DatabaseConnection,
        { namesByIds: vi.fn(() => Promise.resolve(new Map())) } as unknown as StaffDirectory,
      );
    };
    const reads = { has: (permission: string) => permission !== 'cost.view' };
    const hiddenBefore = { code: 'TEE-OLD' };
    const hiddenAfter = { code: 'TEE-NEW', payload: '{"lines":[{"qty":1}]}' };

    const page = await readerOf().list({ limit: 50 }, reads);
    expect(page.items[0]).toMatchObject({ before: hiddenBefore, after: hiddenAfter });
    const detail = await readerOf().get(ID, reads);
    expect(detail).toMatchObject({ before: hiddenBefore, after: hiddenAfter });
    expect(detail.changes.map((change) => change.field)).toEqual(['code', 'payload']);
    expect(await readerOf().view(ID, reads)).toMatchObject({
      before: hiddenBefore,
      after: hiddenAfter,
    });
    const key = { at: '2026-11-07T10:00:00.000001Z', id: ID };
    const batches = readerOf().exportBatches(
      { dayFrom: '2026-11-01', dayTo: '2026-11-07' },
      reads,
      'UTC',
      key,
      1_000,
      1,
    );
    const first = await batches.next();
    expect(first.value).toEqual([
      expect.objectContaining({
        row: expect.objectContaining({ before: hiddenBefore, after: hiddenAfter }) as unknown,
      }),
    ]);

    const all = { has: () => true };
    expect((await readerOf().view(ID, all)).before).toEqual({ code: 'TEE-OLD', unit_cost: '5.00' });
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
      'manager',
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

/**
 * The SQL text of a Drizzle SQL object, nested SQL included, each bound string written as
 * `'<value>'` and any other bound value as `?`.
 */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk): string => {
      if (typeof chunk === 'object' && chunk !== null) {
        const value = (chunk as { value?: unknown }).value;
        // Literal SQL is a chunk with a `value` array of strings; a nested sql`...` has chunks.
        if (Array.isArray(value)) return value.join('');
        if (Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) return sqlText(chunk);
      }
      return typeof chunk === 'string' ? `'${chunk}'` : '?';
    })
    .join('');
}

// Spec 0010 task 18 (AC-17): every reader selects `recorded_at` as text under the same name, and
// PostgreSQL resolves a bare `ORDER BY recorded_at` to that output column, so the page sorted the
// text and no index could serve it (a full scan and sort of 5,000,000 entries). Each reader must
// order by the table's own columns.
describe('audit reading order (spec 0010, AC-17)', () => {
  const KEYSET_ORDER = 'ORDER BY audit_entries.recorded_at DESC, audit_entries.id DESC';

  function reader() {
    const statements: string[] = [];
    const execute = vi.fn((query: unknown) => {
      statements.push(sqlText(query).replace(/\s+/g, ' '));
      return Promise.resolve({ rows: [] });
    });
    const service = new AuditQueryService(
      { db: { execute } } as unknown as DatabaseConnection,
      { namesByIds: vi.fn(() => Promise.resolve(new Map())) } as unknown as StaffDirectory,
    );
    return { service, statements };
  }

  /** The statements among `statements` that order rows, each of which must name the table. */
  function orderings(statements: string[]): string[] {
    const ordered = statements.filter((text) => text.includes('ORDER BY'));
    expect(ordered.length).toBeGreaterThan(0);
    return ordered;
  }

  it('orders the list, the next page, and the record history by the table columns', async () => {
    const { service, statements } = reader();
    const viewer = { userId: ID, has: () => true, actingHat: () => 'manager' };
    await service.list({ limit: 50 }, viewer);
    await service.list({ actorUserId: ID, limit: 50 }, viewer);
    const cursor = encodeKeyset(['2026-11-07T10:00:00.000001Z', ID]);
    await service.list({ actorUserId: ID, cursor, limit: 50 }, viewer);
    await service.forRecord(viewer, 'sku', ID, undefined, 50);

    for (const text of orderings(statements)) expect(text).toContain(KEYSET_ORDER);
    expect(statements.join('\n')).not.toMatch(/ORDER BY (?!audit_entries\.)/);
  });

  it('orders the export bound and its batches by the table columns', async () => {
    const { service, statements } = reader();
    const query = { dayFrom: '2026-11-01', dayTo: '2026-11-07' };
    const viewer = { has: () => true };
    await service.exportBound(query, viewer);
    const batches = service.exportBatches(
      query,
      viewer,
      'Africa/Cairo',
      { at: '2026-11-07T10:00:00.000001Z', id: ID },
      1_000,
      10,
    );
    for await (const batch of batches) expect(batch).toEqual([]);

    expect(orderings(statements)).toHaveLength(2);
    for (const text of orderings(statements)) expect(text).toContain(KEYSET_ORDER);
  });
});

// Spec 0010 task 18 (AC-17): a day bound also bounds `recorded_at` from midnight UTC two days
// before `dayFrom` to midnight UTC three days after `dayTo`, so the newest first index has a range
// to start from; the `operating_day` conditions still decide the match.
describe('audit day range bound (spec 0010, AC-17)', () => {
  const FROM =
    "audit_entries.recorded_at >= (('2026-11-01'::date - 2)::timestamp AT TIME ZONE 'UTC')";
  const TO = "audit_entries.recorded_at < (('2026-11-07'::date + 3)::timestamp AT TIME ZONE 'UTC')";

  function reader() {
    const statements: string[] = [];
    const execute = vi.fn((query: unknown) => {
      statements.push(sqlText(query).replace(/\s+/g, ' '));
      return Promise.resolve({ rows: [] });
    });
    const service = new AuditQueryService(
      { db: { execute } } as unknown as DatabaseConnection,
      { namesByIds: vi.fn(() => Promise.resolve(new Map())) } as unknown as StaffDirectory,
    );
    return { service, statements };
  }

  it('bounds the list by instant beside the operating day, in UTC', async () => {
    const { service, statements } = reader();
    await service.list(
      { dayFrom: '2026-11-01', dayTo: '2026-11-07', limit: 50 },
      { has: () => true },
    );

    const [page] = statements;
    expect(page).toContain("operating_day >= '2026-11-01'::date");
    expect(page).toContain("operating_day <= '2026-11-07'::date");
    expect(page).toContain(FROM);
    expect(page).toContain(TO);
  });

  it('bounds each side alone, and adds no instant bound without a day', async () => {
    const { service, statements } = reader();
    await service.list({ dayFrom: '2026-11-01', limit: 50 }, { has: () => true });
    await service.list({ dayTo: '2026-11-07', limit: 50 }, { has: () => true });
    await service.list({ action: 'sku.archived', limit: 50 }, { has: () => true });

    const pages = statements.filter((text) => text.includes('ORDER BY'));
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain(FROM);
    expect(pages[0]).not.toContain('audit_entries.recorded_at <');
    expect(pages[1]).toContain(TO);
    expect(pages[1]).not.toContain('audit_entries.recorded_at >=');
    expect(pages[2]).not.toContain('audit_entries.recorded_at >=');
    expect(pages[2]).not.toContain('audit_entries.recorded_at <');
  });

  it('bounds the export bound, its size, and its batches the same way', async () => {
    const { service, statements } = reader();
    const query = { dayFrom: '2026-11-01', dayTo: '2026-11-07' };
    const key = { at: '2026-11-07T10:00:00.000001Z', id: ID };
    const viewer = { has: () => true };
    await service.exportBound(query, viewer);
    await service.exportSize(query, viewer, key, 200_001);
    for await (const batch of service.exportBatches(
      query,
      viewer,
      'Africa/Cairo',
      key,
      1_000,
      10,
    )) {
      expect(batch).toEqual([]);
    }

    expect(statements).toHaveLength(3);
    for (const text of statements) {
      expect(text).toContain(FROM);
      expect(text).toContain(TO);
    }
  });
});
