import { Inject, Injectable } from '@nestjs/common';
import { inArray, schema, type DatabaseConnection } from '@ssdashboard/db';
import { z } from 'zod';
import { DATABASE } from '../database/database.module.js';
import type { Executor } from '../database/sql.js';

/** The install settings other modules read, with their stored shapes. */
const SettingShapes = {
  currency: z.string(),
  timezone: z.string(),
  prices_include_vat: z.boolean(),
  /** `YYYY-MM-DD`; postings must be dated after it in `timezone`. */
  inventory_lock_date: z.iso.date().nullable(),
  document_prefixes: z.record(z.string(), z.string()),
};

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
