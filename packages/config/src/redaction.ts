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
  // Spec 0013: the second ship to phone of an order (`phoneAlt` in a request, an audit diff, and an
  // answer), the one phone spelling the generic `phone` entry does not cover.
  'phonealt',
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
  // Orders, customers, and tasks tables (spec 0002 amendment). Bare `name`, `reason`, `payload`
  // are NOT global keys: products, staff, and operational lines (lockout and void reasons) carry
  // them. They are redacted only on rows a `ROW_MARKER_RULES` entry identifies. `tasks.note` is
  // covered by `note` above, and `risk_flag_note` is listed because it is free text.
  'shiptoname',
  'shiptophone',
  'shiptophonealt',
  'contactphoneraw',
  'phonee164',
  'shiptoaddress',
  // Decision (security n2): the carrier's geography codes stay redacted. With the area list they
  // narrow a person to a zone, and a log line never needs them.
  'shiptogovernoratecode',
  'shiptocitycode',
  'shiptozonecode',
  'couriernote',
  'riskflagnote',
  // Settlement free text (security m6): the partner's own wording on a statement line, and the
  // bank or InstaPay reference a person typed when accounting a line.
  'partnertext',
  'paymentreference',
  // Spec 0014 AC-17: the customer search body (`POST /api/customers/search`) carries a name
  // fragment in `nameContains`. The phone key is covered by `phone`.
  'namecontains',
  // Spec 0014 review: the name search cursor names a customer id (never personal data itself), but
  // a cursor key is redacted everywhere so a future cursor can never carry a name; the customer
  // answers carry the primary phone, the E.164 form of a phone, and a channel's customer id.
  'cursor',
  'primaryphone',
  'e164',
  'externalid',
  // Spec 0015 Security model: a connection's credentials and the Shopify access token never reach a
  // log, whatever object carries them (`shippingAddress` is listed above). `apiSecret` is the legacy
  // custom app's webhook secret (`credentials.kind = 'access_token'`).
  'clientsecret',
  'accesstoken',
  'credentials',
  'apisecret',
];

/**
 * Dotted paths for fields too generic to match by name alone (`name`, `email`). A path matches
 * when an object's path ENDS with its segments, so `customer.name` matches `order.customer.name`
 * and `a.b.customer.name`. `*` stands for exactly one segment. Segments are compared like
 * `PERSONAL_DATA_KEYS`. Array indexes are not part of a path.
 *
 * Email addresses need no path: `redact` masks every address in every string with `maskEmails`,
 * staff and customer alike (Law 151, gate ruling 2026-11-07). Log lines name staff by id.
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
  // Spec 0014: the merged record on a profile (`merges[].other.name`) and the merge answer
  // (`survivor.name`). `items.name` is deliberately not here: any list answer has `items[]`, and
  // product names must stay readable. Customer search answers are never logged.
  'other.name',
  'survivor.name',
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
  'phonee164',
  'shiptophone',
  'shiptoname',
];

/** The generic keys redacted in an object that has a contact marker. */
const CONTACT_IDENTITY_KEYS: readonly string[] = ['name', 'email'];

/**
 * A row that one table owns, found by keys only that table's row has. When an object matches,
 * the generic keys in `redact` (a bare `name`, `reason`, `payload`) are personal in THAT object
 * only. `identifiedBy` lists alternatives; each alternative is a set of keys that must all be
 * present. Keys are normalized like `PERSONAL_DATA_KEYS`.
 */
export interface RowMarkerRule {
  /** Any one alternative matching marks the row; each alternative needs all of its keys. */
  readonly identifiedBy: readonly (readonly string[])[];
  /** Keys redacted in a marked row. */
  readonly redact: readonly string[];
}

