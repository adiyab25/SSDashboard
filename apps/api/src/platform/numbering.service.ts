import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@ssdashboard/db';
import type { Executor } from '../database/sql.js';
import { localDate, SettingsService } from './settings.service.js';

/** A document type with no prefix in the `document_prefixes` setting. */
export class NumberingError extends Error {
  readonly code = 'UnknownDocType';

  /** Takes the document type that had no prefix. */
  constructor(docType: string) {
    super(`No document prefix is set for "${docType}"`);
    this.name = 'NumberingError';
  }
}

/** Gap free document numbers per type and year, like `PO-2026-000123` (AC-10). */
@Injectable()
export class NumberingService {
  /** Takes the settings service that holds the document prefixes. */
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  /**
   * Issues the next number inside the caller's document transaction. Call it as the last
   * step: the counter row stays locked until that transaction ends, and a rollback gives
   * the number back. The full number is returned for storing, so a later prefix change
   * never rewrites it.
   */
  async next(executor: Executor, docType: string, date: Date): Promise<string> {
    const { timezone, document_prefixes: prefixes } = await this.settings.read(
      ['timezone', 'document_prefixes'],
      executor,
    );
    const prefix = prefixes[docType];
    if (!prefix) throw new NumberingError(docType);
    const year = Number(localDate(date, timezone).slice(0, 4));
    const { rows } = await executor.execute<{ last_value: number }>(sql`
      INSERT INTO document_counters (doc_type, year, last_value)
      VALUES (${docType}, ${year}, 1)
      ON CONFLICT (doc_type, year) DO UPDATE SET last_value = document_counters.last_value + 1
      RETURNING last_value`);
    const value = rows[0]?.last_value;
    if (value === undefined) throw new Error('The document counter returned no value');
    return `${prefix}-${year}-${String(value).padStart(6, '0')}`;
  }
}
