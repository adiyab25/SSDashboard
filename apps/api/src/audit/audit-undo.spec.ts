import {
  AUDIT_ACTIONS,
  type AuditActionDefinition,
  type AuditEntryView,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../database/sql.js';
import { auditHttpError } from './audit-http.js';
import type { AuditQueryService, EntryRow } from './audit-query.service.js';
import { AuditUndoStartCheck } from './audit-undo-start-check.js';
import { AuditUndoBodyPipe } from './audit-undo.controller.js';
import {
  AuditUndoRegistry,
  isUndoableEntry,
  type AuditUndoHandler,
} from './audit-undo.registry.js';
import { AuditUndoService, isUndoneTwice, undoLockKey } from './audit-undo.service.js';
import type { AuditUndoneWriter } from './audit-undone.writer.js';
import type { AuditService } from './audit.service.js';
import {
  AlreadyUndone,
  AuditEntryNotFound,
  AuditReadForbidden,
  AuditReasonInvalid,
  AuditUndoHandlerDuplicate,
  AuditUndoHandlerForeign,
  AuditUndoHandlerMissing,
  AuditUndoRecordMismatch,
  NotUndoable,
  UndoNotPossible,
} from './audit.errors.js';

const ID = '01937f3a-0000-7000-8000-00000000000a';
const RECORD = '01937f3a-0000-7000-8000-00000000000b';

// A scratch undoable code, planted in the live registry for one test at a time (AC-19). It is
// inventory's, like the `sku.archived` row it copies.
const UNDOABLE = 'sku.scratch_merged';
const HANDLER = 'inventory.scratch_unmerge';
const DECLARED = 'SCRATCH_LATER_CHANGE';
// A scratch undoable code on a record type that keeps reason codes (security review AS13).
const CODED = 'customer.scratch_merged';
const registry = AUDIT_ACTIONS as Record<string, AuditActionDefinition>;
const plant = () => {
  registry[UNDOABLE] = {
    ...AUDIT_ACTIONS['sku.archived'],
    undoable: true,
    undoHandler: HANDLER,
    undoRefusalCodes: [DECLARED],
  };
};
const plantCoded = () => {
  registry[CODED] = {
    ...AUDIT_ACTIONS['sku.archived'],
    recordType: 'customer',
    reason: 'optional',
    reasonCodes: ['duplicate_contact'],
    undoable: true,
    undoHandler: HANDLER,
    undoReasonCodes: ['wrong_match'],
    undoRefusalCodes: [DECLARED],
  };
};

afterEach(() => {
  delete registry[UNDOABLE];
  delete registry[CODED];
});

const handler = (undo: AuditUndoHandler['undo']): AuditUndoHandler => ({ undo });
const noop = handler(() => Promise.resolve({ record: { type: 'sku', id: RECORD } }));

// Spec 0010 Key invariants: every undoable code has a registered handler, or the api stops.
describe('AuditUndoRegistry and the start check', () => {
  // Review M4R13: holds for any registry, so the first real undoable code keeps it green as long
  // as its owner registers.
  it('passes the start check once every handler the live registry names is registered by its owner', () => {
    const undos = new AuditUndoRegistry();
    for (const action of Object.values(registry)) {
      if (action.undoable && action.undoHandler && !undos.handlerOf(action.undoHandler)) {
        undos.register(action.undoHandler, noop, action.module);
      }
    }

    expect(undos.missingHandlers()).toEqual([]);
    expect(() => new AuditUndoStartCheck(undos).onApplicationBootstrap()).not.toThrow();
  });

  it('stops the start for a planted undoable code’s missing handler, and passes once its owner registers', () => {
    plant();
    const undos = new AuditUndoRegistry();
    const check = new AuditUndoStartCheck(undos);

    // The live registry's own undoable codes (spec 0014's `customers.merge_undo`) are registered
    // by their owners, so only the planted handler is missing.
    for (const action of Object.values(registry)) {
      if (action.undoable && action.undoHandler && action.undoHandler !== HANDLER) {
        if (!undos.handlerOf(action.undoHandler)) {
          undos.register(action.undoHandler, noop, action.module);
        }
      }
    }
    expect(undos.missingHandlers()).toEqual([HANDLER]);
    expect(() => check.onApplicationBootstrap()).toThrow(AuditUndoHandlerMissing);

    undos.register(HANDLER, noop, 'inventory');
    expect(undos.missingHandlers()).toEqual([]);
    expect(() => check.onApplicationBootstrap()).not.toThrow();
  });

  // Review M4R1: the registry is in every process that records entries (the worker too), so it
  // must never stop one; only the api's start check does.
  it('keeps the registry itself free of any start hook', () => {
    plant();
    const undos = new AuditUndoRegistry();

    expect('onApplicationBootstrap' in undos).toBe(false);
    expect('onModuleInit' in undos).toBe(false);
  });

  it('refuses a handler code registered twice', () => {
    plant();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, noop, 'inventory');

    expect(() => undos.register(HANDLER, noop, 'inventory')).toThrow(AuditUndoHandlerDuplicate);
  });

  // Security review AS33: a module answers only for the handler codes of its own actions.
  it('refuses a handler code from a module that does not own the action, or one no action names', () => {
    plant();
    const undos = new AuditUndoRegistry();

    expect(() => undos.register(HANDLER, noop, 'customers')).toThrow(AuditUndoHandlerForeign);
    expect(() => undos.register('inventory.no_such_undo', noop, 'inventory')).toThrow(
      AuditUndoHandlerForeign,
    );
    expect(undos.handlerOf(HANDLER)).toBeUndefined();
    // Nor when two actions name one code and one of them is another module's.
    plantCoded();
    registry[CODED] = { ...(registry[CODED] as AuditActionDefinition), module: 'customers' };
    expect(() => undos.register(HANDLER, noop, 'inventory')).toThrow(AuditUndoHandlerForeign);
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
  const answer = (error: unknown) => {
    const mapped = auditHttpError(error);
    return mapped && { status: mapped.getStatus(), body: mapped.getResponse() };
  };

  it('maps the refusals to 409 with stable codes', () => {
    expect(answer(new NotUndoable())).toMatchObject({
      status: 409,
      body: { code: 'NOT_UNDOABLE' },
    });
    expect(answer(new AlreadyUndone())).toMatchObject({
      status: 409,
      body: { code: 'ALREADY_UNDONE' },
    });
    expect(answer(new AuditUndoRecordMismatch(HANDLER))).toBeUndefined();
    expect(answer(new AuditUndoHandlerMissing([HANDLER]))).toBeUndefined();
    expect(answer(new AuditUndoHandlerForeign(HANDLER, 'customers'))).toBeUndefined();
  });

  // Security review AS31: a fixed message, and an owner code only of the code shape.
  it('answers UNDO_NOT_POSSIBLE with a fixed message, and undoCode only when there is one', () => {
    expect(answer(new UndoNotPossible('MERGE_NOT_LATEST'))).toEqual({
      status: 409,
      body: {
        code: 'UNDO_NOT_POSSIBLE',
        undoCode: 'MERGE_NOT_LATEST',
        message: 'This change can no longer be undone',
      },
    });
    expect(answer(new UndoNotPossible())).toEqual({
      status: 409,
      body: { code: 'UNDO_NOT_POSSIBLE', message: 'This change can no longer be undone' },
    });
    expect(new UndoNotPossible('call 01012345678').undoCode).toBeUndefined();
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

  /** The row the writer answers: the undone entry as written, with a cost field in `after`. */
  const written: EntryRow = {
    id: 'undone-id',
    recorded_at: '2026-11-07T10:00:00.000001Z',
    operating_day: '2026-11-07',
    correlation_id: 'corr',
    actor_kind: 'person',
    actor_user_id: ID,
    actor_ref: null,
    actor_hat: 'manager',
    job_id: null,
    action: `${UNDOABLE}_undone`,
    record_type: 'sku',
    record_id: RECORD,
    record_label: null,
    before: { merged: true },
    after: { merged: false, unitCost: '5.00' },
    personal_fields: [],
    reason: 'wrong match',
    undo_action: null,
  };

  /** The service over a transaction that answers `results` in order. */
  /** A statement as text: literal SQL kept, a bound string as `'value'`, any other value as `?`. */
  function statementText(query: unknown): string {
    const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
    return chunks
      .map((chunk): string => {
        if (typeof chunk === 'object' && chunk !== null) {
          const value = (chunk as { value?: unknown }).value;
          if (Array.isArray(value)) return value.join('');
          if (Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
            return statementText(chunk);
          }
        }
        return typeof chunk === 'string' ? `'${chunk}'` : '?';
      })
      .join('');
  }

  function serviceWith(results: { rows: unknown[] }[], undos: AuditUndoRegistry) {
    const statements: unknown[] = [];
    const execute = vi.fn((query: unknown) => {
      statements.push(query);
      return Promise.resolve(results.shift() ?? { rows: [] });
    });
    const tx = { execute };
    const connection = {
      db: {
        transaction: (work: (t: Transaction) => Promise<unknown>) =>
          work(tx as unknown as Transaction),
      },
    } as unknown as DatabaseConnection;
    const write = vi.fn<AuditUndoneWriter['write']>(() => Promise.resolve(written));
    const writer = { write } as unknown as AuditUndoneWriter;
    const audit = { newCorrelationId: () => 'corr' } as unknown as AuditService;
    const view = vi.fn<AuditQueryService['view']>(() =>
      Promise.resolve({ id: 'undone-id' } as AuditEntryView),
    );
    const reader = { view } as unknown as AuditQueryService;
    return {
      service: new AuditUndoService(connection, audit, writer, reader, undos),
      write,
      view,
      tx,
    };
  }
  const viewer = { userId: ID, has: () => true, actingHat: () => 'manager' };
  /** The answers of the lock, the target read, and the "already undone" read. */
  const reads = (row = target()) => [{ rows: [] }, { rows: [row] }, { rows: [] }];

  it('refuses an entry the registry does not mark undoable, before any handler runs', async () => {
    plant();
    const undo = vi.fn();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, handler(undo), 'inventory');
    delete registry[UNDOABLE];
    const { service } = serviceWith(reads(), undos);

    await expect(service.undo(ID, viewer, 'wrong')).rejects.toBeInstanceOf(NotUndoable);
    expect(undo).not.toHaveBeenCalled();
  });

  // Spec 0012 AC-17, the owner's ruling of 2026-11-11 "Hide whole entry": a cost entry is
  // missing to an undoer without cost.view, never "not undoable", so its existence never leaks.
  it('reads the target under the visibility condition, so a cost entry is missing without cost.view, and not undoable with it', async () => {
    const undos = new AuditUndoRegistry();
    const cost = target({
      action: 'cost_record.recorded',
      record_type: 'style',
      undo_action: null,
    });
    const noCost = { ...viewer, has: (permission: string) => permission !== 'cost.view' };

    // The database applies the condition; the fake answers no row to a statement that carries it.
    const hidden = serviceWith([{ rows: [] }, { rows: [] }], undos);
    await expect(hidden.service.undo(ID, noCost, 'wrong')).rejects.toBeInstanceOf(
      AuditEntryNotFound,
    );
    const targetRead = statementText(hidden.tx.execute.mock.calls[1]?.[0]);
    expect(targetRead).toContain(
      `NOT (audit_entries.action = ANY('{"cost_record.recorded"}'::text[]))`,
    );
    const holderRead = serviceWith(reads(cost), undos);
    await expect(holderRead.service.undo(ID, viewer, 'wrong')).rejects.toBeInstanceOf(NotUndoable);
    expect(statementText(holderRead.tx.execute.mock.calls[1]?.[0])).not.toContain('NOT (');
    await expect(
      serviceWith(reads(cost), undos).service.undo(ID, viewer, 'wrong'),
    ).rejects.toBeInstanceOf(NotUndoable);
  });

  it('refuses an entry already undone, before any handler runs', async () => {
    plant();
    const undo = vi.fn();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, handler(undo), 'inventory');
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
      'inventory',
    );
    const { service, write } = serviceWith(reads(), undos);

    await expect(service.undo(ID, viewer, 'wrong')).rejects.toBeInstanceOf(AuditUndoRecordMismatch);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes the undone code on the same record with the masked reason, the handler told the entry and the actor', async () => {
    plant();
    const undo = vi.fn<AuditUndoHandler['undo']>(() =>
      Promise.resolve({ record: { type: 'sku', id: RECORD }, before: { merged: true } }),
    );
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, handler(undo), 'inventory');
    const { service, write, tx } = serviceWith(reads(), undos);

    await expect(service.undo(ID, viewer, ' wrong, call 01012345678 ')).resolves.toEqual({
      id: 'undone-id',
    });
    // Review M4R2, security review AS32: the handler only ever sees the checked, masked reason.
    expect(undo).toHaveBeenCalledWith(tx, {
      entry: expect.objectContaining({
        id: ID,
        action: UNDOABLE,
        undo: { action: HANDLER, args: { into: RECORD } },
      }) as unknown,
      actor: { kind: 'person', userId: ID, hat: 'manager' },
      reason: 'wrong, call [phone]',
    });
    expect(write).toHaveBeenCalledWith(tx, ID, {
      actor: { kind: 'person', userId: ID, hat: 'manager' },
      action: `${UNDOABLE}_undone`,
      record: { type: 'sku', id: RECORD },
      before: { merged: true },
      reason: 'wrong, call [phone]',
      correlationId: 'corr',
    });
  });

  // Review M4R2, security review AS32: the reason policy runs before any owner code.
  it('refuses a typed note on a record type that keeps reason codes before the handler runs', async () => {
    plantCoded();
    const undo = vi.fn();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, handler(undo), 'inventory');
    const coded = target({ action: CODED, record_type: 'customer' });

    for (const reason of ['customer Ahmed asked', 'duplicate_contact', 'wrong_match_x']) {
      const { service, write } = serviceWith(reads(coded), undos);
      await expect(service.undo(ID, viewer, reason)).rejects.toBeInstanceOf(AuditReasonInvalid);
      expect(write).not.toHaveBeenCalled();
    }
    expect(undo).not.toHaveBeenCalled();

    // A listed undo reason code goes through, as it is.
    undo.mockResolvedValueOnce({ record: { type: 'customer', id: RECORD } });
    const { service } = serviceWith(reads(coded), undos);
    await service.undo(ID, viewer, 'wrong_match');
    expect(undo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'wrong_match' }),
    );
  });

  // Review M4R3: one entry, one lock, whatever the letter case of its id.
  it('lower cases the entry id before the lock, the reads, and the write', async () => {
    plant();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, noop, 'inventory');
    const { service, write } = serviceWith(reads(), undos);
    const upper = ID.toUpperCase();

    expect(undoLockKey(upper)).toBe(undoLockKey(ID));
    expect(undoLockKey(ID)).not.toBe(undoLockKey(RECORD));
    await service.undo(upper, viewer, 'wrong');
    expect(write).toHaveBeenCalledWith(expect.anything(), ID, expect.anything());
  });

  // Review M4R3: the unique index is the backstop; its refusal is a second undo, not a 500.
  it('answers AlreadyUndone when the unique index refuses a second undone entry', async () => {
    plant();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, noop, 'inventory');
    const { service, write } = serviceWith(reads(), undos);
    const unique = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'audit_entries_undoes_entry_unique',
    });
    write.mockRejectedValueOnce(new Error('Failed query', { cause: unique }));

    await expect(service.undo(ID, viewer, 'wrong')).rejects.toBeInstanceOf(AlreadyUndone);
    expect(isUndoneTwice(unique)).toBe(true);
    expect(isUndoneTwice({ code: '23505', constraint: 'another_unique' })).toBe(false);
  });

  // Security review AS31: only a refusal code the action declares reaches the answer.
  it('passes on a declared refusal code and drops any other', async () => {
    plant();
    const answers: unknown[] = [];
    for (const thrown of [
      new UndoNotPossible(DECLARED),
      new UndoNotPossible('AHMED_MOHAMED_ALI'),
      new UndoNotPossible(),
    ]) {
      const undos = new AuditUndoRegistry();
      undos.register(
        HANDLER,
        handler(() => Promise.reject(thrown)),
        'inventory',
      );
      const { service, write } = serviceWith(reads(), undos);
      const error = await service.undo(ID, viewer, 'wrong').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UndoNotPossible);
      expect(write).not.toHaveBeenCalled();
      answers.push(auditHttpError(error)?.getResponse());
    }

    expect(answers).toEqual([
      {
        code: 'UNDO_NOT_POSSIBLE',
        undoCode: DECLARED,
        message: 'This change can no longer be undone',
      },
      { code: 'UNDO_NOT_POSSIBLE', message: 'This change can no longer be undone' },
      { code: 'UNDO_NOT_POSSIBLE', message: 'This change can no longer be undone' },
    ]);
  });

  // Review M4R17: the undo is committed; a failing read after it must not answer an error.
  it('answers from the row it wrote, cost stripped, when the read after commit fails', async () => {
    plant();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, noop, 'inventory');
    const { service, view } = serviceWith(reads(), undos);
    view.mockRejectedValueOnce(new Error('staff directory down'));
    const noCost = { ...viewer, has: (permission: string) => permission !== 'cost.view' };

    const answer = await service.undo(ID, noCost, 'wrong');

    expect(answer).toMatchObject({
      id: 'undone-id',
      action: `${UNDOABLE}_undone`,
      actorName: null,
      before: { merged: true },
      after: { merged: false },
      reason: 'wrong match',
      undone: false,
      canUndo: false,
    });
  });

  // Security review AS37: the fallback covers a failed read, never a refused one.
  it('passes on a read refusal after commit instead of answering from the written row', async () => {
    plant();
    const undos = new AuditUndoRegistry();
    undos.register(HANDLER, noop, 'inventory');
    const { service, view } = serviceWith(reads(), undos);
    view.mockRejectedValueOnce(new AuditReadForbidden());

    await expect(service.undo(ID, viewer, 'wrong')).rejects.toBeInstanceOf(AuditReadForbidden);
  });
});