/**
 * The owner aware rows (security-data-model-m3 MJ1): `customers` (`name`), `customer_merges`
 * (`reason`), `settlement_period_events` (`reason`), and `outbound_commands` (`payload`, `failure_reason`). Matching works for snake or
 * camel case, bare, nested under any key, and inside arrays. Also the hat change log line of
 * identity (`HatsChanged`, spec 0008 AC-13): its `reason` is free text a manager types about a
 * person, so it never reaches a log; the audit trail (spec 0010) is where it is kept.
 */
export const ROW_MARKER_RULES: readonly RowMarkerRule[] = [
  {
    identifiedBy: [['mergedintoid'], ['riskflagsource'], ['riskflagnote'], ['riskflag']],
    redact: ['name'],
  },
  {
    identifiedBy: [['survivorid'], ['mergedid'], ['undoesmergeid'], ['repointedids']],
    redact: ['reason'],
  },
  {
    // settlement_period_events: `reason` is the free text of a revoke.
    identifiedBy: [['periodid', 'action']],
    redact: ['reason'],
  },
  {
    identifiedBy: [['idempotencykey', 'linkedtype'], ['syncstate']],
    redact: ['payload', 'failurereason'],
  },
  {
    // The hat change log line (`hatChangeLogLine` in apps/api/src/identity/sessions/): only it
    // carries both lists. Sign in reason codes (`bad_credentials`, `locked`) stay readable.
    identifiedBy: [['hatsadded', 'hatsremoved']],
    redact: ['reason'],
  },
];

/** What an email address inside free text becomes (`maskEmails`). */
export const EMAIL_MASK = '[email]';

/**
 * The characters allowed between the digits of one phone number: white space, dot, dash, the
 * brackets around an area code, slash, and underscore (security review AS15).
 */
const SEP = '[\\s.\\-()/_]*';

/**
 * Phone shaped text, matched on text whose Arabic-Indic, Extended Arabic-Indic, and full width
 * digits are already folded to Western and whose invisible format characters (direction and zero
 * width marks, `\p{Cf}`) are dropped: Egyptian mobiles (`01012345678`, `+20 101 234 5678`,
 * `0020-1012345678`, `201012345678`), Egyptian landlines with their trunk 0 (`02 2345 6789`,
 * `03 123 4567`, `040 123 4567`), and international numbers (`+` or `00`, then 8 to 15 digits).
 * Digit runs with no phone shape (order numbers, ids, timestamps) are left alone on purpose. A
 * match never starts or ends inside a longer digit run, but may sit right next to letters
 * (`call01012345678`, `01012345678ext`, security review AS27); `maskPhones` skips a match only
 * when it lies wholly inside a uuid (AS22, AS25).
 */
const PHONE_PATTERN = new RegExp(
  [
    // Egyptian mobile: +20 / 0020 / bare 20 (optional trunk 0) or a leading 0, then 1[0125] + 8 digits.
    // Never starts with a separator, and a bare 10 digit run with no prefix is not a phone.
    `(?<![0-9])(?:(?:\\+|00)${SEP}20${SEP}0?|20${SEP}0?|0${SEP})1[0125](?:${SEP}[0-9]){8}(?![0-9])`,
    // Egyptian landline with its trunk 0, 9 or 10 digits in all: Cairo and Giza 02 + 8 digits,
    // Alexandria 03 + 7 digits, and the two digit area codes (040, 045, 050, 082, 093, ...) + 7
    // digits. So 0, an area code of one or two digits starting 2 to 9, then the subscriber number
    // as one run or two groups (3 or 4 digits, then 4). Slashes and underscores are not accepted
    // here, so a date such as 06/11/2026 or 06.11.2026 never reads as a landline.
    '(?<![0-9])0[\\s.\\-()]*[2-9][0-9]?[\\s.\\-()]*[0-9]{3,4}[\\s.\\-]?[0-9]{4}(?![0-9])',
    // International: + or 00, a non-zero country digit, then 7 to 14 more digits.
    `(?<![0-9])(?:\\+|00)${SEP}[1-9](?:${SEP}[0-9]){7,14}(?![0-9])`,
  ].join('|'),
  'g',
);

