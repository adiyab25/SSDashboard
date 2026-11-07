import {
  AUDIT_ACTIONS,
  type AuditActionDefinition,
  type AuditEntryView,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../database/sql.js';
import { auditHttpError } from './audit-http.js';
import type { AuditQueryService } from './audit-query.service.js';
import { AuditUndoBodyPipe } from './audit-undo.controller.js';
import {
  AuditUndoRegistry,
  isUndoableEntry,
  type AuditUndoHandler,
} from './audit-undo.registry.js';
import { AuditUndoService, undoLockKey } from './audit-undo.service.js';
import type { AuditService } from './audit.service.js';
import {
  AlreadyUndone,
  AuditUndoHandlerDuplicate,
  AuditUndoHandlerMissing,
  AuditUndoRecordMismatch,
  NotUndoable,
  UndoNotPossible,
} from './audit.errors.js';

const ID = '01937f3a-0000-7000-8000-000000000001';
const RECORD = '01937f3a-0000-7000-8000-000000000002';

// A scratch undoable code, planted in the live registry for one test at a time (AC-19).
const UNDOABLE = 'sku.scratch_merged';
const HANDLER = 'inventory.scratch_unmerge';
const registry = AUDIT_ACTIONS as Record<string, AuditActionDefinition>;
const plant = () => {
  registry[UNDOABLE] = {
    ...AUDIT_ACTIONS['sku.archived'],
    undoable: true,
    undoHandler: HANDLER,
  };
};

afterEach(() => {
  delete registry[UNDOABLE];
});

const handler = (undo: AuditUndoHandler['undo']): AuditUndoHandler => ({ undo });

// Spec 0010 Key invariants: every undoable code has a registered handler, or the app stops.
describe('AuditUndoRegistry', () => {
  it('starts with today’s registry, where nothing is undoable', () => {
    expect(() => new AuditUndoRegistry().onApplicationBootstrap()).not.toThrow();
  });

  it('names a planted undoable code’s handler when no module registered it, and passes once one does', () => {
    plant();
    const undos = new AuditUndoRegistry();

    expect(undos.missingHandlers()).toEqual([HANDLER]);
    expect(() => undos.onApplicationBootstrap()).toThrow(AuditUndoHandlerMissing);

    undos.register(
      HANDLER,
      handler(() => Promise.resolve({ record: { type: 'sku', id: RECORD } })),
    );
    expect(undos.missingHandlers()).toEqual([]);
    expect(() => undos.onApplicationBootstrap()).not.toThrow();
  });

  it('refuses a handler code registered twice', () => {
    const undos = new AuditUndoRegistry();
    const noop = handler(() => Promise.resolve({ record: { type: 'sku', id: RECORD } }));
    undos.register(HANDLER, noop);

    expect(() => undos.register(HANDLER, noop)).toThrow(AuditUndoHandlerDuplicate);
  });

  it('marks an entry undoable only for an undoable code naming its own handler', () => {
    expect(isUndoableEntry(UNDOABLE, HANDLER)).toBe(false);
    plant();
    expect(isUndoableEntry(UNDOABLE, HANDLER)).toBe(true);
    expect(isUndoableEntry(UNDOABLE, 'inventory.other')).toBe(false);
    expect(isUndoableEntry(UNDOABLE, null)).toBe(false);
    expect(isUndoableEntry(`${UNDOABLE}_undone`, HANDLER)).toBe(false);
    expect(isUndoableEntry('sku.archived', HANDLER)).toBe(false);
  });
});

// Spec 0010 API surface: the undo body's answers.
describe('AuditUndoBodyPipe', () => {
  const pipe = new AuditUndoBodyPipe();
  const answer = (body: unknown): unknown => {
    try {
      pipe.transform(body);
      return undefined;
    } catch (error) {
      return (error as { getStatus(): number; getResponse(): { code: string } }).getResponse().code;
    }
  };

  it('trims a good reason', () => {
    expect(pipe.transform({ reason: '  wrong match ' })).toEqual({ reason: 'wrong match' });
  });

  it.each([
    [undefined, 'REASON_REQUIRED'],
    [{}, 'REASON_REQUIRED'],
    [{ reason: '' }, 'REASON_REQUIRED'],
    [{ reason: '   ' }, 'REASON_REQUIRED'],
    [{ reason: null }, 'REASON_REQUIRED'],
    [{ reason: 'x'.repeat(501) }, 'REASON_TOO_LONG'],
    [{ reason: 42 }, 'INVALID_INPUT'],
    [{ reason: 'ok', extra: 1 }, 'INVALID_INPUT'],
    [[], 'INVALID_INPUT'],
  ])('answers %j with %s', (body, code) => {
    expect(answer(body)).toBe(code);
  });
});

describe('the undo errors at the api edge', () => {
  it('maps the refusals to 409 with stable codes, and keeps the owner code to its shape', () => {
    const answer = (error: unknown) => {
      const mapped = auditHttpError(error);
      return mapped && { status: mapped.getStatus(), body: mapped.getResponse() };
    };

    expect(answer(new NotUndoable())).toMatchObject({
      status: 409,
      body: { code: 'NOT_UNDOABLE' },
    });
    expect(answer(new AlreadyUndone())).toMatchObject({
      status: 409,
      body: { code: 'ALREADY_UNDONE' },
    });
    expect(answer(new UndoNotPossible('MERGE_NOT_LATEST'))).toMatchObject({
      status: 409,
      body: { code: 'UNDO_NOT_POSSIBLE', undoCode: 'MERGE_NOT_LATEST' },
    });
    expect(new UndoNotPossible('call 01012345678').undoCode).toBe('UNDO_NOT_POSSIBLE');
    expect(answer(new AuditUndoRecordMismatch(HANDLER))).toBeUndefined();
    expect(answer(new AuditUndoHandlerMissing([HANDLER]))).toBeUndefined();
  });
});

// Spec 0010 AC-14: the service's own refusals, on a fake transaction.
describe('AuditUndoService', () => {
  const target = (overrides: Record<string, unknown> = {}) => ({
    id: ID,
    action: UNDOABLE,
    correlation_id: ID,
    record_type: 'sku',
    record_id: RECORD,
    record_label: null,
    before: { merged: false },
    after: { merged: true },
    undo_action: HANDLER,
    undo_args: { into: RECORD },
    ...overrides,
  });

  /** The service over a transaction that answers `results` in order. */
  function serviceWith(results: { rows: unknown[] }[], undos: AuditUndoRegistry) {
    const execute = vi.fn(() => Promise.resolve(results.shift() ?? { rows: [] }));
    const tx = { execute } as unknown as Transaction;
    const connection = {
      db: { transaction: (work: (t: Transaction) => Promise<unknown>) => work(tx) },
    } as unknown as DatabaseConnection;
    const recordUndone = vi.fn(() => Promise.resolve('undone-id'));
    const audit = { newCorrelationId: () => 'corr', recordUndone } as unknown as AuditService;
    const view = vi.fn(() => Promise.resolve({ id: 'undone-id' } as AuditEntryView));
    const reader = { view } as unknown as AuditQueryService;
    return { service: new AuditUndoService(connection, audit, reader, undos), recordUndone, tx };
  }
  const viewer = { userId: ID, has: () => true, actingHat: () => 'manager' };

  it('refuses an entry the registry does not mark undoable, before any handler runs', async () => {
    const undo = vi.fn();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, handler(undo));
    const { service } = serviceWith([{ rows: [] }, { rows: [target()] }], undos);

    await expect(service.undo(ID, viewer, 'wrong')).rejects.toBeInstanceOf(NotUndoable);
    expect(undo).not.toHaveBeenCalled();
  });

  it('refuses an entry already undone, before any handler runs', async () => {
    plant();
    const undo = vi.fn();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, handler(undo));
    const { service } = serviceWith(
      [{ rows: [] }, { rows: [target()] }, { rows: [{ id: 'x' }] }],
      undos,
    );

    await expect(service.undo(ID, viewer, 'wrong')).rejects.toBeInstanceOf(AlreadyUndone);
    expect(undo).not.toHaveBeenCalled();
  });

  it('refuses a handler that answers another record, and writes nothing', async () => {
    plant();
    const undos = new AuditUndoRegistry();
    undos.register(
      HANDLER,
      handler(() => Promise.resolve({ record: { type: 'sku', id: ID } })),
    );
    const { service, recordUndone } = serviceWith(
      [{ rows: [] }, { rows: [target()] }, { rows: [] }],
      undos,
    );

    await expect(service.undo(ID, viewer, 'wrong')).rejects.toBeInstanceOf(AuditUndoRecordMismatch);
    expect(recordUndone).not.toHaveBeenCalled();
  });

  it('writes the undone code on the same record with the reason, the handler told the entry and the actor', async () => {
    plant();
    const undo = vi.fn<AuditUndoHandler['undo']>(() =>
      Promise.resolve({ record: { type: 'sku', id: RECORD }, before: { merged: true } }),
    );
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, handler(undo));
    const { service, recordUndone, tx } = serviceWith(
      [{ rows: [] }, { rows: [target()] }, { rows: [] }],
      undos,
    );

    await expect(service.undo(ID, viewer, 'wrong match')).resolves.toEqual({ id: 'undone-id' });
    expect(undo).toHaveBeenCalledWith(tx, {
      entry: expect.objectContaining({
        id: ID,
        action: UNDOABLE,
        undo: { action: HANDLER, args: { into: RECORD } },
      }) as unknown,
      actor: { kind: 'person', userId: ID, hat: 'manager' },
      reason: 'wrong match',
    });
    expect(recordUndone).toHaveBeenCalledWith(tx, ID, {
      actor: { kind: 'person', userId: ID, hat: 'manager' },
      action: `${UNDOABLE}_undone`,
      record: { type: 'sku', id: RECORD },
      before: { merged: true },
      reason: 'wrong match',
      correlationId: 'corr',
    });
  });

  it('keys the lock on the entry id, the same for every caller', () => {
    expect(undoLockKey(ID)).toBe(undoLockKey(ID));
    expect(undoLockKey(ID)).not.toBe(undoLockKey(RECORD));
  });
});
