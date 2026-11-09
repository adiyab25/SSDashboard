import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module.js';
import { ENV } from '../config/config.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import type { Env } from '../config/env.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ConnectorsModule } from './connectors.module.js';
import { InboxPurgeJob } from './inbox/inbox-purge.job.js';
import { BackfillJob } from './shopify/backfill.job.js';
import { BulkRunProgress } from './shopify/bulk-run-progress.js';
import { BulkRunner } from './shopify/bulk-runner.js';
import { ConnectJob } from './shopify/connect.job.js';
import { ConnectionAccess } from './shopify/connection-access.js';
import { ConnectorBudget } from './shopify/connector-budget.js';
import { ConnectorClock } from './shopify/connector-clock.js';
import { ConnectorShopifyWorker } from './shopify/connector-shopify.worker.js';
import { ExchangeByEdit } from './shopify/exchange-by-edit.js';
import { GatewayScanJob } from './shopify/gateway-scan.job.js';
import { HourlyCheckJob } from './shopify/hourly-check.job.js';
import { InboxJob } from './shopify/inbox.job.js';
import { ShopifyClient } from './shopify/shopify-client.js';
import { SweepJob } from './shopify/sweep.job.js';

/**
 * The connectors module's worker half (spec 0015 tasks 6, 7, 9, 10, 11, and 12): the process's
 * one `ShopifyClient` (token cache, rate policy; `SHOPIFY_MOCK_ORIGIN` when set), the
 * `connector-shopify` queue, its schedules, and its handlers (`ConnectorShopifyWorker`, declared
 * through the worker's `JobRegistry`), the `connect` job, the `inbox` job (which applies orders
 * through the orders module's `OrderTransactions`, `OrderIntake`, and `OrderTransitions`, and
 * Shopify customers through the customers module's exported `CustomersService`), `ExchangeByEdit`
 * (task 10: replacement orders for lines added while a fulfillment is active), and task 12's
 * sweeps, hourly check (which retries waiting replacements through
 * `ExchangeByEdit.retryWaitingReplacements`), gateway scan, backfill (through the `BulkRunner`),
 * and inbox purge, with the `ConnectorClock` and `ConnectorBudget` a test may replace. Imported
 * only by `WorkerModule`: the api never calls Shopify (spec 0015 key invariants). In its own file,
 * apart from `ConnectorsModule`, because it imports `OrdersModule`, which imports
 * `ConnectorsModule`.
 */
@Module({
  imports: [ConnectorsModule, ChannelsModule, CustomersModule, PlatformModule, OrdersModule],
  providers: [
    {
      provide: ShopifyClient,
      useFactory: (env: Env) => new ShopifyClient({ mockOrigin: env.SHOPIFY_MOCK_ORIGIN }),
      inject: [ENV],
    },
    ConnectorClock,
    ConnectorBudget,
    ConnectionAccess,
    ConnectJob,
    ExchangeByEdit,
    InboxJob,
    SweepJob,
    HourlyCheckJob,
    BulkRunner,
    BulkRunProgress,
    GatewayScanJob,
    BackfillJob,
    InboxPurgeJob,
    ConnectorShopifyWorker,
  ],
  // Task 12's hourly check takes the waiting replacements through `retryWaitingReplacements`.
  exports: [ExchangeByEdit],
})
export class ConnectorsWorkerModule {}
