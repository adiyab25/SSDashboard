import { Inject, Injectable } from '@nestjs/common';
import type { AuditActor } from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import { CatalogChannelSync } from '../../catalog/channel-sync/catalog-channel-sync.js';
import { pgArray, type Transaction } from '../../database/sql.js';

/** How many catalog ids one `unlink` call takes (well inside its 10,000 and 100,000 caps). */
const UNLINK_CHUNK = 5_000;

/** What `ProductUnlink` gave back to the app. */
export interface UnlinkCounts {
  /** Styles whose channel link was cleared. */
  readonly styles: number;
  /** Variants whose channel link was cleared. */
  readonly variants: number;
}

/**
 * Gives a connection's catalog fields back to the app (spec 0015 AC-16, *State machines*
 * `connections.status`; spec 0012 AC-15 and its Follow-up): `CatalogChannelSync.unlink` for the
 * styles and variants the connection's product and variant mappings name and that no other live
 * mapping holds (a mapping not removed, of a connection that is not archived), so a style two
 * stores sell keeps the other store's link. Runs in the caller's transaction and writes no
 * mapping row: the mappings stay for history.
 *
 * - `forConnection` is the archive step (task 16's archive route calls it in the transaction that
 *   archives the connection).
 * - `forGone` is a Shopify variant gone from its product's read back (the product job calls it).
 *
 * Never unlinks a style or variant another live mapping still holds, and never touches a catalog
 * row itself (only `CatalogChannelSync` writes the catalog).
 */
@Injectable()
export class ProductUnlink {
  /** Takes the catalog's channel contract. */
  constructor(@Inject(CatalogChannelSync) private readonly catalog: CatalogChannelSync) {}

  /**
   * The archive step: every style and variant the connection's product and variant mappings name
   * (removed ones included: a deleted Shopify product keeps its catalog link until here) that no
   * mapping of another connection that is not archived holds. `actor` is a `system_job` (the
   * catalog refuses anything else).
   */
  async forConnection(
    tx: Transaction,
    connectionId: string,
    actor: AuditActor,
  ): Promise<UnlinkCounts> {
    return this.unlinkWhere(
      tx,
      sql`m.connection_id = ${connectionId}::uuid`,
      sql`o.connection_id <> ${connectionId}::uuid`,
      actor,
    );
  }

  /**
   * The mappings `mappingIds` (variant or product rows) are gone from Shopify: their styles and
   * variants are unlinked unless another live mapping (not one of these) still holds them.
   */
  async forGone(
    tx: Transaction,
    mappingIds: readonly string[],
    actor: AuditActor,
  ): Promise<UnlinkCounts> {
    if (mappingIds.length === 0) return { styles: 0, variants: 0 };
    const ids = pgArray([...mappingIds]);
    return this.unlinkWhere(
      tx,
      sql`m.id = ANY(${ids}::uuid[])`,
      sql`o.id <> ALL(${ids}::uuid[])`,
      actor,
    );
  }

  /** The catalog ids of the mappings `scope` selects that no live mapping `others` holds. */
  private async unlinkWhere(
    tx: Transaction,
    scope: SQL,
    others: SQL,
    actor: AuditActor,
  ): Promise<UnlinkCounts> {
    const { rows } = await tx.execute<{ entity: 'product' | 'variant'; local_id: string }>(sql`
      SELECT DISTINCT m.entity, m.local_id FROM connection_external_ids m
      WHERE ${scope} AND m.entity IN ('product', 'variant') AND m.local_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM connection_external_ids o
          JOIN connections c ON c.id = o.connection_id
          WHERE o.entity = m.entity AND o.local_id = m.local_id AND o.removed_at IS NULL
            AND c.status <> 'archived' AND ${others})
      ORDER BY m.local_id`);
    const styleIds = rows.filter((row) => row.entity === 'product').map((row) => row.local_id);
    const variantIds = rows.filter((row) => row.entity === 'variant').map((row) => row.local_id);
    let styles = 0;
    let variants = 0;
    for (let i = 0; i < Math.max(styleIds.length, variantIds.length); i += UNLINK_CHUNK) {
      const done = await this.catalog.unlink(
        tx,
        {
          styleIds: styleIds.slice(i, i + UNLINK_CHUNK),
          variantIds: variantIds.slice(i, i + UNLINK_CHUNK),
        },
        actor,
      );
      styles += done.styles;
      variants += done.variants;
    }
    return { styles, variants };
  }
}
