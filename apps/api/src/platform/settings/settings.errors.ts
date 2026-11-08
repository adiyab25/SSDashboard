/** The stable code of each settings rule a caller can break (spec 0009, AC-3). */
export type SettingErrorKind =
  | 'SettingUnknown'
  | 'SettingInvalid'
  | 'SettingLocked'
  | 'NotLicensed'
  | 'SettingReasonRequired'
  | 'StaleSetting'
  | 'SettingUnreadable'
  | 'ModuleRequiredBy'
  | 'ModuleRequires';

/** One way a value failed its entry's schema: the path inside the value and Zod's message. */
export interface SettingIssue {
  path: string;
  message: string;
}

/**
 * A typed settings domain error; `settingsHttpError` maps it at the api edge. A message names the
 * key at most, never a value, because error text reaches logs.
 */
export class SettingError extends Error {
  /**
   * Takes the stable code, a message safe to log and show, the schema issues if any, and the
   * module keys the rule names: for `ModuleRequiredBy` the `on` modules that require the one being
   * turned off, for `ModuleRequires` the required modules that are not `on`.
   */
  constructor(
    readonly kind: SettingErrorKind,
    message: string,
    readonly issues: readonly SettingIssue[] = [],
    readonly modules: readonly string[] = [],
  ) {
    super(message);
    this.name = kind;
  }
}
