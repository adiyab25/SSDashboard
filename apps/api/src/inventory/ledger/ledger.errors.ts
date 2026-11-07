/**
 * Every stock rule the ledger can refuse, from bad input to a locked period or a lock timeout.
 * Callers switch on this, so add a code here before throwing a new one.
 */
export type LedgerErrorCode =
  | 'InvalidInput'
  | 'UnknownReference'
  | 'InsufficientStock'
  | 'PeriodLocked'
  | 'FutureDate'
  | 'TrackingMismatch'
  | 'NotStockable'
  | 'Archived'
  | 'InvalidCost'
  | 'ReservationMismatch'
  | 'IdempotencyConflict'
  | 'AlreadyReversed'
  | 'CannotReverseReversal'
  | 'NotFound'
  | 'DuplicateReservation'
  | 'ReservationClosed'
  | 'QuantityTooLarge'
  | 'DiscrepancyClosed'
  | 'NotRebuildable'
  | 'LockTimeout'
  | 'LockDateUnreadable';

/** A stock rule the ledger refused. Feature 7's endpoints map `code` to an HTTP error. */
export class LedgerError extends Error {
  /**
   * Takes the stable `code`, a message safe to show, and optional structured `details` for the
   * caller.
   */
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}
