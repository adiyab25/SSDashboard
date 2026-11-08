import { Logger } from '@nestjs/common';
import type { DatabaseConnection } from '@ssdashboard/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Executor } from '../../database/sql.js';
import { SETTINGS_CACHE_LIFETIME_MS, SettingsCache } from './settings-cache.js';
import { SettingError } from './settings.errors.js';
import { canonicalJson, localDate, SettingsService } from './settings.service.js';

interface Row {
  key: string;
  value: unknown;
  updated_at?: string;
  updated_by?: string | null;
}

/** A stand in for the database: every `execute` resolves to these rows, and is counted. */
function executorWith(rows: Row[]): Executor & { calls: number } {
  const executor = {
    calls: 0,
    execute: () => {
      executor.calls += 1;
      return Promise.resolve({
        rows: rows.map((row) => ({
          updated_at: '2026-11-07T08:00:00.000000Z',
          updated_by: null,
          ...row,
        })),
      });
    },
  };
  return executor as unknown as Executor & { calls: number };
}

const service = new SettingsService({ db: executorWith([]) } as unknown as DatabaseConnection);

// Spec 0009, AC-2: one read path, typed by the registry.
describe('SettingsService.read', () => {
  it('returns the settings asked for, in their stored shapes', async () => {
    const executor = executorWith([
      { key: 'timezone', value: 'Africa/Cairo' },
      { key: 'inventory_lock_date', value: '2026-10-31' },
      { key: 'prices_include_vat', value: false },
    ]);

    const result = await service.read(
      ['timezone', 'inventory_lock_date', 'prices_include_vat'],
      executor,
    );

    expect(result).toEqual({
      timezone: 'Africa/Cairo',
      inventory_lock_date: '2026-10-31',
      prices_include_vat: false,
    });
  });

  it('reads a key with no row as its registry default (covers: AC-2)', async () => {
    const result = await service.read(
      ['operations_wind_down_days', 'operations_wind_down_pickup_days', 'timezone'],
      executorWith([]),
    );

    expect(result).toEqual({
      operations_wind_down_days: 60,
      operations_wind_down_pickup_days: 3,
      timezone: 'Africa/Cairo',
    });
  });

  it('accepts no lock date (null)', async () => {
    const result = await service.read(
      ['inventory_lock_date'],
      executorWith([{ key: 'inventory_lock_date', value: null }]),
    );

    expect(result.inventory_lock_date).toBeNull();
  });

  // Spec 0004 AC-4 and AC-8: a bad language, currency, or time zone is refused on read.
  it.each([
    ['currency', 'egp', 'EGP'],
    ['currency', 'EGPP', 'EGP'],
    ['timezone', 'Mars/Olympus', 'Africa/Cairo'],
    ['languages', [], ['en', 'ar']],
    ['languages', ['en', 'en'], ['en', 'ar']],
    ['languages', ['english'], ['en', 'ar']],
    ['default_language', 'EN', 'en'],
    ['inventory_lock_date', '31/10/2026', null],
    ['document_prefixes', { PO: 12 }, undefined],
    ['operations_wind_down_days', 59, 60],
  ])('reads %s = %j as the default and flags it (covers: AC-2)', async (key, value, fallback) => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fresh = new SettingsService({ db: executorWith([]) } as unknown as DatabaseConnection);

    const [setting] = await fresh.load([key], executorWith([{ key, value }]));

    expect(setting?.invalid).toBe(true);
    if (fallback !== undefined) expect(setting?.value).toEqual(fallback);
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toContain(key);
    expect(line).not.toContain(JSON.stringify(value));
    errors.mockRestore();
  });

  it('logs one invalid row once, however often it is read', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fresh = new SettingsService({ db: executorWith([]) } as unknown as DatabaseConnection);
    const bad = executorWith([{ key: 'operating_day_cutoff_hour', value: 'secret-value' }]);

    await fresh.read(['operating_day_cutoff_hour'], bad);
    await fresh.read(['operating_day_cutoff_hour'], bad);

    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});

