import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuditModule } from './audit/audit.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { MailModule } from './mail/mail.module.js';
import { PartnersModule } from './partners/partners.module.js';
import { PlatformModule } from './platform/platform.module.js';

/**
 * The root module of the `app` entry point (the api process): wires config, database, mail,
 * identity (sign in, staff and partner logins), platform, audit, catalog, inventory and partners.
 * The worker uses its own module so no HTTP code runs there.
 */
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ConfigModule,
    DatabaseModule,
    MailModule,
    IdentityModule,
    HealthModule,
    PlatformModule,
    AuditModule,
    CatalogModule,
    InventoryModule,
    PartnersModule,
  ],
})
export class AppModule {}
