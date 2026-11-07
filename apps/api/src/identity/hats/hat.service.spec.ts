import type { DatabaseConnection } from '@ssdashboard/db';
import { sql } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import { Access } from '../../platform/access/access.js';
import { HatsChanged } from '../../platform/events/auth-events.js';
import type { Actor } from '../access/actor.js';
import type { IdentityAudit, IdentityAuditEntry } from '../audit-port/identity-audit.js';
import type { SessionAudiences } from '../sessions/session-audiences.js';
import type { AuthAudit } from '../sign-in/auth-audit.service.js';
import { HatService } from './hat.service.js';

const TARGET = '0190c0de-0000-7000-8000-000000000002';
const UPDATED_AT = '2026-11-06T10:00:00.123456Z';

const actorWith = (hats: string[], grants: string[] = []): Actor => ({
  id: '0190c0de-0000-7000-8000-000000000001',
  ip: '203.0.113.7',
  userAgent: 'Firefox',
  access: new Access({ userId: 'x', hats, grants, partnerAccountId: null }),
});
const MANAGER_WITH_COST = actorWith(['manager'], ['cost.view']);

/** The person as the locked read returns them. */
interface Target {
  hats: string[];
  partner_account_id?: string | null;
  cost_view?: boolean;
  fresh?: boolean;
  banned?: boolean;
}

/**
 * A HatService over a fake database whose transaction runs the callback with one fake `tx`, and
 * records whether a call happened inside it. Every statement answers the target row, so the lock,
 * the read, the last manager check and the writes all pass.
 */
function setup(target: Target, options: { recordFails?: boolean; consignment?: boolean } = {}) {
  const steps: string[] = [];
  let inside = false;
  const tx = {
    execute: vi.fn(() =>
      Promise.resolve({
        rows: [
          { fresh: true, banned: false, cost_view: false, partner_account_id: null, ...target },
        ],
        rowCount: 0,
      }),
    ),
  };
  const connection = {
    db: {
      transaction: async <T>(run: (handle: typeof tx) => Promise<T>): Promise<T> => {
        inside = true;
        steps.push('begin');
        try {
          const result = await run(tx);
          steps.push('commit');
          return result;
        } catch (error) {
          steps.push('rollback');
          throw error;
        } finally {
          inside = false;
        }
      },
    },
  } as unknown as DatabaseConnection;
  const entries: Array<{ tx: unknown; entry: IdentityAuditEntry; inside: boolean }> = [];
  const audit: IdentityAudit = {
    record: vi.fn((handle: unknown, entry: IdentityAuditEntry) => {
      entries.push({ tx: handle, entry, inside });
      steps.push('audit');
      if (options.recordFails) return Promise.reject(new Error('the audit write failed'));
      return Promise.resolve();
    }),
    newCorrelationId: () => 'c0ffee00-0000-4000-8000-000000000001',
  };
  const hatsChanged = vi.fn(() => steps.push('announce'));
  const authAudit = { hatsChanged } as unknown as AuthAudit;
  const audiences = {
    staffCondition: () => sql`true`,
    partnerCondition: () => sql`true`,
  } as unknown as SessionAudiences;
  const partners = {
    isConsignmentPartner: vi.fn(() => Promise.resolve(options.consignment ?? true)),
  };
  const service = new HatService(connection, audiences, authAudit, audit, partners);
  return { service, tx, entries, steps, hatsChanged, audit, partners };
}

const change = (hats: string[], costView: boolean, reason?: string) =>
  ({
    hats,
    costView,
    updatedAt: UPDATED_AT,
    ...(reason !== undefined && { reason }),
  }) as Parameters<HatService['replaceStaffAccess']>[1];

