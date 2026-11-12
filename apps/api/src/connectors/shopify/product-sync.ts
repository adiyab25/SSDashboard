import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAX_CHANNEL_VARIANTS, type AuditActor } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { CatalogChannelSync } from '../../catalog/channel-sync/catalog-channel-sync.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { OrderIntake } from '../../orders/intake/order-intake.service.js';
import { OrderTransactions, type OrderTransaction } from '../../orders/order-transactions.js';
import {
  InvalidOrderInput,
  LineAlreadyMapped,
  OrderLockTimeout,
  VariantUnknown,
} from '../../orders/orders.errors.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { ProductUnlink } from '../connections/product-unlink.js';
import { ATTENTION_OUTCOMES, ChannelProductNeedsAttention } from '../connectors.events.js';
import { orderErrorCodeOf } from './error-codes.js';
import { parseOrderMappingState, type OrderMappingState } from './order-mapping-state.js';
import {
  mapShopifyProduct,
  parseProductOfVariant,
  parseShopifyProductPage,
  parseShopifyVariantsPage,
  ShopifyProductMappingError,
  type ShopifyProduct,
  type ShopifyProductVariant,
} from './product-mapper.js';
import {
  ShopifyClient,
  type ShopifyConnectionAccess,
  type ShopifyWarning,
} from './shopify-client.js';
import {
  PRODUCT_OF_VARIANT_READ,
  PRODUCT_OF_VARIANT_READ_EXPECTED_COST,
  PRODUCT_OF_VARIANT_READ_OPERATION,
  PRODUCT_READ,
  PRODUCT_READ_ESTIMATED_COST,
  PRODUCT_READ_OPERATION,
  PRODUCT_VARIANTS_PAGE,
  PRODUCT_VARIANTS_PAGE_OPERATION,
} from './shopify-queries.js';

/** The most waiting orders one product apply links in a run; the next read back links the rest. */
export const LATE_LINK_ORDERS_MAX = 500;

/** A read's value and the warnings of every answer it took. */
export interface ProductReadAnswer<T> {
  /** What was read. */
  readonly value: T;
  /** `API_VERSION_FELL_FORWARD` when any answer of the read carried it. */
  readonly warnings: readonly ShopifyWarning[];
}

/** How one product apply ended, for the inbox event and the late links. */
export interface ProductApplied {
  /** The inbox event's status. */
  readonly status: 'processed' | 'ignored';
  /**
   * Its outcome: `stale`, `not_visible`, `gift_card`, `product_removed`, `needs_attention` (a
   * variant took an attention outcome), or null.
   */
  readonly outcome: string | null;
  /** Shopify variant gids that map to an app variant now and did not before (late links). */
  readonly newlyMapped: readonly string[];
}

/** Where a product applies: the connection and its store. */
export interface ProductTarget {
  readonly connectionId: string;
  readonly storeId: string;
}

/** A product or variant mapping row, read under its row lock. */
interface MappingRow extends Record<string, unknown> {
  id: string;
  external_id: string;
  local_id: string | null;
  external_version: string | null;
  removed: boolean;
  state: unknown;
}

/** A variant mapping's `state` (spec 0015 data model: `inventoryItemId`, `tracked`, `lastOutcome`). */
interface VariantState {
  /** The Shopify product gid the variant belongs to (to find the variants gone from it). */
  readonly productId: string;
  /** The variant's Shopify inventory item gid (the stock push of milestone 3 sets levels on it). */
  readonly inventoryItemId: string;
  /** Whether Shopify tracks the item's inventory. */
  readonly tracked: boolean;
  /** The catalog's last outcome for the variant (`ChannelVariantOutcome`). */
  readonly lastOutcome: string;
}

/** The `lastOutcome` of a mapping state, or null. */
function lastOutcomeOf(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const value = (state as Record<string, unknown>)['lastOutcome'];
  return typeof value === 'string' ? value : null;
}

/** A Shopify instant as the UTC ISO text bound in SQL. */
function isoOf(instant: string): string {
  return new Date(instant).toISOString();
}

