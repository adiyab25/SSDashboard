import { isDeepStrictEqual } from 'node:util';
import {
  createRedactor,
  DEFAULT_REDACTION_RULES,
  maskPhones,
  redact,
  REDACTED,
} from '@ssdashboard/config/redaction';

/** A diff object with its personal values masked, and where they were. */
export interface MaskedDiff {
  /** The input with every personal value replaced by `[REDACTED]` or its phones by `[phone]`. */
  masked: Record<string, unknown>;
  /** The dotted paths (array items by index) whose values were masked. */
  personalPaths: string[];
}

/** One redactor per list of record type keys, built once. */
const redactors = new Map<string, (value: unknown) => unknown>();

function redactorFor(personalKeys: readonly string[]): (value: unknown) => unknown {
  if (!personalKeys.length) return redact;
  const key = personalKeys.join('\u0000');
  let redactor = redactors.get(key);
  if (!redactor) {
    redactor = createRedactor({
      ...DEFAULT_REDACTION_RULES,
      keys: [...DEFAULT_REDACTION_RULES.keys, ...personalKeys],
    });
    redactors.set(key, redactor);
  }
  return redactor;
}

/**
 * A whole number of 10 to 15 digits (security review AS4): the length of a phone written without
 * its `+`. No quantity or id in a diff is that long (money travels as decimal text), so it is
 * treated as phone shaped and masked.
 */
export function isPhoneLengthNumber(value: number): boolean {
  if (!Number.isInteger(value)) return false;
  const digits = String(Math.abs(value)).length;
  return digits >= 10 && digits <= 15;
}

/** JSON text that holds an object or an array, parsed; undefined for any other string. */
function parseJsonText(text: string): unknown {
  const start = text.trimStart();
  if (!start.startsWith('{') && !start.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Redactor = (value: unknown) => unknown;

/**
 * Walks the input beside its redacted copy and builds the stored copy: a masked value replaces
 * the input and its path is listed; a phone length number is masked (security review AS4); a
 * uuid is kept (AS22). JSON text under a personal key is masked whole; any other JSON text is
 * walked beside the redactor's own parsed result, so the number rule reaches inside it, and is
 * stored as the walked value written back as JSON, never as the input text, which may hold a
 * duplicate key the parser dropped (AS14, AS21). Its path is listed only when something inside
 * was masked, so a text that is only reformatted is not reported as personal (AS9).
 */
function merge(
  input: unknown,
  output: unknown,
  path: readonly string[],
  found: string[],
  redactor: Redactor,
): unknown {
  if (Array.isArray(input) && Array.isArray(output)) {
    return input.map((item, index) =>
      merge(item, output[index], [...path, String(index)], found, redactor),
    );
  }
  if (isPlainObject(input) && isPlainObject(output)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      result[key] = merge(input[key], output[key], [...path, key], found, redactor);
    }
    return result;
  }
  if (typeof input === 'number' && isPhoneLengthNumber(input)) {
    found.push(path.join('.'));
    return REDACTED;
  }
  if (typeof input === 'string') {
    // A wholly uuid string is an id, never a phone (security review AS22).
    if (UUID.test(input)) return input;
    const parsed = parseJsonText(input);
    if (parsed !== undefined) {
      // The outer redactor already saw this text at its own path. When the key itself is
      // personal its value came back masked whole ("[REDACTED]"), not JSON: keep that (security
      // review AS21). Otherwise walk the parsed text beside the redactor's own parsed result, so
      // the path aware rules (customer.name) and the number rule both apply inside it.
      const redacted = typeof output === 'string' ? parseJsonText(output) : undefined;
      if (redacted === undefined) {
        found.push(path.join('.'));
        return output;
      }
      const inside: string[] = [];
      const walked = merge(parsed, redacted, path, inside, redactor);
      if (inside.length) found.push(path.join('.'));
      return JSON.stringify(walked);
    }
  }
  if (!isDeepStrictEqual(input, output)) {
    found.push(path.join('.'));
    return output;
  }
  return input;
}

/**
 * Masks the personal values of a `before` or `after` object (spec 0010, AC-4) with the shared
 * redaction list (`PERSONAL_DATA_KEYS`, `PERSONAL_DATA_PATHS`, the contact and row markers, and
 * phone shaped text) plus the record type's own `personalKeys` (security review AS2: a changed
 * fields diff of a customer carries a bare `name` with no marker beside it), and lists the paths
 * it changed. `ownCode` is the record type's own code contract: a top level `code` that matches
 * it is the record's code and is stored as written, so a SKU coded `01012345678` is not masked as
 * a phone (AS16). Pure: never mutates its input, never logs, and never returns a personal value.
 */
export function maskPersonalData(
  value: Record<string, unknown>,
  personalKeys: readonly string[] = [],
  ownCode?: RegExp,
): MaskedDiff {
  const code = value['code'];
  const trusted = ownCode !== undefined && typeof code === 'string' && ownCode.test(code);
  const subject = trusted
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'code'))
    : value;
  const redactor = redactorFor(personalKeys);
  const personalPaths: string[] = [];
  const walked = merge(subject, redactor(subject), [], personalPaths, redactor) as Record<
    string,
    unknown
  >;
  // Keep the caller's key order, with the trusted code back in its place.
  const masked = trusted
    ? Object.fromEntries(
        Object.keys(value).map((key) => [key, key === 'code' ? code : walked[key]]),
      )
    : walked;
  return { masked, personalPaths };
}

/**
 * Whether any object key, at any depth, is phone shaped (security review AS4): a phone used as a
 * key cannot be masked without losing the field, so the entry is refused instead.
 */
export function hasPhoneShapedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPhoneShapedKey);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      maskPhones(key) !== key || /^\+?\d{10,15}$/.test(key) || hasPhoneShapedKey(child),
  );
}

/**
 * Whether a value holds no personal data: its redacted copy, with the record type's own personal
 * keys, equals it (spec 0010, "Who acts"; security review AS17). Used for `record_label` and
 * `undo_args`, which are refused, never masked.
 */
export function holdsNoPersonalData(value: unknown, personalKeys: readonly string[] = []): boolean {
  const subject = withoutUuids(value);
  return isDeepStrictEqual(redactorFor(personalKeys)(subject), subject);
}

/** The value with every wholly uuid string set aside, so an id is never read as personal (AS22). */
function withoutUuids(value: unknown): unknown {
  if (typeof value === 'string') return UUID.test(value) ? '' : value;
  if (Array.isArray(value)) return value.map(withoutUuids);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withoutUuids(item)]),
    );
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/**
 * Whether undo arguments hold only ids, codes, and numbers (security reviews AS3, AS17), in
 * objects and arrays of them: a uuid, a code of at most 64 characters with no space, or a finite
 * number that is not phone length, under keys that are codes too. Text, booleans, and nulls are
 * refused, so a name or a sentence can never ride along. The owning module keeps anything richer
 * in its own table and points at it.
 */
export function isUndoArgsShape(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isUndoArgsShape);
  if (isPlainObject(value)) {
    return Object.entries(value).every(([key, item]) => CODE.test(key) && isUndoArgsShape(item));
  }
  if (typeof value === 'number') return Number.isFinite(value) && !isPhoneLengthNumber(value);
  if (typeof value === 'string') return UUID.test(value) || CODE.test(value);
  return false;
}
