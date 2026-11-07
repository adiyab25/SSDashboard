import { createHash } from 'node:crypto';

/** The namespace of setting record ids: a fixed random uuid, never to change. */
const SETTING_NAMESPACE = '6f1d3c52-8a7e-4b0f-9c1e-2d5a7b9e0f43';

/**
 * The audit record id of a setting: a name based (version 5) uuid of its key. `audit_entries`
 * keeps record ids as uuids and settings rows have no id, so every `setting.changed` entry of
 * one key carries the same id and the audit list can filter one setting's history. Pure; the
 * label of the entry carries the key itself.
 */
export function settingRecordId(key: string): string {
  const namespace = Buffer.from(SETTING_NAMESPACE.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1').update(namespace).update(key, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
