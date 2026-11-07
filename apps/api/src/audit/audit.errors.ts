/** The stable code of each audit rule a caller can break. */
export type AuditErrorCode =
  | 'AuditReasonRequired'
  | 'AuditReasonTooLong'
  | 'UnknownAuditAction'
  | 'AuditRecordTypeMismatch'
  | 'AuditPersonalDataRefused';

/**
 * Base of every typed audit domain error (spec 0010, API surface). Domain code throws these; the
 * api edge maps them with `auditHttpError`. A message never carries the caller's values, because
 * a refused value may be personal data and error text reaches logs.
 */
export class AuditError extends Error {
  /** Takes the stable code and a message safe to log and show. */
  constructor(
    readonly code: AuditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = code;
  }
}

/** A required reason is missing or blank (AC-5); the api answers 422 `REASON_REQUIRED`. */
export class AuditReasonRequired extends AuditError {
  /** Takes the action code whose registry entry requires a reason. */
  constructor(readonly action: string) {
    super('AuditReasonRequired', 'A reason is required for this action');
  }
}

/** A reason longer than 500 characters after trimming (AC-5); the api answers 422 `REASON_TOO_LONG`. */
export class AuditReasonTooLong extends AuditError {
  /** Builds the error; the reason text itself is never carried. */
  constructor() {
    super('AuditReasonTooLong', 'A reason can be at most 500 characters');
  }
}

/** The action code is not in `AUDIT_ACTIONS` (AC-10): a programming error, caught in tests. */
export class UnknownAuditAction extends AuditError {
  /** Takes the code that is not registered. */
  constructor(readonly action: string) {
    super('UnknownAuditAction', `Unknown audit action ${action}`);
  }
}

/**
 * The entry's record type is not the one the registry gives its action code (security review
 * AS8): a programming error, caught in tests, so one code never names two kinds of record.
 */
export class AuditRecordTypeMismatch extends AuditError {
  /** Takes the action code and the record type the caller passed. */
  constructor(
    readonly action: string,
    readonly recordType: string,
  ) {
    super('AuditRecordTypeMismatch', `Audit action ${action} does not record a ${recordType}`);
  }
}

/**
 * Personal data reached `record_label` or `undo_args`, where it is refused rather than masked
 * (AC-4, AC-14): a programming error, caught in tests. Names the field, never the value.
 */
export class AuditPersonalDataRefused extends AuditError {
  /** Takes the entry field that held personal data (`record.label` or `undo.args`). */
  constructor(readonly field: string) {
    super('AuditPersonalDataRefused', `Personal data is not allowed in ${field}`);
  }
}
