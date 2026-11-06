/** The stable code of each audit rule a caller can break. */
export type AuditErrorCode =
  | 'AuditReasonRequired'
  | 'AuditReasonTooLong'
  | 'AuditReasonInvalid'
  | 'UnknownAuditAction'
  | 'AuditRecordTypeMismatch'
  | 'AuditCorrelationMismatch'
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

/**
 * A typed note, or a code the action does not list, where the record type takes a reason code
 * (spec 0010, AC-5, security reviews AS13, AS23): a customer, order, exchange, or outbound
 * command keeps one of its action's `reasonCodes`, never free text about a person. The api
 * answers 422 `REASON_INVALID`.
 */
export class AuditReasonInvalid extends AuditError {
  /** Takes the action code; the reason text itself is never carried. */
  constructor(readonly action: string) {
    super('AuditReasonInvalid', 'This action takes a reason code, not a typed note');
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
 * A `recordMany` call mixed correlation ids (spec 0010, AC-6): one call is one business action,
 * so its entries share one id. A programming error, caught in tests.
 */
export class AuditCorrelationMismatch extends AuditError {
  /** Builds the error; the ids themselves are not carried. */
  constructor() {
    super(
      'AuditCorrelationMismatch',
      'The entries of one recordMany call must share a correlation id',
    );
  }
}

/**
 * Personal data reached `record_label` or `undo_args`, where it is refused rather than masked, or
 * a phone shaped key reached any diff (AC-4, AC-14; security review AS3, AS4): a programming
 * error, caught in tests. Names the field, never the value.
 */
export class AuditPersonalDataRefused extends AuditError {
  /** Takes the entry field that held personal data (`record.label` or `undo.args`). */
  constructor(readonly field: string) {
    super('AuditPersonalDataRefused', `Personal data is not allowed in ${field}`);
  }
}
