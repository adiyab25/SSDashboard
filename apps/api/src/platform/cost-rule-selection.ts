import type { CostRule, OrderCostRuleStatus } from '@ssdashboard/contracts';

/**
 * Thrown when a day given to the cost rule lookup is not a `YYYY-MM-DD` calendar date (for
 * example `2026-02-30` or `6/11/2026`). A typed domain error, so a caller maps it to its own
 * answer; it is never swallowed into a `not_set`.
 */
export class InvalidOperatingDay extends Error {
  /** The rejected input, as given. */
  readonly day: string;

  /** Names the rejected day. */
  constructor(day: string) {
    super(`"${day}" is not a YYYY-MM-DD calendar date`);
    this.name = 'InvalidOperatingDay';
    this.day = day;
  }
}

/**
 * Checks that `day` is a real `YYYY-MM-DD` calendar date (leap days included), and throws
 * `InvalidOperatingDay` otherwise. Pure; it never reads a clock or a time zone.
 */
export function assertOperatingDay(day: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new InvalidOperatingDay(day);
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // setUTCFullYear, not Date.UTC, which reads years 0 to 99 as 1900 to 1999.
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, date);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== date
  ) {
    throw new InvalidOperatingDay(day);
  }
}

/**
 * One `order_cost_rules` row of one kind as the lookup reads it. Dates are `YYYY-MM-DD` and
 * `recordedAt` an ISO text with microseconds in UTC, so plain string comparison orders them.
 */
export interface CostRuleCandidate {
  /** The row's `id` (a time ordered uuidv7): the last tiebreaker when `recordedAt` is equal. */
  id: string;
  status: OrderCostRuleStatus;
  /** `numeric(14,4)` text; null exactly when `status` is `not_set`. */
  value: string | null;
  effectiveFrom: string;
  recordedAt: string;
}

/**
 * Picks the rule in force on `onDay` from the rows of one kind (spec 0002, catalog child, "Per
 * order cost rules"): the latest `effectiveFrom` not after the day, then the latest `recordedAt`,
 * then the greatest `id` (the last tiebreaker for an equal instant; the database sets `recordedAt`
 * to the moment of the insert, whatever the writer sends, security review S1). A day before
 * the first row, or a winning `not_set` row, is `not_set`. Pure: it never reads the database and
 * never answers 0 for a rule that is not set (AC-32).
 */
export function selectCostRule(rows: readonly CostRuleCandidate[], onDay: string): CostRule {
  let best: CostRuleCandidate | undefined;
  for (const row of rows) {
    if (row.effectiveFrom > onDay) continue;
    if (!best || outranks(row, best)) best = row;
  }
  if (!best || best.status === 'not_set' || best.value === null) return { status: 'not_set' };
  return { status: 'set', value: best.value };
}

function outranks(a: CostRuleCandidate, b: CostRuleCandidate): boolean {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom > b.effectiveFrom;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt > b.recordedAt;
  return a.id > b.id;
}
