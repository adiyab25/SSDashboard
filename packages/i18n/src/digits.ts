/**
 * Digit input at every edge (spec 0004, AC-18): Arabic-Indic and Extended Arabic-Indic digits and
 * the Arabic separators are mapped to their Western forms, then parsed by strict rules. Pure
 * string work with no loops that depend on the input, no `Intl`, and no float.
 */

/** Thrown when typed digits are not a valid quantity or amount; never guessed or rounded. */
export class InvalidDigitInputError extends Error {
  readonly code = 'InvalidDigitInput';
}

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/** Invisible marks (U+200E, U+200F, U+061C) and the no break space (U+00A0). */
const INVISIBLE = /[\u200e\u200f\u061c\u00a0]/g;

/**
 * Maps Arabic-Indic (U+0660 to U+0669) and Extended Arabic-Indic (U+06F0 to U+06F9) digits to
 * 0 to 9, the Arabic decimal separator U+066B to `.`, the Arabic thousands separator U+066C and
 * the Arabic comma U+060C to `,`, and removes U+200E, U+200F, U+061C, and the no break space.
 * Everything else is left as typed. Never apply it to passwords, tokens, names, or free text.
 */
export function normalizeDigits(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - ARABIC_INDIC_ZERO))
    .replace(/[\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) - EXTENDED_ARABIC_INDIC_ZERO))
    .replace(/\u066b/g, '.')
    .replace(/[\u066c\u060c]/g, ',');
}

/**
 * A whole number typed in any digit set: digits only after normalizing (`"\u0663"` gives `3`).
 * Throws `InvalidDigitInputError` for a sign, a separator, letters, or an unsafe integer.
 */
export function parseQuantity(text: string): number {
  const value = normalizeDigits(text).trim();
  if (!/^\d+$/.test(value)) {
    throw new InvalidDigitInputError('A quantity is whole digits only');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidDigitInputError('A quantity is too large');
  return parsed;
}

const PLAIN = /^-?\d+(?:\.\d+)?$/;
const GROUPED = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/**
 * An amount typed in any digit set, as a decimal string with at most `digits` fraction digits
 * (2 for amounts, 4 for unit costs). A comma is accepted only as a thousands separator in a
 * valid grouping (`1,234.50`); `1,5` and more fraction digits than allowed are rejected, never
 * guessed or rounded. Throws `InvalidDigitInputError`. No float is ever involved.
 */
export function parseMoney(text: string, digits: number): string {
  const value = normalizeDigits(text).trim();
  if (!PLAIN.test(value) && !GROUPED.test(value)) {
    throw new InvalidDigitInputError('An amount is digits with an optional decimal part');
  }
  const decimal = value.replace(/,/g, '');
  const fraction = decimal.split('.')[1] ?? '';
  if (fraction.length > digits) {
    throw new InvalidDigitInputError(`An amount has at most ${digits} decimals`);
  }
  return decimal;
}
