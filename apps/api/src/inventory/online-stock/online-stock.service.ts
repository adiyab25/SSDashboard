import { Inject, Injectable } from '@nestjs/common';
import {
  OnlineStockCandidateQuery,
  OnlineStockChangedSinceQuery,
  OnlineStockListQuery,
  OnlineStockVariantIds,
  type OnlineLocationRef,
  type OnlineStockCandidateResponse,
  type OnlineStockChangedSinceResponse,
  type OnlineStockListResponse,
  type OnlineStockRow,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { z } from 'zod';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { LedgerError } from '../ledger/ledger.errors.js';
import { buildAvailabilitySql } from '../ledger/ledger.service.js';
import { OnlineStockError } from './online-stock.errors.js';

/**
 * How far the change feed's watermark trails the database clock (spec 0011 AC-4): every ledger
 * write stamps its transaction's start and commits within seconds (each lock wait is capped at
 * 5 seconds), so a caller that stores the watermark as its next `since` misses no late commit.
 * Assumed: no ledger transaction stays open 5 minutes.
 */
export const ONLINE_FEED_LAG = '5 minutes';

/** `to_char` format of an instant: microseconds, UTC, so a position round trips exactly. */
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** What the online gate shows about a location's stock (spec 0011 AC-19, Value sourcing). */
export interface OnlineGateCounts {
  /** Variants with a positive on hand at the location. */
  variantsWithStock: number;
  /** Their total on hand. */
  totalOnHand: number;
  /** Variants with a balance or an active reservation whose pushable figure would be 0. */
  variantsPushedZero: number;
}

function parse<T extends z.ZodType>(shape: T, input: unknown): z.infer<T> {
  const result = shape.safeParse(input);
  if (!result.success) {
    throw new LedgerError('InvalidInput', result.error.issues.map((i) => i.message).join('; '));
  }
  return result.data;
}

/** The figures of one variant; `pushable` is what is free after orders hold stock and wait for it. */
function toRow(
  variantId: string,
  onHand: number,
  reserved: number,
  unfilledDemand: number,
): OnlineStockRow {
  return {
    variantId,
    onHand,
    reserved,
    unfilledDemand,
    available: onHand - reserved,
    pushable: Math.max(onHand - reserved - unfilledDemand, 0),
  };
}

/**
 * The online stock read (spec 0011 AC-2 to AC-4): how many pieces of each variant a channel may
 * offer, counted at the one online location only. Stock at a partner, a shop, a second warehouse,
 * transit, or scrap never adds to any figure. It reads inventory tables only and never writes;
 * with no online location every read raises `NoOnlineLocation` and never answers zeros. Callers
 * (the Shopify connector, the gate) never post stock through it.
 */
@Injectable()
export class OnlineStockService {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** The online location (`{ id, code, name }`), or null when no location feeds online stock. */
  async onlineLocation(executor: Executor = this.connection.db): Promise<OnlineLocationRef | null> {
    const { rows } = await executor.execute<{
      id: string;
      code: string;
      name: { en?: string; ar?: string };
    }>(sql`
      SELECT id, code, name FROM locations WHERE sellable_online AND archived_at IS NULL`);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, code: row.code, name: { en: row.name.en, ar: row.name.ar } };
  }

  /**
   * The numbers of the asked variants at the online location, in input order, one row per
   * distinct variant; a variant with no balance there answers zeros. Raises `NoOnlineLocation`.
   */
  async forVariants(variantIds: readonly string[]): Promise<OnlineStockRow[]> {
    const ids = [...new Set(parse(OnlineStockVariantIds, variantIds))];
    const location = await this.requireOnline();
    return this.rowsFor(this.connection.db, location.id, ids);
  }

  /**
   * Every variant with a balance or an active reservation at the online location, a keyset page
   * by variant id (spec 0011 AC-3); a variant on no page has `pushable` 0.
   */
  async list(query: OnlineStockListQuery): Promise<OnlineStockListResponse> {
    const parsed = parse(OnlineStockListQuery, query);
    const location = await this.requireOnline();
    const page = await this.pageOf(location.id, parsed.afterVariantId, parsed.limit);
    return {
      onlineLocationId: location.id,
      rows: await this.rowsFor(this.connection.db, location.id, page.ids),
      nextAfterVariantId: page.next,
    };
  }

  /**
   * The same figures for a location that is not necessarily online yet, for the Shopify
   * connector's first push preview (spec 0011 Contract for neighbours). With `variantIds` it
   * reads those; otherwise it pages like `list`. Raises `UnknownReference` for a missing or
   * archived location, and never `NoOnlineLocation`.
   */
  async forCandidate(
    locationId: string,
    query: OnlineStockCandidateQuery = {},
  ): Promise<OnlineStockCandidateResponse> {
    const parsed = parse(OnlineStockCandidateQuery, query);
    const id = parse(z.uuid(), locationId);
    const { rows: found } = await this.connection.db.execute(sql`
      SELECT 1 FROM locations WHERE id = ${id} AND archived_at IS NULL`);
    if (!found.length) throw new LedgerError('UnknownReference', 'No such active location');
    if (parsed.variantIds) {
      const ids = [...new Set(parsed.variantIds)];
      return {
        locationId: id,
        rows: await this.rowsFor(this.connection.db, id, ids),
        nextAfterVariantId: null,
      };
    }
    const page = await this.pageOf(id, parsed.afterVariantId, parsed.limit);
    return {
      locationId: id,
      rows: await this.rowsFor(this.connection.db, id, page.ids),
      nextAfterVariantId: page.next,
    };
  }

  /**
   * Each variant whose balance or reservation (held or unfilled, any status) at the online
   * location changed after `since`, oldest change first by (`changedAt`, `variantId`), with its
   * current numbers (spec 0011 AC-4). Store the first page's `watermark` as the next `since`
   * after paging through all rows with `after`; a variant may be seen twice. When
   * `onlineLocationId` differs from the one stored, resync with `list`.
   */
  async changedSince(
    query: OnlineStockChangedSinceQuery,
  ): Promise<OnlineStockChangedSinceResponse> {
    const parsed = parse(OnlineStockChangedSinceQuery, query);
    const location = await this.requireOnline();
    const db = this.connection.db;
    const marked = await db.execute<{ watermark: string }>(sql`
      SELECT to_char((now() - ${ONLINE_FEED_LAG}::interval) AT TIME ZONE 'UTC', ${ISO_UTC}) AS watermark`);
    const watermark = marked.rows[0]?.watermark;
    if (!watermark) throw new Error('The watermark query returned no row');
    const newer: SQL =
      parsed.since === null ? sql`` : sql`AND updated_at > ${parsed.since}::timestamptz`;
    const after: SQL = parsed.after
      ? sql`WHERE (changed_at, variant_id) > (${parsed.after.changedAt}::timestamptz, ${parsed.after.variantId}::uuid)`
      : sql``;
    const { rows: changed } = await db.execute<{ variant_id: string; changed_at: string }>(sql`
      WITH changes AS (
        SELECT variant_id, max(updated_at) AS changed_at FROM (
          SELECT variant_id, updated_at FROM stock_levels
          WHERE location_id = ${location.id} ${newer}
          UNION ALL
          SELECT variant_id, updated_at FROM reservations
          WHERE location_id = ${location.id} ${newer}
        ) c GROUP BY variant_id
      ), page AS (
        SELECT variant_id, changed_at FROM changes ${after}
        ORDER BY changed_at, variant_id
        LIMIT ${parsed.limit + 1}
      )
      SELECT variant_id, to_char(changed_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS changed_at
      FROM page ORDER BY page.changed_at, variant_id`);
    const page = changed.slice(0, parsed.limit);
    const numbers = await this.rowsFor(
      db,
      location.id,
      page.map((row) => row.variant_id),
    );
    const byVariant = new Map(numbers.map((row) => [row.variantId, row]));
    const last = page.at(-1);
    return {
      onlineLocationId: location.id,
      watermark,
      rows: page.map((row) => ({
        ...(byVariant.get(row.variant_id) ?? toRow(row.variant_id, 0, 0, 0)),
        changedAt: row.changed_at,
      })),
      nextAfter:
        changed.length > parsed.limit && last
          ? { changedAt: last.changed_at, variantId: last.variant_id }
          : null,
    };
  }

  /**
   * The gate's figures for a location (spec 0011 AC-19): variants with stock, their total on hand,
   * and the variants that would be pushed as 0. Read through `executor` so `make-online`
   * recomputes them inside its transaction.
   */
  async gateCounts(
    locationId: string,
    executor: Executor = this.connection.db,
  ): Promise<OnlineGateCounts> {
    const { rows } = await executor.execute<{
      variants_with_stock: number;
      total_on_hand: number;
      variants_pushed_zero: number;
    }>(sql`
      WITH bal AS (
        SELECT variant_id, sum(on_hand)::int AS on_hand
        FROM stock_levels WHERE location_id = ${locationId} GROUP BY variant_id
      ), res AS (
        SELECT variant_id, sum(open_quantity)::int AS reserved, sum(unfilled_quantity)::int AS unfilled
        FROM reservations WHERE location_id = ${locationId} AND status = 'active' GROUP BY variant_id
      ), v AS (
        SELECT variant_id, coalesce(bal.on_hand, 0) AS on_hand, coalesce(res.reserved, 0) AS reserved,
               coalesce(res.unfilled, 0) AS unfilled
        FROM bal FULL JOIN res USING (variant_id)
        WHERE coalesce(bal.on_hand, 0) <> 0 OR res.reserved IS NOT NULL
      )
      SELECT count(*) FILTER (WHERE on_hand > 0)::int AS variants_with_stock,
             coalesce(sum(on_hand) FILTER (WHERE on_hand > 0), 0)::int AS total_on_hand,
             count(*) FILTER (WHERE greatest(on_hand - reserved - unfilled, 0) = 0)::int AS variants_pushed_zero
      FROM v`);
    const row = rows[0];
    return {
      variantsWithStock: row?.variants_with_stock ?? 0,
      totalOnHand: row?.total_on_hand ?? 0,
      variantsPushedZero: row?.variants_pushed_zero ?? 0,
    };
  }

  /** How many active reservations a location holds (the ones that stay when the flag moves away). */
  async activeReservations(
    locationId: string,
    executor: Executor = this.connection.db,
  ): Promise<number> {
    const { rows } = await executor.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM reservations
      WHERE location_id = ${locationId} AND status = 'active'`);
    return rows[0]?.n ?? 0;
  }

  private async requireOnline(): Promise<OnlineLocationRef> {
    const location = await this.onlineLocation();
    if (!location) {
      throw new OnlineStockError(
        'NoOnlineLocation',
        'No location feeds online stock. Make one online first.',
      );
    }
    return location;
  }

  /** One keyset page of variant ids with a balance or an active reservation at the location. */
  private async pageOf(
    locationId: string,
    afterVariantId: string | undefined,
    limit: number,
  ): Promise<{ ids: string[]; next: string | null }> {
    const after: SQL = afterVariantId ? sql`AND variant_id > ${afterVariantId}::uuid` : sql``;
    const { rows } = await this.connection.db.execute<{ variant_id: string }>(sql`
      SELECT variant_id FROM (
        SELECT variant_id FROM stock_levels
        WHERE location_id = ${locationId} AND on_hand <> 0 ${after}
        UNION
        SELECT variant_id FROM reservations
        WHERE location_id = ${locationId} AND status = 'active' ${after}
      ) v
      ORDER BY variant_id
      LIMIT ${limit + 1}`);
    const ids = rows.slice(0, limit).map((row) => row.variant_id);
    const last = ids.at(-1);
    return { ids, next: rows.length > limit && last ? last : null };
  }

  /** The figures of the given variants at one location, in input order. */
  private async rowsFor(
    executor: Executor,
    locationId: string,
    variantIds: readonly string[],
  ): Promise<OnlineStockRow[]> {
    if (!variantIds.length) return [];
    const pairs = variantIds.map((id): [string, string] => [id, locationId]);
    const availability = await executor.execute<{
      variant_id: string;
      on_hand: number;
      reserved: number;
    }>(sql`
      SELECT variant_id, sum(on_hand)::int AS on_hand, sum(reserved)::int AS reserved
      FROM (${buildAvailabilitySql(pairs)}) a GROUP BY variant_id`);
    const waiting = await executor.execute<{ variant_id: string; unfilled: number }>(sql`
      SELECT variant_id, sum(unfilled_quantity)::int AS unfilled
      FROM reservations
      WHERE location_id = ${locationId} AND status = 'active'
        AND variant_id = ANY(${pgArray(variantIds)}::uuid[])
      GROUP BY variant_id`);
    const balances = new Map(availability.rows.map((row) => [row.variant_id, row]));
    const unfilled = new Map(waiting.rows.map((row) => [row.variant_id, row.unfilled]));
    return variantIds.map((id) =>
      toRow(
        id,
        balances.get(id)?.on_hand ?? 0,
        balances.get(id)?.reserved ?? 0,
        unfilled.get(id) ?? 0,
      ),
    );
  }
}
