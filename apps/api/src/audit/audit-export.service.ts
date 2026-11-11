import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_EXPORT_BATCH,
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_MAX_ROWS,
  auditActionOf,
  personActor,
  type AuditExportQuery,
} from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { en, flatten } from '@ssdashboard/i18n';
import { DATABASE } from '../database/database.module.js';
import { auditDiffFor } from './audit-cost-fields.js';
import { AuditExportTooLarge } from './audit.errors.js';
import {
  AuditQueryService,
  type AuditKey,
  type AuditViewer,
  type EntryRow,
} from './audit-query.service.js';
import { AuditService, type JsonObject } from './audit.service.js';

/** The UTF-8 byte order mark, so a spreadsheet opens Arabic text right (spec 0010, AC-15). */
export const CSV_BOM = '\uFEFF';

const ENGLISH = flatten(en);

/**
 * One CSV cell: quoted, inner quotes doubled, objects as JSON, null as empty. A value that a
 * spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, a tab, or a carriage
 * return) gets a leading `'`, so a reason or a label can never execute in the reader's sheet.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** One CSV line of cells, ended with CRLF as spreadsheets expect. */
export function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** The export file name, `audit-<dayFrom>-<dayTo>.csv` (spec 0010, Value sourcing). */
export function exportFileName(query: Pick<AuditExportQuery, 'dayFrom' | 'dayTo'>): string {
  return `audit-${query.dayFrom}-${query.dayTo}.csv`;
}

/** The cells of one entry, in `AUDIT_EXPORT_COLUMNS` order. */
export function exportCells(row: EntryRow, localAt: string, actorName: string | null): unknown[] {
  const definition = auditActionOf(row.action);
  const label = definition ? ENGLISH[definition.label] : undefined;
  return [
    localAt,
    row.operating_day,
    row.actor_kind,
    actorName ?? row.actor_ref ?? row.actor_user_id,
    row.actor_hat,
    row.action,
    label ?? row.action,
    row.record_type,
    row.record_id,
    row.record_label,
    row.reason,
    row.before,
    row.after,
    row.personal_fields.join(';'),
    row.correlation_id,
    row.id,
  ];
}

/** What `prepare` approved: the newest entry key inside the filter and the rows at or below it. */
export interface AuditExportPlan {
  fileName: string;
  /** Null when the filter holds no entry: the file is the header alone. */
  bound: AuditKey | null;
  rows: number;
  /**
   * Whether the reader holds `cost.view` (spec 0008 AC-6): without it, every cost field leaves
   * the `before` and `after` cells, as it leaves the screen.
   */
  showCost: boolean;
  /**
   * The person exporting, as `prepare` was given them: the batch reader checks `audit.export` on
   * them again and strips cost itself (security review AS29), so the file never rests on the
   * route alone.
   */
  viewer: AuditViewer;
}

/**
 * The reader went away while the file streamed (spec 0010, review M3R1): the sink throws it so
 * the stream stops, its generator closes, and nothing waits on a socket that will never drain.
 */
export class AuditExportCutOff extends Error {
  /** Builds the error; it carries no values. */
  constructor() {
    super('The export reader went away');
    this.name = 'AuditExportCutOff';
  }
}

/**
 * The CSV export of the trail (spec 0010, AC-15, task 14). `prepare` decides before anything
 * streams: it reads the newest entry key inside the filter, counts the entries at or below it
 * (a `LIMIT`ed count, never a full one), refuses more than 200,000 with `AuditExportTooLarge`,
 * then writes and commits the `audit.exported` entry in its own transaction. Writing it first
 * means an export is on record even if the download is cut off, and a failure to record stops
 * the export before any row leaves. `stream` then writes the byte order mark, the header, and
 * only the entries at or below that key, at most the counted number, in keyset batches of 1,000,
 * so the file holds exactly `after.rows` rows and never the export's own entry, which is newer
 * (review M3R2). The file holds no personal data because the table holds none, and no cost
 * field for a reader without `cost.view` (`AuditExportPlan.showCost`, spec 0008 AC-6), nor any
 * cost entry (`COST_ENTRY_ACTIONS`: the reader's bound, count, and batches leave them out, so
 * `rows` never counts one). It reads no
 * setting: the caller passes the install time zone, so this module never imports the platform
 * module (review M3R6).
 */
@Injectable()
export class AuditExportService {
  /** Takes the app database connection, the reader, and the writer. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(AuditQueryService) private readonly reader: AuditQueryService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Bounds, counts, and records the export, returning its plan. Throws `AuditExportTooLarge`
   * past 200,000 rows, before writing anything. `reason` is the decoded `x-audit-reason` header.
   * The `audit.exported` entry names the viewer's hat that holds `audit.export`.
   */
  async prepare(
    query: AuditExportQuery,
    viewer: AuditViewer,
    reason?: string,
  ): Promise<AuditExportPlan> {
    const bound = await this.reader.exportBound(query, viewer);
    const rows = bound
      ? await this.reader.exportSize(query, viewer, bound, AUDIT_EXPORT_MAX_ROWS + 1)
      : 0;
    if (rows > AUDIT_EXPORT_MAX_ROWS) throw new AuditExportTooLarge(AUDIT_EXPORT_MAX_ROWS);
    const exportId = this.audit.newCorrelationId();
    // The filter, without the fields the caller left out, is the entry's `after`.
    const given = Object.fromEntries(
      Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    await this.connection.db.transaction((tx) =>
      this.audit.record(tx, {
        actor: personActor(viewer.userId, viewer.actingHat('audit.export')),
        action: 'audit.exported',
        record: { type: 'audit_entry', id: exportId },
        after: { ...given, rows } satisfies JsonObject,
        ...(reason ? { reason } : {}),
        correlationId: exportId,
      }),
    );
    return {
      fileName: exportFileName(query),
      bound,
      rows,
      showCost: viewer.has('cost.view'),
      viewer,
    };
  }

  /**
   * Streams the planned file through `write` (which resolves when the sink can take more, and
   * throws `AuditExportCutOff` when its reader is gone): the byte order mark and header first,
   * then the planned rows, batch by batch, the instant in `timezone`. Returns the rows written.
   * A throw from `write` ends the loop, which closes the batch generator.
   */
  async stream(
    query: AuditExportQuery,
    plan: AuditExportPlan,
    timezone: string,
    write: (chunk: string) => Promise<void>,
  ): Promise<number> {
    await write(CSV_BOM + csvLine(AUDIT_EXPORT_COLUMNS));
    if (!plan.bound) return 0;
    let written = 0;
    const batches = this.reader.exportBatches(
      query,
      plan.viewer,
      timezone,
      plan.bound,
      AUDIT_EXPORT_BATCH,
      plan.rows,
    );
    for await (const batch of batches) {
      await write(
        batch
          .map(({ row, localAt, actorName }) =>
            csvLine(
              exportCells(
                {
                  ...row,
                  before: auditDiffFor(row.before, plan.showCost),
                  after: auditDiffFor(row.after, plan.showCost),
                },
                localAt,
                actorName,
              ),
            ),
          )
          .join(''),
      );
      written += batch.length;
    }
    return written;
  }
}
