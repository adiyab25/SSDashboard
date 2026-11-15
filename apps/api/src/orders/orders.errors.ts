/** Every refusal the orders module can raise, as a stable code the api edge maps to an HTTP answer. */
export type OrdersErrorCode =
  | 'OrderNotFound'
  | 'OrderNumberTaken'
  | 'StoreNotInternal'
  | 'ChannelNotAllowed'
  | 'VariantUnknown'
  | 'PartialPrepaymentNotSupported'
  | 'RelatedOrderState'
  | 'RelatedOrderUnknown'
  | 'GiftMustStayFree'
  | 'LineFullyDiscounted'
  | 'RelatedOrderOtherCustomer'
  | 'AlreadyReopened'
  | 'TransactionNested'
  | 'InvalidPhoneAlt'
  | 'InvalidOrderInput'
  | 'LockTimeout'
  | 'OrderLocked'
  | 'OrderStale'
  | 'OrderNeedsALine'
  | 'EditChangesPayment'
  | 'EditOverpaid'
  | 'EditInShopify'
  | 'CancelInShopify'
  | 'WriteBackOpen'
  | 'GiftNotAllowed'
  | 'DuplicateTargetRequired'
  | 'InvalidPhoneMain'
  | 'OrderStoreMissing'
  | 'ChannelLineIdConflict'
  | 'LineAlreadyMapped'
  | 'PaymentMethodLocked'
  | 'LineShort'
  | 'LocationNotFound';

/**
 * A typed domain error of the orders module (never an error string). Messages are fixed text and
 * never carry a ship to field, a phone, or a note (Law 151): a caller may log `code` and the
 * message safely.
 */
export class OrdersError extends Error {
  /** Takes the stable code and a message safe to show. */
  constructor(
    readonly code: OrdersErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** No order has that id. */
export class OrderNotFound extends OrdersError {
  /** Builds the error; it names no order. */
  constructor() {
    super('OrderNotFound', 'No order has that id');
  }
}

/** The store already holds an order with that number (spec 0002 B1). */
export class OrderNumberTaken extends OrdersError {
  /** Builds the error; it names no number. */
  constructor() {
    super('OrderNumberTaken', 'This store already has an order with that number');
  }
}

/** The store of a manual order is not an active internal store. */
export class StoreNotInternal extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('StoreNotInternal', 'A manual order goes into an active internal store');
  }
}

/** The channel of a manual order is not an active manual, WhatsApp, or Instagram channel. */
export class ChannelNotAllowed extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'ChannelNotAllowed',
      'A manual order arrives on an active manual, WhatsApp, or Instagram channel',
    );
  }
}

/** A line names a variant that does not exist or is archived. */
export class VariantUnknown extends OrdersError {
  /** Builds the error; it names no variant. */
  constructor() {
    super('VariantUnknown', 'A line names a SKU that does not exist or is archived');
  }
}

/** A prepayment other than 0 or the full total (spec 0013 AC-1). */
export class PartialPrepaymentNotSupported extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'PartialPrepaymentNotSupported',
      'A manual order is paid on delivery or fully prepaid; a deposit is not supported yet',
    );
  }
}

/** The linked order is in a state the relation does not accept (spec 0013 AC-23). */
export class RelatedOrderState extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('RelatedOrderState', 'The linked order is not in a state this link accepts');
  }
}

/** The linked order does not exist. */
export class RelatedOrderUnknown extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('RelatedOrderUnknown', 'The linked order does not exist');
  }
}

/** A sale line has nothing to pay and the person may not gift (spec 0013 security S1). */
export class LineFullyDiscounted extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'LineFullyDiscounted',
      'A sale line cannot be fully discounted; a gift is entered as a gifted order',
    );
  }
}

/** A reopened order must belong to the customer of the order it reopens. */
export class RelatedOrderOtherCustomer extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('RelatedOrderOtherCustomer', 'The order to reopen belongs to another customer');
  }
}

/** The order was already reopened once, whatever became of that reopened order. */
export class AlreadyReopened extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('AlreadyReopened', 'This order has already been reopened; an order is reopened once');
  }
}

/** `OrderTransactions.run` was called inside another `run`: a programming error, never an answer. */
export class OrderTransactionNested extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'TransactionNested',
      'An order unit of work cannot open another; pass the open transaction down instead',
    );
  }
}

/** A gifted order or edit gave a line or the shipping a price above 0 (spec 0013 AC-2). */
export class GiftMustStayFree extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('GiftMustStayFree', 'A gifted order costs the customer nothing');
  }
}

/** The second phone does not parse. Never carries the text. */
export class InvalidPhoneAlt extends OrdersError {
  /** Builds the error; it carries no phone text. */
  constructor() {
    super('InvalidPhoneAlt', 'The second phone number is not a valid number');
  }
}

