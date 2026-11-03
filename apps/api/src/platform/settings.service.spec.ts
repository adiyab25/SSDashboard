import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../database/sql.js';
import { localDate, SettingsService } from './settings.service.js';

/** A stand in for the database: `select().from().where()` resolves to these rows. */
function executorWith(rows: { key: string; value: unknown }[]): Executor {
  const chain = { from: () => chain, where: () => Promise.resolve(rows) };
  return { select: () => chain } as unknown as Executor;
}

const service = new SettingsService({ db: executorWith([]) } as unknown as DatabaseConnection);

describe('SettingsService.read', () => {
  it('returns the settings asked for, in their stored shapes', async () => {
    const executor = executorWith([
      { key: 'timezone', value: 'Africa/Cairo' },
      { key: 'inventory_lock_date', value: '2026-10-31' },
      { key: 'prices_include_vat', value: true },
    ]);

    const result = await service.read(
      ['timezone', 'inventory_lock_date', 'prices_include_vat'],
      executor,
    );

    expect(result).toEqual({
      timezone: 'Africa/Cairo',
      inventory_lock_date: '2026-10-31',
      prices_include_vat: true,
    });
  });

  it('accepts no lock date (null)', async () => {
    const result = await service.read(
      ['inventory_lock_date'],
      executorWith([{ key: 'inventory_lock_date', value: null }]),
    );

    expect(result.inventory_lock_date).toBeNull();
  });

  it('throws when a setting is missing, instead of guessing a default', async () => {
    await expect(service.read(['timezone'], executorWith([]))).rejects.toThrow(
      'Setting "timezone" is missing',
    );
  });

  it('throws when a stored value has the wrong shape', async () => {
    await expect(
      service.read(
        ['inventory_lock_date'],
        executorWith([{ key: 'inventory_lock_date', value: '31/10/2026' }]),
      ),
    ).rejects.toThrow();
    await expect(
      service.read(
        ['document_prefixes'],
        executorWith([{ key: 'document_prefixes', value: { PO: 12 } }]),
      ),
    ).rejects.toThrow();
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
