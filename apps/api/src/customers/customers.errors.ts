/** The stable codes of the customers module's domain errors. */
export type CustomersErrorCode =
  | 'CUSTOMER_NOT_FOUND'
  | 'INVALID_PHONE'
  | 'INVALID_QUERY'
  | 'INVALID_CURSOR'
  | 'INVALID_CHANNEL_CUSTOMER';

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
