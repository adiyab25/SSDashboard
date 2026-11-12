import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module.js';
import { ChannelsModule } from '../../channels/channels.module.js';
import { StaffDirectoryModule } from '../../identity/staff/staff-directory.js';
import { OrdersModule } from '../../orders/orders.module.js';
import { PlatformModule } from '../../platform/platform.module.js';
import { CustomersModule } from '../customers.module.js';
import { CustomerFlagsController } from '../flags/customer-flags.controller.js';
import { CustomerFlags } from '../flags/customer-flags.service.js';
import { ChannelLabels } from './channel-labels.js';
import { CustomerProfileController } from './customer-profile.controller.js';
import { CustomerProfileService } from './customer-profile.service.js';
import { CustomerRiskSignals } from './customer-risk-signals.js';
import { CustomerTimelineService } from './customer-timeline.service.js';

/**
 * The customers module's leaf (spec 0014 Decision): the profile, the timeline, the returner
 * signal, and the flag routes, which read orders through the orders module's `OrderQueries`. The
 * orders module imports `CustomersModule`, so these parts cannot live there without a cycle; only
 * `AppModule` imports this module (listed after `CustomersModule`, so `GET merge-suggestions` is
 * matched before `GET :id`), and it exports nothing. It reads stores and channels through
 * `ChannelsService`, settings through `SettingsService`, and staff names through `StaffDirectory`.
 */
@Module({
  imports: [
    AuditModule,
    ChannelsModule,
    CustomersModule,
    OrdersModule,
    PlatformModule,
    StaffDirectoryModule,
  ],
  controllers: [CustomerFlagsController, CustomerProfileController],
  providers: [
    ChannelLabels,
    CustomerFlags,
    CustomerProfileService,
    CustomerRiskSignals,
    CustomerTimelineService,
  ],
})
export class CustomerProfileModule {}
