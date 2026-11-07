import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AuditEntryListQuery, type AuditEntryListResponse } from '@ssdashboard/contracts';
import type { Access } from '../platform/access/access.js';
import { CurrentAccess } from '../platform/access/current-access.decorator.js';
import { Permission } from '../platform/access/permission.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { InvalidCursorError } from '../platform/keyset-cursor.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { serializeAuditPage } from './audit-cost-fields.js';
import { AuditQueryService } from './audit-query.service.js';

/**
 * The audit trail for managers (spec 0010, AC-12, AC-13). Staff audience only; partners and the
 * portal have no audit route. Reading needs `audit.read` (the manager hat by default, spec 0008):
 * anyone else gets 403 `FORBIDDEN`. Cost fields in a diff reach only a reader with `cost.view`.
 * There is no write route: only server code records entries, so a client can never forge one.
 */
@Audience('staff')
@Permission('audit.read')
@Controller('audit/entries')
export class AuditEntriesController {
  /** Takes the audit query service. */
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
      if (error instanceof InvalidCursorError) {
        throw new BadRequestException({ code: 'INVALID_CURSOR', message: error.message });
      }
      throw error;
    }
  }
}
