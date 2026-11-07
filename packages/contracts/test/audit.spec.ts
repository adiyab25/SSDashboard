import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { en, flatten } from '@ssdashboard/i18n';
import type { MessageKey } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { maskPhones } from '@ssdashboard/config/redaction';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_REASON_HEADER,
  AUDIT_RECORD_TYPES,
  AuditExportQuery,
  AuditExportReason,
  auditExportDayCount,
  AuditActor,
  type AuditActionDefinition,
  auditRecordTypeOf,
  ReasonCode,
  carrierActor,
  importActor,
  partnerUserActor,
  personActor,
  portalCustomerActor,
  systemJobActor,
  AuditEntryListQuery,
  AuditEntryView,
  auditActionOf,
  isAuditActionCode,
} from '../src/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Every way a registry falls short of spec 0010 AC-10 (milestone 2 task 11): a malformed code, an
 * empty field, a label missing in either language, a proof file that is missing or does not name
 * the code, a record type the audit trail does not know (review AW2), or an undoable code without
 * its undo handler. Empty means the registry is complete. Runs on the real registry and on planted
 * ones, so each check is proven to fail.
 */
function registryFaults(registry: Readonly<Record<string, AuditActionDefinition>>): string[] {
  const english = flatten(en);
  const arabic = flatten(ar);
  return Object.entries(registry).flatMap(([code, action]) => {
    const faults: string[] = [];
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(code)) faults.push(`${code}: code shape`);
    if (!action.module) faults.push(`${code}: module`);
    if (!['required', 'optional'].includes(action.reason)) faults.push(`${code}: reason`);
    if (typeof action.automatic !== 'boolean') faults.push(`${code}: automatic`);
    if (typeof action.undoable !== 'boolean') faults.push(`${code}: undoable`);
    if (!english[action.label]) faults.push(`${code}: English label`);
    if (!arabic[action.label]) faults.push(`${code}: Arabic label`);
    if (!auditRecordTypeOf(action.recordType)) faults.push(`${code}: unknown record type`);
    if (action.undoable && !action.undoHandler) faults.push(`${code}: undoable without a handler`);
    if (!action.undoable && action.undoHandler) faults.push(`${code}: handler on a final action`);
    // Security review AS23: a record type that keeps reason codes needs the action's own list,
    // each a code with no phone in it; a free text record type takes no list.
    const form = auditRecordTypeOf(action.recordType)?.reason;
    if (form === 'code' && !action.reasonCodes?.length)
      faults.push(`${code}: reason codes missing`);
    if (form === 'text' && action.reasonCodes) faults.push(`${code}: reason codes on free text`);
    for (const reason of action.reasonCodes ?? []) {
      if (!ReasonCode.safeParse(reason).success || maskPhones(reason) !== reason) {
        faults.push(`${code}: reason code shape ${reason}`);
      }
    }
    const proof = `${REPO_ROOT}${action.proof}`;
    if (!existsSync(proof)) faults.push(`${code}: proof file missing`);
    else if (!readFileSync(proof, 'utf8').includes(code)) faults.push(`${code}: proof misses code`);
    return faults;
  });
}

// Spec 0010, AC-10: every registry entry is complete, labelled in both languages, and proven by
// a test that exists and names the code; an undoable code names its handler (task 11).
describe('audit action registry', () => {
  const complete = AUDIT_ACTIONS['stock_receipt.voided'];

  it('is complete', () => {
    expect(registryFaults(AUDIT_ACTIONS)).toEqual([]);
  });

  it.each([
    ['an undoable code without a handler', { ...complete, undoable: true }, 'undoable without'],
    ['a handler on a final code', { ...complete, undoHandler: 'x.undo' }, 'handler on a final'],
    [
      'a label in neither catalog',
      { ...complete, label: 'audit.actions.noSuchAction' as MessageKey },
      'Arabic label',
    ],
    ['an unknown record type', { ...complete, recordType: 'planet' }, 'unknown record type'],
    ['a proof that misses the code', { ...complete, proof: 'AGENTS.md' }, 'proof misses code'],
    ['a missing proof file', { ...complete, proof: 'no/such/file.ts' }, 'proof file missing'],
    [
      'a customer action without reason codes',
      { ...complete, recordType: 'customer' },
      'codes missing',
    ],
    [
      'a customer reason code holding a phone',
      { ...complete, recordType: 'customer', reasonCodes: ['call_01012345678'] },
      'reason code shape',
    ],
    ['reason codes on a free text type', { ...complete, reasonCodes: ['wrong'] }, 'on free text'],
  ])('refuses a planted entry with %s', (_case, planted, fault) => {
    const faults = registryFaults({ 'stock_receipt.voided': planted });

    expect(faults.join('\n')).toContain(fault);
  });

  it('knows its codes and nothing else', () => {
    expect(isAuditActionCode('stock_receipt.voided')).toBe(true);
    expect(isAuditActionCode('sku.archived')).toBe(true);
    expect(isAuditActionCode('stock_receipt.deleted')).toBe(false);
    expect(isAuditActionCode('constructor')).toBe(false);
    expect(auditActionOf('stock_receipt.voided')?.reason).toBe('required');
    expect(auditActionOf('nope.nope')).toBeUndefined();
  });
});

