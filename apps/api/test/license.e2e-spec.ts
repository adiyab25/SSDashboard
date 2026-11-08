import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  LicenseSummary,
  PostLicenseAnswer,
  SettingsListResponse,
  type LicensePayload,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/database/database.module.js';
import { LICENSE_CHANGED, type LicenseChanged } from '../src/platform/license/license-events.js';
import { signLicense } from '../src/platform/license/license-signing.js';
import { sha256Hex } from '../src/platform/license/license-verifier.js';
import { LICENSE_CHECK_LOCK, LicenseService } from '../src/platform/license/license.service.js';
import { PlatformClock } from '../src/platform/license/platform-clock.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { installOf, testVendorKey, trustTestKey } from './license-support.js';
import { devDatabaseUrl } from './support.js';

// Load the root .env into this process's env before any api saves it: the file starts two apps
// in turn, and the first one's close restores the env it found.
devDatabaseUrl();

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Spec 0009 milestone 2, task 13 (AC-14, AC-16, AC-17, AC-20, AC-26) and its review fixes: the
// license through the real api on a scratch database, with a fixed clock and a vendor key made
// here (`test-1`, not dev only) beside the committed dev key. The api runs with
// NODE_ENV=production, as installs do, so the dev key is refused. Cases: a valid file, an already
// recorded one, one flipped byte, an unknown key, the dev key in production, another install's
// license, a file over 16 KB, the file deleted after a valid check, an older upload (`changed:
// false`), the same license with other whitespace (`already_recorded`), a pilot Warehouse license
// then a perpetual one, the latest check by insert order, a forged license row that grants
// nothing, two concurrent checks emitting one `LicenseChanged`, a server clock set ahead then
// back, and a wind down end forgotten at the next lapse.
describe('the signed license (spec 0009 milestone 2)', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let service: LicenseService;
  let managerCookie: string;
  let supportCookie: string;
  let install: { tenantId: string; clientCode: string };
  const vendor = testVendorKey();
  const devKey = readFileSync(
    new URL('../src/platform/license/dev-license-key.pem', import.meta.url),
    'utf8',
  );
  const dir = mkdtempSync(join(tmpdir(), 'ssd-license-'));
  const file = join(dir, 'license.json');
  const changes: LicenseChanged[] = [];
  const clock = { at: new Date('2026-11-07T10:00:00.000Z') };

  const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
    format: 1,
    licenseId: 'SSD-2026-0001',
    clientCode: install.clientCode,
    tenantId: install.tenantId,
    bundles: ['operations'],
    operationsExpiresOn: '2027-11-07',
    issuedOn: '2026-11-07',
    ...over,
  });
  const vendorSigned = (over: Partial<LicensePayload> = {}): string =>
    signLicense(payload(over), 'test-1', vendor.privateKey);
  const summary = async (): Promise<LicenseSummary> => {
    const reply = await api.call(managerCookie, 'GET', '/api/platform/license');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return LicenseSummary.parse(reply.body);
  };
  const phases = async () =>
    Object.fromEntries((await summary()).bundles.map((bundle) => [bundle.bundle, bundle.phase]));
  const upload = (envelope: string, cookie = managerCookie) =>
    api.call(cookie, 'POST', '/api/platform/license', { envelope });
  const count = async (table: 'licenses' | 'license_checks'): Promise<number> => {
    const { rows } = await api.owner.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table}`,
    );
    return rows[0]?.n ?? 0;
  };
  const latestCheck = async () => {
    const { rows } = await api.owner.pool.query<{
      id: string;
      trigger: string;
      outcome: string;
      file_sha256: string | null;
      operations_phase: string;
      warehouse_phase: string;
      wind_down_ended_at: Date | null;
      clock_behind: boolean;
    }>(
      `SELECT id, trigger, outcome, file_sha256, operations_phase, warehouse_phase,
              wind_down_ended_at, clock_behind
       FROM license_checks ORDER BY seq DESC LIMIT 1`,
    );
    return rows[0];
  };
  const licensedOperations = async (): Promise<boolean> => {
    const reply = await api.call(managerCookie, 'GET', '/api/settings');
    const entries = SettingsListResponse.parse(reply.body).entries;
    return entries.find((entry) => entry.key === 'operations_wind_down_days')?.licensed ?? false;
  };

  beforeAll(async () => {
    api = await startInProcessApi(
      (builder) => {
        trustTestKey(builder, vendor);
        builder.overrideProvider(PlatformClock).useValue({ now: () => Promise.resolve(clock.at) });
      },
      { licenseFile: file },
    );
    service = api.app.get(LicenseService);
    api.app.get(EventEmitter2).on(LICENSE_CHANGED, (event: LicenseChanged) => changes.push(event));
    install = await installOf(api);
    const manager = await api.addPerson(['manager']);
    managerCookie = await api.signIn(manager.email);
    const support = await api.addPerson(['support']);
    supportCookie = await api.signIn(support.email);
  });

  afterAll(async () => {
    await api?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with core only: the api start check found no file (AC-16)', async () => {
    const before = await summary();

    expect(before.bundles).toEqual([
      expect.objectContaining({ bundle: 'warehouse', phase: 'not_licensed', expiresOn: null }),
      expect.objectContaining({ bundle: 'operations', phase: 'not_licensed', expiresOn: null }),
    ]);
    expect(before.lastCheck).toMatchObject({ trigger: 'api_start', outcome: 'file_missing' });
    expect(before.licenses).toEqual([]);
    expect(await licensedOperations()).toBe(false);
  });

  it('records a valid file once, audits it, and emits one LicenseChanged (AC-14, AC-20)', async () => {
    const text = vendorSigned();
    writeFileSync(file, text);

    const result = await service.checkFile('daily');

    expect(result).toMatchObject({
      outcome: 'valid',
      operations: 'active',
      warehouse: 'not_licensed',
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      operations: { from: 'not_licensed', to: 'active' },
      warehouse: { from: 'not_licensed', to: 'not_licensed' },
    });
    const signedPayload = (JSON.parse(text) as { payload: string }).payload;
    const { rows } = await api.owner.pool.query(
      `SELECT license_id, key_id, sha256, payload_sha256, source, recorded_by, envelope FROM licenses`,
    );
    expect(rows).toEqual([
      {
        license_id: 'SSD-2026-0001',
        key_id: 'test-1',
        sha256: sha256Hex(Buffer.from(text)),
        payload_sha256: sha256Hex(Buffer.from(signedPayload, 'base64url')),
        source: 'file',
        recorded_by: null,
        envelope: text,
      },
    ]);
    const audit = await api.owner.pool.query(
      `SELECT actor_kind, actor_ref, record_type, record_label, after FROM audit_entries
       WHERE action = 'license.added'`,
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: 'system_job',
        actor_ref: 'platform.license_check',
        record_type: 'license',
        record_label: 'SSD-2026-0001',
        after: {
          licenseId: 'SSD-2026-0001',
          keyId: 'test-1',
          bundles: ['operations'],
          operationsExpiresOn: '2027-11-07',
          warehouseExpiresOn: null,
          issuedOn: '2026-11-07',
          source: 'file',
        },
      },
    ]);
    const after = await summary();
    expect(after.bundles[1]).toMatchObject({
      bundle: 'operations',
      phase: 'active',
      perpetual: false,
      expiresOn: '2027-11-07',
      daysLeft: 365,
    });
    // Never a signature or the envelope in the answer.
    expect(JSON.stringify(after)).not.toContain(
      (JSON.parse(text) as { signature: string }).signature,
    );
    expect(after.licenses).toEqual([
      expect.objectContaining({
        licenseId: 'SSD-2026-0001',
        source: 'file',
        bundles: ['operations'],
      }),
    ]);
    expect(await licensedOperations()).toBe(true);

    // The same file again is already recorded: no row, no entry, no event.
    expect(await service.checkFile('daily')).toMatchObject({
      outcome: 'already_recorded',
      phaseChanged: false,
    });
    expect(await count('licenses')).toBe(1);
    expect(changes).toHaveLength(1);
  });

  it('refuses one flipped byte as bad_signature and changes nothing else (AC-16)', async () => {
    const envelope = JSON.parse(vendorSigned({ licenseId: 'SSD-2026-0002' })) as {
      payload: string;
    };
    const bytes = Buffer.from(envelope.payload, 'base64url');
    bytes[20] = (bytes[20] ?? 0) ^ 0x01;
    const text = JSON.stringify({ ...envelope, payload: bytes.toString('base64url') });
    writeFileSync(file, text);

    expect(await service.checkFile('daily')).toMatchObject({
      outcome: 'bad_signature',
      operations: 'active',
      phaseChanged: false,
    });
    expect(await latestCheck()).toMatchObject({
      outcome: 'bad_signature',
      file_sha256: sha256Hex(Buffer.from(text)),
    });
    expect(await count('licenses')).toBe(1);
    expect((await summary()).lastCheck).toMatchObject({ outcome: 'bad_signature' });
  });

  it('refuses an unknown key, the dev key in production, and another install (AC-14, AC-20)', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const checks = await count('license_checks');

    const unknown = await upload(signLicense(payload(), 'vendor-9', privateKey));
    const dev = await upload(signLicense(payload({ licenseId: 'DEV-1' }), 'dev-1', devKey));
    const other = await upload(vendorSigned({ clientCode: 'someone_else' }));
    const tenant = await upload(vendorSigned({ tenantId: '01937f3a-0000-7000-8000-0000000000bb' }));

    expect([unknown, dev, other, tenant].map((reply) => [reply.status, reply.body])).toEqual([
      [422, expect.objectContaining({ code: 'LICENSE_INVALID', outcome: 'unknown_key' })],
      [422, expect.objectContaining({ code: 'LICENSE_INVALID', outcome: 'dev_key_in_production' })],
      [422, expect.objectContaining({ code: 'LICENSE_INVALID', outcome: 'wrong_install' })],
      [422, expect.objectContaining({ code: 'LICENSE_INVALID', outcome: 'wrong_install' })],
    ]);
    // Each refused upload is one check row; nothing is recorded and no phase moves.
    expect(await count('license_checks')).toBe(checks + 4);
    expect(await count('licenses')).toBe(1);
    expect(await phases()).toEqual({ warehouse: 'not_licensed', operations: 'active' });
    // The dev key in a file is refused the same way.
    writeFileSync(file, signLicense(payload({ licenseId: 'DEV-2' }), 'dev-1', devKey));
    expect(await service.checkFile('daily')).toMatchObject({ outcome: 'dev_key_in_production' });
  });

  it('refuses a body that is too large or not a license, and a person without settings.manage', async () => {
    const checks = await count('license_checks');

    const tooLarge = await upload('x'.repeat(16_385));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({ code: 'LICENSE_TOO_LARGE' });
    expect(await count('license_checks')).toBe(checks);
    const notALicense = await upload('not a license');
    expect(notALicense.status).toBe(422);
    expect(notALicense.body).toMatchObject({ code: 'LICENSE_INVALID', outcome: 'bad_format' });
    expect(await upload(vendorSigned(), supportCookie)).toMatchObject({ status: 403 });
    expect(await api.call(supportCookie, 'GET', '/api/platform/license')).toMatchObject({
      status: 403,
    });
  });

  it('refuses a file over 16 KB unread, with no hash (AC-14, security M2-7)', async () => {
    writeFileSync(file, 'x'.repeat(100_000));

    expect(await service.checkFile('daily')).toMatchObject({
      outcome: 'bad_format',
      operations: 'active',
    });
    expect(await latestCheck()).toMatchObject({ outcome: 'bad_format', file_sha256: null });
  });

  it('keeps every module on when the file is deleted after a valid check, and says so (AC-16)', async () => {
    rmSync(file, { force: true });

    expect(await service.checkFile('daily')).toMatchObject({
      outcome: 'file_missing',
      operations: 'active',
    });
    const after = await summary();
    expect(after.lastCheck).toMatchObject({ trigger: 'daily', outcome: 'file_missing' });
    expect(after.bundles[1]).toMatchObject({ phase: 'active' });
    expect(after.licenses).toHaveLength(1);
    expect(await licensedOperations()).toBe(true);
  });

  it('records an older upload with changed: false, and the same license again adds nothing (AC-20, security M2-3)', async () => {
    const older = vendorSigned({ licenseId: 'SSD-2026-0000', operationsExpiresOn: '2027-05-01' });

    const reply = await upload(older);

    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const answer = PostLicenseAnswer.parse(reply.body);
    expect(answer).toMatchObject({ changed: false, resumingSteps: [] });
    expect(answer.summary.bundles[1]).toMatchObject({ expiresOn: '2027-11-07' });
    expect(answer.summary.licenses.map((license) => license.licenseId)).toContain('SSD-2026-0000');
    const entries = async () =>
      (
        await api.owner.pool.query<{ actor_kind: string; actor_hat: string; source: string }>(
          `SELECT actor_kind, actor_hat, after->>'source' AS source FROM audit_entries
           WHERE action = 'license.added' AND record_label = 'SSD-2026-0000'`,
        )
      ).rows;
    expect(await entries()).toEqual([
      { actor_kind: 'person', actor_hat: 'manager', source: 'upload' },
    ]);

    // The identical file, and the same signed payload re-saved with other whitespace: both are
    // already recorded, with no new license row and no new audit entry.
    const reworded = JSON.stringify(JSON.parse(older));
    expect(reworded).not.toBe(older);
    for (const text of [older, reworded]) {
      const again = await upload(text);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(PostLicenseAnswer.parse(again.body).changed).toBe(false);
      expect(await latestCheck()).toMatchObject({
        trigger: 'upload',
        outcome: 'already_recorded',
        file_sha256: sha256Hex(Buffer.from(text)),
      });
    }
    expect(await count('licenses')).toBe(2);
    expect(await entries()).toHaveLength(1);
  });

  it('runs a pilot Warehouse license to off, then a perpetual one supersedes it (AC-15, AC-20)', async () => {
    const pilot = await upload(
      vendorSigned({
        licenseId: 'SSD-PILOT-1',
        bundles: ['warehouse'],
        operationsExpiresOn: undefined,
        warehouseExpiresOn: '2026-11-27',
      }),
    );
    expect(pilot.status, JSON.stringify(pilot.body)).toBe(200);
    const during = PostLicenseAnswer.parse(pilot.body);
    expect(during.changed).toBe(true);
    expect(during.summary.bundles[0]).toMatchObject({
      bundle: 'warehouse',
      phase: 'expiring',
      perpetual: false,
      expiresOn: '2026-11-27',
      daysLeft: 20,
      // Local midnight in Cairo (UTC+2 in December) of expiry plus 15.
      lapsesAt: '2026-12-11T22:00:00.000000Z',
    });
    expect(during.summary.notices).toEqual([
      expect.objectContaining({
        bundle: 'warehouse',
        phase: 'expiring',
        level: 'info',
        daysLeft: 20,
      }),
    ]);
    expect(changes.at(-1)?.warehouse).toEqual({ from: 'not_licensed', to: 'expiring' });

    clock.at = new Date('2026-12-20T10:00:00.000Z');
    expect(await service.checkFile('daily')).toMatchObject({
      warehouse: 'off',
      phaseChanged: true,
    });
    expect(changes.at(-1)?.warehouse).toEqual({ from: 'expiring', to: 'off' });
    expect((await summary()).notices).toEqual([
      expect.objectContaining({ bundle: 'warehouse', phase: 'off', level: 'critical' }),
    ]);

    const perpetual = await upload(
      vendorSigned({
        licenseId: 'SSD-WH-1',
        bundles: ['warehouse'],
        operationsExpiresOn: undefined,
      }),
    );
    const answer = PostLicenseAnswer.parse(perpetual.body);
    expect(answer.changed).toBe(true);
    expect(answer.summary.bundles[0]).toMatchObject({
      phase: 'active',
      perpetual: true,
      expiresOn: null,
      daysLeft: null,
    });
    expect(answer.summary.notices).toEqual([]);
    expect(changes.at(-1)?.warehouse).toEqual({ from: 'off', to: 'active' });
  });

  it('takes the latest check by insert order, never by its clock based id (review M2 code 1)', async () => {
    // A check row with an id from long ago (as after a clock set back) and other phases, planted
    // as the owner around the id stamp: inserted last, it is the latest.
    const plantedId = '01000000-0000-7000-8000-000000000001';
    await api.owner.pool.query(
      'ALTER TABLE license_checks DISABLE TRIGGER license_checks_1_stamp_id',
    );
    try {
      await api.owner.pool.query(
        `INSERT INTO license_checks (id, checked_at, trigger, outcome, operations_phase, warehouse_phase)
         VALUES ($1, $2, 'daily', 'file_unreadable', 'off', 'off')`,
        [plantedId, clock.at.toISOString()],
      );
    } finally {
      await api.owner.pool.query(
        'ALTER TABLE license_checks ENABLE TRIGGER license_checks_1_stamp_id',
      );
    }
    expect((await latestCheck())?.id).toBe(plantedId);
    expect((await summary()).lastCheck).toMatchObject({ outcome: 'file_unreadable' });
    // The live phases never read a check's phases: both bundles are still licensed.
    expect(await phases()).toEqual({ warehouse: 'active', operations: 'active' });

    const before = changes.length;
    const next = await service.checkFile('daily');

    // The next check compares with the planted row, so it records the move back once.
    expect(next).toMatchObject({ operations: 'active', warehouse: 'active', phaseChanged: true });
    expect(changes.slice(before)).toEqual([
      expect.objectContaining({
        operations: { from: 'off', to: 'active' },
        warehouse: { from: 'off', to: 'active' },
      }),
    ]);
    expect((await latestCheck())?.id).toBe(next.checkId);
    expect(await service.checkFile('daily')).toMatchObject({ phaseChanged: false });
  });

  it('grants nothing for a license row that does not verify (security M2-2)', async () => {
    const recorded = await api.owner.pool.query<{ envelope: string }>(
      `SELECT envelope FROM licenses WHERE license_id = 'SSD-2026-0001'`,
    );
    const envelope = recorded.rows[0]?.envelope as string;
    // A real envelope with terms that grant more than it signs, and a row with no valid envelope.
    for (const [licenseId, text, expiry] of [
      ['FORGED-1', envelope, '2099-12-31'],
      ['FORGED-2', '{"keyId":"test-1","payload":"e30","signature":"AA"}', '2099-12-31'],
    ] as const) {
      await api.owner.pool.query(
        `INSERT INTO licenses (license_id, key_id, envelope, sha256, payload_sha256, client_code,
                               bundles, operations_expires_on, issued_on, source)
         VALUES ($1, 'test-1', $2, encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
                 encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $3,
                 ARRAY['operations'], $4, '2026-11-07', 'upload')`,
        [licenseId, text, install.clientCode, expiry],
      );
    }

    const after = await summary();
    expect(after.bundles[1]).toMatchObject({ expiresOn: '2027-11-07' });
    expect(after.licenses.map((license) => license.licenseId)).not.toContain('FORGED-1');
    expect(after.licenses.map((license) => license.licenseId)).not.toContain('FORGED-2');
    expect(await service.checkFile('daily')).toMatchObject({
      operations: 'active',
      phaseChanged: false,
      entitlementChanged: false,
    });
  });

  it('emits one LicenseChanged when two checks run at once (AC-14)', async () => {
    // 18 days before the Operations expiry: the phase moves to expiring (the forged rows of the
    // case before would have kept it active).
    clock.at = new Date('2027-10-20T10:00:00.000Z');
    const before = changes.length;
    // Hold the check lock from the owner, so both checks are waiting on it before either runs.
    const holder = await api.owner.pool.connect();
    let results: Awaited<ReturnType<LicenseService['checkFile']>>[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LICENSE_CHECK_LOCK]);
      const running = Promise.all([service.checkFile('daily'), service.checkFile('worker_start')]);
      for (let tries = 0; ; tries += 1) {
        const { rows } = await api.owner.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        );
        if ((rows[0]?.n ?? 0) >= 2) break;
        if (tries > 200) throw new Error('the two checks never waited on the lock');
        await pause(25);
      }
      await holder.query('COMMIT');
      results = await running;
    } finally {
      holder.release();
    }

    expect(results.map((result) => result.operations)).toEqual(['expiring', 'expiring']);
    expect(results.filter((result) => result.phaseChanged)).toHaveLength(1);
    expect(changes.slice(before)).toEqual([
      expect.objectContaining({ operations: { from: 'active', to: 'expiring' } }),
    ]);
    expect((await summary()).notices).toEqual([
      expect.objectContaining({ bundle: 'operations', phase: 'expiring', daysLeft: 18 }),
    ]);
  });

  it('records a server clock set ahead then back, never acting on it (owner ruling 2)', async () => {
    // Set ahead past the whole wind down (lapse 2027-11-22, 60 days): Operations is recorded off
    // and its end is stamped in 2028.
    clock.at = new Date('2028-03-01T10:00:00.000Z');
    expect(await service.checkFile('daily')).toMatchObject({ operations: 'off' });
    expect((await latestCheck())?.wind_down_ended_at).not.toBeNull();
    expect(await licensedOperations()).toBe(false);

    // Back on the right day: the check says the clock is behind, and the phase follows the clock
    // as it is, never the end stamped while it was ahead, so Operations is not off for good.
    clock.at = new Date('2027-10-21T10:00:00.000Z');
    expect(await service.checkFile('daily')).toMatchObject({
      operations: 'expiring',
      phaseChanged: true,
    });
    expect(await latestCheck()).toMatchObject({ clock_behind: true, operations_phase: 'expiring' });
    const back = await summary();
    expect(back.lastCheck).toMatchObject({ clockBehind: true });
    expect(back.bundles[1]).toMatchObject({ phase: 'expiring', daysLeft: 17 });
    expect(await licensedOperations()).toBe(true);
    expect(await service.windDown()).toBeNull();
  });

  it('forgets the end of an earlier wind down at the next lapse (review M2 code 5)', async () => {
    // The first lapse runs its full wind down and ends.
    clock.at = new Date('2027-12-01T10:00:00.000Z');
    expect(await service.windDown()).toMatchObject({
      phase: 'wind_down',
      lapsesOn: '2027-11-22',
      windDownEndsOn: '2028-01-21',
      endedAt: null,
    });
    clock.at = new Date('2028-01-25T10:00:00.000Z');
    expect(await service.checkFile('daily')).toMatchObject({ operations: 'off' });
    expect((await service.windDown())?.endedAt).not.toBeNull();

    // A renewal, then its own lapse: the earlier end belongs to the earlier lapse.
    const renewal = await upload(
      vendorSigned({ licenseId: 'SSD-2028-0001', operationsExpiresOn: '2028-11-07' }),
    );
    expect(PostLicenseAnswer.parse(renewal.body).summary.bundles[1]).toMatchObject({
      phase: 'active',
    });
    clock.at = new Date('2028-12-01T10:00:00.000Z');
    expect(await service.windDown()).toMatchObject({
      phase: 'wind_down',
      lapsesOn: '2028-11-22',
      endedAt: null,
    });
    expect(await phases()).toMatchObject({ operations: 'wind_down' });
  });

  it('records a genuine license despite a planted row with its payload hash (security re-review R2)', async () => {
    // Operations is in its second wind down here (2028-12-01). The renewal is genuine; a row
    // planted as the owner carries its payload hash but no envelope that verifies.
    const renewal = vendorSigned({ licenseId: 'SSD-2029-0001', operationsExpiresOn: '2029-11-07' });
    const payloadHash = sha256Hex(
      Buffer.from((JSON.parse(renewal) as { payload: string }).payload, 'base64url'),
    );
    await api.owner.pool.query(
      `INSERT INTO licenses (license_id, key_id, envelope, sha256, payload_sha256, client_code,
                             bundles, operations_expires_on, issued_on, source)
       VALUES ('SSD-2029-0001', 'test-1', '{}', encode(sha256('planted'::bytea), 'hex'), $1, $2,
               ARRAY['operations'], '2029-11-07', '2026-11-07', 'upload')`,
      [payloadHash, install.clientCode],
    );
    // The planted row grants nothing.
    expect(await phases()).toMatchObject({ operations: 'wind_down' });

    const reply = await upload(renewal);

    // Not already_recorded: the renewal itself is recorded, audited, and counted.
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const answer = PostLicenseAnswer.parse(reply.body);
    expect(answer.changed).toBe(true);
    expect(answer.summary.bundles[1]).toMatchObject({
      phase: 'active',
      expiresOn: '2029-11-07',
    });
    expect(await latestCheck()).toMatchObject({ trigger: 'upload', outcome: 'valid' });
    const rows = await api.owner.pool.query<{ envelope: string }>(
      'SELECT envelope FROM licenses WHERE payload_sha256 = $1 ORDER BY recorded_at',
      [payloadHash],
    );
    expect(rows.rows.map((row) => row.envelope)).toEqual(['{}', renewal]);
    const audit = await api.owner.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_entries
       WHERE action = 'license.added' AND record_label = 'SSD-2029-0001'`,
    );
    expect(audit.rows[0]?.n).toBe(1);
    // The same renewal again is already recorded: the trusted copy, not the planted row.
    const again = await upload(renewal);
    expect(PostLicenseAnswer.parse(again.body).changed).toBe(false);
    expect(await latestCheck()).toMatchObject({ outcome: 'already_recorded' });
  });
});

