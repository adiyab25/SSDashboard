import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CostService } from './cost.service.js';

/** Products and SKUs (spec 0006). Imports nothing from inventory; inventory imports this. */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService, CostService],
  exports: [CatalogService, CostService],
})
export class CatalogModule {}
