/**
 * The log line a hat change writes (spec 0005, AC-33 e), in the shape of the AC-23 sign in lines:
 * who acted, on whom, from where, when, and which hats were added and removed. The event name is
 * spec 0008's `HatsChanged`, which also owns the event payload (it adds `before`, `after` and
 * `reason`, spec 0008 AC-13); this is only the line.
 *
 * It must never carry an email, a name, a phone or any other personal data: ids and hat names only.
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
}

/** Who changed whose hats, from where and when: the AC-23 context, where both people are known. */
export interface HatChangeContext {
  actorId: string;
  targetId: string;
  ip: string;
  userAgent: string | null;
  at: Date;
}

/**
 * Builds the {@link HatChangeLogLine} for a change from `before` to `after` (the full hat sets).
 * The lists are sorted so the same change always logs the same line. It works the difference out
 * itself, so a caller can never log a hat as both added and removed.
 */
export function hatChangeLogLine(
  context: HatChangeContext,
  before: readonly string[],
  after: readonly string[],
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
  };
}
