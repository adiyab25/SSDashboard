/** The online stock rules a caller can break: there is no online location to read. */
export type OnlineStockErrorCode = 'NoOnlineLocation';

/**
 * Raised by every online stock read while no location feeds online stock (spec 0011 AC-2): the
 * read never answers zeros then, because a channel would push zero stock for every variant. The
 * Shopify connector pushes nothing on this error. Carries no personal data.
 */
export class OnlineStockError extends Error {
  /** Takes the stable `code` and a message safe to show. */
  constructor(
    readonly code: OnlineStockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OnlineStockError';
  }
}
