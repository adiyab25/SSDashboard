import {
  OffImpact,
  PutSettingAnswer,
  SettingsListResponse,
  type PutSettingBody,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys of the settings screen. */
export const settingsKeys = {
  /** The list of every entry, for one invalidation. */
  all: ['settings'] as const,
  /** The off dialog's impact of one module's switch. */
  offImpact: (key: string) => ['settings', 'off-impact', key] as const,
};

/** Every registry entry with the value in force (needs `settings.manage`: 403 otherwise). */
export function listSettings(signal?: AbortSignal) {
  return apiRequest('GET', '/api/settings', SettingsListResponse, { signal });
}

/**
 * What turning a module off will do (spec 0009, AC-30): waiting commands that will fail, work in
 * flight that stays finishable, and the pieces each partner holds. Needs `settings.manage`.
 */
export function getOffImpact(key: string, signal?: AbortSignal) {
  return apiRequest('GET', `/api/settings/${encodeURIComponent(key)}/off-impact`, OffImpact, {
    signal,
  });
}

/**
 * Writes one setting (spec 0009, AC-3). `body.expectedUpdatedAt` is the `updatedAt` the screen
 * showed, unchanged; a change made meanwhile answers 409 `STALE_SETTING`.
 */
export function putSetting(key: string, body: PutSettingBody) {
  return apiRequest('PUT', `/api/settings/${encodeURIComponent(key)}`, PutSettingAnswer, { body });
}
