import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { PlatformModule } from '../platform/platform.module.js';
import { BarcodesController } from './barcodes/barcodes.controller.js';
import { BarcodesService } from './barcodes/barcodes.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogLocks } from './catalog-locks.service.js';
import { CatalogChannelSync } from './channel-sync/catalog-channel-sync.js';
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
 * (spec 0012), and `CatalogChannelSync`, the channel upsert contract spec 0015's connector calls.
 * Imports nothing from inventory; inventory imports this and locks SKU rows through `CatalogLocks`
 * (spec 0011 AC-18). Imports `AuditModule` for the entries of its person and channel actions,
 * `StaffDirectoryModule` for "recorded by" names, and `PlatformModule` for `SettingsService`
 * (the three catalog settings the channel sync reads).
 */
@Module({
  imports: [AuditModule, StaffDirectoryModule, PlatformModule],
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
    CatalogLocks,
    CostService,
    StylesService,
    SeasonsService,
    ProductGroupsService,
    BarcodesService,
    CostRecordsService,
    CatalogChannelSync,
  ],
  exports: [CatalogService, CatalogLocks, CostService, CatalogChannelSync],
})
export class CatalogModule {}
