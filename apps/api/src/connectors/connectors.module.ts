import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service.js';

/**
 * The connectors module (spec 0015), as a stand-in: today only `ConnectorsService` with the
 * outbound command reads and `writeBackAvailable` that spec 0013 milestone 2 needs, plus the four
 * `OutboundCommand*` event classes. It owns the connector tables (`connections`,
 * `outbound_commands`, and the rest in `table-ownership.ts`) and has no routes yet; spec 0015
 * task 13 adds the outbound framework. It must never import the orders module (orders imports it).
 */
@Module({
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
