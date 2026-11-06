import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { en, flatten } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AuditActor,
  AuditEntryListQuery,
  AuditEntryView,
  auditActionOf,
  isAuditActionCode,
} from '../src/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Spec 0010, AC-10: every registry entry is complete, labelled in both languages, and proven by
// a test that exists and names the code.
describe('audit action registry', () => {
  const english = flatten(en);
  const arabic = flatten(ar);

  it.each(Object.entries(AUDIT_ACTIONS))('%s is complete', (code, action) => {
    expect(code).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    expect(action.module).not.toBe('');
    expect(action.recordType).not.toBe('');
    expect(['required', 'optional']).toContain(action.reason);
    expect(typeof action.automatic).toBe('boolean');
    expect(typeof action.undoable).toBe('boolean');
    expect(english[action.label]).toBeTruthy();
    expect(arabic[action.label]).toBeTruthy();
    const proof = `${REPO_ROOT}${action.proof}`;
    expect(existsSync(proof), action.proof).toBe(true);
    expect(readFileSync(proof, 'utf8')).toContain(code);
  });

  it('knows its codes and nothing else', () => {
    expect(isAuditActionCode('stock_receipt.voided')).toBe(true);
    expect(isAuditActionCode('stock_receipt.deleted')).toBe(false);
    expect(isAuditActionCode('constructor')).toBe(false);
    expect(auditActionOf('stock_receipt.voided')?.reason).toBe('required');
    expect(auditActionOf('nope.nope')).toBeUndefined();
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