// Spec 0009 Follow-up (security third check m2, S1): license dates are read with
// `to_char(…, 'YYYY-MM-DD')`, so a connection whose DateStyle is not ISO still sees every term
// equal to its signed payload; with `::text` the license would grant nothing there.
describe('license dates under a non ISO DateStyle (spec 0009, S1)', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  const vendor = testVendorKey();

  beforeAll(async () => {
    api = await startInProcessApi((builder) => trustTestKey(builder, vendor), {
      connectionOptions: '-c DateStyle=German',
    });
  });

  afterAll(async () => {
    await api?.close();
  });

  it('verifies, records, and counts a license whose dates the session prints the German way', async () => {
    const pool = api.app.get<DatabaseConnection>(DATABASE).pool;
    const style = await pool.query<{ DateStyle: string }>('SHOW DateStyle');
    expect(style.rows[0]?.DateStyle).toBe('German, DMY');
    const printed = await pool.query<{ day: string }>(`SELECT '2099-11-07'::date::text AS day`);
    expect(printed.rows[0]?.day).toBe('07.11.2099');

    const install = await installOf(api);
    const manager = await api.addPerson(['manager']);
    const service = api.app.get(LicenseService);
    const text = signLicense(
      {
        format: 1,
        licenseId: 'SSD-DATESTYLE-1',
        clientCode: install.clientCode,
        tenantId: install.tenantId,
        bundles: ['operations', 'warehouse'],
        operationsExpiresOn: '2099-11-07',
        warehouseExpiresOn: '2098-01-31',
        issuedOn: '2026-11-07',
      },
      'test-1',
      vendor.privateKey,
    );

    await expect(service.upload(text, { userId: manager.id, hat: 'manager' })).resolves.toEqual({
      changed: true,
    });
    // Forget the trust this process gave the row it wrote, so the stored row is verified again.
    (service as unknown as { rowTrust: Map<string, boolean> }).rowTrust.clear();

    const licensed = await service.licensedBundles();
    expect([...licensed].sort()).toEqual(['core', 'operations', 'warehouse']);
    const summary = await service.summary();
    expect(summary.licenses).toEqual([
      expect.objectContaining({
        licenseId: 'SSD-DATESTYLE-1',
        operationsExpiresOn: '2099-11-07',
        warehouseExpiresOn: '2098-01-31',
        issuedOn: '2026-11-07',
      }),
    ]);
  });
});
