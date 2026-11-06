import {
  InvalidDigitInputError,
  normalizeDigits,
  parseMoney,
  parseQuantity,
} from '@ssdashboard/i18n';
import { z } from 'zod';

/** Adds the typed error as a Zod issue on the field, so the api answers 400 with the field error. */
function parseOrIssue<T>(run: () => T, ctx: z.RefinementCtx): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof InvalidDigitInputError) {
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
    throw error;
  }
}

/**
 * Text typed in Arabic or Western digits, normalized to Western digits and nothing else (for
 * phone like text; spec 0004 AC-18). Never use it on passwords, tokens, names, search, or free text.
 */
export const westernDigits = z.string().transform((value) => normalizeDigits(value));

/**
 * A whole number sent as a number or as text in any digit set, normalized to an integer and
 * kept inside `min` and `max` (inclusive).
 */
export const quantityInput = (range: { min: number; max: number }) =>
  z
    .union([z.number(), z.string()])
    .transform((value, ctx) =>
      typeof value === 'number' ? value : parseOrIssue(() => parseQuantity(value), ctx),
    )
    .pipe(z.number().int().min(range.min).max(range.max));

/**
 * An amount typed in any digit set, as the normalized decimal string with at most `digits`
 * fraction digits. Pipe it into `MoneyString`, `UnitCostString`, or `PriceString`, which keep
 * the range rules. Never rounds.
 */
export const moneyInput = (digits: number) =>
  z.string().transform((value, ctx) => parseOrIssue(() => parseMoney(value, digits), ctx));