/** The input is well formed but cannot make an order (an amount the money rules refuse). */
export class InvalidOrderInput extends OrdersError {
  /** Takes fixed words of what is wrong; never a value the caller typed. */
  constructor(message: string) {
    super('InvalidOrderInput', message);
  }
}

/** A lock wait passed its cap; the caller answers 503 `BUSY` and may retry. */
export class OrderLockTimeout extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('LockTimeout', 'Orders are busy with another change. Try again.');
  }
}

/**
 * The order can no longer be edited (spec 0013 AC-8): its carrier delivery exists (the money
 * freeze), or it has left `new`, `confirmed`, and `packed`. Also an unpack once the delivery exists.
 */
export class OrderLocked extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('OrderLocked', 'This order can no longer be changed');
  }
}

/** The order changed since the person loaded it (`expectedUpdatedAt` does not match). */
export class OrderStale extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('OrderStale', 'This order was changed by someone else. Reload it and try again.');
  }
}

/** An edit would leave the order without an open line (AC-9): cancel the order instead. */
export class OrderNeedsALine extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('OrderNeedsALine', 'An order keeps at least one line; cancel the order instead');
  }
}

/** An edit would move `cod_expected_amount` between 0 and above 0 (AC-9). */
export class EditChangesPayment extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'EditChangesPayment',
      'This edit would change how the order is paid: between nothing to collect and cash on delivery',
    );
  }
}

/** An edit would bring the total below what was prepaid and credited (AC-9, review M5). */
export class EditOverpaid extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('EditOverpaid', 'This edit would bring the total below what the customer already paid');
  }
}

/** A Shopify store order is edited in Shopify while its write back is unavailable (AC-10). */
export class EditInShopify extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'EditInShopify',
      'Edit this order in Shopify; the app reads the change back from Shopify and writes nothing to Shopify yet',
    );
  }
}

/** A Shopify store order is cancelled in Shopify while its write back is unavailable (AC-7). */
export class CancelInShopify extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'CancelInShopify',
      'Cancel this order in Shopify; the app reads the cancel back from Shopify and writes nothing to Shopify yet',
    );
  }
}

/** An outbound command on the order is still open, so it cannot be packed (AC-7, carried B2). */
export class WriteBackOpen extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('WriteBackOpen', 'An edit of this order has not reached the channel yet');
  }
}

/** A line or shipping edit of a gifted order by a person without `orders.gift` (AC-2). */
export class GiftNotAllowed extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('GiftNotAllowed', 'Changing the lines or shipping of a gifted order needs orders.gift');
  }
}

/** A `duplicate` cancel names no order, an unknown one, or the order itself (AC-7). */
export class DuplicateTargetRequired extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'DuplicateTargetRequired',
      'A duplicate names the other order it duplicates, and that order must exist',
    );
  }
}

/** An edit's new main phone does not parse. Never carries the text. */
export class InvalidPhoneMain extends OrdersError {
  /** Builds the error; it carries no phone text. */
  constructor() {
    super('InvalidPhoneMain', 'The phone number is not a valid number');
  }
}

/**
 * An order names a store the channels service does not know: broken data, never a caller's
 * mistake (500 at the edge, logged by order id).
 */
export class OrderStoreMissing extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('OrderStoreMissing', 'The order names a store that does not exist');
  }
}

/**
 * A line already carries another channel line id, or another line of the order already carries
 * that id (spec 0013 AC-14, `recordChannelLineIds`): a channel id is written once, from null.
 */
export class ChannelLineIdConflict extends OrdersError {
  /** Builds the error; it names no id. */
  constructor() {
    super('ChannelLineIdConflict', 'A line already carries another channel line id');
  }
}

/** The line already has a variant (spec 0013 AC-25 b): a mapped variant never changes in place. */
export class LineAlreadyMapped extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('LineAlreadyMapped', 'This line is already mapped to a SKU');
  }
}

/**
 * The payment method can no longer be corrected (spec 0013 AC-25 c): the carrier delivery exists,
 * something was collected, the cash moved past its first states, or the order left `new`,
 * `confirmed`, and `packed`. Nothing was applied.
 */
export class PaymentMethodLocked extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('PaymentMethodLocked', 'The payment method of this order can no longer be corrected');
  }
}

/**
 * Packing refused: an open line is still short of stock after the top up (spec 0013 AC-7, AC-13,
 * owner decision Q-16.5). Names no line, phone, or person.
 */
export class LineShort extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('LineShort', 'A line is short of stock, so the order cannot be packed yet');
  }
}

/**
 * `hold-open-orders` named a location that does not exist, is archived, or could never feed
 * online stock (spec 0013 AC-26).
 */
export class LocationNotFound extends OrdersError {
  /** Builds the error. */
  constructor() {
    super('LocationNotFound', 'No active location that can feed online stock has that id');
  }
}