/**
 * The products of spec 0015 task 8 (AC-16, AC-9, Inbound processing items 3 and 6), worker side:
 *
 * - `read` reads one product back through the one `ShopifyClient` (`PRODUCT_READ`, then
 *   `PRODUCT_VARIANTS_PAGE` while Shopify has more, `PRODUCT_READ_VARIANTS_PAGE` a page, up to
 *   `MAX_CHANNEL_VARIANTS`); `productOfVariant` names a variant's product (the product read before
 *   an order, review M8). Both run before any unit of work and throw the client's errors.
 * - `apply` is the body of the unit (inside `OrderTransactions.run`, READ COMMITTED as the catalog
 *   requires; no Shopify call): the stale, gift card, and removal rules, `applyProduct` with the
 *   ids from `connection_external_ids`, the style and variant mappings with each variant's
 *   inventory item id and outcome, `ChannelProductNeedsAttention` once per variant and outcome,
 *   and `ProductUnlink.forGone` for variants gone from the product.
 * - `linkWaitingOrders` links the lines of known orders that arrived unmapped and whose variant
 *   now maps (`OrderIntake.linkChannelLineVariant`, AC-9), one order unit each, after the product
 *   unit committed.
 *
 * Law 151: a product holds no personal data, but its log lines and outputs still carry ids and
 * codes only.
 */
@Injectable()
export class ProductSync {
  private readonly logger = new Logger('ShopifyProducts');

  /** Takes the database, the client, the catalog contract, events, unlink, and orders. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ShopifyClient) private readonly shopify: ShopifyClient,
    @Inject(CatalogChannelSync) private readonly catalog: CatalogChannelSync,
    @Inject(DomainEvents) private readonly events: DomainEvents,
    @Inject(ProductUnlink) private readonly unlink: ProductUnlink,
    @Inject(OrderTransactions) private readonly orderTransactions: OrderTransactions,
    @Inject(OrderIntake) private readonly intake: OrderIntake,
  ) {}

  /**
   * Reads one product back with every variant (AC-16): null when Shopify answers no product (or
   * the product went while its pages were read). Throws `ShopifyClientError` and
   * `ShopifyProductMappingError` (`PRODUCT_UNREADABLE`, `VARIANTS_TRUNCATED` past 2,048).
   */
  async read(
    access: ShopifyConnectionAccess,
    productGid: string,
  ): Promise<ProductReadAnswer<ShopifyProduct | null>> {
    const warnings = new Set<ShopifyWarning>();
    const first = await this.shopify.request(access, {
      operationName: PRODUCT_READ_OPERATION,
      query: PRODUCT_READ,
      variables: { id: productGid },
      expectedCost: PRODUCT_READ_ESTIMATED_COST,
    });
    first.warnings.forEach((warning) => warnings.add(warning));
    const page = parseShopifyProductPage(first.data);
    if (page === null) return { value: null, warnings: [...warnings] };
    const variants: ShopifyProductVariant[] = [...page.product.variants];
    let cursor = page.nextCursor;
    while (cursor !== null) {
      if (variants.length >= MAX_CHANNEL_VARIANTS) {
        throw new ShopifyProductMappingError('VARIANTS_TRUNCATED', ['variants']);
      }
      const answer = await this.shopify.request(access, {
        operationName: PRODUCT_VARIANTS_PAGE_OPERATION,
        query: PRODUCT_VARIANTS_PAGE,
        variables: { id: page.product.id, after: cursor },
        expectedCost: PRODUCT_READ_ESTIMATED_COST,
      });
      answer.warnings.forEach((warning) => warnings.add(warning));
      const next = parseShopifyVariantsPage(answer.data, page.product.id);
      if (next === null) return { value: null, warnings: [...warnings] };
      variants.push(...next.variants);
      cursor = next.nextCursor;
    }
    if (variants.length > MAX_CHANNEL_VARIANTS) {
      throw new ShopifyProductMappingError('VARIANTS_TRUNCATED', ['variants']);
    }
    return { value: { ...page.product, variants }, warnings: [...warnings] };
  }

