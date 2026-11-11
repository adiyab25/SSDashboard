import {
  decodeKeyset,
  decodeTimeIdKeyset,
  encodeKeyset,
  InvalidCursorError,
} from '../../platform/keyset-cursor.js';

/**
 * The source keys of the customer timeline, compared as plain text (`COLLATE "C"`): the second
 * part of the timeline's total order (spec 0014, Timeline and lenses). `order` is the orders
 * module's source; the rest are this module's own rows.
 */
export const TIMELINE_SOURCES = ['channel_id', 'flag', 'merge', 'order', 'phone'] as const;
/** One timeline source key. */
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

/** A place in the timeline's total order: `at` descending, then `source` ascending, then `id` descending. */
export interface TimelinePosition {
  /** A microsecond UTC timestamp as the api issues it. */
  at: string;
  source: TimelineSource;
  /** The entry's row id (lower case uuid). */
  id: string;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const isSource = (value: string): value is TimelineSource =>
  (TIMELINE_SOURCES as readonly string[]).includes(value);

/** The timeline cursor: the last entry's (`at`, source, id), base64url encoded. */
export function encodeTimelineCursor(position: TimelinePosition): string {
  return encodeKeyset([position.at, position.source, position.id]);
}

/**
 * The years a timeline cursor may name. No entry is older than 1970, and a year past 9998 could
 * step one microsecond into year 10000, which the order source's cursor refuses (a 500, not a 400).
 */
const FIRST_YEAR = 1970;
const LAST_YEAR = 9998;

/**
 * Decodes a timeline cursor, or throws `InvalidCursorError`: three parts, a microsecond UTC
 * timestamp that is a real instant in the years 1970 to 9998, a known source key, and a uuid
 * (lower cased).
 */
export function decodeTimelineCursor(cursor: string): TimelinePosition {
  const [at, source, id] = decodeKeyset(cursor, 3);
  if (at === undefined || source === undefined || id === undefined || !isSource(source)) {
    throw new InvalidCursorError();
  }
  // The (timestamp, id) checks of the shared keyset decoder, so a forged instant or id is a 400.
  const checked = decodeTimeIdKeyset(encodeKeyset([at, id]));
  const year = Number(checked.at.slice(0, 4));
  if (year < FIRST_YEAR || year > LAST_YEAR) throw new InvalidCursorError();
  return { at: checked.at, source, id: checked.id.toLowerCase() };
}

/**
 * Whether entry `a` comes before entry `b` in the total order (negative), after it (positive), or
 * is the same place (zero). Timestamps in the issued microsecond form and lower case uuids compare
 * as text exactly as PostgreSQL compares the values.
 */
export function compareTimeline(a: TimelinePosition, b: TimelinePosition): number {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

/**
 * The microsecond UTC timestamp one microsecond later, counted in whole microseconds as a
 * `BigInt` (never a float, which loses the microsecond far from 1970). Takes a timestamp the
 * timeline decoder accepted, so the answer is never past year 9999.
 */
export function nextMicrosecond(at: string): string {
  const total = BigInt(Date.parse(`${at.slice(0, 23)}Z`)) * 1000n + BigInt(at.slice(23, 26)) + 1n;
  // Floor division, so an instant before 1970 (a negative count) steps the right way too.
  const micros = ((total % 1000n) + 1000n) % 1000n;
  const wholeMillis = (total - micros) / 1000n;
  return `${new Date(Number(wholeMillis)).toISOString().slice(0, 23)}${String(micros).padStart(3, '0')}Z`;
}

/**
 * The orders module's own keyset cursor (`placed_at`, `id`, `OrderQueries.forCustomers`) that
 * resumes the order source exactly after `position`. `forCustomers` answers the orders strictly
 * below its cursor in (`placed_at` desc, `id` desc), so:
 * - after an order entry, its own (`at`, `id`);
 * - after an entry of a source sorted before `order` at the same instant, every order at that
 *   instant is still to come: (`at` plus one microsecond, the nil uuid), which no order equals;
 * - after an entry of a source sorted after `order`, the orders at that instant are behind:
 *   (`at`, the nil uuid), below which no order at that instant falls.
 * Only the shared encoding of `platform/keyset-cursor.ts` is used, never an orders file.
 */
export function orderCursorAfter(position: TimelinePosition | null): string | null {
  if (position === null) return null;
  if (position.source === 'order') return encodeKeyset([position.at, position.id]);
  if (position.source < 'order') return encodeKeyset([nextMicrosecond(position.at), NIL_UUID]);
  return encodeKeyset([position.at, NIL_UUID]);
}