/**
 * A uuid in text (any version), standing alone: not glued to a Latin letter or digit on either
 * side, so `01012345678-0000-...` or `x0000...` is not one (security review AS25).
 */
const UUID_PATTERN =
  /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/gi;

/** Invisible format characters (left to right and right to left marks, zero width joiners). */
const FORMAT_CHARACTER = /^\p{Cf}$/u;

/**
 * The digit a character stands for when it is Arabic-Indic (٠-٩), Extended Arabic-Indic (۰-۹),
 * or full width (０-９), else the character itself.
 */
function foldDigit(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  if (code >= 0xff10 && code <= 0xff19) return String(code - 0xff10);
  return char;
}

/** Any character the match text must change: a format character or a non Western digit. */
const NEEDS_FOLDING = /[\p{Cf}\u0660-\u0669\u06f0-\u06f9\uff10-\uff19]/u;

/**
 * The text to match phones in: digits folded and format characters dropped, with the index in
 * `text` of every code unit kept, so a match maps back to its span in the original. Text with
 * nothing to fold is its own match text (`origin` null: every index maps to itself), the common
 * case in log lines. Otherwise one pass over the code units: ASCII is copied as it is, and only
 * other characters are looked at, so the walk stays linear and cheap (security review AS26).
 */
function matchableText(text: string): { folded: string; origin: number[] | null } {
  if (!NEEDS_FOLDING.test(text)) return { folded: text, origin: null };
  const parts: string[] = [];
  const origin: number[] = [];
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      parts.push(text.charAt(index));
      origin.push(index);
      index += 1;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? code);
    if (!FORMAT_CHARACTER.test(char)) {
      const kept = foldDigit(char);
      for (let unit = 0; unit < kept.length; unit += 1) origin.push(index + unit);
      parts.push(kept);
    }
    index += char.length;
  }
  return { folded: parts.join(''), origin };
}

/**
 * Replaces every phone shaped substring of `text` with `[phone]`: Western, Arabic-Indic, or full
 * width digits, with spaces, dots, dashes, brackets, slashes, or underscores between them, and
 * any invisible format character inside (the whole original span is masked, marks included).
 * Pure; returns `text` unchanged when nothing matches. Names and addresses written in free text
 * cannot be found by shape: they are removed by field (see `PERSONAL_DATA_KEYS`), so put personal
 * text in a named field.
 *
 * A match that lies wholly inside a standalone uuid is an id and is left alone; one that only
 * touches or overlaps a uuid is masked. So `ref aaaaaaaa-bbbb-cccc-dddd-201012345678` is kept: a
 * phone written as a uuid's last group cannot be told apart from a uuid (security review AS25).
 * Runs in time linear in the text: the phone and uuid matches are both in text order and are
 * walked together once (AS26).
 *
 * Must never throw, and must never return the matched digits.
 */
export function maskPhones(text: string): string {
  const { folded, origin } = matchableText(text);
  const uuids = [...text.matchAll(UUID_PATTERN)].map((m) => ({
    from: m.index,
    to: m.index + m[0].length,
  }));
  let next = 0;
  let out = '';
  let last = 0;
  let found = false;
  for (const match of folded.matchAll(PHONE_PATTERN)) {
    const start = origin ? (origin[match.index] ?? 0) : match.index;
    // A match always ends with a digit, one code unit long in the folded text.
    const tail = match.index + match[0].length - 1;
    const end = (origin ? (origin[tail] ?? start) : tail) + 1;
    // Both lists are in text order: pass the uuids that end before this match, once overall.
    while (next < uuids.length && (uuids[next]?.to ?? 0) <= start) next += 1;
    const uuid = uuids[next];
    // Digits wholly inside a uuid are an id, never a phone (security reviews AS22, AS25).
    if (uuid && uuid.from <= start && end <= uuid.to) continue;
    out += text.slice(last, start) + PHONE_MASK;
    last = end;
    found = true;
  }
  return found ? out + text.slice(last) : text;
}

