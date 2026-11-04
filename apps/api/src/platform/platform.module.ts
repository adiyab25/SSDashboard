import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller.js';
import { NumberingService } from './numbering.service.js';
import { SettingsService } from './settings.service.js';

/** Install wide services other modules use: settings and document numbering. */
@Module({
  controllers: [ConfigController],
  providers: [SettingsService, NumberingService],
  exports: [SettingsService, NumberingService],
})
export class PlatformModule {}
