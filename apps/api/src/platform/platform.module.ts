import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller.js';
import { CostRulesService } from './cost-rules.service.js';
import { NumberingService } from './numbering.service.js';
import { SettingsService } from './settings.service.js';

/** Install wide services other modules use: settings, document numbering, and the per order cost rules. */
@Module({
  controllers: [ConfigController],
  providers: [SettingsService, NumberingService, CostRulesService],
  exports: [SettingsService, NumberingService, CostRulesService],
})
export class PlatformModule {}
