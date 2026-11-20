import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { ConnectorsModule } from '../connectors/connectors.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { StaffDirectoryModule } from '../identity/staff/staff-directory.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { OrderEditing } from './editing/order-editing.service.js';
import { OrderIntake } from './intake/order-intake.service.js';
import { OrderMovesController } from './moves/order-moves.controller.js';
import { OrderTransactions } from './order-transactions.js';
import { OrderQueries } from './reading/order-query.service.js';
import { ShipmentJobs } from './shipment/shipment-jobs.js';
import { ShipmentPosting } from './shipment/shipment-posting.js';
import { OrderTaskLink } from './reading/order-task-link.js';
import { OrdersController } from './reading/orders.controller.js';
import { AwaitingRestockController } from './stock/awaiting-restock.controller.js';
import { OrderStockController } from './stock/order-stock.controller.js';
import { OrderStock } from './stock/order-stock.js';
import { ShortLinesProjection } from './stock/short-lines.projection.js';
import { OrderTransitions } from './transitions/order-transitions.service.js';
import { WriteBackProjection } from './projections/write-back.projection.js';
import { OrderWriter } from './writer/order-writer.js';

/**
 * The orders module (spec 0013): the only writer of `orders`, `order_lines`, and `order_events`.
 * Other features move an order only through the exported write paths inside one
 * `OrderTransactions.run`, and read it through `OrderQueries`. Core, no toggle (every controller
 * declares `@RequiresModule('orders')`, spec 0009). Milestones 1 to 4 hold the manual, gifted,
 * reopened, and replacement order, the list and search, the order page, editing (`OrderEditing`),
 * confirm, cancel, pack, and unpack (`OrderTransitions`), the write back projection, feature 13's
 * channel intake, and stock (`OrderStock` with spec 0011's reservations, the short lines
 * projection, the `orders.open_orders_held` gate check, and `hold-open-orders`); milestone 5 adds
 * the carrier and cash moves on `OrderTransitions` and the stock side of the carrier facts
 * (`ShipmentJobs` sends the `orders.post_shipment` jobs, `ShipmentPosting` does their work, run in
 * the worker by `OrdersWorkerModule`), and task 15's Shopify half: `recordChannelStockOut` and
 * `recordChannelFulfillmentCancelled` on `OrderTransitions`, and on `OrderStock` (exported for
 * features 13, 20, and 21) `recordChannelReturn`, `restockAwaiting`, `closeAwaiting`,
 * `postChannelFulfillment`, and `pendingFor`, with the awaiting restock routes
 * (`AwaitingRestockController`). It reads stores, channels, customers, SKUs, staff names,
 * outbound commands, and stock only through their owners' services.
 */
@Module({
  imports: [
    AuditModule,
    CatalogModule,
    ChannelsModule,
    ConnectorsModule,
    CustomersModule,
    InventoryModule,
    PlatformModule,
    StaffDirectoryModule,
    TasksModule,
  ],
  controllers: [
    OrdersController,
    OrderMovesController,
    OrderStockController,
    AwaitingRestockController,
  ],
  providers: [
    OrderTransactions,
    OrderWriter,
    OrderIntake,
    OrderEditing,
    OrderTransitions,
    OrderStock,
    OrderQueries,
    WriteBackProjection,
    ShortLinesProjection,
    OrderTaskLink,
    ShipmentJobs,
    ShipmentPosting,
  ],
  exports: [
    OrderTransactions,
    OrderIntake,
    OrderEditing,
    OrderTransitions,
    OrderQueries,
    OrderStock,
    ShipmentPosting,
  ],
})
export class OrdersModule {}
