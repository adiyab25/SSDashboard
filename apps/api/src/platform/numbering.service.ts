import { Inject, Injectable } from '@nestjs/common';
import { sql } from '@ssdashboard/db';
import type { Executor } from '../database/sql.js';
import { SettingError } from './settings/settings.errors.js';
import { localDate, SettingsService } from './settings/settings.service.js';

/** A document type with no prefix in the `document_prefixes` setting. */
export class NumberingError extends Error {
  readonly code = 'UnknownDocType';

  /** Takes the document type that had no prefix. */
  constructor(docType: string) {
    super(`No document prefix is set for "${docType}"`);
    this.name = 'NumberingError';
  }
}

/**
 * The stored `document_prefixes` fail their schema, so no number is issued (spec 0009, review
 * R18): the document is refused with 409 `DOCUMENT_PREFIXES_UNREADABLE` until a manager sets the
 * prefixes again, never numbered with the defaults, which could repeat a number already issued.
 */
export class DocumentPrefixesUnreadable extends Error {
  readonly code = 'DocumentPrefixesUnreadable';

  /** Builds the error; it carries no setting value. */
  constructor() {
    super('The document prefixes setting cannot be read. Set the prefixes again in the settings.');
    this.name = 'DocumentPrefixesUnreadable';
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
   * never rewrites it. Corrupt stored prefixes throw `DocumentPrefixesUnreadable`.
   */
  async next(executor: Executor, docType: string, date: Date): Promise<string> {
    const { timezone, document_prefixes: prefixes } = await this.prefixesAndZone(executor);
    // A document type outside the registry's list has no prefix: NumberingError below.
    const prefix: string | undefined = Object.hasOwn(prefixes, docType)
      ? prefixes[docType as keyof typeof prefixes]
      : undefined;
    if (!prefix) throw new NumberingError(docType);
    const year = Number(localDate(date, timezone).slice(0, 4));
    const { rows } = await executor.execute<{ last_value: number }>(sql`
      INSERT INTO document_counters (doc_type, year, last_value)
      VALUES (${docType}, ${year}, 1)
      ON CONFLICT (tenant_id, doc_type, year) DO UPDATE SET last_value = document_counters.last_value + 1
      RETURNING last_value`);
    const value = rows[0]?.last_value;
    if (value === undefined) throw new Error('The document counter returned no value');
    return `${prefix}-${year}-${String(value).padStart(6, '0')}`;
  }

  private async prefixesAndZone(executor: Executor) {
    try {
      return await this.settings.read(['timezone', 'document_prefixes'], executor);
    } catch (error) {
      if (error instanceof SettingError && error.kind === 'SettingUnreadable') {
        throw new DocumentPrefixesUnreadable();
      }
      throw error;
    }
  }
}
