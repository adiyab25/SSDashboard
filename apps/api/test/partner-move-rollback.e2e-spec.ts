import { randomUUID } from 'node:crypto';
import { PartnerUserDetail } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/database/sql.js';
import {
  IDENTITY_AUDIT,
  type IdentityAudit,
  type IdentityAuditEntry,
} from '../src/identity/audit-port/identity-audit.js';
import { startInProcessApi, type InProcessApi, type PlantedPerson } from './in-process-api.js';

/**
 * An identity audit port that fails for the targets in `failFor`, as the hat service's last step
 * (the entry is written after the hat row and the session delete), and writes nothing otherwise.
 */
class FailingAudit implements IdentityAudit {
  readonly failFor = new Set<string>();

  record(_tx: Transaction, entry: IdentityAuditEntry): Promise<void> {
    return this.failFor.has(entry.record.id)
      ? Promise.reject(new Error('the audit write failed'))
      : Promise.resolve();
  }

  newCorrelationId(): string {
    return randomUUID();
  }
}

// Spec 0008 AC-12 and spec 0005 AC-33 (b): moving a partner user to another account deletes their
// sessions in the same transaction as the hat row change, so a failure at the end of the change
// (here the audit write) leaves the hat on account A and every session alive.
describe('moving a partner user rolls back as one change', { timeout: 300_000 }, () => {
  const audit = new FailingAudit();
  let api: InProcessApi;
  let boss: PlantedPerson & { cookie: string };
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    api = await startInProcessApi((builder) => {
      builder.overrideProvider(IDENTITY_AUDIT).useValue(audit);
    });
    accountA = await api.addParty('RA');
    accountB = await api.addParty('RB');
    const person = await api.addPerson(['manager'], { costView: true });
    boss = { ...person, cookie: await api.signIn(person.email) };
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  it('leaves the hat row on account A and the sessions intact when the audit write fails', async () => {
    const partner = await api.addPerson(['partner'], { partnerAccountId: accountA });
    const cookie = await api.signIn(partner.email);
    const read = await api.call(boss.cookie, 'GET', `/api/partner-users/${partner.id}`);
    const { updatedAt } = PartnerUserDetail.parse(read.body);
    audit.failFor.add(partner.id);

    const failed = await api.call(boss.cookie, 'PUT', `/api/partner-users/${partner.id}/access`, {
      partnerAccountId: accountB,
      updatedAt,
    });

    audit.failFor.delete(partner.id);
    expect(failed.status).toBe(500);
    const hats = await api.owner.pool.query(
      'SELECT hat, partner_account_id FROM hat_assignments WHERE user_id = $1::uuid',
      [partner.id],
    );
    expect(hats.rows).toEqual([{ hat: 'partner', partner_account_id: accountA }]);
    const sessions = await api.owner.pool.query(
      'SELECT count(*)::int AS count FROM sessions WHERE user_id = $1::uuid',
      [partner.id],
    );
    expect(sessions.rows[0]).toMatchObject({ count: 1 });
    // The same cookie still works and still names account A.
    const me = await api.call(cookie, 'GET', '/api/partner/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ partnerAccountId: accountA });
    // And `updated_at` did not move, so the same read still passes the stale check.
    const again = await api.call(boss.cookie, 'GET', `/api/partner-users/${partner.id}`);
    expect(PartnerUserDetail.parse(again.body).updatedAt).toBe(updatedAt);
  });
});
