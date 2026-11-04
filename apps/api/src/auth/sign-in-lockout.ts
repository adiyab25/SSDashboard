import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';

/** Spec 0005, AC-3. */
export const LOCKOUT = {
  windowMinutes: 10,
  lockMinutes: 15,
  /** Failures for one email text from one address. */
  pairLimit: 5,
  /** Failures for one email text from any addresses. */
  emailLimit: 20,
} as const;

/** The row that counts an email's failures from every address. */
export const ALL_ADDRESSES = '*';

export interface FailureOutcome {
  /** A lock began with this failure, for the pair or for the email as a whole. */
  pairLocked: boolean;
  emailLocked: boolean;
}

interface CounterRow extends Record<string, unknown> {
  scope: string;
  failures: number;
}

/**
 * Failed sign in counters in PostgreSQL (spec 0005, AC-3), so a restart cannot clear a lock.
 * Counting is one atomic upsert: two attempts at the same moment each add one, and a lock
 * already running is never shortened or restarted.
 */
@Injectable()
export class SignInLockout {
  private readonly db: Database;

  constructor(@Inject(DATABASE) connection: DatabaseConnection) {
    this.db = connection.db;
  }

  /** Is this email from this address locked, or this email from anywhere? */
  async isLocked(emailKey: string, ip: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM sign_in_attempts
       WHERE email_key = ${emailKey}
         AND scope IN (${ip}, ${ALL_ADDRESSES})
         AND locked_until > now()
       LIMIT 1`);
    return result.rows.length > 0;
  }

  /** Adds one failure to both rows and starts a lock when a limit is reached. */
  async recordFailure(emailKey: string, ip: string): Promise<FailureOutcome> {
    const window = sql`make_interval(mins => ${LOCKOUT.windowMinutes}::int)`;
    // A counter starts over when its window is over and no lock is still running.
    const fresh = sql`(a.window_started_at + ${window} <= now() AND (a.locked_until IS NULL OR a.locked_until <= now()))`;
    const result = await this.db.execute<CounterRow>(sql`
      INSERT INTO sign_in_attempts AS a (email_key, scope, failures, window_started_at, locked_until)
      VALUES (${emailKey}::text, ${ip}::text, 1, now(), NULL), (${emailKey}::text, ${ALL_ADDRESSES}::text, 1, now(), NULL)
      ON CONFLICT (email_key, scope) DO UPDATE SET
        failures = CASE WHEN ${fresh} THEN 1 ELSE a.failures + 1 END,
        window_started_at = CASE WHEN ${fresh} THEN now() ELSE a.window_started_at END,
        locked_until = CASE
          WHEN ${fresh} THEN NULL
          WHEN a.locked_until > now() THEN a.locked_until
          WHEN a.failures + 1 >= CASE WHEN a.scope = ${ALL_ADDRESSES}::text
                                      THEN ${LOCKOUT.emailLimit}::int ELSE ${LOCKOUT.pairLimit}::int END
            THEN now() + make_interval(mins => ${LOCKOUT.lockMinutes}::int)
          ELSE NULL END
      RETURNING scope, failures`);

    // The failure that reaches a limit exactly is the one that started the lock.
    const reached = (scope: string, limit: number) =>
      result.rows.some((row) => row.scope === scope && row.failures === limit);
    return {
      pairLocked: reached(ip, LOCKOUT.pairLimit),
      emailLocked: reached(ALL_ADDRESSES, LOCKOUT.emailLimit),
    };
  }

  /** Forgets this email's failures. Called only after a full sign in. */
  async reset(emailKey: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM sign_in_attempts WHERE email_key = ${emailKey}`);
  }
}
