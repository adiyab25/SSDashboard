import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { CustomersService } from './customers.service.js';
import { CustomerProfileController } from './profile/customer-profile.controller.js';
import { CustomerProfileService } from './profile/customer-profile.service.js';
import { CustomerSearchThrottle } from './search/customer-search-throttle.js';
import { CustomerSearchController } from './search/customer-search.controller.js';
import { CustomerSearchService } from './search/customer-search.service.js';

/**
 * The customers module (spec 0014): one customer per normalized phone. It owns the customer
 * tables and exports `CustomersService`, the only way any module links, finds, or flags a
 * customer. Core, no toggle. Milestone 1 holds find or create, search, and the profile; merge,
 * flag, and the timeline follow in later milestones.
 */
@Module({
  imports: [ChannelsModule, StaffDirectoryModule],
  controllers: [CustomerSearchController, CustomerProfileController],
  providers: [
    CustomersService,
    CustomerSearchService,
    CustomerProfileService,
    // One window per api process (README, Decisions); the factory keeps the defaults of the constants.
    { provide: CustomerSearchThrottle, useFactory: () => new CustomerSearchThrottle() },
  ],
  exports: [CustomersService],
})
export class CustomersModule {}
