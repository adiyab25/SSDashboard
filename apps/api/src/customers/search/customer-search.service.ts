import { Inject, Injectable } from '@nestjs/common';
import {
  EgyptianPhone,
  InvalidPhone,
  type CustomerSearchRequest,
  type CustomerSearchResponse,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import {
  decodeKeyset,
  decodeTimeIdKeyset,
  encodeKeyset,
  InvalidCursorError,
} from '../../platform/keyset-cursor.js';
import { briefRows, MICRO_UTC } from '../customer-briefs.js';
import { CustomersError } from '../customers.errors.js';
import { CustomersService } from '../customers.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The customer id inside a name search cursor, or `InvalidCursorError` when it is not exactly one uuid. */
function nameCursorId(cursor: string): string {
  const [id] = decodeKeyset(cursor, 1);
  if (id === undefined || !UUID.test(id)) throw new InvalidCursorError();
  return id;
}

/** Escapes `\`, `%`, and `_` so a typed fragment matches itself inside `ILIKE`. */
const likeFragment = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Finds customers by phone, by a name fragment, or the flagged ones (spec 0014 AC-3, AC-5). It
 * answers canonical customers only, so a merged id never appears on its own, and pages by keyset
 * with no row skipped or repeated. It must never echo the typed phone or name in an error, and it
 * never reads a table of another module.
 */
@Injectable()
export class CustomerSearchService {
  /** Takes the app database connection and the customers service. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Runs the one search the request names. A phone that does not parse is `INVALID_PHONE` (the
   * message never holds the text); a cursor this endpoint did not issue is `INVALID_CURSOR`.
   */
  async search(request: CustomerSearchRequest): Promise<CustomerSearchResponse> {
    try {
      if (request.phone !== undefined) return await this.byPhone(request.phone);
      if (request.nameContains !== undefined) {
        return await this.byName(request.nameContains, request.limit, request.cursor);
      }
      if (request.flagged === true) return await this.flagged(request.limit, request.cursor);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new CustomersError('INVALID_CURSOR', 'The cursor is not one this endpoint issued');
      }
      throw error;
    }
    throw new CustomersError(
      'INVALID_QUERY',
      'Give exactly one of phone, nameContains, or flagged',
    );
  }

  private async byPhone(text: string): Promise<CustomerSearchResponse> {
    let customerId: string | null;
    try {
      customerId = await this.customers.findByPhone(EgyptianPhone.parse(text));
    } catch (error) {
      if (error instanceof InvalidPhone) {
        throw new CustomersError('INVALID_PHONE', 'The text is not a valid phone number');
      }
      throw error;
    }
    const items = customerId === null ? [] : await briefRows(this.connection.db, [customerId]);
    return { items, nextCursor: null };
  }

  private async byName(
    fragment: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<CustomerSearchResponse> {
    // The cursor holds only the id of the last row (never a name): the next page starts after that
    // row's own (name, id), read here, so an id this endpoint never issued is `INVALID_CURSOR`.
    const afterId = cursor === undefined ? null : nameCursorId(cursor);
    if (afterId !== null) {
      const known = await this.connection.db.execute<{ id: string }>(
        sql`SELECT id FROM customers WHERE id = ${afterId}::uuid AND name IS NOT NULL`,
      );
      if (known.rows.length === 0) throw new InvalidCursorError();
    }
    const afterClause =
      afterId === null
        ? sql``
        : sql`AND (name COLLATE "C", id::text COLLATE "C") >
              (SELECT name COLLATE "C", id::text COLLATE "C" FROM customers WHERE id = ${afterId}::uuid)`;
    const { rows } = await this.connection.db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM customers
      WHERE merged_into_id IS NULL
        AND name ILIKE ${`%${likeFragment(fragment)}%`} ESCAPE '\\'
        ${afterClause}
      ORDER BY name COLLATE "C", id::text COLLATE "C"
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await briefRows(
        this.connection.db,
        page.map((row) => row.id),
      ),
      nextCursor: rows.length > limit && last ? encodeKeyset([last.id]) : null,
    };
  }

  private async flagged(
    limit: number,
    cursor: string | undefined,
  ): Promise<CustomerSearchResponse> {
    const after = cursor === undefined ? null : decodeTimeIdKeyset(cursor);
    const afterClause =
      after === null
        ? sql``
        : sql`AND (risk_flag_set_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)`;
    const { rows } = await this.connection.db.execute<{ id: string; at: string }>(sql`
      SELECT id, to_char(risk_flag_set_at AT TIME ZONE 'UTC', ${sql.raw(MICRO_UTC)}) AS at
      FROM customers
      WHERE risk_flag IS NOT NULL AND merged_into_id IS NULL ${afterClause}
      ORDER BY risk_flag_set_at DESC NULLS FIRST, id DESC
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await briefRows(
        this.connection.db,
        page.map((row) => row.id),
      ),
      nextCursor: rows.length > limit && last ? encodeKeyset([last.at, last.id]) : null,
    };
  }
}
