import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  AuditRecordHistoryQuery,
  AuditRecordRef,
  type AuditEntryListResponse,
} from '@ssdashboard/contracts';
import type { AuthenticatedRequest } from '../identity/sign-in/current-staff.js';
import { Roles } from '../identity/sign-in/roles.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { auditReadError, viewerOf } from './audit-entries.controller.js';
import { AuditQueryService } from './audit-query.service.js';

/**
 * The history of one record, for the panel other record screens embed (spec 0010, task 13):
 * `GET /api/audit/records/:type/:id/entries`. Staff audience only, `audit.read` (the `admin`
 * role until hats land) on the route and again inside `AuditQueryService.forRecord`. A bad type,
 * id, or query is 400 `INVALID_FILTER`; a forged cursor 400 `INVALID_CURSOR`.
 */
@Audience('staff')
@Controller('audit/records')
export class AuditRecordsController {
  /** Takes the audit reader. */
  constructor(private readonly entries: AuditQueryService) {}

  /** `audit.read`: the record's entries newest first, one keyset page at a time. */
  @Roles('admin')
  @Get(':type/:id/entries')
  async history(
    @Param(new ZodQueryPipe(AuditRecordRef, 'INVALID_FILTER')) record: AuditRecordRef,
    @Query(new ZodQueryPipe(AuditRecordHistoryQuery, 'INVALID_FILTER'))
    query: AuditRecordHistoryQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<AuditEntryListResponse> {
    try {
      return await this.entries.forRecord(
        viewerOf(request),
        record.type,
        record.id,
        query.cursor,
        query.limit,
      );
    } catch (error) {
      throw auditReadError(error);
    }
  }
}
