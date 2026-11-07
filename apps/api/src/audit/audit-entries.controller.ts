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
import type { AuthenticatedRequest } from '../identity/sign-in/current-staff.js';
import { Roles } from '../identity/sign-in/roles.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { InvalidCursorError } from '../platform/keyset-cursor.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { auditHttpError } from './audit-http.js';
import type { AuditViewer } from './audit-query.service.js';
import { AuditQueryService } from './audit-query.service.js';

/** The signed in person as the audit readers see them. */
export const viewerOf = (request: AuthenticatedRequest): AuditViewer => ({
  id: request.staff.id,
  role: request.staff.role,
});

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
 * in its own module (review M3R6). Staff audience only; partners
 * and the portal have no audit route. Each route names its own permission with one `@Roles`:
 * `audit.read` and `audit.export` are the `admin` role until hats land (spec 0008), and anyone
 * else gets 403 `FORBIDDEN`; the later switch to permissions is one decorator per route. There is
 * no write route: only server code records entries, so a client can never forge one.
 */
@Audience('staff')
@Controller('audit/entries')
export class AuditEntriesController {
  /** Takes the audit reader. */
  constructor(private readonly entries: AuditQueryService) {}

  /**
   * `audit.read`: entries newest first with the person, record, action, day, and correlation
   * filters, one keyset page at a time. A bad filter is 400 `INVALID_FILTER`, a cursor this
   * endpoint did not issue 400 `INVALID_CURSOR`.
   */
  @Roles('admin')
  @Get()
  async list(
    @Query(new ZodQueryPipe(AuditEntryListQuery, 'INVALID_FILTER')) query: AuditEntryListQuery,
  ): Promise<AuditEntryListResponse> {
    try {
      return await this.entries.list(query);
    } catch (error) {
      throw auditReadError(error);
    }
  }

  /** `audit.read`: one entry with its field by field diff, or 404 `ENTRY_NOT_FOUND`. */
  @Roles('admin')
  @Get(':id')
  async get(@Param('id', entryId()) id: string): Promise<AuditEntryDetail> {
    try {
      return await this.entries.get(id);
    } catch (error) {
      throw auditReadError(error);
    }
  }
}
