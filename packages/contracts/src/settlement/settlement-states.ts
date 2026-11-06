import { InvalidAmountError } from '../money.js';
import type {
  SettlementMatchResult,
  SettlementPeriodAction,
  SettlementPeriodState,
} from './settlement-enums.js';

/**
 * A line's state from its match rows and a period's status from its events (spec 0002
 * "settlement"). Both tables are append only history, so the current state is always the latest
 * row. Nothing here reads a database; the settlement service passes the rows in.
 */

/** A timestamp as the database driver or JSON gives it. */
export type RecordedAt = string | Date;

/** The columns of a `settlement_line_matches` row that decide a line's state. */
export interface SettlementLineMatchRow {
  id: string;
  /** The row this one replaces; null on a line's first row. The database requires it on every later row. */
  supersedesMatchId: string | null;
  result: SettlementMatchResult;
  /** Required by the database for `unmatched` and `cleared`. */
  reasonCode: string | null;
}

/** The columns of a `settlement_period_events` row that decide a period's status. */
export interface SettlementPeriodEventRow {
  id: string;
  recordedAt: RecordedAt;
  action: SettlementPeriodAction;
}

/**
 * Thrown when a line's match rows do not form one chain (two heads, a fork, or none, a cycle), or
 * when a row follows an `accounted` row other than the superseded clear (domain review D1). Carries
 * no row data.
 */
export class InvalidMatchChain extends Error {
  readonly code = 'InvalidMatchChain';

  /** Takes the plain words of what is wrong. */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMatchChain';
  }
}

/** A line's current state. */
export interface LineMatchState {
  result: SettlementMatchResult;
  /** The latest row's reason; `not_yet_matched` when the line has no rows. */
  reasonCode: string | null;
  /**
   * True for `accounted` and `cleared`: nothing further is expected of the line. The one row that
   * may still follow an `accounted` row is a `cleared` row with the reason `superseded`, once the
   * line's statement is superseded (the database checks the statement; domain review D1).
   */
  terminal: boolean;
  /** True for `matched`, `accounted`, and `cleared`: the results a period may close over. */
  settled: boolean;
  /** The id of the latest row; null when the line has no rows. */
  latestMatchId: string | null;
}

const instantOf = (value: RecordedAt): number => {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(time)) throw new InvalidAmountError('A recorded time is not a date');
  return time;
};

/**
 * The latest event by `recorded_at`, then by `id`. The database stamps `recorded_at` with the
 * moment of the insert (`clock_timestamp()`, security review S1), so events of one transaction
 * keep their order; on an equal instant the greater id wins (uuidv7, growing within a session,
 * compared as text).
 */
function latestEvent(events: readonly SettlementPeriodEventRow[]): SettlementPeriodEventRow | null {
  let latest: SettlementPeriodEventRow | null = null;
  for (const row of events) {
    if (latest === null) {
      latest = row;
      continue;
    }
    const delta = instantOf(row.recordedAt) - instantOf(latest.recordedAt);
    if (delta > 0 || (delta === 0 && row.id > latest.id)) latest = row;
  }
  return latest;
}

/** The one row that may follow an `accounted` row (domain review D1). */
const isSupersededClear = (row: SettlementLineMatchRow): boolean =>
  row.result === 'cleared' && row.reasonCode === 'superseded';

/**
 * A line's state: its head match row, the one no other row supersedes (the chain, never
 * timestamps: two transactions can commit in the other order from their start times). A line with
 * no rows is `unmatched` with the reason `not_yet_matched`. `accounted` and `cleared` are
 * terminal; `matched` is settled but a later row may still unmatch it. The database's one
 * exception holds here too: an `accounted` row may be followed only by a `cleared` row with the
 * reason `superseded` (the statement was superseded, domain review D1), which ends the line as
 * `cleared`. Throws `InvalidMatchChain` when the rows have two heads or none, when anything else
 * follows an `accounted` row, or when any row follows a `cleared` row (review R17). Must never be
 * stored.
 */
export function lineMatchState(matches: readonly SettlementLineMatchRow[]): LineMatchState {
  if (matches.length === 0) {
    return {
      result: 'unmatched',
      reasonCode: 'not_yet_matched',
      terminal: false,
      settled: false,
      latestMatchId: null,
    };
  }
  const superseded = new Set<string>();
  const byId = new Map(matches.map((row) => [row.id, row]));
  for (const row of matches) {
    if (row.supersedesMatchId === null) continue;
    superseded.add(row.supersedesMatchId);
    const target = byId.get(row.supersedesMatchId);
    if (target?.result === 'accounted' && !isSupersededClear(row)) {
      throw new InvalidMatchChain(
        'Only a cleared row with the reason superseded may follow an accounted row',
      );
    }
    // Review R17: a cleared line belongs to a superseded statement; nothing follows it.
    if (target?.result === 'cleared') {
      throw new InvalidMatchChain('No row may follow a cleared row');
    }
  }
  const heads = matches.filter((row) => !superseded.has(row.id));
  const [latest] = heads;
  if (latest === undefined) throw new InvalidMatchChain('The match rows have no head (a cycle)');
  if (heads.length > 1) {
    throw new InvalidMatchChain(`The match rows have ${heads.length} heads (a fork)`);
  }
  const terminal = latest.result === 'accounted' || latest.result === 'cleared';
  return {
    result: latest.result,
    reasonCode: latest.reasonCode,
    terminal,
    settled: terminal || latest.result === 'matched',
    latestMatchId: latest.id,
  };
}

/**
 * A period's status: `open` with no events, else the latest event's result (by `recorded_at`,
 * then `id`, see `latestEvent`): `closed` gives `closed`, `revoked` gives `open`. The stored `status` column must
 * always equal this.
 */
export function settlementPeriodStatus(
  events: readonly SettlementPeriodEventRow[],
): SettlementPeriodState {
  const latest = latestEvent(events);
  if (latest === null) return 'open';
  switch (latest.action) {
    case 'closed':
      return 'closed';
    case 'revoked':
      return 'open';
    default: {
      const unreachable: never = latest.action;
      return unreachable;
    }
  }
}