// Security review S1: a setting that guards the ledger fails closed on business reads.
describe('SettingsService fail closed settings', () => {
  it('refuses a corrupt lock date on read and get, but shows it to the staff read', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bad = executorWith([{ key: 'inventory_lock_date', value: '31/10/2026' }]);

    await expect(service.get('inventory_lock_date', bad)).rejects.toMatchObject({
      kind: 'SettingUnreadable',
    });
    await expect(service.read(['inventory_lock_date', 'timezone'], bad)).rejects.toBeInstanceOf(
      SettingError,
    );
    const [staff] = await service.load(['inventory_lock_date'], bad);
    expect(staff).toMatchObject({ value: null, invalid: true });
    errors.mockRestore();
  });

  // Review N1: the log line of a fail closed setting says the work stops, not "using its default".
  it('logs what a corrupt fail closed row does, naming the key only', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fresh = new SettingsService({ db: executorWith([]) } as unknown as DatabaseConnection);
    const bad = executorWith([{ key: 'document_prefixes', value: { PO: 'secret-prefix' } }]);

    await expect(fresh.get('document_prefixes', bad)).rejects.toMatchObject({
      kind: 'SettingUnreadable',
    });

    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toContain('"document_prefixes"');
    expect(line).toContain('refused');
    expect(line).not.toContain('default');
    expect(line).not.toContain('secret-prefix');
    errors.mockRestore();
  });

  it('still reads a corrupt row of an ordinary setting as its default', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bad = executorWith([{ key: 'operations_wind_down_days', value: 'soon' }]);

    expect(await service.get('operations_wind_down_days', bad)).toBe(60);
    errors.mockRestore();
  });

  // Spec 0009, AC-2: a key outside the registry fails `tsc`.
  it('takes only registry keys', () => {
    // @ts-expect-error 'nope' is not a SettingKey
    const read = () => service.get('nope');
    expect(typeof read).toBe('function');
  });
});

// Spec 0009, AC-2, AC-4: reads without a transaction come from the cache.
describe('SettingsService cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves a read without a transaction from the cache for 30 seconds', async () => {
    const db = executorWith([{ key: 'operations_wind_down_days', value: 90 }]);
    const cached = new SettingsService({ db } as unknown as DatabaseConnection);

    expect(await cached.get('operations_wind_down_days')).toBe(90);
    expect(await cached.get('operations_wind_down_days')).toBe(90);
    expect(db.calls).toBe(1);

    vi.advanceTimersByTime(SETTINGS_CACHE_LIFETIME_MS - 1);
    await cached.get('operations_wind_down_days');
    expect(db.calls).toBe(1);

    vi.advanceTimersByTime(1);
    await cached.get('operations_wind_down_days');
    expect(db.calls).toBe(2);
  });

  it('always goes to the database when given a transaction', async () => {
    const db = executorWith([]);
    const tx = executorWith([{ key: 'timezone', value: 'UTC' }]);
    const cached = new SettingsService({ db } as unknown as DatabaseConnection);

    expect(await cached.get('timezone', tx)).toBe('UTC');
    expect(await cached.get('timezone', tx)).toBe('UTC');
    expect(tx.calls).toBe(2);
    expect(db.calls).toBe(0);
  });

  it('reads again after a notification drops the key', async () => {
    const db = executorWith([]);
    const cache = new SettingsCache();
    const cached = new SettingsService({ db } as unknown as DatabaseConnection, cache);

    await cached.get('timezone');
    cache.drop('timezone');
    await cached.get('timezone');

    expect(db.calls).toBe(2);
  });

  it('never keeps a value loaded before a drop (a change landed meanwhile)', () => {
    const cache = new SettingsCache();
    const generation = cache.generation();
    cache.drop('timezone');
    cache.store(
      {
        key: 'timezone',
        value: 'UTC',
        raw: 'UTC',
        hasRow: true,
        invalid: false,
        updatedAt: null,
        updatedBy: null,
      },
      generation,
    );

    expect(cache.get('timezone')).toBeUndefined();
  });
});

describe('canonicalJson', () => {
  it('compares objects regardless of key order, and arrays by order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(canonicalJson(['en', 'ar'])).not.toBe(canonicalJson(['ar', 'en']));
    expect(canonicalJson(null)).toBe('null');
  });
});

// Spec 0002: the lock date and document year are taken in the install's time zone (AC-6, AC-10).
describe('localDate', () => {
  it('gives the Cairo calendar date, which is ahead of UTC late in the evening (covers: AC-6)', () => {
    // Winter, UTC+2: 22:30 UTC is 00:30 the next day in Cairo.
    expect(localDate(new Date('2026-01-15T22:30:00Z'), 'Africa/Cairo')).toBe('2026-01-16');
    expect(localDate(new Date('2026-01-15T21:30:00Z'), 'Africa/Cairo')).toBe('2026-01-15');
  });

  it('follows Egyptian summer time (UTC+3)', () => {
    expect(localDate(new Date('2026-07-15T21:30:00Z'), 'Africa/Cairo')).toBe('2026-07-16');
  });

  it('turns the year in Cairo before it turns in UTC (covers: AC-10)', () => {
    expect(localDate(new Date('2030-12-31T23:30:00Z'), 'Africa/Cairo')).toBe('2031-01-01');
  });

  it('formats as YYYY-MM-DD with zero padding', () => {
    expect(localDate(new Date('2026-03-05T12:00:00Z'), 'UTC')).toBe('2026-03-05');
  });
});
