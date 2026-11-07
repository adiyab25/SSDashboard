import { Inject, Injectable } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import type { Executor } from '../../database/sql.js';

/**
 * The one clock the license reads (spec 0009, *Data model sketch*): PostgreSQL's
 * `clock_timestamp()`, the moment of the read, so a check that waited for the check lock judges
 * the day after the wait and never records a phase going backwards around midnight (review M2
 * code 2), and every process judges a day by the same server clock. The license and lapse tests
 * bind a fixed clock in its place. Never read `Date.now()` for a license phase.
 */
@Injectable()
export class PlatformClock {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** The database's current instant, through `executor` when given. */
  async now(executor: Executor = this.connection.db): Promise<Date> {
    const { rows } = await executor.execute<{ now: string }>(
      sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    );
    return new Date(rows[0]?.now ?? Number.NaN);
  }
}
