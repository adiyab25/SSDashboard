import type * as Contracts from '@ssdashboard/contracts';
import type { AuditActionCode } from '@ssdashboard/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../database/sql.js';
import { AUDIT_ACTIONS, personActor, systemJobActor } from '@ssdashboard/contracts';
import {
  AuditCorrelationMismatch,
  AuditPersonalDataRefused,
  AuditReasonInvalid,
  AuditReasonRequired,
  AuditReasonTooLong,
  AuditRecordTypeMismatch,
  UnknownAuditAction,
} from './audit.errors.js';
import { AuditUndoneWriter } from './audit-undone.writer.js';
import { AuditService, type AuditEntryInput, type JsonObject } from './audit.service.js';

// Scratch codes, as later features add them (AC-19): a customer edit, whose record type masks a
// bare name, email, reason, and external id and takes a reason code (security reviews AS2, AS13,
// AS18), and an order edit, whose label has no code contract of its own. The real registry has no
// customer or order action yet.
const CUSTOMER_CODE = 'customer.scratch_edited';
const ORDER_CODE = 'order.scratch_edited';
const OUTBOUND_CODE = 'outbound_command.scratch_sent';
vi.mock('@ssdashboard/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof Contracts>();
  const optional = { ...actual.AUDIT_ACTIONS['stock_receipt.voided'], reason: 'optional' };
  return {
    ...actual,
    auditActionOf: (code: string) => {
      if (code === CUSTOMER_CODE) {
        return {
          ...optional,
          module: 'customers',
          recordType: 'customer',
          reasonCodes: ['duplicate_contact'],
        };
      }
      if (code === ORDER_CODE) {
        return { ...optional, module: 'orders', recordType: 'order', reasonCodes: ['address_fix'] };
      }
      if (code === OUTBOUND_CODE) {
        return { ...optional, module: 'connectors', recordType: 'outbound_command' };
      }
      return actual.auditActionOf(code);
    },
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
const COLUMNS = 17;

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
  undoesEntryId: 16,
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
      action: 'sku.archived',
      record: { type: 'sku', id: RECEIPT, label: 'TEE-BLK-M' },
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

  it('issues a new correlation id each time, and a system job its own job id (AC-6)', () => {
    const first = audit.newCorrelationId();

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit.newCorrelationId()).not.toBe(first);
    expect(audit.newCorrelationId(personActor(USER, 'admin'))).not.toBe(first);
    expect(audit.newCorrelationId(systemJobActor('reconcile', RECEIPT))).toBe(RECEIPT);
  });

  it('refuses one recordMany call that mixes correlation ids (AC-6)', async () => {
    const { tx, execute } = fakeTx();

    await expect(
      audit.recordMany(tx, [voidEntry(), voidEntry({ correlationId: 'corr-2' })]),
    ).rejects.toBeInstanceOf(AuditCorrelationMismatch);
    expect(execute).not.toHaveBeenCalled();
  });
});

/** A customer edit entry through the scratch customer code. */
function customerEntry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    ...voidEntry(),
    action: CUSTOMER_CODE as AuditActionCode,
    record: { type: 'customer', id: RECEIPT },
    reason: undefined,
    ...overrides,
  };
}

