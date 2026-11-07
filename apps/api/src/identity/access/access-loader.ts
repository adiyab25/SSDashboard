import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { Access } from '../../platform/access/access.js';

/** The raw holdings of one person, as one read returns them. */
interface HoldingsRow extends Record<string, unknown> {
  hats: string[];
  grants: string[];
  partner_account_id: string | null;
}

/**
 * Reads what a person may do, `Access`, from `hat_assignments` and `permission_grants` (spec 0008,
 * Value sourcing "Any request"). The session guard calls it on every `staff` and `partner` request
 * and puts the answer on `request.access`, so a grant or a removal acts on the next request with
 * the same cookie. It must never cache an answer or keep one in the session or a cookie.
 */
@Injectable()
export class AccessLoader {
  private readonly db: Database;

  /** Takes the database connection the holdings are read from. */
  constructor(@Inject(DATABASE) connection: DatabaseConnection) {
    this.db = connection.db;
  }

  /** The person's hats, extra grants and partner account in one read, as an `Access`. */
  async load(userId: string): Promise<Access> {
    const result = await this.db.execute<HoldingsRow>(
      sql`SELECT
            coalesce((SELECT array_agg(hat ORDER BY hat) FROM hat_assignments
                       WHERE user_id = ${userId}::uuid), '{}') AS hats,
            coalesce((SELECT array_agg(permission ORDER BY permission) FROM permission_grants
                       WHERE user_id = ${userId}::uuid), '{}') AS grants,
            (SELECT partner_account_id FROM hat_assignments
              WHERE user_id = ${userId}::uuid AND hat = 'partner') AS partner_account_id`,
    );
    const row = result.rows[0];
    return new Access({
      userId,
      hats: row?.hats ?? [],
      grants: row?.grants ?? [],
      partnerAccountId: row?.partner_account_id ?? null,
    });
  }
}
