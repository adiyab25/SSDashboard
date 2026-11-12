import { Inject, Injectable } from '@nestjs/common';
import {
  personActor,
  type CreateLocationRequest,
  type LocationDetail,
  type LocationOwnerType,
  type LocationListResponse,
  type LocationStatus,
  type UpdateLocationRequest,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import { AuditService, type JsonObject } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import {
  pgArray,
  pgConstraint,
  isStillReferenced,
  type Executor,
  type Transaction,
} from '../../database/sql.js';
import type { Access } from '../../platform/access/access.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ledgerTransaction } from '../ledger/locks.js';
import { LocationPolicyService } from './location-policy.service.js';

/**
 * The signed in person changing a location, with their `Access` (spec 0008): the audit entry
 * names the hat that holds `catalog.manage` (`actingHat`).
 */
export interface LocationCaller {
  id: string;
  access: Pick<Access, 'actingHat'>;
}

/** A location as other inventory answers name it. */
export interface LocationRef {
  id: string;
  code: string;
  name: { en?: string; ar?: string };
}

/** `to_char` format of `updatedAt`: microseconds, UTC (spec 0006, Value sourcing). */
export const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * The location rules a caller can break: missing, code taken, edited by someone else, code
 * locked by use, stock still on hand, or still referenced.
 */
export type LocationErrorCode =
  | 'NotFound'
  | 'CodeTaken'
  | 'Stale'
  | 'CodeLocked'
  | 'StockOnHand'
  | 'InUse'
  | 'AlreadyConfirmed'
  | 'AlreadyOnline'
  | 'OnlineGateFailed'
  | 'OnlineGateStale'
  | 'OnlineNeedsWarehouse'
  | 'NoOnlineLocation';

/**
 * A location rule the caller broke (AC-4); the controller maps `code` to an HTTP answer. The
 * seeded transit and virtual locations are `NotFound` on every management action.
 */
export class LocationError extends Error {
  /**
   * Takes the stable `code` the controller maps to an HTTP answer, a message safe to show, and
   * optional `details` the answer carries (the failed gate keys of `OnlineGateFailed`).
   */
  constructor(
    readonly code: LocationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
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

/**
 * Reads a page cursor back into the last row's code. Throws `InvalidCursorError` for anything
 * this endpoint did not issue, even text Node would decode loosely.
 */
export function decodeCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  const code = Buffer.from(cursor, 'base64url').toString('utf8');
  // Node decodes loosely; only a cursor that round trips is one we issued.
  if (!code || encodeCursor(code) !== cursor) throw new InvalidCursorError();
  return code;
}

/** Only warehouses and shops are listed or managed; transit and virtual are system rows. */
const WORK_KIND = sql`kind IN ('warehouse', 'shop')`;

/** A location row as `LOCATION_COLUMNS` selects it. */
export interface LocationRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: { en?: string; ar?: string };
  kind: 'warehouse' | 'shop';
  owner_type: LocationOwnerType;
  sellable_online: boolean;
  online: boolean;
  stock_verified_at: string | null;
  archived: boolean;
  updated_at: string;
}

/** The columns every location answer selects (`toDetail` reads them). */
export const LOCATION_COLUMNS = sql`
  id, code, name, kind, owner_type, sellable_online,
  (sellable_online AND archived_at IS NULL) AS online,
  to_char(stock_verified_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS stock_verified_at,
  archived_at IS NOT NULL AS archived,
  to_char(updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS updated_at`;

/** A location row as the detail answer of the list and the management routes. */
export function toDetail(row: LocationRow, codeLocked: boolean): LocationDetail {
  return {
    id: row.id,
    code: row.code,
    name: { en: row.name.en, ar: row.name.ar },
    kind: row.kind === 'shop' ? 'shop' : 'warehouse',
    ownerType: row.owner_type,
    sellableOnline: row.sellable_online,
    online: row.online,
    stockVerifiedAt: row.stock_verified_at,
    archived: row.archived,
    updatedAt: row.updated_at,
    codeLocked,
  };
}

/** The audited fields of a location row, as the audit diff names them. */
function auditedFields(row: LocationRow): JsonObject {
  return {
    code: row.code,
    name: {
      ...(row.name.en ? { en: row.name.en } : {}),
      ...(row.name.ar ? { ar: row.name.ar } : {}),
    },
    kind: row.kind,
    sellableOnline: row.sellable_online,
  };
}

/** Only the fields an edit changed, before and after, or null when nothing changed. */
function changedFields(
  before: LocationRow,
  after: LocationRow,
): { before: JsonObject; after: JsonObject } | null {
  const old = auditedFields(before);
  const now = auditedFields(after);
  const keys = Object.keys(now).filter(
    (key) => JSON.stringify(old[key]) !== JSON.stringify(now[key]),
  );
  if (!keys.length) return null;
  return {
    before: Object.fromEntries(keys.map((key) => [key, old[key] ?? null])),
    after: Object.fromEntries(keys.map((key) => [key, now[key] ?? null])),
  };
}

function codeTaken(error: unknown, code: string): unknown {
  if (pgConstraint(error) === 'locations_code_unique') {
    return new LocationError('CodeTaken', `Location code ${code} is already in use`);
  }
  return error;
}

/** Warehouses and shops: the switcher list, and full management for people holding `catalog.manage` (AC-4). */
@Injectable()
export class LocationsService {
  /**
   * Takes the app database connection, the ledger service that knows what stock a location
   * holds, and the policy service that answers what an owner type allows.
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(LocationPolicyService) private readonly policy: LocationPolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Warehouses and shops, active (default) or archived, ordered by code. Ordering and the
   * keyset comparison both use the "C" collation, so pages never skip or repeat a row.
   */
  async listWorkLocations(query: {
    status?: LocationStatus;
    cursor?: string;
    limit: number;
  }): Promise<LocationListResponse> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const filters: SQL[] = [
      WORK_KIND,
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

  /**
   * Creates a sellable warehouse or shop that does not allow negative stock and is never online
   * (AC-4, AC-29; the online flag moves only through the gate, spec 0011 AC-1). The
   * owner type defaults to the brand's own; the policy service refuses a party whose roles do not
   * fit it (`PartyRoleMismatch`). The check and
   * the insert run in one transaction and the party row is read `FOR SHARE`, so a party archived
   * or stripped of its role at the same moment cannot be linked. It runs through
   * `ledgerTransaction`, so a lock wait is capped at 5 seconds and answers `LockTimeout` (503, as
   * ledger writes do).
   */
  async create(input: z.output<typeof CreateLocationRequest>): Promise<LocationDetail> {
    try {
      return await ledgerTransaction(this.connection.db, async (tx) => {
        await this.policy.assertCanCreate(input, tx);
        const { rows } = await tx.execute<LocationRow>(sql`
        INSERT INTO locations (code, name, kind, owner_type, party_id, sellable_online, is_sellable, allow_negative)
        VALUES (${input.code}, ${JSON.stringify(input.name)}::jsonb, ${input.kind},
                ${input.ownerType ?? sql`DEFAULT`}, ${input.partyId ?? null},
                false, true, false)
        RETURNING ${LOCATION_COLUMNS}`);
        const row = rows[0];
        if (!row) throw new Error('The location insert returned no row');
        return toDetail(row, false);
      });
    } catch (error) {
      throw codeTaken(error, input.code);
    }
  }

  /**
   * Edits name, kind, and code (AC-4; online selling changes only through the gate, spec 0011) with the stale check on `updatedAt`. A code change first
   * locks the location against postings (as an archive does), then answers `CodeLocked` once
   * stock was posted there or a receipt names it. The fields that really changed are recorded as
   * one `location.edited` entry in the same transaction (spec 0010, AC-11).
   */
  async update(
    id: string,
    input: z.output<typeof UpdateLocationRequest>,
    caller: LocationCaller,
  ): Promise<LocationDetail> {
    const correlationId = this.audit.newCorrelationId();
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
        if (input.kind) {
          // The online location stays a warehouse (spec 0011 AC-1): refuse before the database does.
          if (current.online && input.kind !== 'warehouse') {
            throw new LocationError(
              'OnlineNeedsWarehouse',
              'The online location must stay a warehouse. Move online stock to another warehouse first.',
            );
          }
          sets.push(sql`kind = ${input.kind}`);
        }
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
        const changed = changedFields(current, row);
        if (changed) {
          await this.audit.record(tx, {
            actor: personActor(caller.id, caller.access.actingHat('catalog.manage')),
            action: 'location.edited',
            record: { type: 'location', id, label: row.code },
            ...changed,
            correlationId,
          });
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
   * Archiving an active location records `location.archived`.
   */
  async archive(id: string, caller: LocationCaller): Promise<LocationDetail> {
    const correlationId = this.audit.newCorrelationId();
    return ledgerTransaction(this.connection.db, async (tx) => {
      if (!(await this.lockWork(tx, id))) throw notFound();
      const before = await this.findWork(tx, id);
      const usage = (await this.ledger.usage({ locationIds: [id] }, tx)).get(id);
      if (usage?.onHandNonZero || usage?.activeReserved) {
        throw new LocationError(
          'StockOnHand',
          'This location still has stock on hand or reserved. Move or adjust it first.',
        );
      }
      const location = await this.setArchived(tx, id, true);
      if (before && !before.archived) {
        await this.recordArchive(tx, location, caller, correlationId, before.sellable_online);
      }
      return location;
    });
  }

  /**
   * Brings an archived location back to the switcher and pickers, recording `location.unarchived`;
   * refused with `PolicyChangedSinceArchive` when a locked term of its owner type's policy changed
   * after it was archived.
   */
  async unarchive(id: string, caller: LocationCaller): Promise<LocationDetail> {
    const correlationId = this.audit.newCorrelationId();
    return ledgerTransaction(this.connection.db, async (tx) => {
      if (!(await this.lockWork(tx, id))) throw notFound();
      // A location back from the archive counts again for the owner type's policy locks, and
      // never comes back under locked terms changed since it was archived (spec 0009 AC-24, D13).
      await this.policy.holdOwnerTypeOf(id, tx);
      await this.policy.assertUnchangedSinceArchive(id, tx);
      const before = await this.findWork(tx, id);
      const location = await this.setArchived(tx, id, false);
      if (before?.archived) await this.recordArchive(tx, location, caller, correlationId);
      return location;
    });
  }

  /** The archive or unarchive entry: `archived` before and after, labelled with the code. */
  private async recordArchive(
    tx: Transaction,
    location: LocationDetail,
    caller: LocationCaller,
    correlationId: string,
    wasOnline = false,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: personActor(caller.id, caller.access.actingHat('catalog.manage')),
      action: location.archived ? 'location.archived' : 'location.unarchived',
      record: { type: 'location', id: location.id, label: location.code },
      // An archive that turns online stock off says so (spec 0011 AC-1).
      before: { archived: !location.archived, ...(wasOnline ? { online: true } : {}) },
      after: { archived: location.archived, ...(wasOnline ? { online: false } : {}) },
      correlationId,
    });
  }

  /**
   * How many locations of an owner type are not archived (spec 0009, AC-24): above zero, the
   * locked fields of the type's policy cannot change. System locations count too.
   */
  async countActiveByOwnerType(
    ownerType: LocationOwnerType,
    executor: Executor = this.connection.db,
  ): Promise<number> {
    const { rows } = await executor.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM locations
      WHERE owner_type = ${ownerType}::location_owner_type AND archived_at IS NULL`);
    return rows[0]?.n ?? 0;
  }

  /**
   * How many locations of an owner type sell online (spec 0009, AC-24): above zero, the type's
   * policy cannot turn online selling off. An archived location never sells online (archive
   * clears the flag, and unarchive never sets it), so it does not count.
   */
  async countSellableOnlineByOwnerType(
    ownerType: LocationOwnerType,
    executor: Executor = this.connection.db,
  ): Promise<number> {
    const { rows } = await executor.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM locations
      WHERE owner_type = ${ownerType}::location_owner_type AND sellable_online
        AND archived_at IS NULL`);
    return rows[0]?.n ?? 0;
  }

  /**
   * Deletes a location nothing references (AC-4): receipts, movements, balances, reservations,
   * serials, or bins make the delete fail with `InUse`.
   */
  async delete(id: string): Promise<void> {
    let deleted: boolean;
    try {
      const { rows } = await this.connection.db.execute(sql`
        DELETE FROM locations WHERE id = ${id} AND ${WORK_KIND} RETURNING id`);
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

  /**
   * Records that a location's stock is confirmed counted (spec 0011 AC-19): the gate's "stock
   * counted" fact. Called by the confirm action here and by feature 15's verify step. Sets
   * `stock_verified_at` and `stock_verified_by` only while unset and answers whether it did, so a
   * second call changes nothing. A system location is never confirmed (false).
   */
  async recordStockVerified(tx: Transaction, locationId: string, by: string): Promise<boolean> {
    const { rows } = await tx.execute(sql`
      UPDATE locations
      SET stock_verified_at = now(), stock_verified_by = ${by}, updated_at = now()
      WHERE id = ${locationId} AND ${WORK_KIND} AND stock_verified_at IS NULL
      RETURNING id`);
    return rows.length > 0;
  }

  /** One warehouse or shop as the detail answer, or null when it does not exist (or is a system row). */
  async detailOf(tx: Executor, id: string): Promise<LocationDetail | null> {
    const { rows } = await tx.execute<LocationRow>(sql`
      SELECT ${LOCATION_COLUMNS} FROM locations WHERE id = ${id} AND ${WORK_KIND}`);
    const row = rows[0];
    return row ? toDetail(row, await this.isCodeLocked(tx, id)) : null;
  }

  private async findWork(tx: Transaction, id: string): Promise<LocationRow | null> {
    const { rows } = await tx.execute<LocationRow>(sql`
      SELECT ${LOCATION_COLUMNS} FROM locations WHERE id = ${id} AND ${WORK_KIND}`);
    return rows[0] ?? null;
  }

  /** `ledger.lockForArchive` for a warehouse or shop; a system location counts as missing. */
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
          sellable_online = false,
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
