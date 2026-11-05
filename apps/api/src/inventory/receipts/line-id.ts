import { createHash } from 'node:crypto';

/** Fixed namespace for stock receipt line ids. Never change it: stored ids derive from it. */
export const STOCK_RECEIPT_LINE_NAMESPACE = '5f0c3b1e-6d2a-4c8f-9b7e-2a4d6e8f0c13';

/** RFC 9562 UUID version 5 (SHA-1, name based). */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new Error('The namespace is not a UUID');
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A receipt line's id: UUID v5 of `<receipt id>:<position>` (spec 0006, Value sourcing). It is
 * deterministic because the ledger's request hash includes `sourceLineId`, so an honest retry
 * must send the same ids.
 */
export function receiptLineId(receiptId: string, position: number): string {
  return uuidV5(`${receiptId}:${position}`, STOCK_RECEIPT_LINE_NAMESPACE);
}
