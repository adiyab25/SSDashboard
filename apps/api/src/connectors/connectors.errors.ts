/** Why the connectors module refused a call, as a stable code the api edge turns into an answer. */
export type ConnectionsErrorCode =
  | 'SHOP_ALREADY_CONNECTED'
  | 'STORE_CODE_TAKEN'
  | 'CONNECTION_ARCHIVED'
  | 'NOT_FOUND'
  | 'INVALID_CURSOR'
  | 'SCAN_RUNNING'
  | 'BACKFILL_RUNNING'
  | 'CONNECTION_NOT_READY'
  | 'GATEWAYS_UNMAPPED'
  | 'CONNECTION_PAUSED'
  | 'GO_LIVE_ALREADY_SET'
  | 'GO_LIVE_OUT_OF_RANGE'
  | 'GATEWAYS_TOO_MANY';

/**
 * A typed domain error of the connectors module (spec 0015), never an error string. Its message
 * is plain words for developers and never holds a credential, a token, or a shop's data.
 */
export class ConnectionsError extends Error {
  /** Takes the stable code and a message for developers. */
  constructor(
    readonly code: ConnectionsErrorCode,
    message: string,
    /** For `GATEWAYS_UNMAPPED`: the scanned gateway names with no payment method (not personal). */
    readonly gateways: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ConnectionsError';
  }
}