  /**
   * The product gid of a Shopify variant (AC-9), or null when Shopify no longer has the variant.
   * Throws the client's errors and `PRODUCT_UNREADABLE`.
   */
  async productOfVariant(
    access: ShopifyConnectionAccess,
    variantGid: string,
  ): Promise<ProductReadAnswer<string | null>> {
    const answer = await this.shopify.request(access, {
      operationName: PRODUCT_OF_VARIANT_READ_OPERATION,
      query: PRODUCT_OF_VARIANT_READ,
      variables: { id: variantGid },
      expectedCost: PRODUCT_OF_VARIANT_READ_EXPECTED_COST,
    });
    return { value: parseProductOfVariant(answer.data), warnings: answer.warnings };
  }

  /**
   * The Shopify variant gids among `gids` that have no live variant mapping on the connection (no
   * row, or only a removed one): their products have never been applied (AC-9).
   */
  async unknownVariants(
    executor: Executor,
    connectionId: string,
    gids: readonly string[],
  ): Promise<string[]> {
    if (gids.length === 0) return [];
    const { rows } = await executor.execute<{ external_id: string }>(sql`
      SELECT external_id FROM connection_external_ids
      WHERE connection_id = ${connectionId}::uuid AND entity = 'variant'
        AND external_id = ANY(${pgArray([...gids])}::text[]) AND removed_at IS NULL`);
    const known = new Set(rows.map((row) => row.external_id));
    return gids.filter((gid) => !known.has(gid));
  }

