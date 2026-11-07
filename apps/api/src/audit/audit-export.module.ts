import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { AuditExportController } from './audit-export.controller.js';
import { AuditExportService } from './audit-export.service.js';
import { AuditModule } from './audit.module.js';

/**
 * The CSV export of the audit trail (spec 0010, AC-15), a leaf module: it imports the audit
 * module and the platform module (for the time zone setting), and nothing imports it but the app
 * root. The audit module itself never imports the platform module, because spec 0009 makes the
 * platform module import audit to record `setting.changed` (review M3R6). The export is
 * `POST /api/audit/entries/export` (security review AS28), which no `GET /api/audit/entries/:id`
 * can shadow; the app root still lists this module before `AuditModule`, so a fixed path this
 * leaf ever serves under `/api/audit/entries/` is matched before `:id` (`audit-routes.spec.ts`).
 */
@Module({
  imports: [AuditModule, PlatformModule],
  controllers: [AuditExportController],
  providers: [AuditExportService],
})
export class AuditExportModule {}
