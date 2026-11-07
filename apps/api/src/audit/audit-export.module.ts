import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { AuditExportController } from './audit-export.controller.js';
import { AuditExportService } from './audit-export.service.js';
import { AuditModule } from './audit.module.js';

/**
 * The CSV export of the audit trail (spec 0010, AC-15), a leaf module: it imports the audit
 * module and the platform module (for the time zone setting), and nothing imports it but the app
 * root. The audit module itself never imports the platform module, because spec 0009 makes the
 * platform module import audit to record `setting.changed` (review M3R6). The app root lists this
 * module before `AuditModule`, so `GET /api/audit/entries/export` is routed before
 * `GET /api/audit/entries/:id`; `audit-routes.spec.ts` fails otherwise.
 */
@Module({
  imports: [AuditModule, PlatformModule],
  controllers: [AuditExportController],
  providers: [AuditExportService],
})
export class AuditExportModule {}
