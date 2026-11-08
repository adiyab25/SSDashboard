import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ConnectorsModule } from './connectors.module.js';
import { ConnectJob } from './shopify/connect.job.js';
import { ConnectorClock } from './shopify/connector-clock.js';
import { ConnectorShopifyWorker } from './shopify/connector-shopify.worker.js';
import { InboxJob } from './shopify/inbox.job.js';
import { ShopifyClient } from './shopify/shopify-client.js';

/**
 * The connectors module's worker half (spec 0015 tasks 6 and 7): the process's one
 * `ShopifyClient` (token cache, rate policy; `SHOPIFY_MOCK_ORIGIN` when set), the
 * `connector-shopify` queue and its handler (`ConnectorShopifyWorker`, declared through the
 * worker's `JobRegistry`), the `connect` job, and the `inbox` job, which applies orders through
 * the orders module's `OrderTransactions` and `OrderIntake`. Imported only by `WorkerModule`: the
 * api never calls Shopify (spec 0015 key invariants). In its own file, apart from
 * `ConnectorsModule`, because it imports `OrdersModule`, which imports `ConnectorsModule`.
 */
@Module({
  imports: [ConnectorsModule, ChannelsModule, PlatformModule, OrdersModule],
  providers: [
    {
      provide: ShopifyClient,
      useFactory: (env: Env) => new ShopifyClient({ mockOrigin: env.SHOPIFY_MOCK_ORIGIN }),
      inject: [ENV],
    },
    ConnectorClock,
    ConnectJob,
    InboxJob,
    ConnectorShopifyWorker,
  ],
})
export class ConnectorsWorkerModule {}
