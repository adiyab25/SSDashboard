import type { Executor } from '../database/sql.js';

/** One connection and the store it is bound to. */
export interface ConnectionStore {
  /** The connection's id. */
  connectionId: string;
  /** The store the connection belongs to. */
  storeId: string;
}

/**
 * What the connectors module gives the channels module so `storeLabelsByConnection` can name the
 * store of a connection without channels reading `connections` (a table connectors owns, spec 0002
 * A5). The connectors module registers one with `ChannelsService.registerConnectionStores` when it
 * starts. An implementation answers only connections that have a store, reads through the given
 * executor, and must never return credentials or any other column of a connection.
 */
export interface ConnectionStoreSource {
  /** The store of each given connection id; ids with no connection or no store are left out. */
  storeIdsByConnection(
    connectionIds: readonly string[],
    executor: Executor,
  ): Promise<ConnectionStore[]>;
}
