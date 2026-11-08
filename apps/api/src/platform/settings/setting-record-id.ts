import { nameBasedUuid } from '../name-based-uuid.js';

/** The namespace of setting record ids: a fixed random uuid, never to change. */
const SETTING_NAMESPACE = '6f1d3c52-8a7e-4b0f-9c1e-2d5a7b9e0f43';

/**
 * The audit record id of a setting: a name based (version 5) uuid of its key. `audit_entries`
 * keeps record ids as uuids and settings rows have no id, so every `setting.changed` entry of
 * one key carries the same id and the audit list can filter one setting's history. Pure; the
 * label of the entry carries the key itself.
 */
export function settingRecordId(key: string): string {
  return nameBasedUuid(SETTING_NAMESPACE, key);
}
