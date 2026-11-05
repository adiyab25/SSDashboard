import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateLocationRequest,
  LocationDetail,
  LocationListResponse,
  LocationStatus,
  UpdateLocationRequest,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import { DATABASE } from '../../database/database.module.js';
import {
  pgArray,
  pgConstraint,
  isStillReferenced,
  type Executor,
  type Transaction,
} from '../../database/sql.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ledgerTransaction } from '../ledger/locks.js';

/** A location as other inventory answers name it. */
export interface LocationRef {
  id: string;
  code: string;
  name: { en?: string; ar?: string };
}

/** `to_char` format of `updatedAt`: microseconds, UTC (spec 0006, Value sourcing). */
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

export type LocationErrorCode =
  'NotFound' | 'CodeTaken' | 'Stale' | 'CodeLocked' | 'StockOnHand' | 'InUse';

/**
 * A location rule the caller broke (AC-4); the controller maps `code` to an HTTP answer. The
 * seeded transit and virtual locations are `NotFound` on every management action.
 */
export class LocationError extends Error {
  constructor(
    readonly code: LocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocationError';
  }
}

const notFound = () => new LocationError('NotFound', 'Location not found');

/** The cursor does not decode to a location code. */
export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not one this endpoint issued');
  }
}

/** A page cursor: the last row's code, base64url encoded. */
export function encodeCursor(code: string): string {
  return Buffer.from(code, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  const code = Buffer.from(cursor, 'base64url').toString('utf8');
  // Node decodes loosely; only a cursor that round trips is one we issued.
  if (!code || encodeCursor(code) !== cursor) throw new InvalidCursorError();
  return code;
}

/** Only warehouses and showrooms are listed or managed; transit and virtual are system rows. */
const WORK_TYPE = sql`type IN ('warehouse', 'showroom')`;

interface LocationRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: { en?: string; ar?: string };
  type: 'warehouse' | 'showroom';
  archived: boolean;
  updated_at: string;
}

const LOCATION_COLUMNS = sql`
  id, code, name, type, archived_at IS NOT NULL AS archived,
  to_char(updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS updated_at`;

function toDetail(row: LocationRow, codeLocked: boolean): LocationDetail {
  return {
    id: row.id,
    code: row.code,
    name: { en: row.name.en, ar: row.name.ar },
    type: row.type === 'showroom' ? 'showroom' : 'warehouse',
    archived: row.archived,
    updatedAt: row.updated_at,
    codeLocked,
  };
}

function codeTaken(error: unknown, code: string): unknown {
  if (pgConstraint(error) === 'locations_code_unique') {
    return new LocationError('CodeTaken', `Location code ${code} is already in use`);
  }
  return error;
}

