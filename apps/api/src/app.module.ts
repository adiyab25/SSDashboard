import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { MailModule } from './mail/mail.module.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ConfigModule,
    DatabaseModule,
    MailModule,
    AuthModule,
    HealthModule,
    PlatformModule,
    InventoryModule,
  ],
})
export class AppModule {}
