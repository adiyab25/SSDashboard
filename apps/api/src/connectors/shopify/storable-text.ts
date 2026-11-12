// What PostgreSQL can store from a Shopify string (security review N3, N4; code review R4). A
// `text` column refuses U+0000, and `jsonb` refuses U+0000 and an unpaired surrogate escape (which
// `JSON.stringify` writes for a lone surrogate). Pure: no database, no log.
import { z } from 'zod';

/** One unpaired UTF-16 surrogate (a high one with no low after it, or a low one with no high). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every unpaired surrogate of a string, for removal. */
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, 'g');

/**
 * Whether a Shopify string can be stored as is in a `text` column and inside `jsonb`: no U+0000
 * and no unpaired surrogate. Never changes the value.
 */
export function isStorableText(value: string): boolean {
  return !value.includes('\u0000') && !LONE_SURROGATE.test(value);
}

/**
 * The string without its unpaired surrogates. A text cleaner calls it after stripping control
 * characters (which removes U+0000), so its result is always storable.
 */
export function withoutLoneSurrogates(value: string): string {
  return value.replace(LONE_SURROGATES, '');
}

/**
 * A Shopify id (a gid) or other identifier the connector stores verbatim (in `connection_external_ids`
 * state, a channel line id, a customer's channel id): a non empty, storable string of at most 255
 * characters. A broken answer fails its read as unreadable instead of failing every retry at the
 * database.
 */
export const StorableShopifyId = z
  .string()
  .min(1)
  .max(255)
  .refine(isStorableText, { message: 'Not storable text' });

/** A Shopify string stored verbatim that may be empty (a time zone name, a shop name). */
export const StorableShopifyText = z.string().refine(isStorableText, {
  message: 'Not storable text',
});
