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
  | 'LockTimeout';

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

/** The order already has an open reopened order. */
export class AlreadyReopened extends OrdersError {
  /** Builds the error. */
  constructor() {
    super(
      'AlreadyReopened',
      'This order has already been reopened and the new order is still open',
    );
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
