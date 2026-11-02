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
  | 'DiscrepancyClosed';

/** A stock rule the ledger refused. Feature 7's endpoints map `code` to an HTTP error. */
export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}
