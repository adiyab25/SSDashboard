import { once } from 'node:events';
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Logger,
  Query,
  Res,
} from '@nestjs/common';
import { AUDIT_REASON_HEADER, AuditExportQuery, AuditExportReason } from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { Access } from '../platform/access/access.js';
import { CurrentAccess } from '../platform/access/current-access.decorator.js';
import { Permission } from '../platform/access/permission.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { SettingsService } from '../platform/settings.service.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { auditReadError } from './audit-entries.controller.js';
import { AuditExportCutOff, AuditExportService } from './audit-export.service.js';

/** The part of a response the export writes to: a writable that can close under it. */
export type ExportResponse = Pick<Response, 'write' | 'destroyed' | 'writableEnded'> &
  Pick<Response, 'once' | 'off'>;

/**
 * A sink over the response (spec 0010, review M3R1): writes a chunk, and when the socket is full
 * waits for `drain` or `close`, whichever comes first. Once the reader is gone (the response is
 * destroyed, or it closed instead of draining) it throws `AuditExportCutOff`, so the stream stops
 * and nothing waits on a socket that will never drain.
 */
export function responseSink(response: ExportResponse): (chunk: string) => Promise<void> {
  return async (chunk) => {
    if (response.destroyed || response.writableEnded) throw new AuditExportCutOff();
    if (response.write(chunk)) return;
    const controller = new AbortController();
    try {
      await Promise.race([
        once(response as unknown as NodeJS.EventEmitter, 'drain', { signal: controller.signal }),
        once(response as unknown as NodeJS.EventEmitter, 'close', {
          signal: controller.signal,
        }).then(() => {
          throw new AuditExportCutOff();
        }),
      ]);
    } finally {
      // Removes the listener of the loser, so a long export never piles up listeners.
      controller.abort();
    }
    if (response.destroyed) throw new AuditExportCutOff();
  };
}

/**
 * The reason header decoded and checked (spec 0010, review M3R3): absent is no reason; present,
 * it must be percent encoded UTF-8 of 1 to 500 characters after trimming, else 400
 * `INVALID_REASON`. Never logged.
 */
export function exportReason(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  let text: string;
  try {
    text = decodeURIComponent(header);
  } catch {
    throw new BadRequestException({ code: 'INVALID_REASON', message: 'The reason is not valid' });
  }
  const reason = AuditExportReason.safeParse(text);
  if (!reason.success) {
    throw new BadRequestException({ code: 'INVALID_REASON', message: 'The reason is not valid' });
  }
  return reason.data;
}

/**
 * `GET /api/audit/entries/export` (spec 0010, AC-15, task 14), in its own module so the audit
 * module never imports the platform module (review M3R6: spec 0009 makes platform import audit).
 * Staff audience, `@Permission('audit.export')` (the manager hat by default, spec 0008). The
 * `before` and `after` cells leave out cost fields for a reader without `cost.view`, like the
 * screen (spec 0008 AC-6).
 */
@Audience('staff')
@Controller('audit/entries')
export class AuditExportController {
  private readonly logger = new Logger('AuditExport');

  /** Takes the export service and the install settings (for the time zone). */
  constructor(
    @Inject(AuditExportService) private readonly exports: AuditExportService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * `audit.export`: the filter as a CSV file. `dayFrom` and `dayTo` are required and cover at
   * most 366 days, both included (400 `INVALID_FILTER`); more than 200,000 rows is 413
   * `EXPORT_TOO_LARGE`, decided before anything streams. The optional reason is the
   * `x-audit-reason` header. The export is recorded as `audit.exported` before the first byte.
   * If the reader goes away, the stream stops and one line is logged, with no values; any other
   * failure while streaming cuts the connection, so a partial file never looks complete.
   */
  @Permission('audit.export')
  @Get('export')
  async export(
    @Query(new ZodQueryPipe(AuditExportQuery, 'INVALID_FILTER')) query: AuditExportQuery,
    @Headers(AUDIT_REASON_HEADER) reasonHeader: string | undefined,
    @CurrentAccess() access: Access,
    @Res() response: Response,
  ): Promise<void> {
    const reason = exportReason(reasonHeader);
    let plan;
    try {
      plan = await this.exports.prepare(query, access, reason);
    } catch (error) {
      throw auditReadError(error);
    }
    const { timezone } = await this.settings.read(['timezone']);
    response.status(200);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${plan.fileName}"`);
    response.setHeader('Cache-Control', 'no-store');
    try {
      await this.exports.stream(query, plan, timezone, responseSink(response));
      response.end();
    } catch (error) {
      if (error instanceof AuditExportCutOff) {
        this.logger.warn('An audit export was cut off: the reader went away');
      } else {
        this.logger.error(`An audit export stopped: ${String(error)}`);
      }
      response.destroy();
    }
  }
}
