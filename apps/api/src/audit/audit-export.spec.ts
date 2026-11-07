import { EventEmitter } from 'node:events';
import { AUDIT_EXPORT_MAX_ROWS } from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import { exportReason, responseSink, type ExportResponse } from './audit-export.controller.js';
import { AuditExportCutOff, AuditExportService, csvCell } from './audit-export.service.js';
import type { AuditKey, AuditQueryService, AuditViewer, EntryRow } from './audit-query.service.js';
import { AuditExportTooLarge } from './audit.errors.js';
import type { AuditService } from './audit.service.js';

const USER_ID = '01937f3a-0000-7000-8000-000000000001';
/** A manager without `cost.view`: the export is recorded under the hat that holds `audit.export`. */
const VIEWER: AuditViewer = {
  userId: USER_ID,
  has: (permission) => permission === 'audit.read' || permission === 'audit.export',
  actingHat: () => 'manager',
};
const QUERY = { dayFrom: '2026-11-01', dayTo: '2026-11-07' };
const BOUND: AuditKey = { at: '2026-11-07T10:00:00.000001Z', id: USER_ID };

/** One batch the reader yields to the stream. */
type ExportBatch = { row: EntryRow; localAt: string; actorName: string | null }[];

/** An export service over a stubbed reader and writer. */
function harness(size: number, batches: number = 3) {
  const closed = { value: false };
  const reader = {
    exportBound: vi.fn(() => Promise.resolve(BOUND)),
    exportSize: vi.fn(() => Promise.resolve(size)),
    exportBatches: vi.fn(async function* (): AsyncGenerator<ExportBatch> {
      try {
        for (let i = 0; i < batches; i += 1) yield await Promise.resolve([]);
      } finally {
        closed.value = true;
      }
    }),
  };
  const audit = { record: vi.fn(() => Promise.resolve()), newCorrelationId: () => USER_ID };
  const connection = {
    db: { transaction: (work: (tx: unknown) => Promise<unknown>) => work({}) },
  } as unknown as DatabaseConnection;
  const service = new AuditExportService(
    connection,
    reader as unknown as AuditQueryService,
    audit as unknown as AuditService,
  );
  return { service, reader, audit, closed };
}

/** A response double whose socket is full: `write` answers false until it drains or closes. */
class FullResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return false;
  }
}

// Spec 0010, review M3R9: the 200,000 row limit is exact.
describe('AuditExportService.prepare', () => {
  it('allows exactly 200,000 rows and records the export with that count', async () => {
    const { service, audit, reader } = harness(AUDIT_EXPORT_MAX_ROWS);

    const plan = await service.prepare(QUERY, VIEWER, 'monthly check');

    expect(plan).toEqual({
      fileName: 'audit-2026-11-01-2026-11-07.csv',
      bound: BOUND,
      rows: 200_000,
      showCost: false,
    });
    expect(reader.exportSize).toHaveBeenCalledWith(QUERY, BOUND, AUDIT_EXPORT_MAX_ROWS + 1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'audit.exported',
        actor: { kind: 'person', userId: USER_ID, hat: 'manager' },
        after: { ...QUERY, rows: 200_000 },
        reason: 'monthly check',
      }),
    );
  });

  it('refuses 200,001 rows with AuditExportTooLarge and records nothing', async () => {
    const { service, audit } = harness(AUDIT_EXPORT_MAX_ROWS + 1);

    await expect(service.prepare(QUERY, VIEWER)).rejects.toBeInstanceOf(AuditExportTooLarge);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('plans a header only file when the filter holds nothing', async () => {
    const { service, reader } = harness(0);
    reader.exportBound.mockResolvedValueOnce(null as unknown as AuditKey);

    expect(await service.prepare(QUERY, VIEWER)).toMatchObject({ bound: null, rows: 0 });
    expect(reader.exportSize).not.toHaveBeenCalled();
  });
});

