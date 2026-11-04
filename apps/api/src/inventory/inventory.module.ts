import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { LedgerService } from './ledger/ledger.service.js';
import { ReconciliationService } from './ledger/reconciliation.service.js';
import { LocationsController } from './locations/locations.controller.js';
import { LocationsService } from './locations/locations.service.js';

/** Stock: the ledger service is the only writer of movements, balances, serials, and reservations. */
@Module({
  imports: [PlatformModule],
  controllers: [LocationsController],
  providers: [LedgerService, ReconciliationService, LocationsService],
  exports: [LedgerService, ReconciliationService],
})
export class InventoryModule {}
