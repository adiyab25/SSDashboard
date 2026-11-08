import { Injectable } from '@nestjs/common';
import { sql } from '@ssdashboard/db';
import type {
  ConnectionStore,
  ConnectionStoreSource,
} from '../../channels/connection-store-source.js';
import { pgArray, type Executor } from '../../database/sql.js';

/**
 * The connectors module's `ConnectionStoreSource` (spec 0015 *Exported services*): which store
 * each connection belongs to, so `ChannelsService.storeLabelsByConnection` never reads
 * `connections`. `ConnectorsModule` registers it with `ChannelsService.registerConnectionStores`
 * from its `onModuleInit`. Reads only `id` and `store_id`, never credentials or any other column.
 */
@Injectable()
export class ConnectionStores implements ConnectionStoreSource {
  /** The store of each given connection that has one; unknown ids and storeless connections are left out. */
  async storeIdsByConnection(
    connectionIds: readonly string[],
    executor: Executor,
  ): Promise<ConnectionStore[]> {
    if (connectionIds.length === 0) return [];
    const { rows } = await executor.execute<{ id: string; store_id: string }>(sql`
      SELECT id, store_id FROM connections
      WHERE id = ANY(${pgArray([...new Set(connectionIds)])}::uuid[]) AND store_id IS NOT NULL`);
    return rows.map((row) => ({ connectionId: row.id, storeId: row.store_id }));
  }
}