// Review AW2: every record type carries its label in both languages, and the customer facing
// ones carry the personal keys the writer masks (security review AS2).
describe('audit record types', () => {
  const english = flatten(en);
  const arabic = flatten(ar);

  it.each(Object.entries(AUDIT_RECORD_TYPES))('%s has both labels', (_type, definition) => {
    expect(english[definition.label]).toBeTruthy();
    expect(arabic[definition.label]).toBeTruthy();
  });

  it('marks the bare personal keys of the customer facing types', () => {
    expect(AUDIT_RECORD_TYPES.customer.personalKeys).toEqual([
      'name',
      'email',
      'reason',
      'externalid',
    ]);
    expect(AUDIT_RECORD_TYPES.outbound_command.personalKeys).toContain('payload');
    expect(auditRecordTypeOf('sku')?.personalKeys).toEqual([]);
    expect(auditRecordTypeOf('toString')).toBeUndefined();
  });

  // Security review AS13: customer facing types keep reason codes; the rest take masked text.
  it('gives the customer facing types a reason code and the rest free text', () => {
    const forms = Object.fromEntries(
      Object.entries(AUDIT_RECORD_TYPES).map(([type, definition]) => [type, definition.reason]),
    );
    expect(forms).toEqual({
      stock_receipt: 'text',
      sku: 'text',
      location: 'text',
      audit_entry: 'text',
      customer: 'code',
      order: 'code',
      exchange: 'code',
      outbound_command: 'code',
    });
  });

  // Security reviews AS16, AS17: a record's own code is its label shape; a customer has none.
  it('takes each record type label in its own shape', () => {
    expect(AUDIT_RECORD_TYPES.sku.labelPattern.test('01012345678')).toBe(true);
    expect(AUDIT_RECORD_TYPES.sku.labelPattern.test('tee-blk-m')).toBe(false);
    expect(AUDIT_RECORD_TYPES.location.labelPattern.test('WH-CAI')).toBe(true);
    expect(AUDIT_RECORD_TYPES.location.labelPattern.test('x'.repeat(17))).toBe(false);
    expect(AUDIT_RECORD_TYPES.stock_receipt.labelPattern.test('SR-2026-000001')).toBe(true);
    expect(AUDIT_RECORD_TYPES.stock_receipt.labelPattern.test('SR-1')).toBe(false);
    expect(AUDIT_RECORD_TYPES.customer.labelPattern).toBeNull();
    expect(AUDIT_RECORD_TYPES.order.labelIsOwnCode).toBe(false);
  });
});

// Milestone 2 task 8: one constructor per actor kind, refusing a wrong shape before the table.
describe('audit actor helpers', () => {
  const id = '01937f3a-0000-7000-8000-000000000001';

  it('builds each of the six kinds', () => {
    expect(personActor(id, 'admin')).toEqual({ kind: 'person', userId: id, hat: 'admin' });
    expect(partnerUserActor(id, 'acct-1')).toEqual({
      kind: 'partner_user',
      userId: id,
      partnerAccountId: 'acct-1',
    });
    expect(systemJobActor('reconcile', id)).toEqual({
      kind: 'system_job',
      name: 'reconcile',
      jobId: id,
    });
    expect(carrierActor('bosta')).toEqual({ kind: 'carrier', connectionCode: 'bosta' });
    expect(importActor('run-1')).toEqual({ kind: 'import', runId: 'run-1' });
    expect(portalCustomerActor(id)).toEqual({ kind: 'portal_customer', customerId: id });
  });

  it('refuses a wrong shape', () => {
    expect(() => personActor('not-a-uuid', 'admin')).toThrow();
    expect(() => personActor(id, '')).toThrow();
    expect(() => partnerUserActor(id, '')).toThrow();
    expect(() => systemJobActor('reconcile', 'job-1')).toThrow();
    expect(() => carrierActor('')).toThrow();
    expect(() => importActor('')).toThrow();
    expect(() => portalCustomerActor('')).toThrow();
  });
});

