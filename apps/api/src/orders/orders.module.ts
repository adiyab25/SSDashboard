import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { ConnectorsModule } from '../connectors/connectors.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { PlatformModule } from '../platform/platform.module.js';
import { OrderEditing } from './editing/order-editing.service.js';
import { OrderIntake } from './intake/order-intake.service.js';
import { OrderMovesController } from './moves/order-moves.controller.js';
import { OrderTransactions } from './order-transactions.js';
import { OrderQueries } from './reading/order-query.service.js';
import { OrdersController } from './reading/orders.controller.js';
import { OrderStock } from './stock/order-stock.js';
import { OrderTransitions } from './transitions/order-transitions.service.js';
import { WriteBackProjection } from './projections/write-back.projection.js';
import { OrderWriter } from './writer/order-writer.js';

/**
 * The orders module (spec 0013): the only writer of `orders`, `order_lines`, and `order_events`.
 * Other features move an order only through the exported write paths inside one
 * `OrderTransactions.run`, and read it through `OrderQueries`. Core, no toggle (its routes take
 * `@RequiresModule('orders')` when spec 0009's module registry lands). Milestones 1 and 2 hold the
 * manual, gifted, reopened, and replacement order, the list and search, the order page, editing
 * (`OrderEditing`), confirm, cancel, pack, and unpack (`OrderTransitions`), and the write back
 * projection; channel intake, stock, and the carrier and cash moves follow in later milestones.
 * It reads stores, channels, customers, SKUs, staff names, and outbound commands only through
 * their owners' services.
 */
@Module({
  imports: [
    AuditModule,
    CatalogModule,
    ChannelsModule,
    ConnectorsModule,
    CustomersModule,
    PlatformModule,
    StaffDirectoryModule,
  ],
  controllers: [OrdersController, OrderMovesController],
  providers: [
    OrderTransactions,
    OrderWriter,
    OrderIntake,
    OrderEditing,
    OrderTransitions,
    OrderStock,
    OrderQueries,
    WriteBackProjection,
  ],
  exports: [OrderTransactions, OrderIntake, OrderEditing, OrderTransitions, OrderQueries],
})
export class OrdersModule {}
