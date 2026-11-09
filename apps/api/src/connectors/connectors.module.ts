import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { ChannelsService } from '../channels/channels.service.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ConnectionSecrets } from './connections/connection-secrets.js';
import { ConnectionStores } from './connections/connection-stores.js';
import { ConnectionsController } from './connections/connections.controller.js';
import { ConnectionsService } from './connections/connections.service.js';
import { GoLiveClock } from './connections/go-live-clock.js';
import { ConnectorsService } from './connectors.service.js';
import { ShopifyHookVerifier } from './hooks/shopify-hook-verifier.js';
import { ShopifyHooksController } from './hooks/shopify-hooks.controller.js';
import { ShopifyHooksService } from './hooks/shopify-hooks.service.js';
import { FreshnessController } from './freshness/freshness.controller.js';
import { FreshnessService } from './freshness/freshness.service.js';
import { SyncRuns } from './sync-runs/sync-runs.js';

/**
 * The connectors module (spec 0015), in the api and the worker alike: `ConnectorsService` (the
 * outbound command reads and `writeBackAvailable` spec 0013 needs), the four `OutboundCommand*`
 * event classes, and from task 6 the connections: `ConnectionsController` (`/api/connections`),
 * `ConnectionsService`, `ConnectionSecrets` (the only place a stored secret opens), and the
 * `ConnectionStoreSource` it registers with `ChannelsService` when it starts, so channels never
 * reads `connections`; from task 7 the Shopify hook (`ShopifyHooksController`,
 * `POST /api/hooks/shopify/:connectionId`), its signature check (`ShopifyHookVerifier`, run by
 * `mountHooks` before the guards), and the inbox writer (`ShopifyHooksService`); from task 12 the
 * sync runs (`SyncRuns`, exported for the worker's jobs) and the freshness line
 * (`FreshnessController`, `GET /api/connections/freshness`, `FreshnessService`). It owns the
 * connector tables (`table-ownership.ts`). It must never import the orders module (orders imports
 * it), and never calls Shopify: only `ConnectorsWorkerModule`'s jobs do.
 */
@Module({
  imports: [AuditModule, ChannelsModule, PlatformModule],
  // `FreshnessController` first: its `connections/freshness` route must be matched before
  // `ConnectionsController`'s `connections/:id`.
  controllers: [FreshnessController, ConnectionsController, ShopifyHooksController],
  providers: [
    ConnectorsService,
    ConnectionsService,
    ConnectionSecrets,
    ConnectionStores,
    ShopifyHookVerifier,
    ShopifyHooksService,
    SyncRuns,
    FreshnessService,
    GoLiveClock,
  ],
  exports: [ConnectorsService, ConnectionSecrets, ShopifyHookVerifier, SyncRuns],
})
export class ConnectorsModule implements OnModuleInit {
  /** Takes the channels service and the store source it registers there. */
  constructor(
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(ConnectionStores) private readonly stores: ConnectionStores,
  ) {}

  /** Registers the connection store source once per process (spec 0015 *Exported services*). */
  onModuleInit(): void {
    this.channels.registerConnectionStores(this.stores);
  }
}
