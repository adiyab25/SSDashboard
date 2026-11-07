import type * as Contracts from '@ssdashboard/contracts';
import type { AuditActionCode } from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../database/sql.js';
import {
  AuditPersonalDataRefused,
  AuditReasonRequired,
  AuditReasonTooLong,
  AuditRecordTypeMismatch,
  UnknownAuditAction,
} from './audit.errors.js';
import { AuditService, type AuditEntryInput } from './audit.service.js';

// A scratch code with an optional reason, as features 8 and 9 add (`hat.revoked`,
// `setting.changed`); the real registry has only required codes so far.
const OPTIONAL_CODE = 'scratch_record.changed';
vi.mock('@ssdashboard/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof Contracts>();
  return {
    ...actual,
    auditActionOf: (code: string) =>
      code === OPTIONAL_CODE
        ? {
            ...actual.AUDIT_ACTIONS['stock_receipt.voided'],
            recordType: 'scratch_record',
            reason: 'optional',
          }
        : actual.auditActionOf(code),
  };
});

const USER = '01937f3a-0000-7000-8000-000000000001';
const RECEIPT = '01937f3a-0000-7000-8000-000000000002';

/** The bound values of a Drizzle SQL object, in order, nested SQL (a joined VALUES list) included. */
function boundValues(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.flatMap((chunk): unknown[] => {
    if (typeof chunk === 'object' && chunk !== null) {
      // Literal SQL is a chunk with a `value` array; a nested sql`...` has its own chunks.
      if (Array.isArray((chunk as { value?: unknown }).value)) return [];
      if (Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
        return boundValues(chunk);
      }
    }
    return [chunk];
  });
}

/** A transaction double that keeps each statement's bound values, in order. */
function fakeTx() {
  const statements: unknown[][] = [];
  const execute = vi.fn((query: unknown) => {
    statements.push(boundValues(query));
    return Promise.resolve({ rows: [] });
  });
  return { tx: { execute } as unknown as Transaction, execute, statements };
}

/** Bound values per entry row. */
const COLUMNS = 16;

const PARAM = {
  correlationId: 0,
  kind: 1,
  userId: 2,
  ref: 3,
  jobId: 4,
  hat: 5,
  action: 6,
  recordType: 7,
  recordId: 8,
  label: 9,
  before: 10,
  after: 11,
  personalFields: 12,
  reason: 13,
  undoAction: 14,
  undoArgs: 15,
} as const;

