import { createHash } from 'node:crypto';
import { UnitCost } from '@ssdashboard/contracts';

/** One posting line reduced to the fields that identify it, so a retry hashes identically. */
export interface HashedLine {
  variantId: string;
  locationId: string;
  binId?: string | undefined;
  lotId?: string | undefined;
  quantity: number;
  unitCost?: string | undefined;
  sourceLineId?: string | undefined;
  serials?: readonly string[] | undefined;
  reservationId?: string | undefined;
  reasonCode?: string | undefined;
}

/**
 * A whole posting reduced to what identifies it, for the idempotency check: the same key with a
 * different hash is a conflict.
 */
export interface HashedRequest {
  operation: 'post' | 'reverse' | 'carrier';
  sourceType: string;
  sourceId: string;
  reversesGroupId: string | null;
  /** Only an explicit date: a retry that leaves it to default must still match. */
  effectiveAt?: Date | undefined;
  lines: readonly HashedLine[];
}

function compare(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a < b ? -1 : 1;
}

/** Canonical JSON: keys sorted at every level, undefined dropped. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of what a posting asks for (spec 0002, Value sourcing): never the key,
 * `postedBy`, or a defaulted date, and lines sorted so their order does not matter.
 *
 * Because `postedBy` is excluded, a replay of the same key from a different user matches and
 * returns the original poster's attribution. To be decided when the HTTP route lands (e.g. scope
 * keys per user, or reject a different poster); no behaviour change here.
 */
export function requestHash(request: HashedRequest): string {
  const lines = request.lines
    // `10` and `10.0000` are the same cost, so a retry that formats it differently matches.
    .map((line) =>
      line.unitCost === undefined
        ? line
        : { ...line, unitCost: UnitCost.of(line.unitCost).toString() },
    )
    .sort(
      (a, b) =>
        compare(a.variantId, b.variantId) ||
        compare(a.locationId, b.locationId) ||
        compare(a.binId, b.binId) ||
        compare(a.lotId, b.lotId) ||
        compare(a.sourceLineId, b.sourceLineId) ||
        compare(canonical(a), canonical(b)),
    );
  return createHash('sha256')
    .update(canonical({ ...request, lines }))
    .digest('hex');
}
