import { Inject, Injectable } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import type { Executor } from '../../database/sql.js';

/** The latest go live instant a backfill accepts: this long after the database clock. */
export const GO_LIVE_MAX_AHEAD_MS = 5 * 60_000;

/** The earliest go live instant a backfill accepts: this long before the database clock. */
export const GO_LIVE_MAX_BEHIND_MS = 60 * 86_400_000;

/**
 * The database clock the first backfill judges its go live instant by (lead decision D11,
 * security review M1): `clock_timestamp()` through the caller's transaction, never the process
 * clock. A test binds a fixed one, because the recorded fixtures carry fixed instants. It reads
 * the clock only; it must never decide anything itself.
 */
@Injectable()
export class GoLiveClock {
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

/**
 * Whether a go live instant lies in the window D11 allows around `now`: not after `now` plus 5
 * minutes and not before `now` minus 60 days. Pure.
 */
export function goLiveInRange(goLiveAt: string, now: Date): boolean {
  const at = Date.parse(goLiveAt);
  return (
    Number.isFinite(at) &&
    at <= now.getTime() + GO_LIVE_MAX_AHEAD_MS &&
    at >= now.getTime() - GO_LIVE_MAX_BEHIND_MS
  );
}
