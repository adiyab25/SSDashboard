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
import { briefRows, FLAG_SEVERITY_SQL, utc } from '../customer-briefs.js';
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

  /**
   * Every canonical customer whose canonical flag is set (spec 0014 AC-5 with AC-11): her own
   * row's flag, else the most severe on the ids merged into her (then the latest set, then the
   * lowest id, as `briefRows` and the profile choose). Each customer is listed through the one row
   * whose flag is her canonical flag, ordered by that row's set time, then its id, both
   * descending; the keyset is that pair, so no customer is skipped or repeated across pages.
   *
   * The first half (a canonical row's own flag) reads `customers_flagged_idx` in its order; the
   * second half (a customer with no flag of her own and a flagged merged record) reads merged rows
   * through `customers_merged_into_idx`, which merges keep few.
   */
  private async flagged(
    limit: number,
    cursor: string | undefined,
  ): Promise<CustomerSearchResponse> {
    const after = cursor === undefined ? null : decodeTimeIdKeyset(cursor);
    const afterOwn =
      after === null
        ? sql``
        : sql`AND (k.risk_flag_set_at, k.id) < (${after.at}::timestamptz, ${after.id}::uuid)`;
    const afterMerged =
      after === null
        ? sql``
        : sql`AND (f.risk_flag_set_at, f.id) < (${after.at}::timestamptz, ${after.id}::uuid)`;
    const { rows } = await this.connection.db.execute<{
      row_id: string;
      customer_id: string;
      at: string;
    }>(sql`
      SELECT row_id, customer_id, ${utc('set_at')} AS at
      FROM (
        (SELECT k.id AS row_id, k.id AS customer_id, k.risk_flag_set_at AS set_at
         FROM customers k
         WHERE k.risk_flag IS NOT NULL AND k.merged_into_id IS NULL ${afterOwn}
         ORDER BY k.risk_flag_set_at DESC NULLS FIRST, k.id DESC
         LIMIT ${limit + 1})
        UNION ALL
        (SELECT f.id, f.merged_into_id, f.risk_flag_set_at
         FROM customers f JOIN customers k ON k.id = f.merged_into_id
         WHERE f.merged_into_id IS NOT NULL AND f.risk_flag IS NOT NULL
           AND k.risk_flag IS NULL ${afterMerged}
           AND f.id = (
             SELECT g.id FROM customers g
             WHERE g.merged_into_id = k.id AND g.risk_flag IS NOT NULL
             ORDER BY array_position(${FLAG_SEVERITY_SQL}::text[], g.risk_flag::text),
                      g.risk_flag_set_at DESC, g.id
             LIMIT 1))
      ) listed
      ORDER BY set_at DESC NULLS FIRST, row_id DESC
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await briefRows(
        this.connection.db,
        page.map((row) => row.customer_id),
      ),
      nextCursor: rows.length > limit && last ? encodeKeyset([last.at, last.row_id]) : null,
    };
  }
}
