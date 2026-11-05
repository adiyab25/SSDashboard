/**
 * Personal data redaction (Law 151, spec 0007 "Personal data in logs and errors").
 *
 * One shared list and one pure function. Customer phones, names, addresses, and message bodies
 * must never reach a log line or the error tracker. Every sink calls THIS module, so the rule
 * lives in one place:
 *
 * - The Nest logger (`apps/api/src/platform/logging`) calls `redact` on every argument.
 * - A future pino logger calls `redact` from `formatters.log` (and `hooks.logMethod` for the
 *   message arguments), and may feed `PERSONAL_DATA_KEYS` and `PERSONAL_DATA_PATHS` to pino's own
 *   `redact` option.
 * - A future error tracker calls `redact(event)` from its `beforeSend` hook and returns the result.
 *
 * Nothing here reads configuration, logs, or performs I/O, so it is safe to call from any sink.
 */

/** What a redacted field's value becomes. */
export const REDACTED = '[REDACTED]';

/** What a phone shaped string inside free text becomes. */
export const PHONE_MASK = '[phone]';

/**
 * Field names that are personal data wherever they appear in an object, at any depth. Compared
 * after lower casing and dropping `_`, `-`, and spaces, so `phone_number`, `phoneNumber`, and
 * `Phone-Number` are one entry. Customer phones, names, addresses, notes, and message bodies.
 *
 * A bare `name` or `email` is NOT here: products, brands, and staff have names and emails that
 * audit lines may carry. Those are covered by `PERSONAL_DATA_PATHS` only under a customer context.
 *
 * Must never contain a key whose redaction would hide operational data (ids, totals, statuses).
 * Emptying this list is the planted failure in verify.md for spec 0007: the logger test must fail.
 */
export const PERSONAL_DATA_KEYS: readonly string[] = [
  'phone',
  'phones',
  'phonenumber',
  'phonenumbers',
  'mobile',
  'mobilenumber',
  'telephone',
  'whatsapp',
  'whatsappnumber',
  'firstname',
  'lastname',
  'fullname',
  'customername',
  'recipientname',
  'consigneename',
  'receivername',
  'address',
  'addresses',
  'address1',
  'address2',
  'addressline',
  'addressline1',
  'addressline2',
  'streetaddress',
  'street',
  'building',
  'apartment',
  'landmark',
  'city',
  'area',
  'district',
  'governorate',
  'postalcode',
  'zip',
  'zone',
  'shippingaddress',
  'billingaddress',
  'customeraddress',
  'deliveryaddress',
  'customeremail',
  'customerphone',
  'firstline',
  'secondline',
  'note',
  'notes',
  'customernote',
  'customernotes',
  'deliverynotes',
  'messagebody',
  'messagetext',
  'whatsappmessage',
  'telegrammessage',
  'telegramtext',
];

/**
 * Dotted paths for fields too generic to match by name alone (`name`, `email`). A path matches
 * when an object's path ENDS with its segments, so `customer.name` matches `order.customer.name`
 * and `a.b.customer.name`. `*` stands for exactly one segment. Segments are compared like
 * `PERSONAL_DATA_KEYS`. Array indexes are not part of a path.
 *
 * Staff emails are deliberately outside this list: staff identities are logged for audit, and the
 * auth logger already reduces failed queries (which carry params) to a pg code.
 */
export const PERSONAL_DATA_PATHS: readonly string[] = [
  'customer.name',
  'customer.email',
  'recipient.name',
  'recipient.email',
  'consignee.name',
  'consignee.email',
  'contact.name',
  'contact.email',
  'buyer.name',
  'buyer.email',
  'shipping.name',
  'billing.name',
  'shippingaddress.name',
  'billingaddress.name',
  'message.body',
  'message.text',
  'messages.body',
  'messages.text',
  'whatsapp.body',
  'whatsapp.text',
  'telegram.body',
  'telegram.text',
];

/**
 * Keys that mark an object as a person's contact record wherever it sits. When an object has one of
 * these, its generic `name` and `email` are personal too (a customer passed as `data`, `contact`,
 * or `params` is still a customer). Normalized like `PERSONAL_DATA_KEYS`.
 */
export const CONTACT_MARKER_KEYS: readonly string[] = [
  'phone',
  'phones',
  'phonenumber',
  'mobile',
  'whatsapp',
  'address',
  'firstname',
  'lastname',
  'fullname',
];

/** The generic keys redacted in an object that has a contact marker. */
const CONTACT_IDENTITY_KEYS: ReadonlySet<string> = new Set(['name', 'email']);

/**
 * Phone shaped text, matched on text whose Arabic-Indic digits are already folded to Western:
 * Egyptian mobiles (`01012345678`, `+20 101 234 5678`, `0020-1012345678`, `201012345678`) and international
 * numbers (`+` or `00`, then 8 to 15 digits). Digit runs with no phone shape (order numbers,
 * ids, timestamps) are left alone on purpose.
 */
const PHONE_PATTERN = new RegExp(
  [
    // Egyptian mobile: +20 / 0020 / bare 20 (optional trunk 0) or a leading 0, then 1[0125] + 8 digits.
    // Never starts with a separator, and a bare 10 digit run with no prefix is not a phone.
    '(?<![0-9])(?:(?:\\+|00)[\\s.\\-]*20[\\s.\\-]*0?|20[\\s.\\-]*0?|0[\\s.\\-]*)1[0125](?:[\\s.\\-]*[0-9]){8}(?![0-9])',
    // International: + or 00, a non-zero country digit, then 7 to 14 more digits.
    '(?<![0-9])(?:\\+|00)[\\s.\\-]*[1-9](?:[\\s.\\-]*[0-9]){7,14}(?![0-9])',
  ].join('|'),
  'g',
);

