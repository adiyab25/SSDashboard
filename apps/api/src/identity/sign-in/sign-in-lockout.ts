import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Database, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { isRetryable, type Executor } from '../../database/sql.js';
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
 * How long, in all, a request waits its turn for a slot (spec 0005, AC-3). One that runs out is
 * turned away like a full window: not checked, not counted.
 */
export const SLOT_WAIT_MS = 2_000;

/**
 * The pause between two tries for the email's turn, give or take half, so waiters do not retry
 * in step. A waiter holds no database connection while it pauses: each try is one short
 * transaction that never waits on a lock, so a flood on one email cannot starve the pool.
 */
export const SLOT_RETRY_MS = 20;

/** The email's turn is held by another request right now. */
const EMAIL_BUSY = Symbol('email busy');

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
   * for the email from all addresses. The lock is only ever tried, never waited on: while
   * another request holds the email's turn this one pauses with no connection and tries again,
   * and after `SLOT_WAIT_MS` it gets no slot. Slot ages use `clock_timestamp()`.
   */
  async takeSlot(emailKey: string, ip: string): Promise<TakenSlot> {
    const deadline = Date.now() + SLOT_WAIT_MS;
    for (;;) {
      const row = await this.trySlot(emailKey, ip);
      if (row !== EMAIL_BUSY) {
        return row?.id ? { slot: row.id } : { slot: null, locked: row?.locked ?? false };
      }
      const left = deadline - Date.now();
      // Waited too long for the email's turn: turned away like a full window, not counted.
      if (left <= 0) return { slot: null, locked: false };
      await sleep(Math.min(left, SLOT_RETRY_MS / 2 + Math.random() * SLOT_RETRY_MS));
    }
  }

  /**
   * One try for the email's turn, in one short transaction: the advisory lock is tried, and only
   * when it is won are the counters read, in a statement of their own so they see every slot and
   * failure committed before the lock was won.
   */
  private async trySlot(
    emailKey: string,
    ip: string,
  ): Promise<SlotRow | undefined | typeof EMAIL_BUSY> {
    const window = sql`make_interval(mins => ${LOCKOUT.windowMinutes}::int)`;
    const slotAge = sql`make_interval(secs => ${LOCKOUT.slotSeconds}::int)`;
    return this.db.transaction(async (tx) => {
      const turn = await tx.execute<{ won: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${SIGN_IN_SLOT_LOCK}::int, hashtext(${emailKey}::text)) AS won`,
      );
      if (!turn.rows[0]?.won) return EMAIL_BUSY;
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
  }

  /**
   * Gives a slot back. With a failure, the failure is added in the same transaction, so no
   * reader sees the slot gone before the failure counts. A slot that went stale still counts.
   * A counted give back that hits a deadlock or a serialization failure is tried once more; it
   * never falls back to giving the slot back uncounted, so a failure is never lost quietly.
   */
  async giveBack(slot: string, failure?: Failure): Promise<FailureOutcome> {
    const remove = sql`DELETE FROM sign_in_slots WHERE id = ${slot}::uuid`;
    if (!failure) {
      await this.db.execute(remove);
      return NO_LOCK;
    }
    return retryOnce(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(remove);
        return addFailure(tx, failure.emailKey, failure.ip);
      }),
    );
  }

  /** Adds one failure to both rows and starts a lock when a limit is reached. */
  async recordFailure(emailKey: string, ip: string): Promise<FailureOutcome> {
    return addFailure(this.db, emailKey, ip);
  }

  /**
   * Forgets this email's failures. Called only after a full sign in. The rows are locked first in
   * `ROW_LOCK_ORDER`, the order `addFailure` takes them in, so the two never deadlock each other.
   */
  async reset(emailKey: string): Promise<void> {
    await retryOnce(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT 1 FROM sign_in_attempts WHERE email_key = ${emailKey}::text
           ORDER BY ${ROW_LOCK_ORDER} FOR UPDATE`);
        await tx.execute(sql`DELETE FROM sign_in_attempts WHERE email_key = ${emailKey}::text`);
      }),
    );
  }
}

/**
 * The order an email's `sign_in_attempts` rows are locked in: the all addresses row first, then
 * each address in byte order. `addFailure` upserts the all addresses row before the address row,
 * so it takes its two rows in this order too.
 */
const ROW_LOCK_ORDER = sql`(scope <> ${ALL_ADDRESSES}::text), scope COLLATE "C"`;

/** Runs `work` again, once, when it failed with a deadlock or a serialization failure. */
async function retryOnce<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isRetryable(error)) throw error;
    return work();
  }
}

/** The atomic counting upsert, on the database or inside a give back transaction. */
async function addFailure(db: Executor, emailKey: string, ip: string): Promise<FailureOutcome> {
  const window = sql`make_interval(mins => ${LOCKOUT.windowMinutes}::int)`;
  // A counter starts over when its window is over and no lock is still running. The all
  // addresses row comes first, so the two rows are locked in `ROW_LOCK_ORDER`.
  const fresh = sql`(a.window_started_at + ${window} <= now() AND (a.locked_until IS NULL OR a.locked_until <= now()))`;
  const result = await db.execute<CounterRow>(sql`
      INSERT INTO sign_in_attempts AS a (email_key, scope, failures, window_started_at, locked_until)
      VALUES (${emailKey}::text, ${ALL_ADDRESSES}::text, 1, now(), NULL), (${emailKey}::text, ${ip}::text, 1, now(), NULL)
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
