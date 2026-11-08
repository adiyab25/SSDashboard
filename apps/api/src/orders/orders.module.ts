import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { PlatformModule } from '../platform/platform.module.js';
import { OrderIntake } from './intake/order-intake.service.js';
import { OrderTransactions } from './order-transactions.js';
import { OrderQueries } from './reading/order-query.service.js';
import { OrdersController } from './reading/orders.controller.js';
import { OrderWriter } from './writer/order-writer.js';

/**
 * The orders module (spec 0013): the only writer of `orders`, `order_lines`, and `order_events`.
 * Other features move an order only through the exported write paths inside one
 * `OrderTransactions.run`, and read it through `OrderQueries`. Core, no toggle. Milestone 1 holds
 * the manual, gifted, reopened, and replacement order, the list and search, and the order page;
 * editing, cancelling, packing, channel intake, stock, and the carrier and cash moves follow in
 * later milestones. It reads stores, channels, customers, SKUs, and staff names only through
 * their owners' services.
 */
@Module({
  imports: [
    AuditModule,
    CatalogModule,
    ChannelsModule,
    CustomersModule,
    PlatformModule,
    StaffDirectoryModule,
  ],
  controllers: [OrdersController],
  providers: [OrderTransactions, OrderWriter, OrderIntake, OrderQueries],
  exports: [OrderTransactions, OrderIntake, OrderQueries],
})
export class OrdersModule {}