  /**
   * Applies one read product inside the caller's unit (see the class), in this order:
   * 1. locks the product mapping; a product Shopify no longer answers marks the product mapping
   *    and its variant mappings removed (outcome `product_removed`; the catalog keeps its link,
   *    AC-16: archive unlinks), or is `ignored` `not_visible` when nothing was mapped;
   * 2. a gift card is `ignored` `gift_card` (spec 0012 Follow-up: never a style);
   * 3. a read not newer than the version last applied is `ignored` `stale` (AC-7);
   * 4. `CatalogChannelSync.applyProduct` with the style and variant ids the mappings hold, as
   *    `actor` (a `system_job`);
   * 5. the product mapping takes the style id (kept when the catalog answers none), the version,
   *    the style outcome, and Shopify's status; each variant mapping takes its variant id (kept
   *    when the catalog answers none), its inventory item id, tracked, and outcome;
   * 6. `ChannelProductNeedsAttention` for each variant whose attention outcome differs from its
   *    last one, so an identical apply publishes nothing;
   * 7. variant mappings of the product that the read no longer lists are marked removed, and
   *    `ProductUnlink.forGone` gives their variants back to the app unless another live mapping
   *    holds them.
   * Rerunnable: it reads its rows again under their locks and keeps no state.
   */
  async apply(
    tx: OrderTransaction,
    target: ProductTarget,
    productGid: string,
    product: ShopifyProduct | null,
    actor: AuditActor,
  ): Promise<ProductApplied> {
    const productRow = (
      await tx.execute<MappingRow>(sql`
        SELECT id, external_id, local_id, removed_at IS NOT NULL AS removed, state,
               to_char(external_version AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS external_version
        FROM connection_external_ids
        WHERE connection_id = ${target.connectionId}::uuid AND entity = 'product'
          AND external_id = ${productGid}
        FOR UPDATE`)
    ).rows[0];

    if (product === null) {
      if (!productRow || productRow.removed) {
        return { status: 'ignored', outcome: 'not_visible', newlyMapped: [] };
      }
      await tx.execute(sql`
        UPDATE connection_external_ids SET removed_at = now(), updated_at = now()
        WHERE connection_id = ${target.connectionId}::uuid AND removed_at IS NULL
          AND ((entity = 'product' AND external_id = ${productGid})
               OR (entity = 'variant' AND state->>'productId' = ${productGid}))`);
      return { status: 'processed', outcome: 'product_removed', newlyMapped: [] };
    }
    if (product.isGiftCard) return { status: 'ignored', outcome: 'gift_card', newlyMapped: [] };
    if (
      productRow &&
      !productRow.removed &&
      productRow.external_version !== null &&
      Date.parse(product.updatedAt) <= Date.parse(productRow.external_version)
    ) {
      return { status: 'ignored', outcome: 'stale', newlyMapped: [] };
    }

    const readGids = product.variants.map((variant) => variant.id);
    const { rows: variantRows } = await tx.execute<MappingRow>(sql`
      SELECT id, external_id, local_id, removed_at IS NOT NULL AS removed, state,
             NULL::text AS external_version
      FROM connection_external_ids
      WHERE connection_id = ${target.connectionId}::uuid AND entity = 'variant'
        AND (external_id = ANY(${pgArray(readGids)}::text[]) OR state->>'productId' = ${productGid})
      ORDER BY id
      FOR UPDATE`);
    const byGid = new Map(variantRows.map((row) => [row.external_id, row]));
    const variantIds = new Map<string, string>();
    for (const row of variantRows) {
      if (row.local_id !== null && !row.removed) variantIds.set(row.external_id, row.local_id);
    }
    const styleId = productRow?.local_id ?? null;

    const input = mapShopifyProduct(product, { storeId: target.storeId, styleId, variantIds });
    const result = await this.catalog.applyProduct(tx, input, actor);

    await tx.execute(sql`
      INSERT INTO connection_external_ids (connection_id, entity, external_id, local_id,
                                           external_version, state)
      VALUES (${target.connectionId}::uuid, 'product', ${productGid},
              ${result.styleId ?? styleId}::uuid, ${isoOf(product.updatedAt)}::timestamptz,
              ${JSON.stringify({ lastOutcome: result.styleOutcome, status: product.status })}::jsonb)
      ON CONFLICT ON CONSTRAINT connection_external_ids_unique DO UPDATE
        SET local_id = EXCLUDED.local_id, external_version = EXCLUDED.external_version,
            state = connection_external_ids.state || EXCLUDED.state, removed_at = NULL,
            updated_at = now()`);

    const newlyMapped: string[] = [];
    let attention = false;
    const records = result.variants.map((answer, i) => {
      const variant = product.variants[i];
      const previous = byGid.get(answer.externalVariantId);
      const previousLocal = previous && !previous.removed ? previous.local_id : null;
      const localId = answer.variantId ?? previousLocal;
      if (localId !== null && localId !== previousLocal) newlyMapped.push(answer.externalVariantId);
      const state: VariantState = {
        productId: productGid,
        inventoryItemId: variant?.inventoryItem.id ?? '',
        tracked: variant?.inventoryItem.tracked ?? false,
        lastOutcome: answer.outcome,
      };
      const needs = ATTENTION_OUTCOMES.includes(answer.outcome);
      if (needs) attention = true;
      const publish = needs && lastOutcomeOf(previous?.state) !== answer.outcome;
      return { answer, localId, state, publish };
    });
    if (records.length > 0) {
      const rows = records.map((record) => ({
        external_id: record.answer.externalVariantId,
        local_id: record.localId,
        state: record.state,
      }));
      await tx.execute(sql`
        INSERT INTO connection_external_ids (connection_id, entity, external_id, local_id,
                                             external_version, state)
        SELECT ${target.connectionId}::uuid, 'variant', r.external_id, r.local_id,
               ${isoOf(product.updatedAt)}::timestamptz, r.state
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
             AS r(external_id text, local_id uuid, state jsonb)
        ON CONFLICT ON CONSTRAINT connection_external_ids_unique DO UPDATE
          SET local_id = EXCLUDED.local_id, external_version = EXCLUDED.external_version,
              state = connection_external_ids.state || EXCLUDED.state, removed_at = NULL,
              updated_at = now()`);
    }
    for (const record of records) {
      if (!record.publish) continue;
      await this.events.publish(
        tx,
        new ChannelProductNeedsAttention(
          target.connectionId,
          productGid,
          record.answer.externalVariantId,
          record.answer.variantId,
          record.answer.outcome,
        ),
      );
    }

    const read = new Set(readGids);
    const gone = variantRows.filter((row) => !row.removed && !read.has(row.external_id));
    if (gone.length > 0) {
      const ids = gone.map((row) => row.id);
      await tx.execute(sql`
        UPDATE connection_external_ids SET removed_at = now(), updated_at = now()
        WHERE id = ANY(${pgArray(ids)}::uuid[])`);
      await this.unlink.forGone(tx, ids, actor);
    }
    return {
      status: 'processed',
      outcome: attention ? 'needs_attention' : null,
      newlyMapped,
    };
  }