describe('HatService.replaceStaffAccess (spec 0008, AC-12, AC-13)', () => {
  it('writes one audit entry through the change’s own transaction, then logs and emits after the commit', async () => {
    const { service, tx, entries, steps, hatsChanged } = setup({ hats: ['warehouse'] });

    await expect(
      service.replaceStaffAccess(
        TARGET,
        change(['support', 'warehouse'], false),
        MANAGER_WITH_COST,
      ),
    ).resolves.toBe(true);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tx).toBe(tx);
    expect(entries[0]?.inside).toBe(true);
    expect(entries[0]?.entry).toEqual({
      actor: { kind: 'person', userId: MANAGER_WITH_COST.id, hat: 'manager' },
      action: 'hat.granted',
      record: { type: 'user', id: TARGET },
      before: { hats: ['warehouse'], costView: false, partnerAccountId: null },
      after: { hats: ['support', 'warehouse'], costView: false, partnerAccountId: null },
      correlationId: 'c0ffee00-0000-4000-8000-000000000001',
    });
    expect(steps).toEqual(['begin', 'audit', 'commit', 'announce']);
    const [line, event] = hatsChanged.mock.calls[0] as unknown as [unknown, HatsChanged];
    expect(line).toMatchObject({ hatsAdded: ['support'], hatsRemoved: [] });
    expect(event).toBeInstanceOf(HatsChanged);
    expect(event).toMatchObject({
      context: { actorId: MANAGER_WITH_COST.id, targetId: TARGET, ip: '203.0.113.7' },
      before: { hats: ['warehouse'] },
      after: { hats: ['support', 'warehouse'] },
      reason: null,
    });
  });

  it('rolls the change back with the entry when the audit write fails, and announces nothing', async () => {
    const { service, steps, hatsChanged } = setup({ hats: ['warehouse'] }, { recordFails: true });

    await expect(
      service.replaceStaffAccess(TARGET, change(['support'], false), MANAGER_WITH_COST),
    ).rejects.toThrow('the audit write failed');

    expect(steps).toEqual(['begin', 'audit', 'rollback']);
    expect(hatsChanged).not.toHaveBeenCalled();
  });

  it('records a change that takes anything away as hat.revoked, with the reason', async () => {
    const { service, entries } = setup({ hats: ['support', 'warehouse'], cost_view: true });

    await service.replaceStaffAccess(
      TARGET,
      change(['operations', 'support'], false, 'Moved to operations'),
      MANAGER_WITH_COST,
    );

    expect(entries[0]?.entry).toMatchObject({
      action: 'hat.revoked',
      before: { hats: ['support', 'warehouse'], costView: true },
      after: { hats: ['support', 'operations'], costView: false },
      reason: 'Moved to operations',
    });
  });

  it('tightens the audit reason policy only when the manager hat is taken away', async () => {
    const managerTaken = setup({ hats: ['manager'], cost_view: true });
    await managerTaken.service.replaceStaffAccess(
      TARGET,
      change(['support'], true, 'Stepped down'),
      MANAGER_WITH_COST,
    );
    const otherTaken = setup({ hats: ['support', 'warehouse'] });
    await otherTaken.service.replaceStaffAccess(
      TARGET,
      change(['support'], false),
      MANAGER_WITH_COST,
    );

    expect(managerTaken.entries[0]?.entry).toMatchObject({
      action: 'hat.revoked',
      reason: 'Stepped down',
      reasonRequired: true,
    });
    expect(otherTaken.entries[0]?.entry.action).toBe('hat.revoked');
    expect(otherTaken.entries[0]?.entry).not.toHaveProperty('reasonRequired');
  });

  it('writes nothing, records nothing and announces nothing for the same set', async () => {
    const { service, entries, hatsChanged } = setup({ hats: ['warehouse'] });

    await expect(
      service.replaceStaffAccess(TARGET, change(['warehouse'], false), MANAGER_WITH_COST),
    ).resolves.toBe(false);

    expect(entries).toEqual([]);
    expect(hatsChanged).not.toHaveBeenCalled();
  });

  it.each([
    ['own hats', ['support']],
    ['own cost grant', ['manager']],
  ])(
    'refuses a change to one’s %s with 409 SELF_HAT_CHANGE before any read',
    async (_case, hats) => {
      const { service, steps } = setup({ hats: ['manager'] });

      await expect(
        service.replaceStaffAccess(MANAGER_WITH_COST.id, change(hats, true), MANAGER_WITH_COST),
      ).rejects.toMatchObject({ response: { code: 'SELF_HAT_CHANGE' } });
      expect(steps).toEqual([]);
    },
  );

  it.each([
    ['NO_HAT', [], false],
    ['HAT_CONFLICT', ['partner'], false],
    ['HAT_CONFLICT', ['partner', 'support'], false],
    ['GRANT_NOT_ALLOWED', ['partner'], true],
  ] as const)('answers 422 %s for %j before any read', async (code, hats, costView) => {
    const { service, steps } = setup({ hats: ['warehouse'] });

    await expect(
      service.replaceStaffAccess(TARGET, change([...hats], costView), MANAGER_WITH_COST),
    ).rejects.toMatchObject({ status: 422, response: { code } });
    expect(steps).toEqual([]);
  });

  it('answers 409 STALE_RECORD and records nothing when updatedAt is not the stored one', async () => {
    const { service, entries, steps } = setup({ hats: ['warehouse'], fresh: false });

    await expect(
      service.replaceStaffAccess(TARGET, change(['support'], false), MANAGER_WITH_COST),
    ).rejects.toMatchObject({ response: { code: 'STALE_RECORD' } });
    expect(entries).toEqual([]);
    expect(steps).toEqual(['begin', 'rollback']);
  });

  it.each([
    ['adding', false, true],
    ['removing', true, false],
  ])(
    'answers 403 FORBIDDEN to a manager without cost.view %s cost for someone else',
    async (_case, before, after) => {
      const { service, entries } = setup({ hats: ['warehouse'], cost_view: before });

      await expect(
        service.replaceStaffAccess(TARGET, change(['warehouse'], after), actorWith(['manager'])),
      ).rejects.toMatchObject({ status: 403, response: { code: 'FORBIDDEN' } });
      expect(entries).toEqual([]);
    },
  );

  it('lets a manager without cost.view change hats when the cost grant stays as it is', async () => {
    const { service } = setup({ hats: ['warehouse'], cost_view: true });

    await expect(
      service.replaceStaffAccess(TARGET, change(['support'], true), actorWith(['manager'])),
    ).resolves.toBe(true);
  });

  it('answers 422 REASON_REQUIRED when the manager hat is taken away without a reason', async () => {
    const { service, entries } = setup({ hats: ['manager'], cost_view: true });

    await expect(
      service.replaceStaffAccess(TARGET, change(['support'], true), MANAGER_WITH_COST),
    ).rejects.toMatchObject({ status: 422, response: { code: 'REASON_REQUIRED' } });
    expect(entries).toEqual([]);
  });

  it('answers 404 for an id that is not a uuid', async () => {
    const { service } = setup({ hats: ['warehouse'] });

    await expect(
      service.replaceStaffAccess('nope', change(['support'], false), MANAGER_WITH_COST),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('HatService.giveFirstAccess (spec 0008, AC-14)', () => {
  it('writes the first set in the caller’s transaction and returns it in catalog order', async () => {
    const { service, tx } = setup({ hats: [] });

    await expect(
      service.giveFirstAccess(
        tx as never,
        TARGET,
        ['warehouse', 'manager'],
        true,
        MANAGER_WITH_COST,
      ),
    ).resolves.toEqual({ hats: ['warehouse', 'manager'], costView: true, partnerAccountId: null });
    expect(tx.execute).toHaveBeenCalled();
  });

  it('refuses cost on a new person from a manager without cost.view', async () => {
    const { service, tx } = setup({ hats: [] });

    await expect(
      service.giveFirstAccess(tx as never, TARGET, ['support'], true, actorWith(['manager'])),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.execute).not.toHaveBeenCalled();
  });
});

const ACCOUNT_A = '0190c0de-0000-7000-8000-0000000000aa';
const ACCOUNT_B = '0190c0de-0000-7000-8000-0000000000bb';
const move = (partnerAccountId: string, reason?: string) => ({
  partnerAccountId,
  updatedAt: UPDATED_AT,
  ...(reason !== undefined && { reason }),
});

describe('HatService.givePartnerAccess (spec 0008, AC-9 and AC-15)', () => {
  it('asks PartnerAccounts in the caller’s transaction and gives the partner hat only, bound to the account', async () => {
    const { service, tx, partners } = setup({ hats: [] });

    await expect(
      service.givePartnerAccess(tx as never, TARGET, ACCOUNT_A, MANAGER_WITH_COST),
    ).resolves.toEqual({ hats: ['partner'], costView: false, partnerAccountId: ACCOUNT_A });
    expect(partners.isConsignmentPartner).toHaveBeenCalledWith(ACCOUNT_A, tx);
    expect(tx.execute).toHaveBeenCalled();
  });

  it('answers 422 UNKNOWN_PARTNER_ACCOUNT and writes nothing for a party that is not a consignment partner', async () => {
    const { service, tx } = setup({ hats: [] }, { consignment: false });

    await expect(
      service.givePartnerAccess(tx as never, TARGET, ACCOUNT_A, MANAGER_WITH_COST),
    ).rejects.toMatchObject({ status: 422, response: { code: 'UNKNOWN_PARTNER_ACCOUNT' } });
    expect(tx.execute).not.toHaveBeenCalled();
  });
});

describe('HatService.movePartnerUser (spec 0008, AC-12; spec 0005 AC-33 b)', () => {
  const partner = { hats: ['partner'], partner_account_id: ACCOUNT_A };
  const statements = (tx: { execute: { mock: { calls: unknown[][] } } }) =>
    JSON.stringify(tx.execute.mock.calls);

  it('replaces the partner row, ends every session and writes hat.revoked in one transaction, then announces', async () => {
    const { service, tx, entries, steps, hatsChanged } = setup(partner);

    await expect(
      service.movePartnerUser(TARGET, move(ACCOUNT_B, 'moved shops'), actorWith(['manager'])),
    ).resolves.toBe(true);

    expect(statements(tx)).toContain('DELETE FROM sessions');
    expect(statements(tx)).toContain('DELETE FROM hat_assignments WHERE user_id = ');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.inside).toBe(true);
    expect(entries[0]?.entry).toMatchObject({
      action: 'hat.revoked',
      record: { type: 'user', id: TARGET },
      before: { hats: ['partner'], costView: false, partnerAccountId: ACCOUNT_A },
      after: { hats: ['partner'], costView: false, partnerAccountId: ACCOUNT_B },
      reason: 'moved shops',
    });
    expect(steps).toEqual(['begin', 'audit', 'commit', 'announce']);
    expect(hatsChanged).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for the same account', async () => {
    const { service, entries, hatsChanged, partners } = setup(partner);

    await expect(service.movePartnerUser(TARGET, move(ACCOUNT_A), MANAGER_WITH_COST)).resolves.toBe(
      false,
    );
    expect(entries).toEqual([]);
    expect(hatsChanged).not.toHaveBeenCalled();
    expect(partners.isConsignmentPartner).not.toHaveBeenCalled();
  });

  it('answers 422 UNKNOWN_PARTNER_ACCOUNT and rolls back for an account that is not a consignment partner', async () => {
    const { service, entries, steps } = setup(partner, { consignment: false });

    await expect(
      service.movePartnerUser(TARGET, move(ACCOUNT_B), MANAGER_WITH_COST),
    ).rejects.toMatchObject({ status: 422, response: { code: 'UNKNOWN_PARTNER_ACCOUNT' } });
    expect(entries).toEqual([]);
    expect(steps).toEqual(['begin', 'rollback']);
  });

  it('answers 409 STALE_RECORD when updatedAt is not the stored one', async () => {
    const { service, entries } = setup({ ...partner, fresh: false });

    await expect(
      service.movePartnerUser(TARGET, move(ACCOUNT_B), MANAGER_WITH_COST),
    ).rejects.toMatchObject({ response: { code: 'STALE_RECORD' } });
    expect(entries).toEqual([]);
  });

  it('answers 404 for an id that is not a uuid', async () => {
    const { service, steps } = setup(partner);

    await expect(
      service.movePartnerUser('nope', move(ACCOUNT_B), MANAGER_WITH_COST),
    ).rejects.toMatchObject({ status: 404 });
    expect(steps).toEqual([]);
  });
});
