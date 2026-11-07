import { Module } from '@nestjs/common';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { AuditEntriesController } from './audit-entries.controller.js';
import { AuditQueryService } from './audit-query.service.js';
import { AuditRecordsController } from './audit-records.controller.js';
import { AuditUndoRegistry } from './audit-undo.registry.js';
import { AuditService } from './audit.service.js';

/**
 * The audit trail (spec 0010, bundle core, always on). Exports `AuditService`, the writer of
 * every entry of a listed code, `AuditQueryService`, the only reader (every public reader checks
 * its viewer's permission and strips cost itself), and `AuditUndoRegistry`, where owning modules
 * register their undo handlers at start; other modules import this module and never the table.
 * The undo route, its service, the undone entry writer, and the start check live in the leaf
 * `AuditUndoModule`, which only the api imports (reviews M4R1, M4R4), so the worker, which loads
 * this module to record entries, never serves an undo or stops on its check. It reads no other
 * module's table: person names come from the staff directory. It imports no owning module: an
 * undo reaches the owner only through the handler the owner registered. It must never import the
 * platform module (spec 0009 makes platform import audit, review M3R6): the export, which needs
 * the time zone setting, is the leaf `AuditExportModule`.
 */
@Module({
  imports: [StaffDirectoryModule],
  controllers: [AuditEntriesController, AuditRecordsController],
  providers: [AuditService, AuditQueryService, AuditUndoRegistry],
  exports: [AuditService, AuditQueryService, AuditUndoRegistry],
})
export class AuditModule {}