  /**
   * Links the lines that arrived unmapped on known orders of the connection and whose Shopify
   * variant is among `variantGids` and now maps (AC-9, Inbound processing item 4): one
   * `OrderTransactions.run` unit per order (at most `LATE_LINK_ORDERS_MAX` a run), which locks the
   * order mapping, calls `OrderIntake.linkChannelLineVariant` (no edit, `updated_at` kept), and
   * drops the linked lines from `state.unmappedLines`, leaving the version alone. A line orders
   * finds already mapped or gone counts as linked; a retired variant (`VariantUnknown`) stays
   * unmapped. An orders domain error or a lock timeout on one order is logged by code and the
   * next order goes on (the order's next read back links it). Answers how many lines it linked.
   */
  async linkWaitingOrders(connectionId: string, variantGids: readonly string[]): Promise<number> {
    if (variantGids.length === 0) return 0;
    const { rows } = await this.connection.db.execute<{ id: string }>(sql`
      SELECT m.id FROM connection_external_ids m
      WHERE m.connection_id = ${connectionId}::uuid AND m.entity = 'order'
        AND m.local_id IS NOT NULL AND m.state ? 'unmappedLines'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(m.state->'unmappedLines') = 'array'
                 THEN m.state->'unmappedLines' ELSE '[]'::jsonb END) l
          WHERE l->>'variantGid' = ANY(${pgArray([...variantGids])}::text[]))
      ORDER BY m.id
      LIMIT ${LATE_LINK_ORDERS_MAX}`);
    let linked = 0;
    for (const row of rows) {
      try {
        linked += await this.orderTransactions.run((tx) =>
          this.linkOrder(tx, connectionId, row.id),
        );
      } catch (error) {
        const code =
          error instanceof OrderLockTimeout ? 'ORDER_LOCK_TIMEOUT' : orderErrorCodeOf(error);
        if (code === null) throw error;
        this.logger.warn(`late link connection=${connectionId} mapping=${row.id} skipped=${code}`);
      }
    }
    if (linked > 0) this.logger.log(`late link connection=${connectionId} lines=${linked}`);
    return linked;
  }

  /** One order of `linkWaitingOrders`, inside its unit. */
  private async linkOrder(
    tx: OrderTransaction,
    connectionId: string,
    mappingId: string,
  ): Promise<number> {
    const mapping = (
      await tx.execute<{ local_id: string | null; state: unknown }>(sql`
        SELECT local_id, state FROM connection_external_ids
        WHERE id = ${mappingId}::uuid FOR UPDATE`)
    ).rows[0];
    if (!mapping?.local_id) return 0;
    const state: OrderMappingState = parseOrderMappingState(mapping.state);
    const lines = state.unmappedLines ?? [];
    const gids = [...new Set(lines.flatMap((line) => (line.variantGid ? [line.variantGid] : [])))];
    if (gids.length === 0) return 0;
    const { rows } = await tx.execute<{ external_id: string; local_id: string }>(sql`
      SELECT external_id, local_id FROM connection_external_ids
      WHERE connection_id = ${connectionId}::uuid AND entity = 'variant'
        AND external_id = ANY(${pgArray(gids)}::text[])
        AND local_id IS NOT NULL AND removed_at IS NULL`);
    const variants = new Map(rows.map((variant) => [variant.external_id, variant.local_id]));
    const linked = new Set<string>();
    for (const line of lines) {
      const variantId = line.variantGid === null ? undefined : variants.get(line.variantGid);
      if (variantId === undefined) continue;
      try {
        await this.intake.linkChannelLineVariant(
          tx,
          mapping.local_id,
          line.channelLineId,
          variantId,
        );
        linked.add(line.channelLineId);
      } catch (error) {
        if (error instanceof LineAlreadyMapped || error instanceof InvalidOrderInput) {
          linked.add(line.channelLineId);
        } else if (!(error instanceof VariantUnknown)) {
          throw error;
        }
      }
    }
    if (linked.size === 0) return 0;
    const next: OrderMappingState = { ...state };
    const left = lines.filter((line) => !linked.has(line.channelLineId));
    if (left.length > 0) next.unmappedLines = left;
    else delete next.unmappedLines;
    await tx.execute(sql`
      UPDATE connection_external_ids SET state = ${JSON.stringify(next)}::jsonb, updated_at = now()
      WHERE id = ${mappingId}::uuid`);
    return linked.size;
  }
}
