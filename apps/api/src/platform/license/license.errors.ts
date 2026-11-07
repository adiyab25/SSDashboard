import type { LicenseCheckOutcome } from '@ssdashboard/contracts';

/** The stable code of each license rule a caller can break (spec 0009, AC-20). */
export type LicenseErrorKind = 'LicenseInvalid' | 'LicenseTooLarge';

/**
 * A typed license domain error; `licenseHttpError` maps it at the api edge. `outcome` names why
 * an upload did not verify. A message never carries the file's content.
 */
export class LicenseError extends Error {
  /** Takes the stable code, a message safe to log and show, and the check outcome if any. */
  constructor(
    readonly kind: LicenseErrorKind,
    message: string,
    readonly outcome: LicenseCheckOutcome | null = null,
  ) {
    super(message);
    this.name = kind;
  }
}
