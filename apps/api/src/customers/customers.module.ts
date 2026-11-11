import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditUndoRegistry } from '../audit/audit-undo.registry.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { CustomersService } from './customers.service.js';
import { CustomerMergeUndoHandler } from './merges/customer-merge-undo.handler.js';
import { CustomerMerges, MERGE_UNDO_HANDLER } from './merges/customer-merges.service.js';
import { CustomerMergesController } from './merges/customer-merges.controller.js';
import { MergeSuggestions } from './merges/merge-suggestions.service.js';
import { CustomerProfileController } from './profile/customer-profile.controller.js';
import { CustomerProfileService } from './profile/customer-profile.service.js';
import { CustomerSearchThrottle } from './search/customer-search-throttle.js';
import { CustomerSearchController } from './search/customer-search.controller.js';
import { CustomerSearchService } from './search/customer-search.service.js';

/**
 * The customers module (spec 0014): one customer per normalized phone. It owns the customer
 * tables and exports `CustomersService`, the only way any module links, finds, or flags a
 * customer. Core, no toggle. It holds find or create, `addPhone`, search, the profile, and merge
 * and undo with the merge suggestions (milestone 2); the flag and the timeline follow. It
 * registers the audit undo handler `customers.merge_undo` from `onModuleInit`; `AppModule`
 * imports it, so the api's undo start check finds the handler.
 */
@Module({
  imports: [AuditModule, ChannelsModule, StaffDirectoryModule],
  // The merge controller comes before the profile one, so `GET merge-suggestions` is matched
  // before `GET :id` (README).
  controllers: [CustomerSearchController, CustomerMergesController, CustomerProfileController],
  providers: [
    CustomersService,
    CustomerSearchService,
    CustomerProfileService,
    CustomerMerges,
    MergeSuggestions,
    CustomerMergeUndoHandler,
    // One window per api process (README, Decisions); the factory keeps the defaults of the constants.
    { provide: CustomerSearchThrottle, useFactory: () => new CustomerSearchThrottle() },
  ],
  exports: [CustomersService],
})
export class CustomersModule implements OnModuleInit {
  /** Takes the undo registry and this module's undo handler. */
  constructor(
    @Inject(AuditUndoRegistry) private readonly undos: AuditUndoRegistry,
    @Inject(CustomerMergeUndoHandler) private readonly mergeUndo: CustomerMergeUndoHandler,
  ) {}

  /** Registers the audit screen's undo of `customer.merged` on behalf of `customers`. */
  onModuleInit(): void {
    this.undos.register(MERGE_UNDO_HANDLER, this.mergeUndo, 'customers');
  }
}
