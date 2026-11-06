import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { MailModule } from './mail/mail.module.js';
import { StaffModule } from './staff/staff.module.js';
import { PlatformModule } from './platform/platform.module.js';

/**
 * The root module of the `app` entry point (the api process): wires config, database, mail,
 * auth, staff, platform, audit, catalog and inventory. The worker uses its own module so no HTTP code
 * runs there.
 */
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ConfigModule,
    DatabaseModule,
    MailModule,
    AuthModule,
    StaffModule,
    HealthModule,
    PlatformModule,
    AuditModule,
    CatalogModule,
    InventoryModule,
  ],
})
export class AppModule {}
