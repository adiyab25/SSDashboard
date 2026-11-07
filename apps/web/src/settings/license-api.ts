import { LicenseSummary, PostLicenseAnswer } from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys of the license summary, shared by the settings section and the shell's banner. */
export const licenseKeys = {
  /** The one summary, for one invalidation or one `setQueryData` after an upload. */
  all: ['license'] as const,
};

/** The license summary: plans, last check, recorded licenses, notices (`settings.manage`: 403 otherwise). */
export function getLicense(signal?: AbortSignal) {
  return apiRequest('GET', '/api/platform/license', LicenseSummary, { signal });
}

/**
 * Uploads the text of a license file (spec 0009, AC-20). 422 `LICENSE_INVALID` carries the check
 * `outcome` in the error body, 413 `LICENSE_TOO_LARGE` a file over 16 KB.
 */
export function uploadLicense(envelope: string) {
  return apiRequest('POST', '/api/platform/license', PostLicenseAnswer, { body: { envelope } });
}
