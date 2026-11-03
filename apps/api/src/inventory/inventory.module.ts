import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { LedgerService } from './ledger/ledger.service.js';
import { ReconciliationService } from './ledger/reconciliation.service.js';

/** Stock: the ledger service is the only writer of movements, balances, serials, and reservations. */
@Module({
  imports: [PlatformModule],
  providers: [LedgerService, ReconciliationService],
  exports: [LedgerService, ReconciliationService],
})
export class InventoryModule {}
