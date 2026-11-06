/**
 * What a person holds, before or after a hat change, as spec 0008 AC-13 names it: the hat names,
 * whether they hold the `cost.view` grant, and the partner account a partner user is bound to
 * (`null` for staff). Ids and names only.
 */
export interface HatHolding {
  hats: string[];
  costView: boolean;
  partnerAccountId: string | null;
}

/**
 * The log line a hat change writes (spec 0005, AC-33 e; spec 0008, AC-13), in the shape of the
 * AC-23 sign in lines: who acted, on whom, from where, when, which hats were added and removed
 * and, when the caller gives them, the full `before` and `after` holdings and the `reason`. A
 * cost only change shows in `before` and `after` with no hat added or removed. The `HatsChanged`
 * event payload is spec 0008's; this is only the line.
 *
 * It must never carry an email, a name, a phone or any other personal data: ids, hat names, the
 * cost grant and the reason the manager typed only.
 */
export interface HatChangeLogLine {
  event: 'HatsChanged';
  actorId: string;
  targetId: string;
  ip: string;
  userAgent: string | null;
  /** ISO 8601, as the other auth lines write it. */
  at: string;
  /** Hats the person holds after the change and did not before, sorted. */
  hatsAdded: string[];
  /** Hats the person held before the change and no longer does, sorted. */
  hatsRemoved: string[];
  /** The full holding before the change (hats sorted), when the caller gave it. */
  before?: HatHolding;
  /** The full holding after the change (hats sorted), when the caller gave it. */
  after?: HatHolding;
  /** The manager's optional reason (spec 0008 allows up to 500 characters), when given. */
  reason?: string;
}

/** Who changed whose hats, from where and when: the AC-23 context, where both people are known. */
export interface HatChangeContext {
  actorId: string;
  targetId: string;
  ip: string;
  userAgent: string | null;
  at: Date;
}

/** The holdings and reason a caller may add to the line (spec 0008, AC-13). */
export interface HatChangeDetail {
  before?: HatHolding;
  after?: HatHolding;
  reason?: string;
}

/** A copy of the holding with its hats sorted and deduplicated, and nothing else on it. */
const holdingOf = (holding: HatHolding): HatHolding => ({
  hats: [...new Set(holding.hats)].sort(),
  costView: holding.costView,
  partnerAccountId: holding.partnerAccountId,
});

/**
 * Builds the {@link HatChangeLogLine} for a change from `before` to `after` (the full hat sets).
 * The lists are sorted so the same change always logs the same line. It works the difference out
 * itself, so a caller can never log a hat as both added and removed. `detail` adds the full
 * holdings and the reason when given; only their named fields are copied, so a wider object can
 * never put more on the line.
 */
export function hatChangeLogLine(
  context: HatChangeContext,
  before: readonly string[],
  after: readonly string[],
  detail: HatChangeDetail = {},
): HatChangeLogLine {
  const was = new Set(before);
  const now = new Set(after);
  return {
    event: 'HatsChanged',
    actorId: context.actorId,
    targetId: context.targetId,
    ip: context.ip,
    userAgent: context.userAgent,
    at: context.at.toISOString(),
    hatsAdded: [...now].filter((hat) => !was.has(hat)).sort(),
    hatsRemoved: [...was].filter((hat) => !now.has(hat)).sort(),
    ...(detail.before && { before: holdingOf(detail.before) }),
    ...(detail.after && { after: holdingOf(detail.after) }),
    ...(detail.reason !== undefined && { reason: detail.reason }),
  };
}
