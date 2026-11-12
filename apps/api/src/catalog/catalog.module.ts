import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { BarcodesController } from './barcodes/barcodes.controller.js';
import { BarcodesService } from './barcodes/barcodes.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CostRecordsController } from './cost-records/cost-records.controller.js';
import { CostRecordsService } from './cost-records/cost-records.service.js';
import { CostService } from './cost.service.js';
import { ProductGroupsController } from './product-groups/product-groups.controller.js';
import { ProductGroupsService } from './product-groups/product-groups.service.js';
import { SeasonsController } from './seasons/seasons.controller.js';
import { SeasonsService } from './seasons/seasons.service.js';
import { StylesController } from './styles/styles.controller.js';
import { StylesService } from './styles/styles.service.js';

/**
 * Products and SKUs (spec 0006), styles, seasons, product groups, barcodes, and cost records
 * (spec 0012). Imports nothing from inventory; inventory imports this. Imports `AuditModule` for
 * the entries of its person actions and `StaffDirectoryModule` for "recorded by" names.
 */
@Module({
  imports: [AuditModule, StaffDirectoryModule],
  controllers: [
    CatalogController,
    StylesController,
    SeasonsController,
    ProductGroupsController,
    BarcodesController,
    CostRecordsController,
  ],
  providers: [
    CatalogService,
    CostService,
    StylesService,
    SeasonsService,
    ProductGroupsService,
    BarcodesService,
    CostRecordsService,
  ],
  exports: [CatalogService, CostService],
})
export class CatalogModule {}
