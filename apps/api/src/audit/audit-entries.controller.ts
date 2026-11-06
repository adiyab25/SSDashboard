import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AuditEntryListQuery, type AuditEntryListResponse } from '@ssdashboard/contracts';
import { Roles } from '../identity/sign-in/roles.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { InvalidCursorError } from '../platform/keyset-cursor.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { AuditQueryService } from './audit-query.service.js';

/**
 * The audit trail for managers (spec 0010, AC-12, AC-13). Staff audience only; partners and the
 * portal have no audit route. Reading needs `audit.read`, which is the `admin` role until hats
 * land (spec 0008): anyone else gets 403 `FORBIDDEN`. There is no write route: only server code
 * records entries, so a client can never forge one.
 */
@Audience('staff')
@Roles('admin')
@Controller('audit/entries')
export class AuditEntriesController {
  /** Takes the audit query service. */
  constructor(private readonly entries: AuditQueryService) {}

  /**
   * Entries newest first with the person, record, action, day, and correlation filters, one
   * keyset page at a time. A bad filter is 400 `INVALID_FILTER`, a cursor this endpoint did not
   * issue 400 `INVALID_CURSOR`.
   */
  @Get()
  async list(
    @Query(new ZodQueryPipe(AuditEntryListQuery, 'INVALID_FILTER')) query: AuditEntryListQuery,
  ): Promise<AuditEntryListResponse> {
    try {
      return await this.entries.list(query);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new BadRequestException({ code: 'INVALID_CURSOR', message: error.message });
      }
      throw error;
    }
  }
}
