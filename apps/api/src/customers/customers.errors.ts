/** The stable codes of the customers module's domain errors. */
export type CustomersErrorCode =
  | 'CUSTOMER_NOT_FOUND'
  | 'INVALID_PHONE'
  | 'INVALID_QUERY'
  | 'INVALID_CURSOR'
  | 'INVALID_CHANNEL_CUSTOMER'
  | 'SAME_CUSTOMER'
  | 'CUSTOMER_MERGED'
  | 'CUSTOMER_CHANGED'
  | 'SUGGESTION_NOT_FOUND'
  | 'SUGGESTION_CLOSED'
  | 'SUGGESTION_MISMATCH'
  | 'MERGE_NOT_FOUND'
  | 'MERGE_ALREADY_UNDONE'
  | 'MERGE_NOT_LATEST';

/**
 * A rule of the customers module that a caller broke. The message is fixed text: it never holds a
 * phone, a name, or a note (Law 151), because error text reaches logs.
 */
export class CustomersError extends Error {
  /** Builds the error with its stable code and a message free of personal data. */
  constructor(
    readonly code: CustomersErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustomersError';
  }
}

/**
 * The undo of a merge refused because the merge was already undone (spec 0014 AC-8): the
 * customer route answers 409 `MERGE_ALREADY_UNDONE`, the audit undo handler `UndoNotPossible`
 * with the same code.
 */
export class MergeAlreadyUndone extends CustomersError {
  /** Builds the error with its fixed message. */
  constructor() {
    super('MERGE_ALREADY_UNDONE', 'This merge was already undone');
    this.name = 'MergeAlreadyUndone';
  }
}

/**
 * The undo of a merge refused because a later merge moved its customers (spec 0014 AC-8, the
 * undo rule): the survivor is no longer canonical, or the merged customer no longer points at it.
 * Undo the later merge first.
 */
export class MergeNotLatest extends CustomersError {
  /** Builds the error with its fixed message. */
  constructor() {
    super('MERGE_NOT_LATEST', 'A later merge must be undone first');
    this.name = 'MergeNotLatest';
  }
}
