/** Why the channels module refused a call, as a stable code the api edge turns into an HTTP answer. */
export type ChannelsErrorCode =
  | 'STORE_CODE_TAKEN'
  | 'INVALID_STORE_INPUT'
  | 'STORE_NOT_FOUND'
  | 'CONNECTION_STORES_NOT_REGISTERED'
  | 'CONNECTION_STORES_ALREADY_REGISTERED';

/**
 * A typed domain error of the channels module (never an error string). The connect route maps
 * `STORE_CODE_TAKEN` to 409 `STORE_CODE_TAKEN` (spec 0015 AC-1). It never carries a customer's
 * personal data.
 */
export class ChannelsError extends Error {
  /** Takes the stable code and a message for developers. */
  constructor(
    readonly code: ChannelsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelsError';
  }
}