/** Warehouses and showrooms: the switcher list and full management for admins (AC-4). */
@Injectable()
export class LocationsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /**
   * Warehouses and showrooms, active (default) or archived, ordered by code. Ordering and the
   * keyset comparison both use the "C" collation, so pages never skip or repeat a row.
   */
  async listWorkLocations(query: {
    status?: LocationStatus;
    cursor?: string;
    limit: number;
  }): Promise<LocationListResponse> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const filters: SQL[] = [
      WORK_TYPE,
      query.status === 'archived' ? sql`archived_at IS NOT NULL` : sql`archived_at IS NULL`,
    ];
    if (after !== undefined) filters.push(sql`code COLLATE "C" > ${after} COLLATE "C"`);
    const { rows } = await this.connection.db.execute<LocationRow>(sql`
      SELECT ${LOCATION_COLUMNS} FROM locations
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY code COLLATE "C"
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const locked = await this.codeLocked(
      this.connection.db,
      page.map((row) => row.id),
    );
    const last = page.at(-1);
    return {
      items: page.map((row) => toDetail(row, locked.has(row.id))),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.code) : null,
    };
  }

  /** Code and name for each id that exists, archived ones included. One query. */
  async byIds(ids: readonly string[]): Promise<Map<string, LocationRef>> {
    if (!ids.length) return new Map();
    const { rows } = await this.connection.db.execute<{
      id: string;
      code: string;
      name: { en?: string; ar?: string };
    }>(
      sql`SELECT id, code, name FROM locations WHERE id = ANY(${pgArray([...new Set(ids)])}::uuid[])`,
    );
    return new Map(
      rows.map((row) => [
        row.id,
        { id: row.id, code: row.code, name: { en: row.name.en, ar: row.name.ar } },
      ]),
    );
  }

  /** Creates a sellable warehouse or showroom that does not allow negative stock (AC-4). */
  async create(input: z.output<typeof CreateLocationRequest>): Promise<LocationDetail> {
    try {
      const { rows } = await this.connection.db.execute<LocationRow>(sql`
        INSERT INTO locations (code, name, type, is_sellable, allow_negative)
        VALUES (${input.code}, ${JSON.stringify(input.name)}::jsonb, ${input.type}, true, false)
        RETURNING ${LOCATION_COLUMNS}`);
      const row = rows[0];
      if (!row) throw new Error('The location insert returned no row');
      return toDetail(row, false);
    } catch (error) {
      throw codeTaken(error, input.code);
    }
  }

  /**
   * Edits name, type, and code (AC-4) with the stale check on `updatedAt`. A code change first
   * locks the location against postings (as an archive does), then answers `CodeLocked` once
   * stock was posted there or a receipt names it.
   */
  async update(id: string, input: z.output<typeof UpdateLocationRequest>): Promise<LocationDetail> {
    try {
      return await ledgerTransaction(this.connection.db, async (tx) => {
        const current = await this.findWork(tx, id);
        if (!current) throw notFound();
        const sets: SQL[] = [sql`updated_at = now()`];
        if (input.code !== undefined && input.code !== current.code) {
          await this.lockWork(tx, id);
          if (await this.isCodeLocked(tx, id)) {
            throw new LocationError(
              'CodeLocked',
              'Stock was posted at this location, so its code cannot change',
            );
          }
          sets.push(sql`code = ${input.code}`);
        }
        if (input.name) sets.push(sql`name = ${JSON.stringify(input.name)}::jsonb`);
        if (input.type) sets.push(sql`type = ${input.type}`);
        const { rows } = await tx.execute<LocationRow>(sql`
          UPDATE locations SET ${sql.join(sets, sql`, `)}
          WHERE id = ${id}
            AND to_char(updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) = ${input.updatedAt}
          RETURNING ${LOCATION_COLUMNS}`);
        const row = rows[0];
        if (!row) {
          // Zero rows: changed by someone else, or deleted meanwhile (then 404, not stale).
          if (!(await this.findWork(tx, id))) throw notFound();
          throw new LocationError(
            'Stale',
            'Someone else changed this location. Reload and try again.',
          );
        }
        return toDetail(row, await this.isCodeLocked(tx, id));
      });
    } catch (error) {
      throw input.code === undefined ? error : codeTaken(error, input.code);
    }
  }

  /**
   * Archives a location with nothing on hand and nothing reserved (AC-4), with the same locking
   * as a SKU archive: the row `FOR UPDATE` through `ledger.lockForArchive`, then `usage`.
   */
  async archive(id: string): Promise<LocationDetail> {
    return ledgerTransaction(this.connection.db, async (tx) => {
      if (!(await this.lockWork(tx, id))) throw notFound();
      const usage = (await this.ledger.usage({ locationIds: [id] }, tx)).get(id);
      if (usage?.onHandNonZero || usage?.activeReserved) {
        throw new LocationError(
          'StockOnHand',
          'This location still has stock on hand or reserved. Move or adjust it first.',
        );
      }
      return this.setArchived(tx, id, true);
    });
  }

  /** Brings an archived location back to the switcher and pickers. */
  async unarchive(id: string): Promise<LocationDetail> {
    return ledgerTransaction(this.connection.db, async (tx) => {
      if (!(await this.lockWork(tx, id))) throw notFound();
      return this.setArchived(tx, id, false);
    });
  }

  /**
   * Deletes a location nothing references (AC-4): receipts, movements, balances, reservations,
   * serials, or bins make the delete fail with `InUse`.
   */
  async delete(id: string): Promise<void> {
    let deleted: boolean;
    try {
      const { rows } = await this.connection.db.execute(sql`
        DELETE FROM locations WHERE id = ${id} AND ${WORK_TYPE} RETURNING id`);
      deleted = rows.length > 0;
    } catch (error) {
      if (isStillReferenced(error)) {
        throw new LocationError(
          'InUse',
          'This location is in use and cannot be deleted. Archive it.',
        );
      }
      throw error;
    }
    if (!deleted) throw notFound();
  }

  private async findWork(tx: Transaction, id: string): Promise<LocationRow | null> {
    const { rows } = await tx.execute<LocationRow>(sql`
      SELECT ${LOCATION_COLUMNS} FROM locations WHERE id = ${id} AND ${WORK_TYPE}`);
    return rows[0] ?? null;
  }

  /** `ledger.lockForArchive` for a warehouse or showroom; a system location counts as missing. */
  private async lockWork(tx: Transaction, id: string): Promise<boolean> {
    if (!(await this.findWork(tx, id))) return false;
    return (await this.ledger.lockForArchive(tx, { locationId: id })) !== null;
  }

  private async setArchived(
    tx: Transaction,
    id: string,
    archived: boolean,
  ): Promise<LocationDetail> {
    const { rows } = await tx.execute<LocationRow>(sql`
      UPDATE locations
      SET archived_at = ${archived ? sql`coalesce(archived_at, now())` : sql`NULL`},
          updated_at = now()
      WHERE id = ${id}
      RETURNING ${LOCATION_COLUMNS}`);
    const row = rows[0];
    if (!row) throw notFound();
    return toDetail(row, await this.isCodeLocked(tx, id));
  }

  private async isCodeLocked(executor: Executor, id: string): Promise<boolean> {
    return (await this.codeLocked(executor, [id])).has(id);
  }

  /**
   * The ids whose code is read only (spec 0006, Value sourcing): a balance row exists there, or
   * a stock receipt names it. Two lean EXISTS checks served by indexes
   * (`stock_levels_location_variant_idx`, `stock_receipts_location_effective_idx`), cheap enough
   * for every list page.
   */
  private async codeLocked(executor: Executor, ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const locked = await this.ledger.withBalance({ locationIds: ids }, executor);
    const rest = [...new Set(ids)].filter((id) => !locked.has(id));
    if (!rest.length) return locked;
    const { rows } = await executor.execute<{ id: string }>(sql`
      SELECT k.id FROM unnest(${pgArray(rest)}::uuid[]) AS k(id)
      WHERE EXISTS (SELECT 1 FROM stock_receipts r WHERE r.location_id = k.id)`);
    for (const row of rows) locked.add(row.id);
    return locked;
  }
}
