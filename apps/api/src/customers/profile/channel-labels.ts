import { Injectable, Logger } from '@nestjs/common';
import type { LocalizedText } from '@ssdashboard/contracts';
import { ChannelsError } from '../../channels/channels.errors.js';
import { ChannelsService } from '../../channels/channels.service.js';
import type { Executor } from '../../database/sql.js';

/** Where one channel customer id came from: the store of its Shopify connection, or its partner channel. */
export interface ChannelIdLabel {
  storeCode: string | null;
  storeName: LocalizedText | null;
  channelCode: string | null;
  channelName: LocalizedText | null;
}

/** The issuer columns of a `customer_external_ids` row. */
export interface ChannelIdIssuer {
  connection_id: string | null;
  channel_id: string | null;
}

/**
 * Labels channel customer ids for the profile and the timeline (spec 0014 Value sourcing): the
 * store of a Shopify id through `ChannelsService.storeLabelsByConnection`, the channel of a
 * partner reference through `ChannelsService.channels`. Read only; it never reads the channels or
 * connectors tables itself. Until the connectors module registers its connection store source, a
 * Shopify id is labelled with nulls and one warning is logged per process.
 */
@Injectable()
export class ChannelLabels {
  private readonly logger = new Logger('CustomerProfile');
  private warnedStoresNotRegistered = false;

  /** Takes the channels service. */
  constructor(private readonly channels: ChannelsService) {}

  /** The label of each row, in the order of `rows`. */
  async of(db: Executor, rows: readonly ChannelIdIssuer[]): Promise<ChannelIdLabel[]> {
    const connectionIds = [
      ...new Set(rows.flatMap((row) => (row.connection_id === null ? [] : [row.connection_id]))),
    ];
    const channelIds = [
      ...new Set(rows.flatMap((row) => (row.channel_id === null ? [] : [row.channel_id]))),
    ];
    const stores = new Map<string, { code: string; name: LocalizedText }>();
    try {
      for (const label of await this.channels.storeLabelsByConnection(connectionIds, db)) {
        stores.set(label.connectionId, { code: label.storeCode, name: label.storeName });
      }
    } catch (error) {
      // Until the connectors module registers its source, a Shopify id shows without a store label.
      if (!(error instanceof ChannelsError) || error.code !== 'CONNECTION_STORES_NOT_REGISTERED') {
        throw error;
      }
      if (!this.warnedStoresNotRegistered) {
        this.warnedStoresNotRegistered = true;
        this.logger.warn(
          'CONNECTION_STORES_NOT_REGISTERED: Shopify customer ids are shown without a store label until the connectors module registers its source',
        );
      }
    }
    const channels = new Map(
      (await this.channels.channels(channelIds, db)).map((channel) => [channel.id, channel]),
    );
    return rows.map((row) => {
      const store = row.connection_id === null ? undefined : stores.get(row.connection_id);
      const channel = row.channel_id === null ? undefined : channels.get(row.channel_id);
      return {
        storeCode: store?.code ?? null,
        storeName: store?.name ?? null,
        channelCode: channel?.code ?? null,
        channelName: channel?.name ?? null,
      };
    });
  }
}
