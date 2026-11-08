import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuditExportModule } from './audit/audit-export.module.js';
import { AuditUndoModule } from './audit/audit-undo.module.js';
import { AuditModule } from './audit/audit.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ChannelsModule } from './channels/channels.module.js';
import { ConfigModule } from './config/config.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { MailModule } from './mail/mail.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PartnersModule } from './partners/partners.module.js';
import { PlatformApiModule } from './platform/platform-api.module.js';
import { PlatformModule } from './platform/platform.module.js';

/**
 * The root module of the `app` entry point (the api process): wires config, database, mail,
 * identity (sign in, staff and partner logins), platform, audit, catalog, channels, connectors, customers, inventory, orders and partners.
 * The worker uses its own module so no HTTP code runs there.
 */
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ConfigModule,
    DatabaseModule,
    MailModule,
    // Before every module that brings in AuditModule, so a fixed path of the export leaf is
    // matched before the entry detail's `:id` (audit-routes.spec.ts).
    AuditExportModule,
    IdentityModule,
    HealthModule,
    PlatformModule,
    PlatformApiModule,
    AuditModule,
    // The undo route and its start check: the api only, never the worker (review M4R1).
    AuditUndoModule,
    CatalogModule,
    ChannelsModule,
    ConnectorsModule,
    CustomersModule,
    InventoryModule,
    OrdersModule,
    PartnersModule,
  ],
})
export class AppModule {}
