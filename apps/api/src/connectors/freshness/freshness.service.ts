import { Inject, Injectable } from '@nestjs/common';
import {
  ConnectionFreshnessResponse,
  FRESHNESS_LATE_AFTER_MINUTES,
  type ConnectionFreshnessState,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { ChannelsService } from '../../channels/channels.service.js';
import { DATABASE } from '../../database/database.module.js';

interface FreshnessRow extends Record<string, unknown> {
  id: string;
  store_id: string | null;
  health: string;
  last_order_at: string | null;
  last_sweep_at: string | null;
  late: boolean;
  failed_commands: number;
  failed_order_events: number;
  as_of: string;
}

/**
 * The freshness line's data (spec 0015 AC-8, AC-18, *Value sourcing* freshness rows): per active
 * connection, the store's public name in both languages (from `ChannelsService`), `last_order_at`,
 * `last_sweep_at`, the failed outbound commands, the orders whose latest inbox event is `failed`,
 * and the state: `failing` on health `failing`, else `late` when the connection is live (it has an
 * orders sweep watermark, set by its first backfill) and its last successful orders sweep is older
 * than 15 minutes (or missing), else `fresh`. Every age is judged by the database clock, and the
 * answer carries that clock's instant (`asOf`). Reads only; never a credential or personal data.
 */
@Injectable()
export class FreshnessService {
  /** Takes the database and the channels service. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
  ) {}

  /** The freshness of every active connection, oldest connection first. */
  async freshness(): Promise<ConnectionFreshnessResponse> {
    const utc = (column: string) =>
      sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
    const { rows } = await this.connection.db.execute<FreshnessRow>(sql`
      SELECT c.id, c.store_id, c.health::text AS health,
             ${utc('c.last_order_at')} AS last_order_at,
             ${utc('c.last_sweep_at')} AS last_sweep_at,
             (c.orders_swept_through IS NOT NULL
              AND (c.last_sweep_at IS NULL
                   OR c.last_sweep_at < now() - make_interval(mins => ${FRESHNESS_LATE_AFTER_MINUTES})))
               AS late,
             (SELECT count(*)::int FROM outbound_commands o
              WHERE o.connection_id = c.id AND o.sync_state = 'failed') AS failed_commands,
             (SELECT count(DISTINCT f.subject_external_id)::int FROM inbound_events f
              WHERE f.connection_id = c.id AND f.status = 'failed' AND f.subject_type = 'order'
                AND f.subject_external_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM inbound_events l
                  WHERE l.connection_id = f.connection_id AND l.subject_type = 'order'
                    AND l.subject_external_id = f.subject_external_id
                    AND (l.received_at, l.id) > (f.received_at, f.id))) AS failed_order_events,
             ${utc('now()')} AS as_of
      FROM connections c
      WHERE c.status = 'active'
      ORDER BY c.created_at, c.id`);
    const storeIds = [...new Set(rows.flatMap((row) => (row.store_id ? [row.store_id] : [])))];
    const names = new Map(
      (await this.channels.stores(storeIds)).map((store) => [store.id, store.publicName]),
    );
    const asOf =
      rows[0]?.as_of ??
      (await this.connection.db.execute<{ as_of: string }>(sql`SELECT ${utc('now()')} AS as_of`))
        .rows[0]?.as_of;
    return ConnectionFreshnessResponse.parse({
      asOf,
      items: rows.map((row) => {
        const state: ConnectionFreshnessState =
          row.health === 'failing' ? 'failing' : row.late ? 'late' : 'fresh';
        return {
          connectionId: row.id,
          storePublicName: (row.store_id ? names.get(row.store_id) : undefined) ?? {},
          lastOrderAt: row.last_order_at,
          lastSweepAt: row.last_sweep_at,
          failedCommands: row.failed_commands,
          failedOrderEvents: row.failed_order_events,
          state,
        };
      }),
    });
  }
}