// Milestone 2 task 9, the personal data guard (security review AS2, AS3, AS4, AS9).
describe('AuditService personal data guard (spec 0010, AC-4)', () => {
  const audit = new AuditService();

  // AS2: a changed fields diff has no marker key, so the record type says which bare keys are
  // personal. The sentinels appear in no bound value.
  it('masks a bare name, email, and reason in a customer diff, and lists them', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(
      tx,
      customerEntry({
        before: { name: 'SENTINEL OLD NAME', email: 'sentinel-old@example.eg', tier: 'gold' },
        after: {
          name: 'SENTINEL NEW NAME',
          email: 'sentinel-new@example.eg',
          merge: { reason: 'SENTINEL merged on request' },
          tier: 'silver',
        },
      }),
    );

    const params = statements[0] ?? [];
    expect(JSON.stringify(params)).not.toMatch(/sentinel/i);
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({
      name: '[REDACTED]',
      email: '[REDACTED]',
      merge: { reason: '[REDACTED]' },
      tier: 'silver',
    });
    expect(params[PARAM.personalFields]).toBe('{"email","merge.reason","name"}');
  });

  it('keeps a bare name and reason where the record type does not mark them personal', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, voidEntry({ after: { name: 'Main warehouse', reason: 'void' } }));

    const params = statements[0] ?? [];
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({
      name: 'Main warehouse',
      reason: 'void',
    });
    expect(params[PARAM.personalFields]).toBe('{}');
  });

  /** An entry of `type` labelled `label`, through a code whose registry type it is. */
  function labelled(type: string, label: string): AuditEntryInput {
    const action = {
      stock_receipt: 'stock_receipt.voided',
      sku: 'sku.archived',
      location: 'location.archived',
      order: ORDER_CODE,
      customer: CUSTOMER_CODE,
    }[type] as AuditActionCode;
    // Only the void requires a reason; the others take none here (a customer or order would
    // refuse the void's typed note).
    const reason = type === 'stock_receipt' ? 'Entered twice' : undefined;
    return { ...voidEntry(), action, reason, record: { type, id: RECEIPT, label } };
  }

  // AS3, AS16, AS17: a label fits its record type. Its own code contract is trusted as it is; a
  // label without one is refused when it is a name, a sentence, or phone shaped; a customer has
  // no label at all.
  it.each([
    ['stock_receipt', 'Ahmed Mohamed'],
    ['stock_receipt', 'TEE-BLK-M'],
    ['stock_receipt', ''],
    ['sku', 'tee-blk-m'],
    ['sku', 'x'.repeat(65)],
    ['location', 'TOO-LONG-LOCATION-CODE'],
    ['order', 'Ahmed Mohamed'],
    ['order', '\u0623\u062d\u0645\u062f'],
    ['order', 'x'.repeat(65)],
    ['order', '01012345678'],
    ['customer', 'C-1'],
  ])('refuses the %s label %j', async (type, label) => {
    const { tx, execute } = fakeTx();

    await expect(audit.record(tx, labelled(type, label))).rejects.toBeInstanceOf(
      AuditPersonalDataRefused,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['stock_receipt', 'SR-2026-000001'],
    ['sku', 'TEE-BLK-M'],
    ['sku', '01012345678'],
    ['sku', '0012345678905'],
    ['location', '01012345678'],
    ['order', '#1042'],
    ['order', 'WH_CAI.2'],
  ])('accepts the %s label %j', async (type, label) => {
    const { tx, execute } = fakeTx();

    await audit.record(tx, labelled(type, label));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // AS16: a SKU or location code is the record's own code, never a phone, in the diff too.
  it('keeps a phone shaped SKU code in the diff and the label', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, {
      ...labelled('sku', '01012345679'),
      action: 'sku.code_changed',
      before: { code: '01012345678' },
      after: { code: '01012345679' },
    });

    const params = statements[0] ?? [];
    expect(params[PARAM.label]).toBe('01012345679');
    expect(JSON.parse(String(params[PARAM.before]))).toEqual({ code: '01012345678' });
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({ code: '01012345679' });
    expect(params[PARAM.personalFields]).toBe('{}');
  });

  it('still masks a phone in any other field of a SKU diff, and a code that is not a SKU code', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, {
      ...labelled('sku', 'TEE-BLK-M'),
      after: { code: 'call 01012345678', note: 'x' },
    });

    const params = statements[0] ?? [];
    expect(String(params[PARAM.after])).not.toContain('01012345678');
  });

  // AS3: undo arguments hold ids, codes, and numbers only.
  it.each<[JsonObject, boolean]>([
    [{ customerId: RECEIPT, ids: [RECEIPT], count: 2, rule: 'exact_match' }, true],
    [{ note: 'Ahmed asked for it' }, false],
    [{ flag: true }, false],
    [{ missing: null }, false],
    [{ number: 201012345678 }, false],
  ])('checks the undo arguments %o', async (args, accepted) => {
    const { tx, execute } = fakeTx();
    const run = audit.record(tx, voidEntry({ undo: { action: 'stock_receipt.undo', args } }));

    if (accepted) {
      await run;
      expect(execute).toHaveBeenCalledTimes(1);
    } else {
      await expect(run).rejects.toBeInstanceOf(AuditPersonalDataRefused);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  // AS4: a phone used as a key is refused; a phone length number is masked.
  it.each(['01012345678', '+201012345678', '201012345678'])(
    'refuses the phone shaped key %j anywhere in a diff',
    async (key) => {
      const { tx, execute } = fakeTx();

      await expect(
        audit.record(tx, voidEntry({ after: { calls: { [key]: 2 } } })),
      ).rejects.toBeInstanceOf(AuditPersonalDataRefused);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('masks a 10 to 15 digit number and keeps shorter ones', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(
      tx,
      voidEntry({ after: { contact: 1012345678, wide: 201012345678901, quantity: 999999999 } }),
    );

    const params = statements[0] ?? [];
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({
      contact: '[REDACTED]',
      wide: '[REDACTED]',
      quantity: 999999999,
    });
    expect(params[PARAM.personalFields]).toBe('{"contact","wide"}');
  });

  // AS9, AS14: JSON text is stored as its parsed and walked value written back, never as the
  // input; it is listed only when something inside was masked.
  it('stores JSON looking text that holds nothing personal written back, unlisted', async () => {
    const { tx, statements } = fakeTx();
    const raw = '{ "status" : "posted",  "lines": [1, 2] }';

    await audit.record(tx, voidEntry({ after: { raw } }));

    const params = statements[0] ?? [];
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({
      raw: '{"status":"posted","lines":[1,2]}',
    });
    expect(params[PARAM.personalFields]).toBe('{}');
  });

  it('drops a duplicate key the parser never kept, so its phone is not stored', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, voidEntry({ after: { raw: '{"y":"01012345678","y":"ok"}' } }));

    const params = statements[0] ?? [];
    expect(String(params[PARAM.after])).not.toContain('01012345678');
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({ raw: '{"y":"ok"}' });
  });

  it('masks a phone length number inside JSON looking text, and lists it', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, voidEntry({ after: { raw: '{"p":1012345678}' } }));

    const params = statements[0] ?? [];
    expect(String(params[PARAM.after])).not.toContain('1012345678');
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({ raw: '{"p":"[REDACTED]"}' });
    expect(params[PARAM.personalFields]).toBe('{"raw"}');
  });

  it('still masks a phone inside JSON looking text, and lists it', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, voidEntry({ after: { raw: '{"phone":"01012345678"}' } }));

    const params = statements[0] ?? [];
    expect(String(params[PARAM.after])).not.toContain('01012345678');
    expect(params[PARAM.personalFields]).toBe('{"raw"}');
  });

  // AS13: a customer facing record type takes a reason code, never a typed note.
  it.each([
    'Customer called, Ahmed Mohamed',
    'ahmed@example.com',
    'Wrong',
    // AS23: a code shaped value the action does not list, a name, or a phone, is refused too.
    'ahmed_mohamed',
    'call_01012345678',
    'address_fix',
  ])('refuses the typed note %j on a customer entry', async (reason) => {
    const { tx, execute } = fakeTx();

    await expect(audit.record(tx, customerEntry({ reason }))).rejects.toBeInstanceOf(
      AuditReasonInvalid,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps a reason code on a customer entry', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, customerEntry({ reason: ' duplicate_contact ' }));

    expect(statements[0]?.[PARAM.reason]).toBe('duplicate_contact');
  });

  it('masks emails and phones in a free text reason', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(
      tx,
      voidEntry({ reason: 'Ahmed (sentinel@example.eg, 02 2345 6789) asked' }),
    );

    expect(statements[0]?.[PARAM.reason]).toBe('Ahmed ([email], [phone]) asked');
  });

  // AS17, AS18: undo keys are codes, the record type's keys apply to undo arguments, and an
  // external id is personal on a customer.
  it('refuses an undo argument key that is not a code, and a personal one of the record type', async () => {
    const { tx, execute } = fakeTx();

    await expect(
      audit.record(tx, voidEntry({ undo: { action: 'x.undo', args: { 'first name': 'C-1' } } })),
    ).rejects.toBeInstanceOf(AuditPersonalDataRefused);
    await expect(
      audit.record(tx, customerEntry({ undo: { action: 'x.undo', args: { name: 'Ahmed' } } })),
    ).rejects.toBeInstanceOf(AuditPersonalDataRefused);
    expect(execute).not.toHaveBeenCalled();
  });

  it('masks a customer external id', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(
      tx,
      customerEntry({ after: { externalId: '201012345678', source: 'whatsapp' } }),
    );

    const params = statements[0] ?? [];
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({
      externalId: '[REDACTED]',
      source: 'whatsapp',
    });
  });

  // AS19: the writer checks the actor's shape itself.
  it('refuses a malformed actor before writing', async () => {
    const { tx, execute } = fakeTx();
    const actor = { kind: 'person', userId: 'not-a-uuid', hat: 'admin' } as const;

    await expect(audit.record(tx, voidEntry({ actor }))).rejects.toThrow();
    await expect(
      audit.record(tx, voidEntry({ actor: { kind: 'person', userId: USER, hat: '' } })),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  // AS21: a personal key's JSON text is masked whole; other JSON text is walked at its own path.
  it.each<[string, string, JsonObject, RegExp]>([
    [
      'a note holding JSON',
      'stock_receipt.voided',
      { note: '{"x":"Ahmed lives in Nasr City"}' },
      /Ahmed|Nasr/,
    ],
    [
      'a ship to address array',
      'stock_receipt.voided',
      { shipToAddress: '["12 Tahrir St","Nasr City"]' },
      /Tahrir|Nasr/,
    ],
    ['a customer name array', CUSTOMER_CODE, { name: '["Ahmed Mohamed"]' }, /Ahmed/],
    [
      'an outbound payload',
      OUTBOUND_CODE,
      { payload: '{"consignee":"Ahmed","phone":"x"}' },
      /Ahmed/,
    ],
    [
      'a customer object as text',
      'stock_receipt.voided',
      { customer: '{"name":"Ahmed","email":"a@x.eg"}' },
      /Ahmed|a@x\.eg/,
    ],
  ])('masks %s', async (_case, action, after, leak) => {
    const { tx, statements } = fakeTx();
    const entry: AuditEntryInput =
      action === 'stock_receipt.voided'
        ? voidEntry({ after })
        : action === OUTBOUND_CODE
          ? {
              ...voidEntry({ after }),
              action: action as AuditActionCode,
              reason: undefined,
              record: { type: 'outbound_command', id: RECEIPT },
            }
          : customerEntry({ after });

    await audit.record(tx, entry);

    const params = statements[0] ?? [];
    expect(String(params[PARAM.after])).not.toMatch(leak);
    expect(String(params[PARAM.personalFields])).not.toBe('{}');
  });

  // AS22: an id is an id, never a phone, in a diff and in undo arguments.
  it('keeps uuids in a diff and in undo arguments as they are', async () => {
    const { tx, statements } = fakeTx();
    const ids = ['7b7d0081-4350-41ce-8a02-0223456789ab', '01012345-6789-4abc-8def-020123456789'];

    await audit.record(
      tx,
      voidEntry({ after: { ids }, undo: { action: 'x.undo', args: { ids } } }),
    );

    const params = statements[0] ?? [];
    expect(JSON.parse(String(params[PARAM.after]))).toEqual({ ids });
    expect(params[PARAM.personalFields]).toBe('{}');
  });

  it('accepts a listed reason code on a customer entry', async () => {
    const { tx, statements } = fakeTx();

    await audit.record(tx, customerEntry({ reason: 'duplicate_contact' }));

    expect(statements[0]?.[PARAM.reason]).toBe('duplicate_contact');
  });
});

// Spec 0010 milestone 4 task 16 (security review AS5): the undone code is written only by an undo,
// on its own derived definition (reason required), with `undoes_entry_id`, and returns the row it
// wrote. Reviews M4R4 and AS33: that writer is `AuditUndoneWriter`, not the exported service.
describe('AuditUndoneWriter (spec 0010, AC-14)', () => {
  const audit = new AuditService();
  const writer = new AuditUndoneWriter();
  const UNDOABLE = 'sku.scratch_merged';
  const registry = actualRegistry();
  const target = '01937f3a-0000-7000-8000-0000000000aa';
  const sku = '01937f3a-0000-7000-8000-0000000000bb';
  const undone = {
    actor: personActor(USER, 'manager'),
    action: `${UNDOABLE}_undone`,
    record: { type: 'sku', id: sku },
    before: { merged: true },
    after: { merged: false },
    reason: '  wrong call, ring 01012345678 ',
    correlationId: 'corr-u',
  };

  /** A transaction double whose insert returns one id. */
  function returningTx() {
    const statements: unknown[][] = [];
    const execute = vi.fn((query: unknown) => {
      statements.push(boundValues(query));
      return Promise.resolve({ rows: [{ id: 'new-entry' }] });
    });
    return { tx: { execute } as unknown as Transaction, statements };
  }

  beforeEach(() => {
    registry[UNDOABLE] = {
      ...registry['sku.archived'],
      undoable: true,
      undoHandler: 'inventory.scratch_unmerge',
    } as Contracts.AuditActionDefinition;
  });
  afterEach(() => {
    delete registry[UNDOABLE];
  });

  it('writes the undone code with undoes_entry_id and a masked reason, and returns its row', async () => {
    const { tx, statements } = returningTx();

    await expect(writer.write(tx, target, undone)).resolves.toEqual({ id: 'new-entry' });

    const params = statements[0] ?? [];
    expect(params[PARAM.action]).toBe(`${UNDOABLE}_undone`);
    expect(params[PARAM.undoesEntryId]).toBe(target);
    expect(params[PARAM.undoAction]).toBeNull();
    expect(params[PARAM.reason]).toBe('wrong call, ring [phone]');
  });

  it('requires a reason on the undone code', async () => {
    const { tx, statements } = returningTx();

    await expect(writer.write(tx, target, { ...undone, reason: '  ' })).rejects.toBeInstanceOf(
      AuditReasonRequired,
    );
    expect(statements).toEqual([]);
  });

  it('refuses an undone code through record, and a listed code through the undone writer', async () => {
    const { tx, statements } = returningTx();

    await expect(
      audit.record(tx, { ...undone, action: `${UNDOABLE}_undone` as AuditActionCode }),
    ).rejects.toBeInstanceOf(UnknownAuditAction);
    await expect(
      writer.write(tx, target, { ...undone, action: 'sku.archived' }),
    ).rejects.toBeInstanceOf(UnknownAuditAction);
    expect(statements).toEqual([]);
  });

  it('leaves the exported service without an undone entry writer', () => {
    expect('recordUndone' in audit).toBe(false);
  });

  it('knows no undone code of an action that is not undoable', async () => {
    const { tx } = returningTx();

    await expect(
      writer.write(tx, target, { ...undone, action: 'sku.archived_undone' }),
    ).rejects.toBeInstanceOf(UnknownAuditAction);
  });
});

/** The real, mutable registry behind the mock, for planting a scratch undoable code. */
function actualRegistry(): Record<string, Contracts.AuditActionDefinition> {
  return AUDIT_ACTIONS;
}
