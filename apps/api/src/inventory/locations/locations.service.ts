import { Inject, Injectable } from '@nestjs/common';
import type { LocationListResponse, LocationSummary } from '@ssdashboard/contracts';
import { and, inArray, isNull, schema, sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';

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
}