// Spec 0010, reviews M3R1 and M3R2: the stream is bounded, and stops when its reader goes away.
describe('AuditExportService.stream', () => {
  it('reads only up to the planned key and row count', async () => {
    const { service, reader } = harness(5, 1);
    const plan = { fileName: 'f', bound: BOUND, rows: 5, showCost: false };

    await service.stream(QUERY, plan, 'Africa/Cairo', () => Promise.resolve());

    expect(reader.exportBatches).toHaveBeenCalledWith(QUERY, 'Africa/Cairo', BOUND, 1_000, 5);
  });

  it('stops and closes its batches when the response closes instead of draining', async () => {
    const { service, closed } = harness(3_000, 3);
    const response = new FullResponse();
    const write = responseSink(response as unknown as ExportResponse);

    const streaming = service.stream(
      QUERY,
      { fileName: 'f', bound: BOUND, rows: 3_000, showCost: false },
      'UTC',
      write,
    );
    await vi.waitFor(() => expect(response.chunks).toHaveLength(1));
    response.destroyed = true;
    response.emit('close');

    await expect(streaming).rejects.toBeInstanceOf(AuditExportCutOff);
    expect(response.chunks).toHaveLength(1);
    expect(closed.value).toBe(false); // the header write failed before the batches opened

    const second = harness(3_000, 3);
    const live = new FullResponse();
    const sink = responseSink(live as unknown as ExportResponse);
    const running = second.service.stream(
      QUERY,
      { fileName: 'f', bound: BOUND, rows: 3_000, showCost: false },
      'UTC',
      sink,
    );
    await vi.waitFor(() => expect(live.chunks).toHaveLength(1));
    live.emit('drain');
    await vi.waitFor(() => expect(live.chunks).toHaveLength(2));
    live.destroyed = true;
    live.emit('close');

    await expect(running).rejects.toBeInstanceOf(AuditExportCutOff);
    expect(second.closed.value).toBe(true);
    expect(live.listenerCount('drain')).toBe(0);
    expect(live.listenerCount('close')).toBe(0);
  });

  it('refuses to write to a response already destroyed', async () => {
    const response = new FullResponse();
    response.destroyed = true;

    await expect(responseSink(response as unknown as ExportResponse)('x')).rejects.toBeInstanceOf(
      AuditExportCutOff,
    );
    expect(response.chunks).toEqual([]);
  });
});

// Spec 0010, review M3R3: the reason travels in a header, percent encoded.
describe('exportReason', () => {
  it('decodes, trims, and checks the header, and absent is no reason', () => {
    expect(exportReason(undefined)).toBeUndefined();
    expect(exportReason(encodeURIComponent('  مراجعة شهرية  '))).toBe('مراجعة شهرية');
    for (const bad of ['', '%20%20', '%E0%A4%A', encodeURIComponent('x'.repeat(501))]) {
      expect(() => exportReason(bad), bad).toThrow();
    }
  });
});

// Spec 0010, review M3R10: the rest of the formula starters.
describe('csvCell formula starters', () => {
  it('defuses a leading tab and a leading carriage return', () => {
    expect(csvCell('\tcmd')).toBe(`"'\tcmd"`);
    expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
  });
});

// Spec 0008 AC-6: the file never carries a cost field the screen would hide.
describe('AuditExportService cost fields', () => {
  const costly: EntryRow = {
    id: USER_ID,
    recorded_at: '2026-11-07T10:00:00.000001Z',
    operating_day: '2026-11-07',
    correlation_id: USER_ID,
    actor_kind: 'person',
    actor_user_id: USER_ID,
    actor_ref: null,
    actor_hat: 'manager',
    job_id: null,
    action: 'stock_receipt.voided',
    undo_action: null,
    record_type: 'stock_receipt',
    record_id: USER_ID,
    record_label: 'SR-2026-000001',
    before: { status: 'posted', referenceValue: '100.00', lines: [{ sku: 'A', unitCost: '5.00' }] },
    after: { status: 'voided', avgUnitCost: '4.00' },
    personal_fields: [],
    reason: 'entered twice',
  };

  /** Streams one planned row for a reader with or without `cost.view`; returns the file text. */
  async function fileFor(showCost: boolean): Promise<string> {
    const { service, reader } = harness(1, 1);
    reader.exportBatches.mockImplementationOnce(async function* () {
      yield await Promise.resolve([{ row: costly, localAt: 't', actorName: null }]);
    });
    const chunks: string[] = [];
    await service.stream(QUERY, { fileName: 'f', bound: BOUND, rows: 1, showCost }, 'UTC', (c) => {
      chunks.push(c);
      return Promise.resolve();
    });
    return chunks.join('');
  }

  it('plans showCost from the viewer', async () => {
    const withCost: AuditViewer = { ...VIEWER, has: () => true };
    expect((await harness(1).service.prepare(QUERY, VIEWER)).showCost).toBe(false);
    expect((await harness(1).service.prepare(QUERY, withCost)).showCost).toBe(true);
  });

  it('leaves every cost field out of the before and after cells without cost.view', async () => {
    const text = await fileFor(false);
    expect(text).toContain('posted');
    expect(text).toContain('entered twice');
    for (const key of ['referenceValue', 'unitCost', 'avgUnitCost', '100.00', '5.00', '4.00']) {
      expect(text).not.toContain(key);
    }
    expect(costly.before?.referenceValue).toBe('100.00');
  });

  it('keeps the cost fields for a reader with cost.view', async () => {
    const text = await fileFor(true);
    for (const key of ['referenceValue', 'unitCost', 'avgUnitCost']) expect(text).toContain(key);
  });
});
