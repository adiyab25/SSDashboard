import { Module } from '@nestjs/common';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { AuditEntriesController } from './audit-entries.controller.js';
import { AuditQueryService } from './audit-query.service.js';
import { AuditRecordsController } from './audit-records.controller.js';
import { AuditUndoController } from './audit-undo.controller.js';
import { AuditUndoRegistry } from './audit-undo.registry.js';
import { AuditUndoService } from './audit-undo.service.js';
import { AuditService } from './audit.service.js';

/**
 * The audit trail (spec 0010, bundle core, always on). Exports `AuditService`, the only writer of
 * `audit_entries`, `AuditQueryService`, its only reader, and `AuditUndoRegistry`, where owning
 * modules register their undo handlers at start; other modules import this module and never the
 * table. It reads no other module's table: person names come from the staff directory. It imports
 * no owning module: an undo reaches the owner only through the handler the owner registered.
 * It must never import the platform module (spec 0009 makes platform import audit, review M3R6):
 * the export, which needs the time zone setting, is the leaf `AuditExportModule`.
 */
@Module({
  imports: [StaffDirectoryModule],
  controllers: [AuditEntriesController, AuditRecordsController, AuditUndoController],
  providers: [AuditService, AuditQueryService, AuditUndoRegistry, AuditUndoService],
  exports: [AuditService, AuditQueryService, AuditUndoRegistry],
})
export class AuditModule {}
