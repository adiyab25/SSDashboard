import { Module } from '@nestjs/common';
import { NumberingService } from './numbering.service.js';
import { SettingsService } from './settings.service.js';

/** Install wide services other modules use: settings and document numbering. */
@Module({
  providers: [SettingsService, NumberingService],
  exports: [SettingsService, NumberingService],
})
export class PlatformModule {}
