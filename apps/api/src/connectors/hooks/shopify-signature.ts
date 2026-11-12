import { createHmac, timingSafeEqual } from 'node:crypto';

/** The length of an HMAC SHA256 digest in bytes: a header that decodes to anything else is wrong. */
const DIGEST_BYTES = 32;

/** Standard base64 with padding, the shape Shopify's `X-Shopify-Hmac-SHA256` header carries. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Checks a Shopify webhook signature (spec 0015 AC-4; shopify.dev "Deliver webhooks through
 * HTTPS": HMAC SHA256 of the raw body, keyed with the app's client secret, base64 in
 * `X-Shopify-Hmac-SHA256`). Runs on the raw bytes before anything is parsed, and compares in
 * constant time (`timingSafeEqual` on two 32 byte buffers). A missing header, one that is not
 * base64, or one that decodes to another length answers false without comparing.
 *
 * Pure: never logs, never throws, and never returns or keeps the secret or the expected digest.
 */
export function verifyShopifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: Buffer | string,
): boolean {
  if (header === undefined) return false;
  const text = header.trim();
  if (text.length === 0 || text.length > 128 || !BASE64.test(text)) return false;
  const given = Buffer.from(text, 'base64');
  if (given.length !== DIGEST_BYTES) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(given, expected);
}
