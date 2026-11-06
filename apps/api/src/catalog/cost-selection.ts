import type { CostBasis } from '@ssdashboard/contracts';

/**
 * One cost record as the lookup reads it. Dates are `YYYY-MM-DD` and `recordedAt` an ISO text
 * with microseconds in UTC, so plain string comparison orders them.
 */
export interface CostRecordCandidate {
  /** The record's `id` (a time ordered uuidv7): the last tiebreaker when `recordedAt` is equal. */
  id: string;
  /** Null for the style's record, set for a variant override. */
  variantId: string | null;
  unitCost: string;
  costBasis: CostBasis;
  effectiveFrom: string;
  recordedAt: string;
}

/** A cost in force on a day, with the basis it rests on. */
export type CostSet = { status: 'set'; unitCost: string; costBasis: CostBasis };

/** No cost record applies: the cost is not set, which is never read as zero (AC-30). */
export type NotSet = { status: 'not_set' };

/** The cost in force on a day, or `NotSet`. */
export type CostResult = CostSet | NotSet;

/**
 * Picks the cost record in force on `onDate` from the records of one variant and its style
 * (spec 0002, A12): the latest `effectiveFrom` not after the day; on a tie a variant override
 * beats a style record; then the latest `recordedAt`, then the greatest `id` (the last tiebreaker
 * for an equal instant). The database sets `recordedAt` to the moment of the insert, whatever the
 * writer sends (security review S1), so a corrected record (same date, later `recordedAt`) always
 * replaces a mistyped one without editing it. No record is `not_set`.
 * Pure: it never reads the database and never returns 0 for a missing cost.
 */
export function selectCost(records: readonly CostRecordCandidate[], onDate: string): CostResult {
  let best: CostRecordCandidate | undefined;
  for (const record of records) {
    if (record.effectiveFrom > onDate) continue;
    if (!best || outranks(record, best)) best = record;
  }
  if (!best) return { status: 'not_set' };
  return { status: 'set', unitCost: best.unitCost, costBasis: best.costBasis };
}

function outranks(a: CostRecordCandidate, b: CostRecordCandidate): boolean {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom > b.effectiveFrom;
  const aOverride = a.variantId !== null;
  if (aOverride !== (b.variantId !== null)) return aOverride;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt > b.recordedAt;
  return a.id > b.id;
}
