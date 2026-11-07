import { Module } from '@nestjs/common';
import { AuditUndoController } from './audit-undo.controller.js';
import { AuditUndoStartCheck } from './audit-undo-start-check.js';
import { AuditUndoService } from './audit-undo.service.js';
import { AuditUndoneWriter } from './audit-undone.writer.js';
import { AuditModule } from './audit.module.js';

/**
 * The one step undo (spec 0010, AC-14), a leaf module that only the api's `AppModule` imports:
 * the route `POST /api/audit/entries/:id/undo`, `AuditUndoService`, the undone entry writer, and
 * the start check that every undoable code has a handler (review M4R1). The worker never imports
 * it, so a process that never serves an undo never stops on that check. It exports nothing: the
 * writer of undone entries is reachable only by `AuditUndoService` (review M4R4, security review
 * AS33). Owners register their handlers in `AuditUndoRegistry`, which `AuditModule` exports.
 */
@Module({
  imports: [AuditModule],
  controllers: [AuditUndoController],
  providers: [AuditUndoService, AuditUndoneWriter, AuditUndoStartCheck],
})
export class AuditUndoModule {}
