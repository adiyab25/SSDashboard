import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  DOCUMENT_PREFIX_DEFAULTS,
  PutSettingAnswer,
  SettingsListResponse,
  type SettingEntryView,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PLATFORM_CHANGED_CHANNEL } from '../src/platform/settings/platform-changes-listener.js';
import { RECONCILE_MODULES_QUEUE } from '../src/platform/settings/reconcile-modules.queue.js';
import { settingRecordId } from '../src/platform/settings/setting-record-id.js';
import { startInProcessApi, type InProcessApi, type PlantedPerson } from './in-process-api.js';
import { grantLicense, testVendorKey, trustTestKey } from './license-support.js';

// Spec 0009 milestone 1 (AC-2, AC-3, AC-26): one setting through the read and write path. A key
// with no row reads as its default; a corrupt row reads as the default, flagged and logged once
// without its value; a write records the row, the `setting.changed` audit entry, the
// notification, and the reconcile job together; a write of the same value writes nothing; a
// stale write is 409; a rolled back write leaves no row, entry, notification, or job; values
// that break a rule across settings, a shared prefix, deep nesting, or a long reason are 422; a
// corrupt lock date or corrupt document prefixes stop stock postings (409 LOCK_DATE_UNREADABLE,
// DOCUMENT_PREFIXES_UNREADABLE); a stored client language may stay; and a person without
// `settings.manage` gets 403.
describe('settings read and write (spec 0009)', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let manager: PlantedPerson;
  let managerCookie: string;
  let supportCookie: string;
  const heard: string[] = [];
  let release: (() => void) | undefined;

  const list = async (): Promise<SettingEntryView[]> => {
    const reply = await api.call(managerCookie, 'GET', '/api/settings');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return SettingsListResponse.parse(reply.body).entries;
  };
  const entry = async (key: string): Promise<SettingEntryView> => {
    const found = (await list()).find((item) => item.key === key);
    if (!found) throw new Error(`no entry ${key}`);
    return found;
  };
  const put = (key: string, body: unknown, cookie = managerCookie) =>
    api.call(cookie, 'PUT', `/api/settings/${key}`, body);
  const auditCount = async (key: string): Promise<number> => {
    const { rows } = await api.owner.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_entries
       WHERE action = 'setting.changed' AND record_label = $1`,
      [key],
    );
    return rows[0]?.n ?? 0;
  };
  const jobCount = async (): Promise<number> => {
    const { rows } = await api.owner.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1',
      [RECONCILE_MODULES_QUEUE],
    );
    return rows[0]?.n ?? 0;
  };
  let sentinels = 0;
  /** Waits, polling up to 5 seconds, until the test's listener has heard `payload`. */
  const hear = async (payload: string): Promise<void> => {
    const started = Date.now();
    while (!heard.includes(payload)) {
      if (Date.now() - started > 5_000) throw new Error(`never heard ${payload}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  /**
   * Everything heard before a sentinel NOTIFY sent now (review R9): notifications are delivered
   * in commit order, so a change that had notified would arrive before the sentinel.
   */
  const heardBeforeNow = async (): Promise<string[]> => {
    sentinels += 1;
    const sentinel = `sentinel-${sentinels}`;
    await api.owner.pool.query('SELECT pg_notify($1, $2)', [PLATFORM_CHANGED_CHANNEL, sentinel]);
    await hear(sentinel);
    return heard.slice(0, heard.indexOf(sentinel)).filter((item) => !item.startsWith('sentinel-'));
  };

  const key = testVendorKey();

  beforeAll(async () => {
    api = await startInProcessApi((builder) => trustTestKey(builder, key));
    manager = await api.addPerson(['manager']);
    managerCookie = await api.signIn(manager.email);
    const support = await api.addPerson(['support']);
    supportCookie = await api.signIn(support.email);
    // A connection of the test's own hears every committed change.
    const listener = await api.owner.pool.connect();
    listener.on('notification', (message) => heard.push(message.payload ?? ''));
    await listener.query(`LISTEN ${PLATFORM_CHANGED_CHANNEL}`);
    release = () => listener.release(true);
  });

  afterAll(async () => {
    release?.();
    await api?.close();
  });

  // Security finding S6 (decided in spec 0009 milestone 2): on an install with no license only
  // core settings change. An Operations setting answers 409 NOT_LICENSED and writes nothing; a
  // core one is written. The case then records an Operations license, which the cases after it
  // need for the Operations keys.
  it('refuses an Operations setting until the Operations plan is licensed, and takes a core one (S6)', async () => {
    expect((await entry('operations_wind_down_days')).licensed).toBe(false);

    const operations = await put('operations_wind_down_days', {
      value: 90,
      reason: 'Longer wind down',
      expectedUpdatedAt: null,
    });
    expect(operations.status, JSON.stringify(operations.body)).toBe(409);
    expect(operations.body).toMatchObject({ code: 'NOT_LICENSED' });
    const { rows } = await api.owner.pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM settings WHERE key = 'operations_wind_down_days')
             + (SELECT count(*) FROM audit_entries WHERE action = 'setting.changed') AS n`,
    );
    expect(Number(rows[0]?.n)).toBe(0);

    const core = await put('operating_day_cutoff_hour', {
      value: 4,
      reason: 'Night shift ends at four',
      expectedUpdatedAt: (await entry('operating_day_cutoff_hour')).updatedAt,
    });
    expect(core.status, JSON.stringify(core.body)).toBe(200);
    expect(PutSettingAnswer.parse(core.body)).toMatchObject({ changed: true, entry: { value: 4 } });

    await grantLicense(api, key, manager);
    expect((await entry('operations_wind_down_days')).licensed).toBe(true);
  });

  it('reads every registry entry, a key with no row as its default (AC-2, AC-26)', async () => {
    const entries = await list();

    expect(entries.map((item) => item.key)).toContain('operations_wind_down_days');
    const days = entries.find((item) => item.key === 'operations_wind_down_days');
    expect(days).toMatchObject({
      value: 60,
      default: 60,
      isDefault: true,
      invalid: false,
      updatedAt: null,
      updatedBy: null,
      canChange: true,
      bundle: 'operations',
      group: 'policies',
      reason: 'required',
      // Licensed by the Operations license recorded in beforeAll.
      licensed: true,
    });
    const timezone = entries.find((item) => item.key === 'timezone');
    expect(timezone).toMatchObject({
      value: 'Africa/Cairo',
      confirm: 'typed',
      warning: 'settings.warnings.timezone',
      licensed: true,
    });
    expect(timezone?.updatedAt).not.toBeNull();
    expect(entries.find((item) => item.key === 'currency')?.canChange).toBe(false);
  });

  it('reads a corrupt row as its default, flagged, with one log line that names no value (AC-2)', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error');
    try {
      await api.owner.pool.query(
        `UPDATE settings SET value = '"not-a-date-7f3a"' WHERE key = 'inventory_lock_date'`,
      );

      const lock = await entry('inventory_lock_date');
      await entry('inventory_lock_date');

      expect(lock).toMatchObject({ value: null, invalid: true });
      const lines = errors.mock.calls.map((call) => call.map(String).join(' '));
      expect(lines.filter((line) => line.includes('inventory_lock_date'))).toHaveLength(1);
      expect(lines.some((line) => line.includes('not-a-date-7f3a'))).toBe(false);
    } finally {
      errors.mockRestore();
      await api.owner.pool.query(
        `UPDATE settings SET value = 'null' WHERE key = 'inventory_lock_date'`,
      );
    }
  });

  it('writes the row, the setting.changed entry, the notification, and the job together (AC-3)', async () => {
    heard.length = 0;

    const reply = await put('operations_wind_down_days', {
      value: 90,
      reason: 'Bosta pays the cash late this season',
      expectedUpdatedAt: null,
    });

    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const answer = PutSettingAnswer.parse(reply.body);
    expect(answer.changed).toBe(true);
    expect(answer.entry).toMatchObject({ value: 90, isDefault: false, invalid: false });
    expect(answer.entry.updatedBy?.id).toBe(manager.id);
    expect(answer.entry.updatedAt).not.toBeNull();

    const { rows } = await api.owner.pool.query<{
      actor_hat: string;
      record_id: string;
      before: unknown;
      after: unknown;
      reason: string;
    }>(
      `SELECT actor_hat, record_id, before, after, reason FROM audit_entries
       WHERE action = 'setting.changed' AND record_label = 'operations_wind_down_days'`,
    );
    expect(rows).toEqual([
      {
        actor_hat: 'manager',
        record_id: settingRecordId('operations_wind_down_days'),
        before: { value: 60 },
        after: { value: 90 },
        reason: 'Bosta pays the cash late this season',
      },
    ]);
    await hear('operations_wind_down_days');
    expect(await heardBeforeNow()).toEqual(['operations_wind_down_days']);
    expect(await jobCount()).toBe(1);
    expect(await entry('operations_wind_down_days')).toMatchObject({
      value: 90,
      updatedAt: answer.entry.updatedAt,
    });
  });

  it('writes nothing for the value already in force (AC-3)', async () => {
    const before = await entry('operations_wind_down_days');
    heard.length = 0;

    const reply = await put('operations_wind_down_days', {
      value: 90,
      reason: 'Again',
      expectedUpdatedAt: before.updatedAt,
    });

    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const answer = PutSettingAnswer.parse(reply.body);
    expect(answer.changed).toBe(false);
    expect(answer.entry.updatedAt).toBe(before.updatedAt);
    expect(await auditCount('operations_wind_down_days')).toBe(1);
    // A key without a row compared with its default: 3 is the pickup default.
    const same = await put('operations_wind_down_pickup_days', {
      value: 3,
      reason: 'Same',
      expectedUpdatedAt: null,
    });
    expect(PutSettingAnswer.parse(same.body)).toMatchObject({ changed: false });
    expect((await entry('operations_wind_down_pickup_days')).updatedAt).toBeNull();
    expect(await heardBeforeNow()).toEqual([]);
  });

  it('refuses a stale write and changes nothing (AC-3)', async () => {
    const stale = await put('operations_wind_down_days', {
      value: 120,
      reason: 'Stale screen',
      expectedUpdatedAt: '2000-01-01T00:00:00.000000Z',
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'STALE_SETTING' });

    const missedRow = await put('operations_wind_down_days', {
      value: 120,
      reason: 'Thought it was the default',
      expectedUpdatedAt: null,
    });
    expect(missedRow.status).toBe(409);
    expect((await entry('operations_wind_down_days')).value).toBe(90);
    expect(await auditCount('operations_wind_down_days')).toBe(1);
  });

  it('answers each refusal with its stable code (AC-3)', async () => {
    const invalid = await put('operations_wind_down_days', {
      value: 59,
      reason: 'Too short',
      expectedUpdatedAt: null,
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({ code: 'SETTING_INVALID' });
    expect((invalid.body as { issues: unknown[] }).issues.length).toBeGreaterThan(0);

    const noReason = await put('operations_wind_down_pickup_days', {
      value: 5,
      reason: '  ',
      expectedUpdatedAt: null,
    });
    expect(noReason.status).toBe(422);
    expect(noReason.body).toMatchObject({ code: 'REASON_REQUIRED' });

    const unknown = await put('nope', { value: 1, reason: 'x', expectedUpdatedAt: null });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'SETTING_UNKNOWN' });

    const locked = await put('currency', { value: 'USD', reason: 'x', expectedUpdatedAt: null });
    expect(locked.status).toBe(409);
    expect(locked.body).toMatchObject({ code: 'SETTING_LOCKED' });
  });

  it('leaves no row, entry, notification, or job when the write rolls back (AC-3, AC-4)', async () => {
    // A check that fails only at commit, after the row, the entry, the NOTIFY, and the job.
    await api.owner.pool.query(`
      CREATE FUNCTION test_refuse_pickup_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused at commit by the test'; END $$;
      CREATE CONSTRAINT TRIGGER test_refuse_pickup_change AFTER INSERT OR UPDATE ON settings
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.key = 'operations_wind_down_pickup_days')
        EXECUTE FUNCTION test_refuse_pickup_change();`);
    await api.owner.pool.query('DELETE FROM pgboss.job WHERE name = $1', [RECONCILE_MODULES_QUEUE]);
    heard.length = 0;
    try {
      const reply = await put('operations_wind_down_pickup_days', {
        value: 5,
        reason: 'Rolled back',
        expectedUpdatedAt: null,
      });

      expect(reply.status).toBe(500);
      expect(await heardBeforeNow()).toEqual([]);
      expect(await auditCount('operations_wind_down_pickup_days')).toBe(0);
      expect(await jobCount()).toBe(0);
      expect(await entry('operations_wind_down_pickup_days')).toMatchObject({
        value: 3,
        updatedAt: null,
      });
    } finally {
      await api.owner.pool.query(`
        DROP TRIGGER test_refuse_pickup_change ON settings;
        DROP FUNCTION test_refuse_pickup_change();`);
    }
  });

  // Review R2: the language settings agree with each other and with the shipped catalogs.
  it('refuses language settings that disagree or have no catalog (AC-3)', async () => {
    const languages = await entry('languages');
    const missingDefault = await put('default_language', {
      value: 'fr',
      expectedUpdatedAt: (await entry('default_language')).updatedAt,
    });
    expect(missingDefault.status).toBe(422);
    expect(missingDefault.body).toMatchObject({ code: 'SETTING_INVALID' });

    const noCatalog = await put('languages', {
      value: ['en', 'ar', 'fr'],
      expectedUpdatedAt: languages.updatedAt,
    });
    expect(noCatalog.status).toBe(422);
    expect(noCatalog.body).toMatchObject({ code: 'SETTING_INVALID', issues: [{ path: '2' }] });

    const dropsDefault = await put('languages', {
      value: ['ar'],
      expectedUpdatedAt: languages.updatedAt,
    });
    expect(dropsDefault.status).toBe(422);
    expect((await entry('languages')).value).toEqual(['en', 'ar']);
  });

  // Review R17: a language already in force may stay without a catalog; only new ones need one.
  it('keeps a stored client language but adds only shipped ones (AC-3)', async () => {
    await api.owner.pool.query(
      `UPDATE settings SET value = '["en", "ar", "fr"]' WHERE key = 'languages'`,
    );
    try {
      const languages = await entry('languages');
      const adds = await put('languages', {
        value: ['en', 'ar', 'fr', 'de'],
        expectedUpdatedAt: languages.updatedAt,
      });
      expect(adds.status).toBe(422);
      expect(adds.body).toMatchObject({ code: 'SETTING_INVALID', issues: [{ path: '3' }] });

      const keeps = await put('languages', {
        value: ['fr', 'en'],
        expectedUpdatedAt: languages.updatedAt,
      });
      expect(keeps.status, JSON.stringify(keeps.body)).toBe(200);
      const kept = PutSettingAnswer.parse(keeps.body);
      expect(kept.entry.value).toEqual(['fr', 'en']);

      const back = await put('languages', {
        value: ['en', 'ar'],
        expectedUpdatedAt: kept.entry.updatedAt,
      });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
    } finally {
      await api.owner.pool.query(
        `UPDATE settings SET value = '["en", "ar"]' WHERE key = 'languages'`,
      );
    }
  });

  // Review R3, security review S2, S3, S4.
  it('refuses shared document prefixes, deep values, and long reasons (AC-3)', async () => {
    const prefixes = await entry('document_prefixes');
    const shared = await put('document_prefixes', {
      value: { ...(prefixes.value as Record<string, string>), SO: 'PO' },
      expectedUpdatedAt: prefixes.updatedAt,
    });
    expect(shared.status).toBe(422);
    expect(shared.body).toMatchObject({ code: 'SETTING_INVALID', issues: [{ path: 'SO' }] });

    // Sent as text: JSON.stringify of the test client would overflow on it first.
    const deep = `{"value":${'['.repeat(5_000)}1${']'.repeat(5_000)},"expectedUpdatedAt":null}`;
    const tooDeepReply = await fetch(`${api.base}/api/settings/document_prefixes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: api.base, cookie: managerCookie },
      body: deep,
    });
    const tooDeep = { status: tooDeepReply.status, body: (await tooDeepReply.json()) as unknown };
    expect(tooDeep.status).toBe(422);
    expect(tooDeep.body).toMatchObject({ code: 'SETTING_INVALID' });

    const longReason = await put('operations_wind_down_pickup_days', {
      value: 4,
      reason: 'x'.repeat(501),
      expectedUpdatedAt: null,
    });
    expect(longReason.status).toBe(422);
    expect(longReason.body).toMatchObject({ code: 'REASON_TOO_LONG' });
  });

  // Security review S1: a corrupt lock date stops stock postings instead of unlocking them.
  it('refuses a stock posting while the lock date or the prefixes row is corrupt (AC-2)', async () => {
    const boss = await api.addPerson(['manager'], { costView: true });
    const cookie = await api.signIn(boss.email);
    const location = await api.call(cookie, 'POST', '/api/locations', {
      code: 'settings-wh',
      name: { en: 'Settings warehouse' },
      kind: 'warehouse',
    });
    expect(location.status, JSON.stringify(location.body)).toBe(201);
    const product = await api.call(cookie, 'POST', '/api/products', {
      name: { en: 'Settings tee' },
      variants: [{ sku: 'SETTINGS-TEE', price: '9.99' }],
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const receipt = () =>
      api.call(
        cookie,
        'POST',
        '/api/stock-receipts',
        {
          locationId: (location.body as { id: string }).id,
          lines: [{ skuId: (product.body as { id: string }).id, quantity: 1, unitCost: '7' }],
        },
        { 'idempotency-key': randomUUID() },
      );
    await api.owner.pool.query(
      `UPDATE settings SET value = '"31/10/2026"' WHERE key = 'inventory_lock_date'`,
    );
    try {
      const refused = await receipt();
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body).toMatchObject({ code: 'LOCK_DATE_UNREADABLE' });
      // The staff read still shows the row, flagged, so a manager can fix it.
      expect(await entry('inventory_lock_date')).toMatchObject({ value: null, invalid: true });
    } finally {
      await api.owner.pool.query(
        `UPDATE settings SET value = 'null' WHERE key = 'inventory_lock_date'`,
      );
    }
    expect((await receipt()).status).toBe(201);

    // Review R18: corrupt document prefixes stop numbering instead of reusing the defaults.
    await api.owner.pool.query(
      `UPDATE settings SET value = jsonb_set(value, '{SO}', '"PO"') WHERE key = 'document_prefixes'`,
    );
    try {
      const refused = await receipt();
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body).toMatchObject({ code: 'DOCUMENT_PREFIXES_UNREADABLE' });
      expect(await entry('document_prefixes')).toMatchObject({ invalid: true });
    } finally {
      await api.owner.pool.query(
        `UPDATE settings SET value = jsonb_set(value, '{SO}', '"SO"') WHERE key = 'document_prefixes'`,
      );
    }
    expect((await receipt()).status).toBe(201);
  });

  // Security review finding 3: a corrupt row with a phone shaped key must not block its repair.
  it('repairs a corrupt prefixes row holding a phone shaped key, auditing a placeholder before (AC-3)', async () => {
    await api.owner.pool.query(
      `UPDATE settings SET value = '{"01012345678": "X"}'::jsonb WHERE key = 'document_prefixes'`,
    );
    const stored = await entry('document_prefixes');
    expect(stored).toMatchObject({ invalid: true });
    const before = await auditCount('document_prefixes');

    const reply = await put('document_prefixes', {
      value: DOCUMENT_PREFIX_DEFAULTS,
      expectedUpdatedAt: stored.updatedAt,
    });

    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(await auditCount('document_prefixes')).toBe(before + 1);
    const { rows } = await api.owner.pool.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM audit_entries
       WHERE action = 'setting.changed' AND record_label = 'document_prefixes'
       ORDER BY recorded_at DESC LIMIT 1`,
    );
    expect(rows[0]?.before).toEqual({ invalid: true });
    expect(rows[0]?.after).toEqual({ value: DOCUMENT_PREFIX_DEFAULTS });
    expect(await entry('document_prefixes')).toMatchObject({ invalid: false });
    // Numbering works again: a stock receipt, which takes a document number, posts.
    const boss = await api.addPerson(['manager'], { costView: true });
    const cookie = await api.signIn(boss.email);
    const location = await api.call(cookie, 'POST', '/api/locations', {
      code: 'repair-wh',
      name: { en: 'Repair warehouse' },
      kind: 'warehouse',
    });
    expect(location.status, JSON.stringify(location.body)).toBe(201);
    const product = await api.call(cookie, 'POST', '/api/products', {
      name: { en: 'Repair tee' },
      variants: [{ sku: 'REPAIR-TEE', price: '9.99' }],
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const receipt = await api.call(
      cookie,
      'POST',
      '/api/stock-receipts',
      {
        locationId: (location.body as { id: string }).id,
        lines: [{ skuId: (product.body as { id: string }).id, quantity: 1, unitCost: '7' }],
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
  });

  it('answers 403 to a person without settings.manage (AC-3, AC-26)', async () => {
    const read = await api.call(supportCookie, 'GET', '/api/settings');
    expect(read.status).toBe(403);
    expect(read.body).toMatchObject({ code: 'FORBIDDEN' });

    const write = await put(
      'operations_wind_down_days',
      { value: 100, reason: 'Not mine to change', expectedUpdatedAt: null },
      supportCookie,
    );
    expect(write.status).toBe(403);
    expect((await entry('operations_wind_down_days')).value).toBe(90);
  });
});
