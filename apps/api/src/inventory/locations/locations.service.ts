import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateLocationRequest,
  LocationDetail,
  LocationListResponse,
  LocationSummary,
} from '@ssdashboard/contracts';
import { and, inArray, isNull, schema, sql, type DatabaseConnection } from '@ssdashboard/db';
import type { z } from 'zod';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, pgConstraint } from '../../database/sql.js';

/** A location as other inventory answers name it. */
export interface LocationRef {
  id: string;
  code: string;
  name: { en?: string; ar?: string };
}

/** `to_char` format of `updatedAt`: microseconds, UTC (spec 0006, Value sourcing). */
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** Another location already has this code (AC-4). */
export class LocationCodeTakenError extends Error {
  constructor(code: string) {
    super(`Location code ${code} is already in use`);
  }
}

const WORK_TYPES = ['warehouse', 'showroom'] as const;

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

@Injectable()
export class LocationsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * Active warehouses and showrooms, ordered by code. Ordering and the keyset comparison
   * both use the "C" collation, so pages never skip or repeat a row.
   */
  async listWorkLocations(query: {
    cursor?: string;
    limit: number;
  }): Promise<LocationListResponse> {
    const { locations } = schema;
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const rows = await this.connection.db
      .select({
        id: locations.id,
        code: locations.code,
        name: locations.name,
        type: locations.type,
      })
      .from(locations)
      .where(
        and(
          inArray(locations.type, [...WORK_TYPES]),
          isNull(locations.archivedAt),
          after === undefined
            ? undefined
            : sql`${locations.code} COLLATE "C" > ${after} COLLATE "C"`,
        ),
      )
      .orderBy(sql`${locations.code} COLLATE "C"`)
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const items = page.map((row): LocationSummary => ({
      id: row.id,
      code: row.code,
      name: { en: row.name.en, ar: row.name.ar },
      type: row.type === 'showroom' ? 'showroom' : 'warehouse',
    }));
    const last = page.at(-1);
    return {
      items,
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
      const { rows } = await this.connection.db.execute<{
        id: string;
        code: string;
        name: { en?: string; ar?: string };
        type: 'warehouse' | 'showroom';
        updated_at: string;
      }>(sql`
        INSERT INTO locations (code, name, type, is_sellable, allow_negative)
        VALUES (${input.code}, ${JSON.stringify(input.name)}::jsonb, ${input.type}, true, false)
        RETURNING id, code, name, type,
                  to_char(updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS updated_at`);
      const row = rows[0];
      if (!row) throw new Error('The location insert returned no row');
      return {
        id: row.id,
        code: row.code,
        name: { en: row.name.en, ar: row.name.ar },
        type: row.type,
        archived: false,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      if (pgConstraint(error) === 'locations_code_unique') {
        throw new LocationCodeTakenError(input.code);
      }
      throw error;
    }
  }
}
