/**
 * A fresh RFC 4122 version 4 UUID for an `Idempotency-Key` header (the api validates `z.uuid()`).
 * `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost), so on plain HTTP it
 * builds the same shape from `crypto.getRandomValues`. Never use it for secrets; it only names
 * one tap of one button.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4 in the high nibble of byte 6, variant 10 in the top bits of byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
