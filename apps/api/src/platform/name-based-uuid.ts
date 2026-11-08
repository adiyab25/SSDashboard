import { createHash } from 'node:crypto';

/**
 * A name based (version 5) uuid of `name` in `namespace`: the same name always gives the same id.
 * For audit record ids of records that have no uuid of their own (a setting, an owner type
 * policy), because `audit_entries` keeps record ids as uuids. Pure; never reads anything.
 */
export function nameBasedUuid(namespace: string, name: string): string {
  const space = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1').update(space).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
