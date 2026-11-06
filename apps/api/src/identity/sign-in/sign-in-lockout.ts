import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { pgErrorCode, type Executor } from '../../database/sql.js';
import { SIGN_IN_SLOT_LOCK } from './locks.js';

/** Spec 0005, AC-3. */
export const LOCKOUT = {
  windowMinutes: 10,
  lockMinutes: 15,
  /** Failures for one email text from one address. */
  pairLimit: 5,
  /** Failures for one email text from any addresses. */
  emailLimit: 20,
  /** A slot older than this holds no place, so a request that died blocks nothing for longer. */
  slotSeconds: 60,
} as const;

/**
 * How long a request waits its turn for a slot. Every waiter holds a pooled connection, so a
 * flood for one email must not wait long enough to starve the pool; one that times out is
 * turned away, uncounted.
 */
export const SLOT_LOCK_TIMEOUT = '2s';

/** SQLSTATE lock_not_available: `lock_timeout` ran out. */
const LOCK_NOT_AVAILABLE = '55P03';

/** The row that counts an email's failures from every address. */
export const ALL_ADDRESSES = '*';

/**
 * What recording one failed sign in led to: whether a lock began and for which scope, so the
 * caller can emit the right event.
 */
export interface FailureOutcome {
  /** A lock began with this failure, for the pair or for the email as a whole. */
  pairLocked: boolean;
  emailLocked: boolean;
}

/** A slot to check one password or code, or why there was none (spec 0005, AC-3). */
export type TakenSlot =
  | { slot: string }
  /** No free slot. `locked` says whether a real lock is running, not just a full window. */
  | { slot: null; locked: boolean };

/** The email and address a counted failure is added to. */
export interface Failure {
  emailKey: string;
  ip: string;
}

const NO_LOCK: FailureOutcome = { pairLocked: false, emailLocked: false };

interface SlotRow extends Record<string, unknown> {
  id: string | null;
  locked: boolean;
}

interface CounterRow extends Record<string, unknown> {
  scope: string;
  failures: number;
}

/**
 * Failed sign in counters in PostgreSQL (spec 0005, AC-3), so a restart cannot clear a lock.
 * Counting is one atomic upsert: two attempts at the same moment each add one, and a lock
 * already running is never shortened or restarted. Before a password or code is checked the
 * attempt takes a slot, so whatever the concurrency no more are checked than the limits allow.
 */
@Injectable()
export class SignInLockout {
  private readonly db: Database;

  /** Takes the app database connection that holds the counters. */
  constructor(@Inject(DATABASE) connection: DatabaseConnection) {
    this.db = connection.db;
  }

  /**
   * Takes a slot to check one password or code. Slots for one email are handed out one at a
   * time, under a transaction advisory lock, and a slot is free only while no lock is running
   * and the window's failures plus the slots still held stay under the limit, for the pair and
   * for the email from all addresses. A request that waits longer than `SLOT_LOCK_TIMEOUT` for
   * its turn gets no slot. Slot ages use `clock_timestamp()`, not the transaction's start, so
   * time spent waiting does not shorten the slot.
   */
  async takeSlot(emailKey: string, ip: string): Promise<TakenSlot> {
    const window = sql`make_interval(mins => ${LOCKOUT.windowMinutes}::int)`;
    const slotAge = sql`make_interval(secs => ${LOCKOUT.slotSeconds}::int)`;
    let row: SlotRow | undefined;
    try {
      row = await this.db.transaction(async (tx) => {
        // SET cannot take a bound parameter; the value is our own constant.
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${SLOT_LOCK_TIMEOUT}'`));
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${SIGN_IN_SLOT_LOCK}::int, hashtext(${emailKey}::text))`,
        );
        // A counter whose window is over with no lock running counts as zero, as it would start
        // over on the next failure.
        const result = await tx.execute<SlotRow>(sql`
        WITH counters AS (
          SELECT
            COALESCE(bool_or(a.locked_until > now()), false) AS locked,
            COALESCE(sum(a.failures) FILTER (WHERE a.scope = ${ip}::text AND a.window_started_at + ${window} > now()), 0) AS pair_failures,
            COALESCE(sum(a.failures) FILTER (WHERE a.scope = ${ALL_ADDRESSES}::text AND a.window_started_at + ${window} > now()), 0) AS email_failures
          FROM sign_in_attempts a
          WHERE a.email_key = ${emailKey}::text AND a.scope IN (${ip}::text, ${ALL_ADDRESSES}::text)
        ),
        held AS (
          SELECT count(*) FILTER (WHERE s.ip = ${ip}::text) AS pair_slots, count(*) AS email_slots
          FROM sign_in_slots s
          WHERE s.email_key = ${emailKey}::text AND s.created_at > clock_timestamp() - ${slotAge}
        ),
        taken AS (
          INSERT INTO sign_in_slots (email_key, ip, created_at)
          SELECT ${emailKey}::text, ${ip}::text, clock_timestamp() FROM counters, held
           WHERE NOT counters.locked
             AND counters.pair_failures + held.pair_slots < ${LOCKOUT.pairLimit}::int
             AND counters.email_failures + held.email_slots < ${LOCKOUT.emailLimit}::int
          RETURNING id
        )
        SELECT (SELECT id FROM taken) AS id, counters.locked FROM counters`);
        return result.rows[0];
      });
    } catch (error) {
      // Waited too long for the email's turn: turned away like a full window, not counted.
      if (pgErrorCode(error) === LOCK_NOT_AVAILABLE) return { slot: null, locked: false };
      throw error;
    }
    if (row?.id) return { slot: row.id };
    return { slot: null, locked: row?.locked ?? false };
  }

  /**
   * Gives a slot back. With a failure, the failure is added in the same transaction, so no
   * reader sees the slot gone before the failure counts. A slot that went stale still counts.
   */
  async giveBack(slot: string, failure?: Failure): Promise<FailureOutcome> {
    const remove = sql`DELETE FROM sign_in_slots WHERE id = ${slot}::uuid`;
    if (!failure) {
      await this.db.execute(remove);
      return NO_LOCK;
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(remove);
      return addFailure(tx, failure.emailKey, failure.ip);
    });
  }

  /** Adds one failure to both rows and starts a lock when a limit is reached. */
  async recordFailure(emailKey: string, ip: string): Promise<FailureOutcome> {
    return addFailure(this.db, emailKey, ip);
  }

  /** Forgets this email's failures. Called only after a full sign in. */
  async reset(emailKey: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM sign_in_attempts WHERE email_key = ${emailKey}`);
  }
}

/** The atomic counting upsert, on the database or inside a give back transaction. */
async function addFailure(db: Executor, emailKey: string, ip: string): Promise<FailureOutcome> {
  const window = sql`make_interval(mins => ${LOCKOUT.windowMinutes}::int)`;
  // A counter starts over when its window is over and no lock is still running.
  const fresh = sql`(a.window_started_at + ${window} <= now() AND (a.locked_until IS NULL OR a.locked_until <= now()))`;
  const result = await db.execute<CounterRow>(sql`
      INSERT INTO sign_in_attempts AS a (email_key, scope, failures, window_started_at, locked_until)
      VALUES (${emailKey}::text, ${ip}::text, 1, now(), NULL), (${emailKey}::text, ${ALL_ADDRESSES}::text, 1, now(), NULL)
      ON CONFLICT (tenant_id, email_key, scope) DO UPDATE SET
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
