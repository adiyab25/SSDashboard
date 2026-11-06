import { Module } from '@nestjs/common';
import { StaffDirectoryModule } from '../staff/staff-directory.js';
import { AuditEntriesController } from './audit-entries.controller.js';
import { AuditQueryService } from './audit-query.service.js';
import { AuditService } from './audit.service.js';

/**
 * The audit trail (spec 0010, bundle core, always on). Exports `AuditService`, the only writer of
 * `audit_entries`, and `AuditQueryService`, its only reader; other modules import this module and
 * never the table. It reads no other module's table: person names come from the staff directory.
 */
@Module({
  imports: [StaffDirectoryModule],
  controllers: [AuditEntriesController],
  providers: [AuditService, AuditQueryService],
  exports: [AuditService, AuditQueryService],
})
export class AuditModule {}
