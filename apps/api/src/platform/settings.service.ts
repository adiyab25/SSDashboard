import { Inject, Injectable } from '@nestjs/common';
import { inArray, schema, type DatabaseConnection } from '@ssdashboard/db';
import { z } from 'zod';
import { DATABASE } from '../database/database.module.js';
import type { Executor } from '../database/sql.js';

/** A language code: two or three lowercase letters. */
const LanguageCode = z.string().regex(/^[a-z]{2,3}$/);

/** The install settings other modules read, with their stored shapes. */
const SettingShapes = {
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().refine(isTimeZone, 'Not a time zone name'),
  prices_include_vat: z.boolean(),
  /** `YYYY-MM-DD`; postings must be dated after it in `timezone`. */
  inventory_lock_date: z.iso.date().nullable(),
  document_prefixes: z.record(z.string(), z.string()),
  /** Enabled language codes in switcher order; at least one, no repeats. */
  languages: z
    .array(LanguageCode)
    .min(1)
    .refine((codes) => new Set(codes).size === codes.length, 'Languages must not repeat'),
  /** The language a first visit opens in; the config endpoint checks it is in `languages`. */
  default_language: LanguageCode,
};

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export type SettingKey = keyof typeof SettingShapes;
export type Settings = { [K in SettingKey]: z.infer<(typeof SettingShapes)[K]> };

@Injectable()
export class SettingsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Reads the given settings, inside the caller's transaction when one is passed. */
  async read<K extends SettingKey>(
    keys: readonly K[],
    executor: Executor = this.connection.db,
  ): Promise<Pick<Settings, K>> {
    const rows = await executor
      .select({ key: schema.settings.key, value: schema.settings.value })
      .from(schema.settings)
      .where(inArray(schema.settings.key, [...keys]));
    const found = new Map(rows.map((row) => [row.key, row.value]));
    const result: Partial<Settings> = {};
    for (const key of keys) {
      if (!found.has(key)) throw new Error(`Setting "${key}" is missing`);
      Object.assign(result, { [key]: SettingShapes[key].parse(found.get(key)) });
    }
    return result as Pick<Settings, K>;
  }
}

/** The calendar date of an instant in a time zone, as `YYYY-MM-DD`. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
