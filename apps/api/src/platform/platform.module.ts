import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

/** Install wide services other modules use: settings (and document numbering). */
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class PlatformModule {}
