import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CreatePartnerUserResponse,
  MeResponse,
  PartnerAccountsResponse,
  PartnerUserDetail,
  PartnerUserListResponse,
  ResetStaffPasswordResponse,
  StaffListResponse,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HatsChanged } from '../src/platform/events/auth-events.js';
import { startInProcessApi, type InProcessApi, type PlantedPerson } from './in-process-api.js';

// Spec 0008 milestone 3 (AC-9, AC-10, AC-12, AC-15): partner logins run by a manager through
// `/api/partner-users` on the shared account mechanics, bound to a consignment partner through
// the partners module, moved to another account with every session ended in the same
// transaction, kept off every staff route (403 `WRONG_AUDIENCE`), and answered on
// `/api/partner/me` with the account of their own hat row whatever the request says.
describe('partner logins', { timeout: 300_000 }, () => {
  let api: InProcessApi;
  let boss: PlantedPerson & { cookie: string };
  let accountA: string;
  let accountB: string;
  let supplier: string;
  let archived: string;
  const events: Array<{ name: string; event: unknown }> = [];

  beforeAll(async () => {
    api = await startInProcessApi();
    api.app.get(EventEmitter2).onAny((name: string | string[], event: unknown) => {
      events.push({ name: String(name), event });
    });
    accountA = await api.addParty('PA');
    accountB = await api.addParty('PB');
    supplier = await api.addParty('SUP', { consignment: false, supplier: true });
    archived = await api.addParty('OLD', { archived: true });
    const person = await api.addPerson(['manager'], { costView: true });
    boss = { ...person, cookie: await api.signIn(person.email) };
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  let counter = 0;
  const newEmail = () => {
    counter += 1;
    return `partner${counter}@example.com`;
  };

  async function createPartnerUser(partnerAccountId = accountA) {
    const reply = await api.call(boss.cookie, 'POST', '/api/partner-users', {
      name: `Partner ${counter}`,
      email: newEmail(),
      partnerAccountId,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return CreatePartnerUserResponse.parse(reply.body);
  }

  async function hatsOf(userId: string) {
    const { rows } = await api.owner.pool.query<{ hat: string; partner_account_id: string | null }>(
      'SELECT hat, partner_account_id FROM hat_assignments WHERE user_id = $1::uuid',
      [userId],
    );
    return rows;
  }

  async function sessionsOf(userId: string): Promise<number> {
    const { rows } = await api.owner.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM sessions WHERE user_id = $1::uuid',
      [userId],
    );
    return Number(rows[0]?.count);
  }

  /** A planted partner user of account A, signed in, with no temporary password. */
  async function signedInPartner(partnerAccountId = accountA) {
    const person = await api.addPerson(['partner'], { partnerAccountId });
    return { ...person, cookie: await api.signIn(person.email) };
  }

  it('creates a partner login with the partner hat only, bound to the account, never cost', async () => {
    const created = await createPartnerUser();

    expect(created.partnerUser).toMatchObject({
      partnerAccountId: accountA,
      status: 'invited',
      twoFactorEnabled: false,
    });
    expect(created.setup.mode).toBe('temporary_password');
    expect(await hatsOf(created.partnerUser.id)).toEqual([
      { hat: 'partner', partner_account_id: accountA },
    ]);
    const { rows } = await api.owner.pool.query(
      'SELECT 1 FROM permission_grants WHERE user_id = $1::uuid',
      [created.partnerUser.id],
    );
    expect(rows).toEqual([]);
    const createdEvent = events.find(
      (entry) =>
        entry.name === 'PartnerUserCreated' &&
        (entry.event as { context: { targetId: string } }).context.targetId ===
          created.partnerUser.id,
    );
    expect(createdEvent?.event).toMatchObject({ partnerAccountId: accountA });
    expect(JSON.stringify(createdEvent?.event)).not.toContain('@example.com');
  });

  it.each([
    ['a supplier that is not a consignment partner', () => supplier],
    ['an archived consignment partner', () => archived],
    ['an id that is no party', () => '0190c0de-0000-7000-8000-00000000dead'],
  ])('answers 422 UNKNOWN_PARTNER_ACCOUNT for %s and creates nobody', async (_case, account) => {
    const email = newEmail();
    const reply = await api.call(boss.cookie, 'POST', '/api/partner-users', {
      name: 'Nobody',
      email,
      partnerAccountId: account(),
    });

    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ code: 'UNKNOWN_PARTNER_ACCOUNT' });
    const { rows } = await api.owner.pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
    expect(rows).toEqual([]);
  });

  it('lists the consignment partners a login can be bound to, by code, and nothing else', async () => {
    const reply = await api.call(boss.cookie, 'GET', '/api/partner-users/partner-accounts');

    expect(reply.status).toBe(200);
    expect(PartnerAccountsResponse.parse(reply.body)).toEqual([
      { id: accountA, code: 'PA', name: 'Party PA' },
      { id: accountB, code: 'PB', name: 'Party PB' },
    ]);
  });

  it('lets a new partner user with the temporary password read /api/partner/me and nothing else', async () => {
    const created = await createPartnerUser();
    if (created.setup.mode !== 'temporary_password') throw new Error('mail is off here');
    const cookie = await api.signIn(created.partnerUser.email, created.setup.temporaryPassword);

    const me = await api.call(cookie, 'GET', '/api/partner/me');
    expect(me.status).toBe(200);
    expect(MeResponse.parse(me.body)).toMatchObject({
      mustChangePassword: true,
      home: 'partner',
      partnerAccountId: accountA,
    });
    const patched = await api.call(cookie, 'PATCH', '/api/partner/me', { name: 'Changed' });
    expect(patched.status).toBe(403);
    expect(patched.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('answers /api/partner/me with the account of the hat row, ignoring any account in the query', async () => {
    const partner = await signedInPartner();

    const reply = await api.call(
      partner.cookie,
      'GET',
      `/api/partner/me?partnerAccountId=${accountB}&partyId=${accountB}`,
      undefined,
      { 'x-partner-account-id': accountB },
    );

    expect(reply.status).toBe(200);
    const me = MeResponse.parse(reply.body);
    expect(me).toMatchObject({
      id: partner.id,
      hats: ['partner'],
      permissions: ['partner.submit_sales', 'partner.view_own'],
      partnerAccountId: accountA,
      staffCode: null,
      home: 'partner',
    });
    const patched = await api.call(partner.cookie, 'PATCH', '/api/partner/me', {
      language: 'ar',
    });
    expect(patched.status).toBe(200);
    expect(MeResponse.parse(patched.body)).toMatchObject({
      language: 'ar',
      partnerAccountId: accountA,
    });
    const refused = await api.call(partner.cookie, 'PATCH', '/api/partner/me', {
      partnerAccountId: accountB,
    });
    expect(refused.status).toBe(422);
  });

  it('answers 403 WRONG_AUDIENCE to a partner user on staff routes, and to staff on the partner route', async () => {
    const partner = await signedInPartner();

    for (const path of ['/api/me', '/api/staff', '/api/partner-users', '/api/stock']) {
      const reply = await api.call(partner.cookie, 'GET', path);
      expect(reply.status, path).toBe(403);
      expect(reply.body, path).toMatchObject({ code: 'WRONG_AUDIENCE' });
    }
    const staffOnPartner = await api.call(boss.cookie, 'GET', '/api/partner/me');
    expect(staffOnPartner.status).toBe(403);
    expect(staffOnPartner.body).toMatchObject({ code: 'WRONG_AUDIENCE' });
  });

  it('keeps partner users and staff apart: each list holds its own, the other id is 404', async () => {
    const created = await createPartnerUser(accountB);

    const partners = PartnerUserListResponse.parse(
      (await api.call(boss.cookie, 'GET', `/api/partner-users?partnerAccountId=${accountB}`)).body,
    );
    expect(partners.rows.map((row) => row.id)).toContain(created.partnerUser.id);
    expect(partners.rows.every((row) => row.partnerAccountId === accountB)).toBe(true);
    expect(partners.rows.map((row) => row.id)).not.toContain(boss.id);

    const staff = StaffListResponse.parse(
      (await api.call(boss.cookie, 'GET', '/api/staff?limit=100')).body,
    );
    expect(staff.rows.map((row) => row.id)).not.toContain(created.partnerUser.id);
    expect(
      (await api.call(boss.cookie, 'GET', `/api/staff/${created.partnerUser.id}`)).status,
    ).toBe(404);

    const staffPerson = await api.addPerson(['support']);
    for (const [method, path] of [
      ['GET', `/api/partner-users/${staffPerson.id}`],
      ['POST', `/api/partner-users/${staffPerson.id}/disable`],
      ['POST', `/api/partner-users/${staffPerson.id}/reset-password`],
      ['POST', `/api/partner-users/${staffPerson.id}/revoke-sessions`],
    ] as const) {
      const reply = await api.call(boss.cookie, method, path, method === 'POST' ? {} : undefined);
      expect(reply.status, `${method} ${path}`).toBe(404);
    }
  });

  it('refuses /api/partner-users to a person without people.manage before reading the body', async () => {
    const warehouse = await api.addPerson(['warehouse']);
    const cookie = await api.signIn(warehouse.email);

    for (const [method, path, body] of [
      ['GET', '/api/partner-users', undefined],
      ['GET', '/api/partner-users/partner-accounts', undefined],
      ['POST', '/api/partner-users', { nonsense: true }],
    ] as const) {
      const reply = await api.call(cookie, method, path, body);
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('resets the password: the old one and every session stop working, a temporary one is handed out', async () => {
    const partner = await signedInPartner();

    const reply = await api.call(
      boss.cookie,
      'POST',
      `/api/partner-users/${partner.id}/reset-password`,
    );

    expect(reply.status).toBe(200);
    const { setup } = ResetStaffPasswordResponse.parse(reply.body);
    expect(setup.mode).toBe('temporary_password');
    expect(await sessionsOf(partner.id)).toBe(0);
    const old = await api.call(partner.cookie, 'GET', '/api/partner/me');
    expect(old.status).toBe(401);
    expect(old.body).toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(api.signIn(partner.email)).rejects.toThrow();
    if (setup.mode !== 'temporary_password') throw new Error('mail is off here');
    const fresh = await api.signIn(partner.email, setup.temporaryPassword);
    expect((await api.call(fresh, 'GET', '/api/partner/me')).status).toBe(200);
    expect(events.some((entry) => entry.name === 'PartnerUserPasswordReset')).toBe(true);
  });

  it('disables and enables a partner login: disabled, it has no session and cannot sign in', async () => {
    const partner = await signedInPartner();

    const disabled = await api.call(
      boss.cookie,
      'POST',
      `/api/partner-users/${partner.id}/disable`,
      {
        reason: 'Contract ended',
      },
    );
    expect(disabled.status).toBe(200);
    expect(PartnerUserDetail.parse(disabled.body)).toMatchObject({
      status: 'disabled',
      disableReason: 'Contract ended',
    });
    expect(await sessionsOf(partner.id)).toBe(0);
    expect((await api.call(partner.cookie, 'GET', '/api/partner/me')).status).toBe(401);
    await expect(api.signIn(partner.email)).rejects.toThrow();

    const enabled = await api.call(boss.cookie, 'POST', `/api/partner-users/${partner.id}/enable`);
    expect(enabled.status).toBe(200);
    expect(PartnerUserDetail.parse(enabled.body).status).toBe('active');
    expect((await api.call(await api.signIn(partner.email), 'GET', '/api/partner/me')).status).toBe(
      200,
    );
    expect(events.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['PartnerUserDisabled', 'PartnerUserEnabled']),
    );
  });

  it('moves a partner user to another account, ending every session in the same change (AC-12, AC-33 b)', async () => {
    const partner = await signedInPartner();
    const before = PartnerUserDetail.parse(
      (await api.call(boss.cookie, 'GET', `/api/partner-users/${partner.id}`)).body,
    );
    expect(await sessionsOf(partner.id)).toBe(1);

    const moved = await api.call(boss.cookie, 'PUT', `/api/partner-users/${partner.id}/access`, {
      partnerAccountId: accountB,
      updatedAt: before.updatedAt,
      reason: 'Moved to the other shop',
    });

    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const after = PartnerUserDetail.parse(moved.body);
    expect(after.partnerAccountId).toBe(accountB);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(await hatsOf(partner.id)).toEqual([{ hat: 'partner', partner_account_id: accountB }]);
    expect(await sessionsOf(partner.id)).toBe(0);
    const old = await api.call(partner.cookie, 'GET', '/api/partner/me');
    expect(old.status).toBe(401);
    expect(old.body).toMatchObject({ code: 'SESSION_EXPIRED' });
    const fresh = await api.signIn(partner.email);
    expect(MeResponse.parse((await api.call(fresh, 'GET', '/api/partner/me')).body)).toMatchObject({
      partnerAccountId: accountB,
    });
    const changed = events
      .filter((entry) => entry.name === 'HatsChanged')
      .map((entry) => entry.event as HatsChanged)
      .find((event) => event.context.targetId === partner.id);
    expect(changed).toMatchObject({
      before: { hats: ['partner'], costView: false, partnerAccountId: accountA },
      after: { hats: ['partner'], costView: false, partnerAccountId: accountB },
      reason: 'Moved to the other shop',
    });

    // The detail read before the move is stale now; an unknown account changes nothing either.
    const stale = await api.call(boss.cookie, 'PUT', `/api/partner-users/${partner.id}/access`, {
      partnerAccountId: accountA,
      updatedAt: before.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'STALE_RECORD' });
    // Signing in again moved `updatedAt` on: read it afresh, as the dialog would.
    const current = PartnerUserDetail.parse(
      (await api.call(boss.cookie, 'GET', `/api/partner-users/${partner.id}`)).body,
    );
    const unknown = await api.call(boss.cookie, 'PUT', `/api/partner-users/${partner.id}/access`, {
      partnerAccountId: supplier,
      updatedAt: current.updatedAt,
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ code: 'UNKNOWN_PARTNER_ACCOUNT' });
    expect(await hatsOf(partner.id)).toEqual([{ hat: 'partner', partner_account_id: accountB }]);
    const staffPerson = await api.addPerson(['support']);
    const staffMove = await api.call(
      boss.cookie,
      'PUT',
      `/api/partner-users/${staffPerson.id}/access`,
      { partnerAccountId: accountB, updatedAt: current.updatedAt },
    );
    expect(staffMove.status).toBe(404);
  });

  it('edits details, refuses a partner account in the edit body, and runs the session actions', async () => {
    const partner = await signedInPartner();

    const edited = await api.call(boss.cookie, 'PATCH', `/api/partner-users/${partner.id}`, {
      name: 'Renamed Partner',
      phone: '+20 100 000 0001',
    });
    expect(edited.status).toBe(200);
    expect(PartnerUserDetail.parse(edited.body)).toMatchObject({
      name: 'Renamed Partner',
      phone: '+20 100 000 0001',
      partnerAccountId: accountA,
    });
    const smuggled = await api.call(boss.cookie, 'PATCH', `/api/partner-users/${partner.id}`, {
      partnerAccountId: accountB,
    });
    expect(smuggled.status).toBe(422);

    const invite = await api.call(
      boss.cookie,
      'POST',
      `/api/partner-users/${partner.id}/resend-invite`,
    );
    expect(invite.status).toBe(409);
    expect(invite.body).toMatchObject({ code: 'NOT_INVITED' });

    const twoFactor = await api.call(
      boss.cookie,
      'POST',
      `/api/partner-users/${partner.id}/reset-two-factor`,
    );
    expect(twoFactor.status).toBe(200);
    expect(await sessionsOf(partner.id)).toBe(0);

    await api.signIn(partner.email);
    const revoked = await api.call(
      boss.cookie,
      'POST',
      `/api/partner-users/${partner.id}/revoke-sessions`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ count: 1 });
    expect(await sessionsOf(partner.id)).toBe(0);
    expect(events.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'PartnerUserUpdated',
        'PartnerUserTwoFactorReset',
        'PartnerUserSessionsRevoked',
      ]),
    );
  });
});
