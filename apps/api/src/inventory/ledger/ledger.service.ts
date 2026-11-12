import { Inject, Injectable } from '@nestjs/common';
import {
  GetAvailableInput,
  GetLevelsInput,
  Money,
  PostingInput,
  ReleaseInput,
  ReserveInput,
  ReverseInput,
  UnitCost,
  type Availability,
  type LedgerSourceType,
  type LevelsPage,
  type PostingResult,
  type Reservation,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import { DATABASE } from '../../database/database.module.js';
import {
  pgArray,
  pgConstraint,
  pgErrorCode,
  type Executor,
  type Transaction,
} from '../../database/sql.js';
import { SettingError } from '../../platform/settings/settings.errors.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { costInbound, costOutbound, type BalanceState, type CostedLine } from './costing.js';
import { LedgerError } from './ledger.errors.js';
import { ledgerTransaction, lockPairs } from './locks.js';
import { requestHash, type HashedLine } from './request-hash.js';

/** How far ahead of the database clock a posting may be dated. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** A posting line after validation, in base units. */
interface Line {
  index: number;
  variantId: string;
  locationId: string;
  binId: string | null;
  lotId: string | null;
  quantity: number;
  /** Inbound lines only. */
  unitCost: UnitCost | null;
  sourceLineId: string | null;
  serials: string[];
  reservationId: string | null;
  reasonCode: string | null;
  /** A reversal's variance is measured against the original movement's cost. */
  referenceCost?: Money;
}

interface Operation {
  idempotencyKey: string;
  requestHash: string;
  sourceType: LedgerSourceType;
  sourceId: string;
  reversesGroupId: string | null;
  effectiveAt: Date | undefined;
  postedBy: string | null;
  lines: Line[];
}

interface BalanceRow extends Record<string, unknown> {
  id: string;
  variant_id: string;
  location_id: string;
  bin_id: string | null;
  lot_id: string | null;
  on_hand: number;
  avg_unit_cost: string;
  total_value: string;
}

interface ReservationRow extends Record<string, unknown> {
  id: string;
  variant_id: string;
  location_id: string;
  lot_id: string | null;
  quantity: number;
  open_quantity: number;
  source_type: string;
  source_id: string;
  source_line_id: string;
  status: 'active' | 'released' | 'fulfilled';
}

interface SerialState {
  id: string | null;
  variantId: string;
  serial: string;
  status: 'in_stock' | 'out';
  locationId: string | null;
  binId: string | null;
  lotId: string | null;
  changed: boolean;
}

function parse<T extends z.ZodType>(shape: T, input: unknown): z.infer<T> {
  const result = shape.safeParse(input);
  if (!result.success) {
    throw new LedgerError('InvalidInput', result.error.issues.map((i) => i.message).join('; '), {
      issues: result.error.issues,
    });
  }
  return result.data;
}

function balanceKey(line: {
  variantId: string;
  locationId: string;
  binId: string | null;
  lotId: string | null;
}): string {
  return `${line.variantId}|${line.locationId}|${line.binId ?? ''}|${line.lotId ?? ''}`;
}

function rowKey(row: BalanceRow): string {
  return `${row.variant_id}|${row.location_id}|${row.bin_id ?? ''}|${row.lot_id ?? ''}`;
}

/** Nulls first, then text order, matching the balance lock order (spec 0002). */
function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function compareLines(a: Line, b: Line): number {
  return (
    compareNullable(a.variantId, b.variantId) ||
    compareNullable(a.locationId, b.locationId) ||
    compareNullable(a.binId, b.binId) ||
    compareNullable(a.lotId, b.lotId) ||
    a.index - b.index
  );
}

/**
 * Caller code run inside a posting's own transaction, after the movements and balances are
 * written (spec 0006). It writes only the caller's own rows and issues the document number
 * last. A throw rolls the whole posting back. On the one deadlock retry the transaction reruns,
 * this callback included, so it must keep no state across attempts. It never runs on a replay.
 */
export type WithinPosting = (tx: Transaction, result: PostingResult) => Promise<void>;

/** Extra behaviour for one posting: `within` runs inside the posting's transaction. */
export interface PostingOptions {
  within?: WithinPosting;
}

/** One balance row as the Stock page reads it. */
export interface StockListRow {
  id: string;
  variantId: string;
  locationId: string;
  onHand: number;
  totalValue: string;
  /** Microsecond UTC string, also the keyset cursor's first part. */
  updatedAt: string;
}

/** What stock state refers to a SKU or location (spec 0006, `usage`). */
export interface StockUsage {
  /** A balance row exists: stock was posted there at least once. */
  hasBalance: boolean;
  onHandNonZero: boolean;
  activeReserved: boolean;
}

/** One movement of a SKU's history with its group's source. */
export interface MovementRow {
  id: string;
  locationId: string;
  quantity: number;
  unitCost: string;
  totalCost: string;
  /** Microsecond UTC strings; `recordedAt` is also the keyset cursor's first part. */
  effectiveAt: string;
  recordedAt: string;
  sourceType: LedgerSourceType;
  sourceId: string;
  reversesGroupId: string | null;
  postedBy: string | null;
}

/** A posting's stored result, plus whether this call replayed an earlier one by its key. */
export type PostingOutcome = PostingResult & { replayed: boolean };

/** `to_char` format for an exact UTC ISO 8601 timestamp, microseconds included. */
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * The inventory ledger: the only writer of movements, balances, serials, and reservations
 * (spec 0002). Every stock change in the system is a posting through `post` or `reverse`.
 */
@Injectable()
export class LedgerService {
  /**
   * Takes the app database connection and the settings service, which supplies the install time
   * zone and period rules.
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /** Posts one atomic group of movements. Replaying the same key returns the stored result. */
  async post(input: PostingInput, options: PostingOptions = {}): Promise<PostingOutcome> {
    const parsed = parse(PostingInput, input);
    const lines = parsed.lines.map((line, index): Line => {
      const inbound = line.quantity > 0;
      if (inbound && line.unitCost === undefined) {
        throw new LedgerError('InvalidCost', `Line ${index + 1}: an inbound line needs a unitCost`);
      }
      if (!inbound && line.unitCost !== undefined) {
        throw new LedgerError(
          'InvalidCost',
          `Line ${index + 1}: an outbound line takes no unitCost`,
        );
      }
      if (inbound && line.reservationId) {
        throw new LedgerError(
          'ReservationMismatch',
          `Line ${index + 1}: only an outbound line can fulfil a reservation`,
        );
      }
      const serials = line.serials ?? [];
      if (new Set(serials).size !== serials.length) {
        throw new LedgerError('TrackingMismatch', `Line ${index + 1}: a serial is listed twice`);
      }
      return {
        index,
        variantId: line.variantId,
        locationId: line.locationId,
        binId: line.binId ?? null,
        lotId: line.lotId ?? null,
        quantity: line.quantity,
        unitCost: line.unitCost === undefined ? null : UnitCost.of(line.unitCost),
        sourceLineId: line.sourceLineId ?? null,
        serials,
        reservationId: line.reservationId ?? null,
        reasonCode: line.reasonCode ?? null,
      };
    });
    const operation: Operation = {
      idempotencyKey: parsed.idempotencyKey,
      requestHash: requestHash({
        operation: 'post',
        sourceType: parsed.sourceType,
        sourceId: parsed.sourceId,
        reversesGroupId: null,
        effectiveAt: parsed.effectiveAt,
        lines: parsed.lines,
      }),
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      reversesGroupId: null,
      effectiveAt: parsed.effectiveAt,
      postedBy: parsed.postedBy,
      lines,
    };
    return this.transact((tx) => this.apply(tx, operation, options.within));
  }

  /**
   * Reverses a whole posting with a new group of opposite movements, costed by the normal
   * rules for each row's direction. A group is reversed at most once; a reversal never is.
   */
  async reverse(input: ReverseInput, options: PostingOptions = {}): Promise<PostingOutcome> {
    const parsed = parse(ReverseInput, input);
    return this.transact(async (tx) => {
      const original = (
        await tx.execute<{
          source_type: LedgerSourceType;
          source_id: string;
          reverses: string | null;
        }>(
          sql`SELECT source_type, source_id, reverses_group_id AS reverses
              FROM movement_groups WHERE id = ${parsed.groupId}`,
        )
      ).rows[0];
      if (!original)
        throw new LedgerError('NotFound', `Movement group ${parsed.groupId} not found`);
      if (original.reverses) {
        throw new LedgerError('CannotReverseReversal', 'A reversal cannot itself be reversed');
      }
      const movements = await tx.execute<{
        variant_id: string;
        location_id: string;
        bin_id: string | null;
        lot_id: string | null;
        quantity: number;
        unit_cost: string;
        total_cost: string;
        cost_variance: string;
        source_line_id: string | null;
        serials: string[];
      }>(sql`
        SELECT m.variant_id, m.location_id, m.bin_id, m.lot_id, m.quantity, m.unit_cost,
               m.total_cost, m.cost_variance, m.source_line_id,
               coalesce(array_agg(s.serial ORDER BY s.serial) FILTER (WHERE s.id IS NOT NULL), '{}') AS serials
        FROM stock_movements m
        LEFT JOIN movement_serials ms ON ms.movement_id = m.id
        LEFT JOIN serials s ON s.id = ms.serial_id
        WHERE m.group_id = ${parsed.groupId}
        GROUP BY m.id
        ORDER BY m.id`);
      const lines = movements.rows.map((row, index): Line => {
        const quantity = -row.quantity;
        return {
          index,
          variantId: row.variant_id,
          locationId: row.location_id,
          binId: row.bin_id,
          lotId: row.lot_id,
          quantity,
          // Reversing an outbound costs the returning units at the original unit cost.
          unitCost: quantity > 0 ? UnitCost.of(row.unit_cost) : null,
          sourceLineId: row.source_line_id,
          serials: row.serials,
          reservationId: null,
          reasonCode: parsed.reasonCode,
          // The original's value (outbound) or price (inbound), negated.
          referenceCost: Money.of(row.total_cost).plus(Money.of(row.cost_variance)).negate(),
        };
      });
      const hashed: HashedLine[] = lines.map((line) => ({
        variantId: line.variantId,
        locationId: line.locationId,
        binId: line.binId ?? undefined,
        lotId: line.lotId ?? undefined,
        quantity: line.quantity,
        sourceLineId: line.sourceLineId ?? undefined,
        serials: line.serials,
        reasonCode: parsed.reasonCode,
      }));
      return this.apply(
        tx,
        {
          idempotencyKey: parsed.idempotencyKey,
          requestHash: requestHash({
            operation: 'reverse',
            sourceType: original.source_type,
            sourceId: original.source_id,
            reversesGroupId: parsed.groupId,
            effectiveAt: parsed.effectiveAt,
            lines: hashed,
          }),
          sourceType: original.source_type,
          sourceId: original.source_id,
          reversesGroupId: parsed.groupId,
          effectiveAt: parsed.effectiveAt,
          postedBy: parsed.postedBy,
          lines,
        },
        options.within,
      );
    });
  }

  /** Balances, paged by id, with reserved and available per SKU, location, and lot. */
  async getLevels(input: GetLevelsInput = {}): Promise<LevelsPage> {
    const parsed = parse(GetLevelsInput, input);
    const filters: SQL[] = [];
    if (parsed.variantId) filters.push(sql`variant_id = ${parsed.variantId}`);
    if (parsed.locationId) filters.push(sql`location_id = ${parsed.locationId}`);
    if (parsed.cursor) filters.push(sql`id > ${parsed.cursor}`);
    const where = filters.length ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
    const { rows } = await this.connection.db.execute<BalanceRow>(sql`
      SELECT id, variant_id, location_id, bin_id, lot_id, on_hand, avg_unit_cost, total_value
      FROM stock_levels ${where}
      ORDER BY id
      LIMIT ${parsed.limit + 1}`);
    const page = rows.slice(0, parsed.limit);
    const pairs = new Map(page.map((row) => [`${row.variant_id}|${row.location_id}`, row]));
    const availability = pairs.size
      ? await this.availability(
          this.connection.db,
          [...pairs.values()].map((row) => [row.variant_id, row.location_id]),
        )
      : [];
    return {
      levels: page.map((row) => ({
        id: row.id,
        variantId: row.variant_id,
        locationId: row.location_id,
        binId: row.bin_id,
        lotId: row.lot_id,
        onHand: row.on_hand,
        avgUnitCost: row.avg_unit_cost,
        totalValue: row.total_value,
      })),
      availability,
      nextCursor: rows.length > parsed.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Balance rows for the Stock page (spec 0006): most recent movement first, keyset on
   * (`updated_at`, `id`), served by `stock_levels_updated_idx`. Transit and virtual locations are
   * left out. `after` is the last row's `updatedAt` and `id` from the previous page.
   */
  async listStock(query: {
    locationId?: string;
    variantId?: string;
    includeZero: boolean;
    after?: { updatedAt: string; id: string };
    limit: number;
  }): Promise<StockListRow[]> {
    const filters: SQL[] = [sql`l.kind IN ('warehouse', 'shop')`];
    if (query.locationId) filters.push(sql`sl.location_id = ${query.locationId}`);
    if (query.variantId) filters.push(sql`sl.variant_id = ${query.variantId}`);
    if (!query.includeZero) filters.push(sql`sl.on_hand <> 0`);
    if (query.after) {
      filters.push(
        sql`(sl.updated_at, sl.id) < (${query.after.updatedAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const { rows } = await this.connection.db.execute<{
      id: string;
      variant_id: string;
      location_id: string;
      on_hand: number;
      total_value: string;
      updated_at: string;
    }>(sql`
      SELECT sl.id, sl.variant_id, sl.location_id, sl.on_hand, sl.total_value,
             to_char(sl.updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS updated_at
      FROM stock_levels sl JOIN locations l ON l.id = sl.location_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY sl.updated_at DESC, sl.id DESC
      LIMIT ${query.limit}`);
    return rows.map((row) => ({
      id: row.id,
      variantId: row.variant_id,
      locationId: row.location_id,
      onHand: row.on_hand,
      totalValue: row.total_value,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Locks a SKU or location against postings for an archive, unarchive, or code change
   * (spec 0006): takes `FOR UPDATE` on that one row and nothing else. No pair locks and no
   * scan of balance or reservation rows, so the lock count does not grow with the balances.
   * Every posting, reversal, reservation, and rebuild reads the row `FOR SHARE` first, so this
   * waits for each one in flight and blocks new ones until commit; `usage` (or the code change
   * `hasBalance` check) run after it sees a settled state. Run inside a transaction, before
   * `usage`. Returns null when the row does not exist.
   */
  async lockForArchive(
    tx: Transaction,
    target: { variantId: string } | { locationId: string },
  ): Promise<{ id: string; archived: boolean } | null> {
    const { rows } =
      'variantId' in target
        ? await tx.execute<{ id: string; archived: boolean }>(sql`
            SELECT id, archived_at IS NOT NULL AS archived
            FROM product_variants WHERE id = ${target.variantId} FOR UPDATE`)
        : await tx.execute<{ id: string; archived: boolean }>(sql`
            SELECT id, archived_at IS NOT NULL AS archived
            FROM locations WHERE id = ${target.locationId} FOR UPDATE`);
    return rows[0] ?? null;
  }

  /**
   * Read only: the ids among `ids` with at least one balance row (stock was posted there).
   * One EXISTS per id on the leading column of `stock_levels_key_unique` (SKU) or
   * `stock_levels_location_variant_idx` (location); no reservation scan, so list pages can ask.
   */
  async withBalance(
    target: { variantIds: readonly string[] } | { locationIds: readonly string[] },
    executor: Executor = this.connection.db,
  ): Promise<Set<string>> {
    const byVariant = 'variantIds' in target;
    const ids = [...new Set(byVariant ? target.variantIds : target.locationIds)];
    if (!ids.length) return new Set();
    const column = byVariant ? sql`variant_id` : sql`location_id`;
    const { rows } = await executor.execute<{ id: string }>(sql`
      SELECT k.id FROM unnest(${pgArray(ids)}::uuid[]) AS k(id)
      WHERE EXISTS (SELECT 1 FROM stock_levels s WHERE s.${column} = k.id)`);
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Read only: whether each SKU or location has any balance row, any balance with on hand other
   * than 0, and any open reservation (spec 0006). Every id asked for is in the answer.
   */
  async usage(
    target: { variantIds: readonly string[] } | { locationIds: readonly string[] },
    executor: Executor = this.connection.db,
  ): Promise<Map<string, StockUsage>> {
    const byVariant = 'variantIds' in target;
    const ids = [...new Set(byVariant ? target.variantIds : target.locationIds)];
    const result = new Map<string, StockUsage>(
      ids.map((id) => [id, { hasBalance: false, onHandNonZero: false, activeReserved: false }]),
    );
    if (!ids.length) return result;
    const column = byVariant ? sql`variant_id` : sql`location_id`;
    const { rows } = await executor.execute<{
      id: string;
      has_balance: boolean;
      on_hand_non_zero: boolean;
      active_reserved: boolean;
    }>(sql`
      SELECT k.id,
             EXISTS (SELECT 1 FROM stock_levels s WHERE s.${column} = k.id) AS has_balance,
             EXISTS (SELECT 1 FROM stock_levels s
                     WHERE s.${column} = k.id AND s.on_hand <> 0) AS on_hand_non_zero,
             EXISTS (SELECT 1 FROM reservations r
                     WHERE r.${column} = k.id AND r.status = 'active'
                       AND r.open_quantity > 0) AS active_reserved
      FROM unnest(${pgArray(ids)}::uuid[]) AS k(id)`);
    for (const row of rows) {
      result.set(row.id, {
        hasBalance: row.has_balance,
        onHandNonZero: row.on_hand_non_zero,
        activeReserved: row.active_reserved,
      });
    }
    return result;
  }

  /**
   * A SKU's movements, newest recorded first, keyset on (`recorded_at`, `id`), served by
   * `stock_movements (variant_id, recorded_at desc, id desc)`. `after` is the last row's
   * `recordedAt` and `id` from the previous page.
   */
  async getMovements(query: {
    variantId: string;
    after?: { recordedAt: string; id: string };
    limit: number;
  }): Promise<MovementRow[]> {
    const filters: SQL[] = [sql`m.variant_id = ${query.variantId}`];
    if (query.after) {
      filters.push(
        sql`(m.recorded_at, m.id) < (${query.after.recordedAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const { rows } = await this.connection.db.execute<{
      id: string;
      location_id: string;
      quantity: number;
      unit_cost: string;
      total_cost: string;
      effective_at: string;
      recorded_at: string;
      source_type: LedgerSourceType;
      source_id: string;
      reverses_group_id: string | null;
      posted_by: string | null;
    }>(sql`
      SELECT m.id, m.location_id, m.quantity, m.unit_cost, m.total_cost,
             to_char(m.effective_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS effective_at,
             to_char(m.recorded_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS recorded_at,
             g.source_type, g.source_id, g.reverses_group_id, g.posted_by
      FROM stock_movements m JOIN movement_groups g ON g.id = m.group_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY m.recorded_at DESC, m.id DESC
      LIMIT ${query.limit}`);
    return rows.map((row) => ({
      id: row.id,
      locationId: row.location_id,
      quantity: row.quantity,
      unitCost: row.unit_cost,
      totalCost: row.total_cost,
      effectiveAt: row.effective_at,
      recordedAt: row.recorded_at,
      sourceType: row.source_type,
      sourceId: row.source_id,
      reversesGroupId: row.reverses_group_id,
      postedBy: row.posted_by,
    }));
  }

  /** Available stock for one SKU, per sellable location and lot. */
  async getAvailable(input: GetAvailableInput): Promise<Availability[]> {
    const parsed = parse(GetAvailableInput, input);
    return this.availability(this.connection.db, null, parsed.variantId, parsed.locationId);
  }

  /** Holds stock for a document line. Rejected when more than available is asked for. */
  async reserve(input: ReserveInput): Promise<Reservation> {
    const parsed = parse(ReserveInput, input);
    const lotId = parsed.lotId ?? null;
    return this.transact(async (tx) => {
      const master = await this.loadMaster(tx, [
        { variantId: parsed.variantId, locationId: parsed.locationId, binId: null, lotId },
      ]);
      const variant = master.variants.get(parsed.variantId);
      const location = master.locations.get(parsed.locationId);
      if (!variant) throw new LedgerError('UnknownReference', `SKU ${parsed.variantId} not found`);
      if (!location) {
        throw new LedgerError('UnknownReference', `Location ${parsed.locationId} not found`);
      }
      if (variant.archived) throw new LedgerError('Archived', 'The SKU is archived');
      if (variant.kind !== 'stocked') {
        throw new LedgerError('NotStockable', `A ${variant.kind} SKU holds no stock`);
      }
      if (location.archived) throw new LedgerError('Archived', 'The location is archived');
      if (lotId && master.lots.get(lotId) !== parsed.variantId) {
        throw new LedgerError('UnknownReference', 'The lot does not belong to this SKU');
      }
      // The same lot rules as posting (AC-8): a reservation a shipment can never match
      // would hold stock forever.
      if (variant.tracking === 'lot' && !lotId) {
        throw new LedgerError('TrackingMismatch', 'A lot tracked SKU is reserved by lot');
      }
      if (variant.tracking !== 'lot' && lotId) {
        throw new LedgerError('TrackingMismatch', 'This SKU is not lot tracked');
      }

      await lockPairs(tx, [[parsed.variantId, parsed.locationId]]);
      const available =
        (await this.availability(tx, null, parsed.variantId, parsed.locationId)).find(
          (row) => row.lotId === lotId,
        )?.available ?? 0;
      if (parsed.quantity > available && !location.allowNegative) {
        throw new LedgerError('InsufficientStock', `Only ${available} available to reserve`, {
          available,
          requested: parsed.quantity,
        });
      }
      try {
        const { rows } = await tx.execute<ReservationRow>(sql`
          INSERT INTO reservations (variant_id, location_id, lot_id, quantity, open_quantity,
                                    source_type, source_id, source_line_id)
          VALUES (${parsed.variantId}, ${parsed.locationId}, ${lotId}, ${parsed.quantity},
                  ${parsed.quantity}, ${parsed.sourceType}, ${parsed.sourceId}, ${parsed.sourceLineId})
          RETURNING *`);
        return this.toReservation(rows[0]);
      } catch (error) {
        if (pgConstraint(error) === 'reservations_active_source_line_unique') {
          throw new LedgerError(
            'DuplicateReservation',
            'This document line already holds an active reservation',
          );
        }
        throw error;
      }
    });
  }

  /** Releases all or part of a reservation's open quantity. It closes when nothing is open. */
  async release(input: ReleaseInput): Promise<Reservation> {
    const parsed = parse(ReleaseInput, input);
    return this.transact(async (tx) => {
      const current = (
        await tx.execute<ReservationRow>(
          sql`SELECT * FROM reservations WHERE id = ${parsed.reservationId} FOR UPDATE`,
        )
      ).rows[0];
      if (!current)
        throw new LedgerError('NotFound', `Reservation ${parsed.reservationId} not found`);
      if (current.status !== 'active') {
        throw new LedgerError('ReservationClosed', `The reservation is already ${current.status}`);
      }
      const quantity = parsed.quantity ?? current.open_quantity;
      if (quantity > current.open_quantity) {
        throw new LedgerError(
          'QuantityTooLarge',
          `Only ${current.open_quantity} is open on this reservation`,
        );
      }
      const open = current.open_quantity - quantity;
      const { rows } = await tx.execute<ReservationRow>(sql`
        UPDATE reservations
        SET open_quantity = ${open},
            status = ${open === 0 ? 'released' : 'active'}::reservation_status,
            closed_at = ${open === 0 ? sql`now()` : sql`NULL`},
            updated_at = now()
        WHERE id = ${current.id}
        RETURNING *`);
      return this.toReservation(rows[0]);
    });
  }

  /**
   * The inventory lock date, read in the posting transaction. A stored lock date that fails its
   * schema refuses the posting (`LockDateUnreadable`), never reads as "nothing locked" (security
   * review S1): a manager fixes it in the settings screen, where it shows as invalid.
   */
  private async lockDate(tx: Transaction): Promise<string | null> {
    try {
      return await this.settings.get('inventory_lock_date', tx);
    } catch (error) {
      if (error instanceof SettingError && error.kind === 'SettingUnreadable') {
        throw new LedgerError(
          'LockDateUnreadable',
          'The inventory lock date setting cannot be read, so stock cannot be posted. Set the lock date again in the settings.',
        );
      }
      throw error;
    }
  }

  private transact<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return ledgerTransaction(this.connection.db, work);
  }

  /** The posting transaction (spec 0002, Key invariants). */
  private async apply(
    tx: Transaction,
    op: Operation,
    within?: WithinPosting,
  ): Promise<PostingOutcome> {
    const lockDate = await this.lockDate(tx);
    // Claim the idempotency key. A repeat finds the stored group; a concurrent first
    // request makes this wait, and if that one rolls back, this one proceeds as new.
    // Dates stay in SQL: the date checks run on the stored values, to the microsecond.
    let inserted;
    try {
      inserted = (
        await tx.execute<{ id: string; future: boolean; operating_day: string }>(sql`
          INSERT INTO movement_groups (idempotency_key, request_hash, source_type, source_id,
                                       reverses_group_id, effective_at, posted_by)
          VALUES (${op.idempotencyKey}, ${op.requestHash}, ${op.sourceType}, ${op.sourceId},
                  ${op.reversesGroupId},
                  coalesce(${op.effectiveAt?.toISOString() ?? null}::timestamptz, now()),
                  ${op.postedBy})
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
          RETURNING id,
                    effective_at > recorded_at + ${`${FUTURE_TOLERANCE_MS} milliseconds`}::interval AS future,
                    to_char(operating_day, 'YYYY-MM-DD') AS operating_day`)
      ).rows[0];
    } catch (error) {
      if (pgConstraint(error) === 'movement_groups_reverses_group_id_unique') {
        throw new LedgerError('AlreadyReversed', 'This posting has already been reversed');
      }
      if (pgConstraint(error) === 'movement_groups_posted_by_users_id_fk') {
        throw new LedgerError('UnknownReference', 'The posting user does not exist');
      }
      throw error;
    }
    if (!inserted) return this.replay(tx, op);

    // AC-6: never in the future, and on an operating day after the lock date. The lock date
    // governs the operating day the trigger stamped on this row (Cairo day with the cutoff hour,
    // ssd_operating_day), never the plain calendar date (review R5): with cutoff 3, a posting at
    // 01:00 on the 1st belongs to the last day of the month before.
    if (inserted.future)
      throw new LedgerError('FutureDate', 'A posting cannot be dated in the future');
    if (lockDate && inserted.operating_day <= lockDate) {
      throw new LedgerError('PeriodLocked', `Inventory is locked up to ${lockDate}`, { lockDate });
    }
    const master = await this.loadMaster(tx, op.lines);
    this.checkLines(op.lines, master);

    const lines = [...op.lines].sort(compareLines);
    await lockPairs(
      tx,
      lines.map((line) => [line.variantId, line.locationId]),
    );
    const balances = await this.lockBalances(tx, lines);
    const reservations = await this.lockReservations(tx, lines);
    const serials = await this.moveSerials(tx, lines);

    const costed: CostedLine[] = [];
    for (const line of lines) {
      const key = balanceKey(line);
      const balance = balances.byKey.get(key);
      if (!balance) throw new Error(`Balance ${key} was not locked`);
      const state = balance.state;
      let result: CostedLine;
      if (line.quantity > 0) {
        if (!line.unitCost) throw new Error('An inbound line reached costing without a unit cost');
        result = costInbound(state, line.quantity, line.unitCost, line.referenceCost);
      } else {
        result = costOutbound(state, line.quantity, line.referenceCost);
        const location = master.locations.get(line.locationId);
        if (result.next.onHand < 0 && !location?.allowNegative) {
          throw new LedgerError('InsufficientStock', `Only ${state.onHand} on hand`, {
            line: line.index + 1,
            onHand: state.onHand,
            requested: -line.quantity,
          });
        }
      }
      balance.state = result.next;
      balance.changed = true;
      if (line.quantity < 0) this.applyReservation(line, reservations, balances.byKey);
      costed.push(result);
    }

    await this.write(tx, inserted.id, lines, costed, balances.byKey, reservations, serials);
    const result = await this.loadResult(tx, inserted.id);
    if (within) await within(tx, result);
    return { ...result, replayed: false };
  }

  private async replay(tx: Transaction, op: Operation): Promise<PostingOutcome> {
    const existing = (
      await tx.execute<{ id: string; request_hash: string }>(
        sql`SELECT id, request_hash FROM movement_groups WHERE idempotency_key = ${op.idempotencyKey}`,
      )
    ).rows[0];
    if (!existing) throw new Error('Idempotency key conflicted but no group was found');
    if (existing.request_hash !== op.requestHash) {
      throw new LedgerError(
        'IdempotencyConflict',
        'This idempotency key was already used for a different request',
      );
    }
    return { ...(await this.loadResult(tx, existing.id)), replayed: true };
  }

  /**
   * The SKUs and locations a posting checks, read `FOR SHARE` (spec 0006): an archive, which
   * takes `FOR UPDATE` in `lockForArchive`, waits for an in flight posting, and the reverse.
   * Rows are locked in id order. This runs before `lockPairs`; an archive takes no pair locks,
   * so the master row locks are the only ones the two contend on.
   */
  private async loadMaster(
    executor: Executor,
    lines: readonly {
      variantId: string;
      locationId: string;
      binId: string | null;
      lotId: string | null;
    }[],
  ) {
    const ids = (pick: (line: (typeof lines)[number]) => string | null) => [
      ...new Set(lines.map(pick).filter((id): id is string => id !== null)),
    ];
    // One after another: a transaction is one connection, and pg 9 drops queued queries.
    const variants = await executor.execute<{
      id: string;
      kind: string;
      tracking: string;
      archived: boolean;
    }>(sql`
      SELECT id, kind, tracking, archived_at IS NOT NULL AS archived
      FROM product_variants WHERE id = ANY(${pgArray(ids((l) => l.variantId))}::uuid[])
      ORDER BY id
      FOR SHARE`);
    const locations = await executor.execute<{
      id: string;
      allow_negative: boolean;
      archived: boolean;
    }>(sql`
      SELECT id, allow_negative, archived_at IS NOT NULL AS archived
      FROM locations WHERE id = ANY(${pgArray(ids((l) => l.locationId))}::uuid[])
      ORDER BY id
      FOR SHARE`);
    const bins = await executor.execute<{ id: string; location_id: string; archived: boolean }>(sql`
      SELECT id, location_id, archived_at IS NOT NULL AS archived
      FROM bins WHERE id = ANY(${pgArray(ids((l) => l.binId))}::uuid[])`);
    const lots = await executor.execute<{ id: string; variant_id: string }>(sql`
      SELECT id, variant_id FROM lots WHERE id = ANY(${pgArray(ids((l) => l.lotId))}::uuid[])`);
    return {
      variants: new Map(variants.rows.map((row) => [row.id, row])),
      locations: new Map(
        locations.rows.map((row) => [
          row.id,
          { allowNegative: row.allow_negative, archived: row.archived },
        ]),
      ),
      bins: new Map(bins.rows.map((row) => [row.id, row])),
      lots: new Map(lots.rows.map((row) => [row.id, row.variant_id])),
    };
  }

  /** Archived, not stocked, lot, and serial rules (AC-8). */
  private checkLines(
    lines: readonly Line[],
    master: Awaited<ReturnType<LedgerService['loadMaster']>>,
  ) {
    for (const line of lines) {
      const at = `Line ${line.index + 1}`;
      const variant = master.variants.get(line.variantId);
      if (!variant) throw new LedgerError('UnknownReference', `${at}: SKU not found`);
      if (variant.archived) throw new LedgerError('Archived', `${at}: the SKU is archived`);
      if (variant.kind !== 'stocked') {
        throw new LedgerError('NotStockable', `${at}: a ${variant.kind} SKU holds no stock`);
      }
      const location = master.locations.get(line.locationId);
      if (!location) throw new LedgerError('UnknownReference', `${at}: location not found`);
      if (location.archived) throw new LedgerError('Archived', `${at}: the location is archived`);
      if (line.binId) {
        const bin = master.bins.get(line.binId);
        if (!bin || bin.location_id !== line.locationId) {
          throw new LedgerError('UnknownReference', `${at}: the bin is not in this location`);
        }
        if (bin.archived) throw new LedgerError('Archived', `${at}: the bin is archived`);
      }
      if (line.lotId) {
        const lotVariant = master.lots.get(line.lotId);
        if (!lotVariant) throw new LedgerError('UnknownReference', `${at}: lot not found`);
        if (lotVariant !== line.variantId) {
          throw new LedgerError('TrackingMismatch', `${at}: the lot belongs to another SKU`);
        }
      }
      if (variant.tracking === 'lot' && !line.lotId) {
        throw new LedgerError('TrackingMismatch', `${at}: a lot tracked SKU needs a lot`);
      }
      if (variant.tracking !== 'lot' && line.lotId) {
        throw new LedgerError('TrackingMismatch', `${at}: this SKU is not lot tracked`);
      }
      if (variant.tracking === 'serial') {
        if (line.serials.length !== Math.abs(line.quantity)) {
          throw new LedgerError(
            'TrackingMismatch',
            `${at}: ${Math.abs(line.quantity)} units need exactly ${Math.abs(line.quantity)} serials`,
          );
        }
      } else if (line.serials.length) {
        throw new LedgerError('TrackingMismatch', `${at}: this SKU is not serial tracked`);
      }
    }
  }

  /** Upserts and locks each distinct balance once, in sorted order, then reads the rest of each SKU and location. */
  private async lockBalances(tx: Transaction, lines: readonly Line[]) {
    const keys = new Map<string, Line>();
    for (const line of lines) if (!keys.has(balanceKey(line))) keys.set(balanceKey(line), line);
    const distinct = [...keys.values()];
    await tx.execute(sql`
      INSERT INTO stock_levels (variant_id, location_id, bin_id, lot_id)
      SELECT * FROM unnest(
        ${pgArray(distinct.map((l) => l.variantId))}::uuid[],
        ${pgArray(distinct.map((l) => l.locationId))}::uuid[],
        ${pgArray(distinct.map((l) => l.binId))}::uuid[],
        ${pgArray(distinct.map((l) => l.lotId))}::uuid[])
      ON CONFLICT ON CONSTRAINT stock_levels_key_unique DO UPDATE SET updated_at = now()`);
    const pairs = [...new Map(lines.map((l) => [`${l.variantId}|${l.locationId}`, l])).values()];
    const { rows } = await tx.execute<BalanceRow>(sql`
      SELECT id, variant_id, location_id, bin_id, lot_id, on_hand, avg_unit_cost, total_value
      FROM stock_levels
      WHERE (variant_id, location_id) IN (
        SELECT * FROM unnest(${pgArray(pairs.map((l) => l.variantId))}::uuid[],
                             ${pgArray(pairs.map((l) => l.locationId))}::uuid[]))`);
    const byKey = new Map(
      rows.map((row) => [
        rowKey(row),
        {
          row,
          changed: false,
          state: {
            onHand: row.on_hand,
            totalValue: Money.of(row.total_value),
            avgUnitCost: UnitCost.of(row.avg_unit_cost),
          },
        },
      ]),
    );
    return { byKey };
  }

  /** Locks the reservations this posting fulfils and the active ones its outbound lines must respect. */
  private async lockReservations(tx: Transaction, lines: readonly Line[]) {
    const outbound = lines.filter((line) => line.quantity < 0);
    if (!outbound.length) return new Map<string, ReservationRow>();
    const ids = outbound.map((line) => line.reservationId).filter((id): id is string => !!id);
    const { rows } = await tx.execute<ReservationRow>(sql`
      SELECT * FROM reservations
      WHERE id = ANY(${pgArray(ids)}::uuid[])
         OR (status = 'active' AND (variant_id, location_id) IN (
               SELECT * FROM unnest(${pgArray(outbound.map((l) => l.variantId))}::uuid[],
                                    ${pgArray(outbound.map((l) => l.locationId))}::uuid[])))
      ORDER BY id
      FOR UPDATE`);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Fulfils the line's reservation, or checks it leaves enough on hand for the reserved quantity (AC-4). */
  private applyReservation(
    line: Line,
    reservations: Map<string, ReservationRow>,
    balances: Map<string, { row: BalanceRow; state: BalanceState }>,
  ): void {
    const at = `Line ${line.index + 1}`;
    if (line.reservationId) {
      const reservation = reservations.get(line.reservationId);
      if (
        !reservation ||
        reservation.status !== 'active' ||
        reservation.variant_id !== line.variantId ||
        reservation.location_id !== line.locationId ||
        reservation.lot_id !== line.lotId
      ) {
        throw new LedgerError(
          'ReservationMismatch',
          `${at}: the reservation is not an open one for this SKU, location, and lot`,
        );
      }
      if (-line.quantity > reservation.open_quantity) {
        throw new LedgerError(
          'ReservationMismatch',
          `${at}: only ${reservation.open_quantity} is open on the reservation`,
        );
      }
      reservation.open_quantity += line.quantity;
      if (reservation.open_quantity === 0) reservation.status = 'fulfilled';
      return;
    }
    let reserved = 0;
    for (const reservation of reservations.values()) {
      if (
        reservation.status === 'active' &&
        reservation.variant_id === line.variantId &&
        reservation.location_id === line.locationId &&
        reservation.lot_id === line.lotId
      ) {
        reserved += reservation.open_quantity;
      }
    }
    if (!reserved) return;
    let onHand = 0;
    for (const { row, state } of balances.values()) {
      if (
        row.variant_id === line.variantId &&
        row.location_id === line.locationId &&
        row.lot_id === line.lotId
      ) {
        onHand += state.onHand;
      }
    }
    if (onHand < reserved) {
      throw new LedgerError(
        'InsufficientStock',
        `${at}: ${reserved} of this stock is reserved for other orders`,
        { line: line.index + 1, reserved, onHandAfter: onHand },
      );
    }
  }

  /**
   * Checks and moves serials (AC-8): a leaving serial must be in stock at that place, an
   * arriving one must not be in stock anywhere. Outbound lines go first, so a serial can
   * move between bins or locations within one posting.
   */
  private async moveSerials(tx: Transaction, lines: readonly Line[]) {
    const wanted = lines.flatMap((line) =>
      line.serials.map((serial) => ({ variantId: line.variantId, serial })),
    );
    const states = new Map<string, SerialState>();
    if (!wanted.length) return { states, byLine: new Map<number, string[]>() };
    const { rows } = await tx.execute<{
      id: string;
      variant_id: string;
      serial: string;
      status: 'in_stock' | 'out';
      location_id: string | null;
      bin_id: string | null;
      lot_id: string | null;
    }>(sql`
      SELECT s.id, s.variant_id, s.serial, s.status, s.location_id, s.bin_id, s.lot_id
      FROM serials s
      JOIN unnest(${pgArray(wanted.map((w) => w.variantId))}::uuid[],
                  ${pgArray(wanted.map((w) => w.serial))}::text[]) AS w(variant_id, serial)
        ON s.variant_id = w.variant_id AND s.serial = w.serial
      ORDER BY s.id
      FOR UPDATE OF s`);
    const serialKey = (variantId: string, serial: string) => `${variantId}\u0000${serial}`;
    for (const row of rows) {
      states.set(serialKey(row.variant_id, row.serial), {
        id: row.id,
        variantId: row.variant_id,
        serial: row.serial,
        status: row.status,
        locationId: row.location_id,
        binId: row.bin_id,
        lotId: row.lot_id,
        changed: false,
      });
    }
    const byLine = new Map<number, string[]>();
    const ordered = [
      ...lines.filter((line) => line.quantity < 0),
      ...lines.filter((line) => line.quantity > 0),
    ];
    for (const line of ordered) {
      const at = `Line ${line.index + 1}`;
      const keys: string[] = [];
      for (const serial of line.serials) {
        const key = serialKey(line.variantId, serial);
        const state = states.get(key);
        if (line.quantity < 0) {
          if (
            !state ||
            state.status !== 'in_stock' ||
            state.locationId !== line.locationId ||
            state.binId !== line.binId
          ) {
            throw new LedgerError(
              'TrackingMismatch',
              `${at}: serial ${serial} is not in stock at this place`,
            );
          }
          Object.assign(state, { status: 'out', locationId: null, binId: null, changed: true });
        } else if (!state) {
          states.set(key, {
            id: null,
            variantId: line.variantId,
            serial,
            status: 'in_stock',
            locationId: line.locationId,
            binId: line.binId,
            lotId: line.lotId,
            changed: true,
          });
        } else {
          if (state.status === 'in_stock') {
            throw new LedgerError(
              'TrackingMismatch',
              `${at}: serial ${serial} is already in stock`,
            );
          }
          Object.assign(state, {
            status: 'in_stock',
            locationId: line.locationId,
            binId: line.binId,
            lotId: line.lotId,
            changed: true,
          });
        }
        keys.push(key);
      }
      byLine.set(line.index, keys);
    }
    return { states, byLine };
  }

  private async write(
    tx: Transaction,
    groupId: string,
    lines: readonly Line[],
    costed: readonly CostedLine[],
    balances: Map<string, { row: BalanceRow; state: BalanceState; changed: boolean }>,
    reservations: Map<string, ReservationRow>,
    serials: Awaited<ReturnType<LedgerService['moveSerials']>>,
  ): Promise<void> {
    // Ids in posting order, so reading a group back by id returns the same order.
    const ids = (
      await tx.execute<{ id: string }>(
        sql`SELECT uuidv7()::text AS id FROM generate_series(1, ${lines.length})`,
      )
    ).rows
      .map((row) => row.id)
      .sort();
    const cost = (i: number) => {
      const line = costed[i];
      if (!line) throw new Error(`Line ${i} was not costed`);
      return line;
    };
    await tx.execute(sql`
      INSERT INTO stock_movements (id, group_id, variant_id, location_id, bin_id, lot_id, quantity,
                                   unit_cost, total_cost, cost_variance, cost_unknown,
                                   source_line_id, reason_code, effective_at, recorded_at)
      SELECT m.id, g.id, m.variant_id, m.location_id, m.bin_id, m.lot_id, m.quantity,
             m.unit_cost, m.total_cost, m.cost_variance, m.cost_unknown, m.source_line_id,
             m.reason_code, g.effective_at, g.recorded_at
      FROM movement_groups g
      CROSS JOIN unnest(
        ${pgArray(ids)}::uuid[],
        ${pgArray(lines.map((l) => l.variantId))}::uuid[],
        ${pgArray(lines.map((l) => l.locationId))}::uuid[],
        ${pgArray(lines.map((l) => l.binId))}::uuid[],
        ${pgArray(lines.map((l) => l.lotId))}::uuid[],
        ${pgArray(lines.map((l) => l.quantity))}::int[],
        ${pgArray(lines.map((_, i) => cost(i).unitCost.toString()))}::numeric[],
        ${pgArray(lines.map((_, i) => cost(i).totalCost.toString()))}::numeric[],
        ${pgArray(lines.map((_, i) => cost(i).costVariance.toString()))}::numeric[],
        ${pgArray(lines.map((_, i) => cost(i).costUnknown))}::boolean[],
        ${pgArray(lines.map((l) => l.sourceLineId))}::uuid[],
        ${pgArray(lines.map((l) => l.reasonCode))}::text[]
      ) AS m(id, variant_id, location_id, bin_id, lot_id, quantity, unit_cost, total_cost,
             cost_variance, cost_unknown, source_line_id, reason_code)
      WHERE g.id = ${groupId}`);

    const changedBalances = [...balances.values()].filter((b) => b.changed);
    await tx.execute(sql`
      UPDATE stock_levels s
      SET on_hand = v.on_hand, avg_unit_cost = v.avg_unit_cost, total_value = v.total_value,
          updated_at = now()
      FROM unnest(
        ${pgArray(changedBalances.map((b) => b.row.id))}::uuid[],
        ${pgArray(changedBalances.map((b) => b.state.onHand))}::int[],
        ${pgArray(changedBalances.map((b) => b.state.avgUnitCost.toString()))}::numeric[],
        ${pgArray(changedBalances.map((b) => b.state.totalValue.toString()))}::numeric[]
      ) AS v(id, on_hand, avg_unit_cost, total_value)
      WHERE s.id = v.id`);

    const touched = [...reservations.values()];
    if (touched.length) {
      await tx.execute(sql`
        UPDATE reservations r
        SET open_quantity = v.open_quantity, status = v.status,
            closed_at = CASE WHEN v.status = 'active' THEN NULL ELSE now() END,
            updated_at = now()
        FROM unnest(
          ${pgArray(touched.map((r) => r.id))}::uuid[],
          ${pgArray(touched.map((r) => r.open_quantity))}::int[],
          ${pgArray(touched.map((r) => r.status))}::reservation_status[]
        ) AS v(id, open_quantity, status)
        WHERE r.id = v.id AND (r.open_quantity <> v.open_quantity OR r.status <> v.status)`);
    }

    await this.writeSerials(tx, lines, ids, serials);
  }

  private async writeSerials(
    tx: Transaction,
    lines: readonly Line[],
    movementIds: readonly string[],
    serials: Awaited<ReturnType<LedgerService['moveSerials']>>,
  ): Promise<void> {
    if (!serials.states.size) return;
    const created = [...serials.states.values()].filter((s) => s.id === null);
    if (created.length) {
      try {
        const { rows } = await tx.execute<{ id: string; variant_id: string; serial: string }>(sql`
          INSERT INTO serials (variant_id, serial, lot_id, status, location_id, bin_id)
          SELECT w.variant_id, w.serial, w.lot_id, w.status, w.location_id, w.bin_id
          FROM unnest(
            ${pgArray(created.map((s) => s.variantId))}::uuid[],
            ${pgArray(created.map((s) => s.serial))}::text[],
            ${pgArray(created.map((s) => s.lotId))}::uuid[],
            ${pgArray(created.map((s) => s.status))}::serial_status[],
            ${pgArray(created.map((s) => s.locationId))}::uuid[],
            ${pgArray(created.map((s) => s.binId))}::uuid[]
          ) AS w(variant_id, serial, lot_id, status, location_id, bin_id)
          RETURNING id, variant_id, serial`);
        for (const row of rows) {
          const state = serials.states.get(`${row.variant_id}\u0000${row.serial}`);
          if (state) state.id = row.id;
        }
      } catch (error) {
        if (pgErrorCode(error) === '23505') {
          throw new LedgerError(
            'TrackingMismatch',
            'A serial arrived in another posting at the same time',
          );
        }
        throw error;
      }
    }
    const updated = [...serials.states.values()].filter((s) => s.id !== null && s.changed);
    const existing = updated.filter((s) => !created.includes(s));
    if (existing.length) {
      await tx.execute(sql`
        UPDATE serials s
        SET status = w.status, location_id = w.location_id, bin_id = w.bin_id,
            lot_id = w.lot_id, updated_at = now()
        FROM unnest(
          ${pgArray(existing.map((s) => s.id))}::uuid[],
          ${pgArray(existing.map((s) => s.status))}::serial_status[],
          ${pgArray(existing.map((s) => s.locationId))}::uuid[],
          ${pgArray(existing.map((s) => s.binId))}::uuid[],
          ${pgArray(existing.map((s) => s.lotId))}::uuid[]
        ) AS w(id, status, location_id, bin_id, lot_id)
        WHERE s.id = w.id`);
    }
    const links: [string, string][] = [];
    lines.forEach((line, i) => {
      const movementId = movementIds[i];
      for (const key of serials.byLine.get(line.index) ?? []) {
        const serialId = serials.states.get(key)?.id;
        if (movementId && serialId) links.push([movementId, serialId]);
      }
    });
    if (links.length) {
      await tx.execute(sql`
        INSERT INTO movement_serials (movement_id, serial_id)
        SELECT * FROM unnest(${pgArray(links.map(([m]) => m))}::uuid[],
                             ${pgArray(links.map(([, s]) => s))}::uuid[])`);
    }
  }

  /** The stored group and its movements, the same shape on the first call and on replays. */
  private async loadResult(executor: Executor, groupId: string): Promise<PostingResult> {
    const group = (
      await executor.execute<{
        id: string;
        reverses_group_id: string | null;
        source_type: LedgerSourceType;
        source_id: string;
        effective_at: string;
        recorded_at: string;
        posted_by: string | null;
      }>(sql`
        SELECT id, reverses_group_id, source_type, source_id, posted_by,
               to_char(effective_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS effective_at,
               to_char(recorded_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS recorded_at
        FROM movement_groups WHERE id = ${groupId}`)
    ).rows[0];
    if (!group) throw new LedgerError('NotFound', `Movement group ${groupId} not found`);
    const movements = await executor.execute<{
      id: string;
      variant_id: string;
      location_id: string;
      bin_id: string | null;
      lot_id: string | null;
      quantity: number;
      unit_cost: string;
      total_cost: string;
      cost_variance: string;
      cost_unknown: boolean;
      source_line_id: string | null;
      reason_code: string | null;
      serials: string[];
    }>(sql`
      SELECT m.id, m.variant_id, m.location_id, m.bin_id, m.lot_id, m.quantity, m.unit_cost,
             m.total_cost, m.cost_variance, m.cost_unknown, m.source_line_id, m.reason_code,
             coalesce(array_agg(s.serial ORDER BY s.serial) FILTER (WHERE s.id IS NOT NULL), '{}') AS serials
      FROM stock_movements m
      LEFT JOIN movement_serials ms ON ms.movement_id = m.id
      LEFT JOIN serials s ON s.id = ms.serial_id
      WHERE m.group_id = ${groupId}
      GROUP BY m.id
      ORDER BY m.id`);
    return {
      groupId: group.id,
      reversesGroupId: group.reverses_group_id,
      sourceType: group.source_type,
      sourceId: group.source_id,
      effectiveAt: group.effective_at,
      recordedAt: group.recorded_at,
      postedBy: group.posted_by,
      movements: movements.rows.map((row) => ({
        id: row.id,
        variantId: row.variant_id,
        locationId: row.location_id,
        binId: row.bin_id,
        lotId: row.lot_id,
        quantity: row.quantity,
        unitCost: row.unit_cost,
        totalCost: row.total_cost,
        costVariance: row.cost_variance,
        costUnknown: row.cost_unknown,
        sourceLineId: row.source_line_id,
        reasonCode: row.reason_code,
        serials: row.serials,
      })),
    };
  }

  /**
   * Available per SKU, location, and lot (AC-9): on hand summed over sellable bins of a
   * sellable location, minus active reservations. Either for the given pairs, or for one SKU.
   */
  private async availability(
    executor: Executor,
    pairs: readonly [string, string][] | null,
    variantId?: string,
    locationId?: string,
  ): Promise<Availability[]> {
    const { rows } = await executor.execute<{
      variant_id: string;
      location_id: string;
      lot_id: string | null;
      on_hand: number;
      reserved: number;
    }>(buildAvailabilitySql(pairs, variantId, locationId));
    return rows.map((row) => ({
      variantId: row.variant_id,
      locationId: row.location_id,
      lotId: row.lot_id,
      onHand: row.on_hand,
      reserved: row.reserved,
      available: row.on_hand - row.reserved,
    }));
  }

  private toReservation(row: ReservationRow | undefined): Reservation {
    if (!row) throw new Error('Expected a reservation row');
    return {
      id: row.id,
      variantId: row.variant_id,
      locationId: row.location_id,
      lotId: row.lot_id,
      quantity: row.quantity,
      openQuantity: row.open_quantity,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceLineId: row.source_line_id,
      status: row.status,
    };
  }
}

/**
 * The statement behind `getAvailable`, `reserve`, and the posting's reservation check: on hand in
 * sellable places minus active reservations, per SKU, location, and lot, for the given (SKU,
 * location) pairs, or for one SKU (optionally at one location). Exported so the scale suite can
 * EXPLAIN exactly what runs (review R3: the one SKU form reads `stock_levels_key_unique`). It only
 * builds SQL; it never runs it and never reads another module's table.
 */
export function buildAvailabilitySql(
  pairs: readonly [string, string][] | null,
  variantId?: string,
  locationId?: string,
): SQL {
  const scope = (alias: string) => {
    const column = (name: string) => sql.raw(`${alias}.${name}`);
    return pairs
      ? sql`(${column('variant_id')}, ${column('location_id')}) IN (
              SELECT * FROM unnest(${pgArray(pairs.map(([v]) => v))}::uuid[],
                                   ${pgArray(pairs.map(([, l]) => l))}::uuid[]))`
      : sql`${column('variant_id')} = ${variantId ?? null}::uuid
            ${locationId ? sql`AND ${column('location_id')} = ${locationId}::uuid` : sql``}`;
  };
  return sql`
    WITH on_hand AS (
      SELECT sl.variant_id, sl.location_id, sl.lot_id, sum(sl.on_hand)::int AS on_hand
      FROM stock_levels sl
      JOIN locations l ON l.id = sl.location_id
      LEFT JOIN bins b ON b.id = sl.bin_id
      WHERE ${scope('sl')} AND l.is_sellable AND (sl.bin_id IS NULL OR b.is_sellable)
      GROUP BY 1, 2, 3
    ), reserved AS (
      SELECT r.variant_id, r.location_id, r.lot_id, sum(r.open_quantity)::int AS reserved
      FROM reservations r
      JOIN locations l ON l.id = r.location_id
      WHERE ${scope('r')} AND r.status = 'active' AND l.is_sellable
      GROUP BY 1, 2, 3
    )
    SELECT coalesce(o.variant_id, r.variant_id) AS variant_id,
           coalesce(o.location_id, r.location_id) AS location_id,
           coalesce(o.lot_id, r.lot_id) AS lot_id,
           coalesce(o.on_hand, 0) AS on_hand,
           coalesce(r.reserved, 0) AS reserved
    FROM on_hand o
    FULL JOIN reserved r
      ON r.variant_id = o.variant_id AND r.location_id = o.location_id
     AND r.lot_id IS NOT DISTINCT FROM o.lot_id
    ORDER BY 1, 2, 3 NULLS FIRST`;
}