/** Folds Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits to Western ones, one to one. */
function foldDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

/**
 * Replaces every phone shaped substring of `text` with `[phone]`, in Western or Arabic-Indic
 * digits, with spaces, dots, or dashes between them. Pure; returns `text` unchanged when nothing
 * matches. Names and addresses written in free text cannot be found by shape: they are removed
 * by field (see `PERSONAL_DATA_KEYS`), so put personal text in a named field.
 *
 * Must never throw, and must never return the matched digits.
 */
export function maskPhones(text: string): string {
  // Folding keeps every character's position, so match offsets in the folded text apply to `text`.
  const folded = foldDigits(text);
  let out = '';
  let last = 0;
  for (const match of folded.matchAll(PHONE_PATTERN)) {
    out += text.slice(last, match.index) + PHONE_MASK;
    last = match.index + match[0].length;
  }
  return last === 0 && out === '' ? text : out + text.slice(last);
}

/** A key reduced to its comparable form: lower case with `_`, `-`, and spaces removed. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

/** The lists a redactor applies. */
export interface RedactionRules {
  /** Field names redacted at any depth (see `PERSONAL_DATA_KEYS`). */
  readonly keys: readonly string[];
  /** Dotted path suffixes redacted (see `PERSONAL_DATA_PATHS`). */
  readonly paths: readonly string[];
  /** Keys that make an object a contact record (see `CONTACT_MARKER_KEYS`). */
  readonly contactMarkers: readonly string[];
}

/** The rules every sink uses unless a test passes its own. */
export const DEFAULT_REDACTION_RULES: RedactionRules = {
  keys: PERSONAL_DATA_KEYS,
  paths: PERSONAL_DATA_PATHS,
  contactMarkers: CONTACT_MARKER_KEYS,
};

const MAX_DEPTH = 24;

/**
 * Builds a `redact` function over the given rules. `redact` below is this over
 * `DEFAULT_REDACTION_RULES`; tests build their own to prove a rule is what stops a leak.
 * Never mutates its input and never throws on shape.
 */
export function createRedactor(rules: RedactionRules): (value: unknown) => unknown {
  const keySet = new Set(rules.keys.map(normalizeKey));
  const markerSet = new Set(rules.contactMarkers.map(normalizeKey));
  const pathSegments = rules.paths.map((p) => p.split('.').map(normalizeKey));

  function pathMatches(path: readonly string[]): boolean {
    return pathSegments.some((segments) => {
      if (segments.length > path.length) return false;
      const tail = path.slice(path.length - segments.length);
      return segments.every((segment, i) => segment === '*' || segment === tail[i]);
    });
  }

  /** A string: JSON text is parsed, redacted by field, and written back; any text gets phones masked. */
  function walkString(text: string, path: readonly string[], seen: WeakSet<object>): string {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(walk(JSON.parse(text) as unknown, path, seen));
      } catch {
        // Not JSON after all: fall through to the plain text rule.
      }
    }
    return maskPhones(text);
  }

  function walk(value: unknown, path: readonly string[], seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return walkString(value, path, seen);
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (path.length >= MAX_DEPTH) return REDACTED;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => walk(item, path, seen));
      const isError = value instanceof Error;
      const source = value as Record<string, unknown>;
      const keys = Object.keys(source);
      const isContact = keys.some((k) => markerSet.has(normalizeKey(k)));
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        const normalized = normalizeKey(key);
        const childPath = [...path, normalized];
        if (
          keySet.has(normalized) ||
          (isContact && CONTACT_IDENTITY_KEYS.has(normalized)) ||
          pathMatches(childPath)
        ) {
          result[key] = REDACTED;
          continue;
        }
        try {
          result[key] = walk(source[key], childPath, seen);
        } catch {
          // A throwing getter or proxy trap: hide the field rather than fail the log call.
          result[key] = REDACTED;
        }
      }
      if (!isError) return result;
      // Keep the Error type: loggers print its stack, and trackers detect it with instanceof.
      const copy: Error = Object.create(Object.getPrototypeOf(value) as object | null) as Error;
      const hidden = (name: string, v: unknown): void => {
        Object.defineProperty(copy, name, {
          value: v,
          enumerable: false,
          writable: true,
          configurable: true,
        });
      };
      hidden('name', walk(value.name, path, seen));
      hidden('message', walk(value.message, path, seen));
      if (typeof value.stack === 'string') hidden('stack', maskPhones(value.stack));
      if ('cause' in value) hidden('cause', walk(value.cause, path, seen));
      return Object.assign(copy, result);
    } finally {
      seen.delete(value);
    }
  }

  return (value) => walk(value, [], new WeakSet());
}

/**
 * Returns a copy of `value` that is safe to log or report: fields named in
 * `PERSONAL_DATA_KEYS` or `PERSONAL_DATA_PATHS` become `[REDACTED]`, and phone shaped text in every
 * remaining string becomes `[phone]`. A string holding JSON is parsed and redacted by field too. Handles nested objects, arrays, errors (as plain objects
 * keeping their type with a redacted message, stack and cause), and cycles.
 *
 * Call it from every sink: the Nest logger now, pino's `formatters.log` and the error tracker's
 * `beforeSend` later. Pure: never mutates `value`, never logs, and never throws (an unreadable field becomes `[REDACTED]`).
 * Must never be bypassed for a "debug" level.
 */
export const redact: (value: unknown) => unknown = createRedactor(DEFAULT_REDACTION_RULES);
