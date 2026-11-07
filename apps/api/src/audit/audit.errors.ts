/** The stable code of each audit rule a caller can break. */
export type AuditErrorCode =
  | 'AuditReasonRequired'
  | 'AuditReasonTooLong'
  | 'AuditReasonInvalid'
  | 'UnknownAuditAction'
  | 'AuditRecordTypeMismatch'
  | 'AuditCorrelationMismatch'
  | 'AuditPersonalDataRefused'
  | 'AuditReadForbidden'
  | 'AuditEntryNotFound'
  | 'AuditExportTooLarge'
  | 'NotUndoable'
  | 'AlreadyUndone'
  | 'UndoNotPossible'
  | 'AuditUndoHandlerMissing'
  | 'AuditUndoHandlerDuplicate'
  | 'AuditUndoHandlerForeign'
  | 'AuditUndoRecordMismatch';

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

/**
 * The viewer may not read the trail (spec 0010, AC-13): they lack `audit.read` (or, for the export
 * reads, `audit.export`; the manager hat by default, spec 0008). Thrown by every public reader of
 * `AuditQueryService`, which other modules reach with a viewer (review AR3, security review
 * AS29); the api answers 403 `FORBIDDEN`.
 */
export class AuditReadForbidden extends AuditError {
  /** Builds the error; it names no viewer. */
  constructor() {
    super('AuditReadForbidden', 'Only a manager can read the audit trail');
  }
}

/** No entry has this id (spec 0010, API surface); the api answers 404 `ENTRY_NOT_FOUND`. */
export class AuditEntryNotFound extends AuditError {
  /** Builds the error; the id is not carried. */
  constructor() {
    super('AuditEntryNotFound', 'Audit entry not found');
  }
}

/**
 * The export would hold more than 200,000 rows (spec 0010, AC-15): decided before anything
 * streams; the api answers 413 `EXPORT_TOO_LARGE` and asks for a narrower range.
 */
export class AuditExportTooLarge extends AuditError {
  /** Builds the error with the row limit the caller passed. */
  constructor(readonly limit: number) {
    super('AuditExportTooLarge', `An export holds at most ${limit} rows. Choose a shorter range.`);
  }
}

/**
 * The entry cannot be undone (spec 0010, AC-14): it carries no `undo_action`, its action is not
 * undoable in the registry (any more), or it names another handler than the registry's. The api
 * answers 409 `NOT_UNDOABLE`.
 */
export class NotUndoable extends AuditError {
  /** Builds the error; the entry id is not carried. */
  constructor() {
    super('NotUndoable', 'This entry cannot be undone');
  }
}

/**
 * An entry already undoes this one (spec 0010, AC-14): an entry is undone at most once. The api
 * answers 409 `ALREADY_UNDONE`.
 */
export class AlreadyUndone extends AuditError {
  /** Builds the error; the entry id is not carried. */
  constructor() {
    super('AlreadyUndone', 'This entry has already been undone');
  }
}

/** The shape of the code an owner's handler gives `UndoNotPossible`: upper snake case. */
const UNDO_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Thrown by an owning module's undo handler when it cannot restore its change (spec 0010, AC-14):
 * a later change got in the way, for example a merge that is no longer the latest. `undoCode` is
 * the owner's stable upper snake case code (`MERGE_NOT_LATEST`), one of the `undoRefusalCodes`
 * its action declares in the registry. It carries no message of the owner's: the api answers a
 * fixed text (security review AS31). `AuditUndoService` passes on only a declared code; a code
 * the action does not declare, or of another shape, leaves `undoCode` undefined, so no value ever
 * reaches the answer or a log. Everything the handler wrote rolls back; the api answers 409
 * `UNDO_NOT_POSSIBLE`, with `undoCode` when there is one.
 */
export class UndoNotPossible extends AuditError {
  /** The owner's declared code, safe to show and log, or undefined. */
  readonly undoCode: string | undefined;

  /** Takes the owner's refusal code (upper snake case), or nothing for a plain refusal. */
  constructor(undoCode?: string) {
    super('UndoNotPossible', 'This change can no longer be undone');
    this.undoCode = undoCode !== undefined && UNDO_CODE.test(undoCode) ? undoCode : undefined;
  }
}

/**
 * An undoable code names an undo handler that no module registered (spec 0010, Key invariants):
 * thrown when the app starts, so a missing handler stops the process instead of failing a
 * manager's click later. A programming error; names the handler codes, never data.
 */
export class AuditUndoHandlerMissing extends AuditError {
  /** Takes the handler codes no module registered. */
  constructor(readonly handlers: readonly string[]) {
    super('AuditUndoHandlerMissing', `No undo handler registered for ${handlers.join(', ')}`);
  }
}

/** Two modules registered one undo handler code: a programming error, thrown at start. */
export class AuditUndoHandlerDuplicate extends AuditError {
  /** Takes the handler code registered twice. */
  constructor(readonly handler: string) {
    super('AuditUndoHandlerDuplicate', `The undo handler ${handler} is registered twice`);
  }
}

/**
 * A module registered an undo handler code that no registry action of its own names (security
 * review AS33): the registry's undoable actions bind each `undoHandler` to their `module`, so a
 * module can never answer for another owner's undo. A programming error, thrown at start; names
 * the handler code and the module, never data.
 */
export class AuditUndoHandlerForeign extends AuditError {
  /** Takes the handler code and the module that tried to register it. */
  constructor(
    readonly handler: string,
    readonly owner: string,
  ) {
    super(
      'AuditUndoHandlerForeign',
      `The undo handler ${handler} is not named by any undoable action of module ${owner}`,
    );
  }
}

/**
 * An undo handler returned another record than the entry it undid (spec 0010, AC-14, security
 * review AS5): the undone entry is always written on the undone entry's own record. A programming
 * error; the undo rolls back.
 */
export class AuditUndoRecordMismatch extends AuditError {
  /** Takes the handler code that returned the wrong record. */
  constructor(readonly handler: string) {
    super('AuditUndoRecordMismatch', `The undo handler ${handler} returned another record`);
  }
}
