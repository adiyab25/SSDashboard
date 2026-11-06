import { z } from 'zod';

/** The kind of a normalized phone: an Egyptian mobile, an Egyptian landline, or any other country. Matches the `customer_phones.kind` enum. */
export const PhoneKind = z.enum(['mobile', 'landline', 'foreign']);
/** One phone kind. */
export type PhoneKind = z.infer<typeof PhoneKind>;

/** A normalized phone: E.164 text (`^\+[1-9][0-9]{7,14}$`) and its kind. */
export const NormalizedPhone = z.object({
  e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  kind: PhoneKind,
});
/** The result of `EgyptianPhone.parse`. */
export type NormalizedPhone = z.infer<typeof NormalizedPhone>;

/**
 * Thrown when text is not a phone number this system accepts. The message never carries the
 * input: a phone is personal data (Law 151) and error text reaches logs.
 */
export class InvalidPhone extends Error {
  readonly code = 'InvalidPhone';

  /** Builds the error with a fixed message; never pass the raw input. */
  constructor() {
    super('The text is not a valid phone number');
    this.name = 'InvalidPhone';
  }
}

const ARABIC_INDIC_ZERO = 0x0660;
const EASTERN_ARABIC_INDIC_ZERO = 0x06f0;

/** Whitespace (incl. non breaking), `-`, `.`, brackets, `/`, and the direction and zero width marks. */
const IGNORED = /[\s\u00A0\-.()/\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u061C\u2060\u00AD]/g;

const EGYPTIAN_MOBILE = /^\+201[0125][0-9]{8}$/;
const MOBILE_NATIONAL_TEN = /^1[0125][0-9]{8}$/;

function fail(): never {
  throw new InvalidPhone();
}

function mobile(e164: string): NormalizedPhone {
  if (!EGYPTIAN_MOBILE.test(e164)) fail();
  return { e164, kind: 'mobile' };
}

/**
 * Turns the phone text every input edge receives into one E.164 number, by the steps of spec
 * 0002 "Phone normalization at the edge": fold Arabic digits, drop separators and marks, read a
 * leading `00` as `+`, then apply the first matching Egyptian rule. Never stores or echoes the raw
 * input, and never guesses: anything that does not match a row is an `InvalidPhone`.
 */
export const EgyptianPhone = {
  /** Returns `{ e164, kind }` or throws `InvalidPhone`. */
  parse(raw: string): NormalizedPhone {
    // Step 1: fold both Arabic digit blocks to ASCII.
    const folded = raw
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - ARABIC_INDIC_ZERO))
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - EASTERN_ARABIC_INDIC_ZERO));
    // Step 2: remove separators and marks; anything but digits and one leading + is invalid.
    let text = folded.replace(IGNORED, '');
    if (!/^\+?[0-9]+$/.test(text)) fail();
    // Step 3: a leading 00 is an international prefix.
    if (text.startsWith('00')) text = `+${text.slice(2)}`;
    // Step 4: the first matching row wins. Step 5 is the mobile check inside `mobile`.
    if (/^01[0-9]{9}$/.test(text)) return mobile(`+20${text.slice(1)}`);
    if (/^1[0-9]{9}$/.test(text)) return mobile(`+20${text}`);
    if (/^\+200[0-9]{10}$/.test(text)) return mobile(`+20${text.slice(4)}`);
    if (/^201[0-9]{9}$/.test(text)) return mobile(`+${text}`);
    if (/^\+201[0-9]{9}$/.test(text)) return mobile(text);
    if (/^\+[0-9]{10}$/.test(text) && MOBILE_NATIONAL_TEN.test(text.slice(1))) {
      return mobile(`+20${text.slice(1)}`);
    }
    if (/^0[2-9][0-9]{7,8}$/.test(text)) return { e164: `+20${text.slice(1)}`, kind: 'landline' };
    if (/^\+20[2-9][0-9]{7,8}$/.test(text)) return { e164: text, kind: 'landline' };
    if (/^\+[1-9][0-9]{7,14}$/.test(text) && !text.startsWith('+20')) {
      return { e164: text, kind: 'foreign' };
    }
    return fail();
  },
};
