import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  AuditEntryListQuery,
  type AuditEntryDetail,
  type AuditEntryListResponse,
} from '@ssdashboard/contracts';
import type { Access } from '../platform/access/access.js';
import { CurrentAccess } from '../platform/access/current-access.decorator.js';
import { Permission } from '../platform/access/permission.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { InvalidCursorError } from '../platform/keyset-cursor.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { serializeAuditDetail, serializeAuditPage } from './audit-cost-fields.js';
import { auditHttpError } from './audit-http.js';
import { AuditQueryService } from './audit-query.service.js';

/** Maps a reader's error to its HTTP answer: audit domain errors, then a forged cursor. */
export function auditReadError(error: unknown): unknown {
  const mapped = auditHttpError(error);
  if (mapped) return mapped;
  if (error instanceof InvalidCursorError) {
    return new BadRequestException({ code: 'INVALID_CURSOR', message: error.message });
  }
  return error;
}

/** A malformed entry id is an entry that does not exist: 404 `ENTRY_NOT_FOUND`. */
const entryId = () =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new NotFoundException({ code: 'ENTRY_NOT_FOUND', message: 'Audit entry not found' }),
  });

/**
 * The audit trail for managers (spec 0010, AC-12, AC-13); the export is `AuditExportController`
 * in its own module (review M3R6). Staff audience only; partners and the portal have no audit
 * route. Reading needs `audit.read` (the manager hat by default, spec 0008): anyone else gets 403
 * `FORBIDDEN`. Cost fields in a diff reach only a reader with `cost.view`. There is no write
 * route: only server code records entries, so a client can never forge one.
 */
@Audience('staff')
@Permission('audit.read')
@Controller('audit/entries')
export class AuditEntriesController {
  /** Takes the audit reader. */
  constructor(private readonly entries: AuditQueryService) {}

  /**
   * Entries newest first with the person, record, action, day, and correlation filters, one
   * keyset page at a time. A bad filter is 400 `INVALID_FILTER`, a cursor this endpoint did not
   * issue 400 `INVALID_CURSOR`. Cost fields leave the diffs for a reader without `cost.view`.
   */
  @Get()
  async list(
    @Query(new ZodQueryPipe(AuditEntryListQuery, 'INVALID_FILTER')) query: AuditEntryListQuery,
    @CurrentAccess() access: Access,
  ): Promise<AuditEntryListResponse> {
    try {
      return serializeAuditPage(await this.entries.list(query), access);
    } catch (error) {
      throw auditReadError(error);
    }
  }

  /**
   * One entry with its field by field diff, or 404 `ENTRY_NOT_FOUND`. Cost fields leave the
   * diff and its changes for a reader without `cost.view`.
   */
  @Get(':id')
  async get(
    @Param('id', entryId()) id: string,
    @CurrentAccess() access: Access,
  ): Promise<AuditEntryDetail> {
    try {
      return serializeAuditDetail(await this.entries.get(id), access);
    } catch (error) {
      throw auditReadError(error);
    }
  }
}
