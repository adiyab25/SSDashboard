import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { LedgerService } from './ledger/ledger.service.js';
import { ReconciliationService } from './ledger/reconciliation.service.js';
import { LocationPolicyService } from './locations/location-policy.service.js';
import { LocationsController } from './locations/locations.controller.js';
import { LocationsService } from './locations/locations.service.js';
import { ReceiptsController } from './receipts/receipts.controller.js';
import { ReceiptsService } from './receipts/receipts.service.js';
import { SkuLifecycleController } from './sku-lifecycle/sku-lifecycle.controller.js';
import { SkuLifecycleService } from './sku-lifecycle/sku-lifecycle.service.js';
import { StockController } from './stock/stock.controller.js';
import { StockService } from './stock/stock.service.js';

/**
 * Stock: the ledger service is the only writer of movements, balances, serials, and
 * reservations. Imports catalog one way; catalog never imports inventory.
 */
@Module({
  imports: [PlatformModule, CatalogModule, StaffDirectoryModule],
  controllers: [LocationsController, ReceiptsController, StockController, SkuLifecycleController],
  providers: [
    LedgerService,
    ReconciliationService,
    LocationsService,
    LocationPolicyService,
    ReceiptsService,
    StockService,
    SkuLifecycleService,
  ],
  exports: [LedgerService, ReconciliationService, LocationPolicyService],
})
export class InventoryModule {}