/**
 * An email address inside free text: local part, `@`, and a dotted domain. The local part may
 * only start where the previous character cannot belong to it, so a long run of letters is
 * scanned once, not once per position (security review AS24: linear time).
 */
const EMAIL_PATTERN =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/**
 * Replaces every email address in `text` with `[email]` (security review AS15). Pure, never
 * throws, linear in the text's length. `redact` applies it to every string, staff and customer
 * addresses alike (Law 151, gate ruling 2026-11-07); log lines name staff by id instead.
 */
export function maskEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, EMAIL_MASK);
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
  /** Owner aware rows (see `ROW_MARKER_RULES`); none when omitted. */
  readonly rowMarkers?: readonly RowMarkerRule[];
}

/** The rules every sink uses unless a test passes its own. */
export const DEFAULT_REDACTION_RULES: RedactionRules = {
  keys: PERSONAL_DATA_KEYS,
  paths: PERSONAL_DATA_PATHS,
  contactMarkers: CONTACT_MARKER_KEYS,
  rowMarkers: ROW_MARKER_RULES,
};

const MAX_DEPTH = 24;

/**
 * Builds a `redact` function over the given rules. `redact` below is this over
 * `DEFAULT_REDACTION_RULES`; tests build their own to prove a rule is what stops a leak.
 * Never mutates its input and never throws on shape.
 */
export function createRedactor(rules: RedactionRules): (value: unknown) => unknown {
  const keySet = new Set(rules.keys.map(normalizeKey));
  // The contact markers are one row rule per marker: any one of them marks the row.
  const compiled = [
    {
      identifiedBy: rules.contactMarkers.map((marker) => [normalizeKey(marker)]),
      redact: new Set(CONTACT_IDENTITY_KEYS),
    },
    ...(rules.rowMarkers ?? []).map((rule) => ({
      identifiedBy: rule.identifiedBy.map((alternative) => alternative.map(normalizeKey)),
      redact: new Set(rule.redact.map(normalizeKey)),
    })),
  ];
  const pathSegments = rules.paths.map((p) => p.split('.').map(normalizeKey));

  function pathMatches(path: readonly string[]): boolean {
    return pathSegments.some((segments) => {
      if (segments.length > path.length) return false;
      const tail = path.slice(path.length - segments.length);
      return segments.every((segment, i) => segment === '*' || segment === tail[i]);
    });
  }

  /** A string: JSON text is parsed, redacted by field, and written back; any text gets phones and emails masked. */
  function walkString(text: string, path: readonly string[], seen: WeakSet<object>): string {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(walk(JSON.parse(text) as unknown, path, seen));
      } catch {
        // Not JSON after all: fall through to the plain text rule.
      }
    }
    return maskEmails(maskPhones(text));
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
      const present = new Set(keys.map(normalizeKey));
      const rowKeys = new Set<string>();
      for (const rule of compiled) {
        if (rule.identifiedBy.some((alternative) => alternative.every((k) => present.has(k)))) {
          for (const k of rule.redact) rowKeys.add(k);
        }
      }
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        const normalized = normalizeKey(key);
        const childPath = [...path, normalized];
        if (keySet.has(normalized) || rowKeys.has(normalized) || pathMatches(childPath)) {
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
      if (typeof value.stack === 'string') hidden('stack', maskEmails(maskPhones(value.stack)));
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
 * remaining string becomes `[phone]`, and every email address `[email]`. A string holding JSON is parsed and redacted by field too. Handles nested objects, arrays, errors (as plain objects
 * keeping their type with a redacted message, stack and cause), and cycles.
 *
 * Call it from every sink: the Nest logger now, pino's `formatters.log` and the error tracker's
 * `beforeSend` later. Pure: never mutates `value`, never logs, and never throws (an unreadable field becomes `[REDACTED]`).
 * Must never be bypassed for a "debug" level.
 */
export const redact: (value: unknown) => unknown = createRedactor(DEFAULT_REDACTION_RULES);
