import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CatalogModule } from './catalog/catalog.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { MailModule } from './mail/mail.module.js';
import { PlatformModule } from './platform/platform.module.js';

/**
 * The root module of the `app` entry point (the api process): wires config, database, mail,
 * identity (sign in and staff), platform, catalog and inventory. The worker uses its own module so no HTTP code
 * runs there.
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
    CatalogModule,
    InventoryModule,
  ],
})
export class AppModule {}
