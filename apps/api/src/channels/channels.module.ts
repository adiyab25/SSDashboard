import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service.js';

/**
 * The channels module (spec 0015 task 2): stores and channels through one exported service,
 * `ChannelsService`. It owns `stores` and `channels` and has no routes: a Shopify store is
 * created through the connect route of the connectors module. Core, no toggle.
 */
@Module({
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
