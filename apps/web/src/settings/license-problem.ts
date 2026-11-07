import { isLicenseCheckProblem, type LicenseCheckView } from '@ssdashboard/contracts';

/**
 * Whether the latest file check is a problem the manager must be told about (spec 0009, AC-16,
 * Igris's ruling of 2026-11-07): every outcome `isLicenseCheckProblem` names, except that
 * `none_configured` counts only while no license has ever been recorded (`recordedCount` is 0).
 * An install that runs on uploads alone has no file by design, so there it is information, not a
 * problem. Pure.
 */
export function isLicenseProblem(check: LicenseCheckView | null, recordedCount: number): boolean {
  if (check === null || !isLicenseCheckProblem(check.outcome)) return false;
  return check.outcome !== 'none_configured' || recordedCount === 0;
}