describe('AuditActor', () => {
  const user = '01937f3a-0000-7000-8000-000000000001';

  it('accepts each of the six kinds in its own shape', () => {
    const actors = [
      { kind: 'person', userId: user, hat: 'admin' },
      { kind: 'partner_user', userId: user, partnerAccountId: 'acct-1' },
      { kind: 'system_job', name: 'reconcile', jobId: user },
      { kind: 'carrier', connectionCode: 'bosta' },
      { kind: 'import', runId: 'run-1' },
      { kind: 'portal_customer', customerId: 'customer-1' },
    ];
    for (const actor of actors) expect(AuditActor.parse(actor)).toEqual(actor);
  });

  it('refuses a person without a user and an unknown kind', () => {
    expect(AuditActor.safeParse({ kind: 'person', hat: 'admin' }).success).toBe(false);
    expect(AuditActor.safeParse({ kind: 'robot', name: 'x' }).success).toBe(false);
  });
});

describe('AuditEntryListQuery', () => {
  it('defaults the limit to 50 and caps it at 200', () => {
    expect(AuditEntryListQuery.parse({}).limit).toBe(50);
    expect(AuditEntryListQuery.parse({ limit: '200' }).limit).toBe(200);
    expect(AuditEntryListQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(AuditEntryListQuery.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('needs a record type with a record id, and an ordered day range', () => {
    const id = '01937f3a-0000-7000-8000-000000000001';
    expect(AuditEntryListQuery.safeParse({ recordId: id }).success).toBe(false);
    expect(
      AuditEntryListQuery.safeParse({ recordType: 'stock_receipt', recordId: id }).success,
    ).toBe(true);
    expect(
      AuditEntryListQuery.safeParse({ dayFrom: '2026-11-06', dayTo: '2026-11-05' }).success,
    ).toBe(false);
    expect(
      AuditEntryListQuery.safeParse({ dayFrom: '2026-11-05', dayTo: '2026-11-05' }).success,
    ).toBe(true);
  });

  it('refuses unknown keys and a malformed action', () => {
    expect(AuditEntryListQuery.safeParse({ offset: '10' }).success).toBe(false);
    expect(AuditEntryListQuery.safeParse({ action: 'Voided' }).success).toBe(false);
  });

  // Security review AS7: PostgreSQL has no year 0000, so it is a bad filter, not a 500.
  it('refuses a day in year 0000 and accepts year 1', () => {
    expect(AuditEntryListQuery.safeParse({ dayFrom: '0000-01-01' }).success).toBe(false);
    expect(AuditEntryListQuery.safeParse({ dayTo: '0000-12-31' }).success).toBe(false);
    expect(AuditEntryListQuery.safeParse({ dayFrom: '0001-01-01' }).success).toBe(true);
  });
});

describe('AuditEntryView', () => {
  const entry = {
    id: '01937f3a-0000-7000-8000-000000000001',
    recordedAt: '2026-11-06T10:00:00.123456Z',
    operatingDay: '2026-11-06',
    correlationId: '01937f3a-0000-7000-8000-000000000002',
    actor: { kind: 'carrier', userId: null, ref: 'bosta', hat: null, jobId: null },
    actorName: null,
    action: 'stock_receipt.voided',
    record: { type: 'stock_receipt', id: '01937f3a-0000-7000-8000-000000000003', label: null },
    before: null,
    after: { status: 'voided' },
    personalFields: [],
    reason: null,
    undone: false,
    canUndo: false,
  };

  // Review AR11: the instant is the api's microsecond UTC text, nothing looser.
  it('takes a microsecond UTC instant and refuses any other precision', () => {
    expect(AuditEntryView.parse(entry)).toEqual(entry);
    expect(
      AuditEntryView.safeParse({ ...entry, recordedAt: '2026-11-06T10:00:00.123Z' }).success,
    ).toBe(false);
    expect(AuditEntryView.safeParse({ ...entry, recordedAt: 'yesterday' }).success).toBe(false);
  });
});

// Spec 0010, review M3R8 and M3R3: one meaning of an export's length, and no reason in the query.
describe('AuditExportQuery', () => {
  it('counts days with both ends included, and allows at most 366', () => {
    expect(auditExportDayCount('2026-01-01', '2026-01-01')).toBe(1);
    expect(auditExportDayCount('2025-01-01', '2026-01-01')).toBe(366);
    expect(AuditExportQuery.safeParse({ dayFrom: '2025-01-01', dayTo: '2026-01-01' }).success).toBe(
      true,
    );
    expect(AuditExportQuery.safeParse({ dayFrom: '2025-01-01', dayTo: '2026-01-02' }).success).toBe(
      false,
    );
  });

  it('takes no reason in the query; the reason header schema trims and caps it', () => {
    expect(
      AuditExportQuery.safeParse({ dayFrom: '2026-01-01', dayTo: '2026-01-01', reason: 'x' })
        .success,
    ).toBe(false);
    expect(AUDIT_REASON_HEADER).toBe('x-audit-reason');
    expect(AuditExportReason.parse('  monthly  ')).toBe('monthly');
    expect(AuditExportReason.safeParse('   ').success).toBe(false);
    expect(AuditExportReason.safeParse('x'.repeat(501)).success).toBe(false);
  });
});
