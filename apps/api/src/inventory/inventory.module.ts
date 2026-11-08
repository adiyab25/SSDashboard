import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { PartnersModule } from '../partners/partners.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { LedgerService } from './ledger/ledger.service.js';
import { ReconciliationService } from './ledger/reconciliation.service.js';
import { LocationPolicyService } from './locations/location-policy.service.js';
import { LocationsController } from './locations/locations.controller.js';
import { LocationsService } from './locations/locations.service.js';
import { OwnerPoliciesController } from './locations/owner-policies.controller.js';
import { ReceiptsController } from './receipts/receipts.controller.js';
import { ReceiptsService } from './receipts/receipts.service.js';
import { SkuLifecycleController } from './sku-lifecycle/sku-lifecycle.controller.js';
import { SkuLifecycleService } from './sku-lifecycle/sku-lifecycle.service.js';
import { StockController } from './stock/stock.controller.js';
import { StockService } from './stock/stock.service.js';

/**
 * Stock: the ledger service is the only writer of movements, balances, serials, and
 * reservations. Imports catalog one way; catalog never imports inventory. Records voids and
 * other audited actions through the audit module's exported `AuditService`. Asks the partners
 * module's `PartnerAccounts` whether a location's party holds the owner type's role. Serves the
 * owner type policy edit of the settings screen (spec 0009, AC-24), since it owns that table.
 */
@Module({
  imports: [PlatformModule, CatalogModule, StaffDirectoryModule, AuditModule, PartnersModule],
  controllers: [
    LocationsController,
    OwnerPoliciesController,
    ReceiptsController,
    StockController,
    SkuLifecycleController,
  ],
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