function voidEntry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    actor: { kind: 'person', userId: USER, hat: 'admin' },
    action: 'stock_receipt.voided',
    record: { type: 'stock_receipt', id: RECEIPT, label: 'SR-2026-000001' },
    before: { status: 'posted' },
    after: { status: 'voided' },
    reason: '  Entered twice  ',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('AuditService.record (spec 0010)', () => {
  const audit = new AuditService();

  it('inserts one entry through the caller transaction, with the reason trimmed', async () => {
    const { tx, execute, statements } = fakeTx();

    await audit.record(tx, voidEntry());

    expect(execute).toHaveBeenCalledTimes(1);
    const params = statements[0] ?? [];
    expect(params[PARAM.kind]).toBe('person');
    expect(params[PARAM.userId]).toBe(USER);
    expect(params[PARAM.hat]).toBe('admin');
    expect(params[PARAM.ref]).toBeNull();
    expect(params[PARAM.action]).toBe('stock_receipt.voided');
    expect(params[PARAM.label]).toBe('SR-2026-000001');
    expect(params[PARAM.before]).toBe('{"status":"posted"}');
    expect(params[PARAM.after]).toBe('{"status":"voided"}');
    expect(params[PARAM.personalFields]).toBe('{}');
    expect(params[PARAM.reason]).toBe('Entered twice');
    expect(params[PARAM.undoArgs]).toBeNull();
  });

  it('refuses an unknown action before writing anything (AC-10)', async () => {
    const { tx, execute } = fakeTx();

    await expect(
      audit.record(tx, voidEntry({ action: 'stock_receipt.deleted' as AuditActionCode })),
    ).rejects.toBeInstanceOf(UnknownAuditAction);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'refuses a missing reason on a required action (%j) before writing (AC-5)',
    async (reason) => {
      const { tx, execute } = fakeTx();

      await expect(audit.record(tx, voidEntry({ reason }))).rejects.toBeInstanceOf(
        AuditReasonRequired,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('refuses a reason over 500 characters and accepts exactly 500', async () => {
    const { tx, execute } = fakeTx();

    await expect(audit.record(tx, voidEntry({ reason: 'x'.repeat(501) }))).rejects.toBeInstanceOf(
      AuditReasonTooLong,
    );
    await audit.record(tx, voidEntry({ reason: 'ب'.repeat(500) }));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('masks a phone typed in the reason (AC-5)', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, voidEntry({ reason: 'call 01012345678' }));

    expect(statements[0]?.[PARAM.reason]).toBe('call [phone]');
  });

  it('masks personal values in before and after and lists their paths (AC-4)', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(
      tx,
      voidEntry({
        before: { address: 'SENTINEL-OLD-ADDRESS', phone: '01011111111', status: 'new' },
        after: {
          address: 'SENTINEL-NEW-ADDRESS',
          phone: '01022222222',
          customer: { name: 'SENTINEL NAME' },
          status: 'edited',
        },
      }),
    );

    const params = statements[0] ?? [];
    const stored = JSON.stringify(params);
    expect(stored).not.toMatch(/SENTINEL|01011111111|01022222222/);
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({
      address: '[REDACTED]',
      phone: '[REDACTED]',
      customer: { name: '[REDACTED]' },
      status: 'edited',
    });
    expect(params[PARAM.personalFields]).toBe('{"address","customer.name","phone"}');
  });

  it('refuses personal data in the record label and the undo arguments', async () => {
    const { tx, execute } = fakeTx();

    await expect(
      audit.record(
        tx,
        voidEntry({ record: { type: 'stock_receipt', id: RECEIPT, label: '01012345678' } }),
      ),
    ).rejects.toBeInstanceOf(AuditPersonalDataRefused);
    await expect(
      audit.record(tx, voidEntry({ undo: { action: 'x.undo', args: { phone: '0101' } } })),
    ).rejects.toBeInstanceOf(AuditPersonalDataRefused);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'partner_user', userId: USER, partnerAccountId: 'acct' }, [USER, 'acct', null, null]],
    [{ kind: 'system_job', name: 'reconcile', jobId: USER }, [null, 'reconcile', USER, null]],
    [{ kind: 'carrier', connectionCode: 'bosta' }, [null, 'bosta', null, null]],
    [{ kind: 'import', runId: 'run-1' }, [null, 'run-1', null, null]],
    [{ kind: 'portal_customer', customerId: 'c-1' }, [null, 'c-1', null, null]],
  ] as const)('maps the %o actor to its columns', async (actor, columns) => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, voidEntry({ actor }));

    const params = statements[0] ?? [];
    expect([
      params[PARAM.userId],
      params[PARAM.ref],
      params[PARAM.jobId],
      params[PARAM.hat],
    ]).toEqual(columns);
    expect(params[PARAM.kind]).toBe(actor.kind);
  });

  // Security review AS8: one code names one kind of record.
  it('refuses a record type the registry does not give the action', async () => {
    const { tx, execute } = fakeTx();

    await expect(
      audit.record(tx, voidEntry({ record: { type: 'order', id: RECEIPT } })),
    ).rejects.toBeInstanceOf(AuditRecordTypeMismatch);
    expect(execute).not.toHaveBeenCalled();
  });

  // Review AR1: a call may tighten the registry's reason policy, never loosen it.
  it('requires a reason when the call tightens an optional action', async () => {
    const { tx, execute } = fakeTx();
    const optional: AuditEntryInput = {
      ...voidEntry(),
      action: OPTIONAL_CODE as AuditActionCode,
      record: { type: 'scratch_record', id: RECEIPT },
      reason: '  ',
    };

    await audit.record(tx, optional);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(audit.record(tx, { ...optional, reasonRequired: true })).rejects.toBeInstanceOf(
      AuditReasonRequired,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // Review AR2: one multi row insert for one business action, all checked before any write.
  it('writes several entries in one insert, and none when one entry is bad', async () => {
    const { tx, execute, statements } = fakeTx();
    const other = '01937f3a-0000-7000-8000-000000000003';

    await audit.recordMany(tx, [
      voidEntry(),
      voidEntry({ record: { type: 'stock_receipt', id: other, label: 'SR-2026-000002' } }),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const params = statements[0] ?? [];
    expect(params).toHaveLength(2 * COLUMNS);
    expect(params[PARAM.recordId]).toBe(RECEIPT);
    expect(params[COLUMNS + PARAM.recordId]).toBe(other);
    expect(params[COLUMNS + PARAM.correlationId]).toBe(params[PARAM.correlationId]);

    await expect(
      audit.recordMany(tx, [voidEntry(), voidEntry({ reason: '' })]),
    ).rejects.toBeInstanceOf(AuditReasonRequired);
    await audit.recordMany(tx, []);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // Review AR5: a diff holds JSON values only. A bigint (Money, UnitCost) is a type error; pass
  // its decimal string. Were the type bypassed, JSON.stringify would throw before any write.
  it('takes JSON values only in a diff', async () => {
    const { tx, execute } = fakeTx();

    await expect(
      // @ts-expect-error a bigint is not a JSON value
      audit.record(tx, voidEntry({ after: { amount: 10n } })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(execute).not.toHaveBeenCalled();
    await audit.record(tx, voidEntry({ after: { amount: '10.00' } }));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('issues a new correlation id each time', () => {
    const first = audit.newCorrelationId();

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit.newCorrelationId()).not.toBe(first);
  });
});
