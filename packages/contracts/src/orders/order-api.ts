import { z } from 'zod';
import { PriceString } from '../catalog/index.js';
import { CustomerRiskFlag } from '../customers/customer-enums.js';
import { moneyInput, quantityInput } from '../digit-input.js';
import { LocalizedText } from '../localized-text.js';
import { Money, MoneyString, TaxRateString, UnitCostString } from '../money.js';
import { OrderOutcome } from './order-outcome.js';
import {
  AwaitingRestockCloseReason,
  CancelReasonCode,
  ChannelFulfillmentPostReason,
  EditReasonCode,
  GiftReasonCode,
  LineRemovalReasonCode,
  OrderRelation,
  OrderType,
  RelatedOrderRelation,
  StockOutSource,
} from './order-reasons.js';
import {
  CashState,
  FulfillmentState,
  OrderActorType,
  OrderLineState,
  OrderMachine,
  ReasonCode,
  RefusedReasonCode,
} from './order-states.js';
import { OrderPaymentMethod } from './payment-method.js';

/**
 * The request and response shapes of the orders routes (spec 0013, API surface). The api validates
 * with them and the web parses every answer with them. Ship to fields, the customer note, and
 * phones are personal data (Law 151): they appear in the detail and list answers for `orders.view`
 * holders only and never in a URL, a log line, a domain event, or an audit column in clear.
 */

const Timestamp = z.iso.datetime({ offset: true });

/** An amount typed in any digit set: 0 or more with at most 2 decimals. */
const Amount = moneyInput(2).pipe(PriceString);

/** The area codes a carrier uses, from one geography list (for example `bosta`). */
export const OrderAreaCodes = z.strictObject({
  list: z.string().trim().min(1).max(32),
  governorateCode: z.string().trim().min(1).max(32),
  cityCode: z.string().trim().min(1).max(32),
  zoneCode: z.string().trim().min(1).max(32),
});
/** The validated shape of `OrderAreaCodes`. */
export type OrderAreaCodes = z.infer<typeof OrderAreaCodes>;

/**
 * Where the parcel goes, as a person types it. Phones are text and are parsed by the api with
 * `EgyptianPhone` (a main phone that does not parse leaves the order unlinked and is kept as
 * typed). Never echoed in an error.
 */
export const OrderShipToInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(64),
  phoneAlt: z.string().trim().max(64).nullable().optional(),
  address: z.string().trim().min(1).max(500),
  courierNote: z.string().trim().max(500).nullable().optional(),
  area: OrderAreaCodes.nullable().optional(),
});
/** The validated shape of `OrderShipToInput`. */
export type OrderShipToInput = z.infer<typeof OrderShipToInput>;

/** One line of a new manual or gifted order. */
export const NewOrderLineInput = z.strictObject({
  variantId: z.uuid(),
  quantity: quantityInput({ min: 1, max: 10_000 }),
  unitPrice: Amount,
  discountAmount: Amount.default('0.00'),
});
/** The validated shape of `NewOrderLineInput`. */
export type NewOrderLineInput = z.infer<typeof NewOrderLineInput>;

/** The order a new one is linked to (spec 0013 AC-23). */
export const RelatedOrderInput = z.strictObject({
  orderId: z.uuid(),
  relation: RelatedOrderRelation,
});
/** The validated shape of `RelatedOrderInput`. */
export type RelatedOrderInput = z.infer<typeof RelatedOrderInput>;

/** How a manual order is paid: cash on delivery, or fully prepaid by one tender. */
export const ManualPaymentMethod = z.enum(['cod', 'instapay', 'bank_transfer', 'wallet']);
/** One manual payment method. */
export type ManualPaymentMethod = z.infer<typeof ManualPaymentMethod>;

const orderBase = {
  /** A uuid the form makes when it opens; a repeat of it returns the first order and writes nothing. */
  clientRef: z.uuid(),
  storeId: z.uuid(),
  channelId: z.uuid(),
  relatedOrder: RelatedOrderInput.nullable().optional(),
  shipTo: OrderShipToInput,
  lines: z.array(NewOrderLineInput).min(1).max(100),
};

/**
 * `POST /api/orders` (`orders.confirm`, AC-1): a sale entered by hand into an internal store.
 * `cod` carries no prepayment; any other method is a full prepayment (the api checks the amount
 * against the total and answers 422 `PARTIAL_PREPAYMENT_NOT_SUPPORTED`). A `goodwill_for`
 * relation belongs to a gifted order only.
 */
export const CreateManualOrderBody = z
  .strictObject({
    ...orderBase,
    shippingChargedAmount: Amount,
    paymentMethod: ManualPaymentMethod,
    prepaidAmount: Amount.default('0.00'),
  })
  .refine((body) => (body.paymentMethod === 'cod') === (Number(body.prepaidAmount) === 0), {
    message: 'Cash on delivery has no prepayment, and any other method is a prepayment',
    path: ['prepaidAmount'],
  })
  .refine((body) => body.relatedOrder?.relation !== 'goodwill_for', {
    message: 'A goodwill link belongs to a gifted order',
    path: ['relatedOrder'],
  });
/** The validated shape of `CreateManualOrderBody`. */
export type CreateManualOrderBody = z.infer<typeof CreateManualOrderBody>;

/**
 * `POST /api/orders/gifted` (`orders.gift`, AC-2): every line keeps its retail price with an
 * equal discount, shipping is 0, payment is `none`. `replacement_goodwill` needs the order it
 * makes good as a `goodwill_for` link, and only it takes one.
 */
export const CreateGiftedOrderBody = z
  .strictObject({
    ...orderBase,
    shippingChargedAmount: Amount.default('0.00'),
    giftReasonCode: GiftReasonCode,
  })
  .refine(
    (body) =>
      (body.giftReasonCode === 'replacement_goodwill') ===
      (body.relatedOrder?.relation === 'goodwill_for'),
    {
      message: 'A goodwill replacement names the order it makes good, and only it does',
      path: ['relatedOrder'],
    },
  )
  .refine((body) => body.relatedOrder?.relation !== 'replacement_for', {
    message: 'A gifted order is never an exchange replacement',
    path: ['relatedOrder'],
  })
  // The retail value stays on the line: a price above 0 and a discount of exactly price times quantity.
  .refine(
    (body) =>
      body.lines.every((line) => {
        const price = Money.of(line.unitPrice);
        return (
          price.sign() > 0 &&
          Money.of(line.discountAmount).equals(price.share(BigInt(line.quantity), 1n))
        );
      }),
    {
      message: 'A gifted line keeps its retail price with a discount equal to price times quantity',
      path: ['lines'],
    },
  );
/** The validated shape of `CreateGiftedOrderBody`. */
export type CreateGiftedOrderBody = z.infer<typeof CreateGiftedOrderBody>;

/** The answer of `POST /api/orders` and `/gifted`: 201 for a new order, 200 for a repeat of the same `clientRef`. */
export const CreatedOrder = z.object({
  id: z.uuid(),
  storeCode: z.string(),
  orderNumber: z.string(),
});
/** The validated shape of `CreatedOrder`. */
export type CreatedOrder = z.infer<typeof CreatedOrder>;

/** An order with the store beside its number (AC-3): shown as `<store code>/<order number>`. */
export const OrderRef = z.object({
  id: z.uuid(),
  storeCode: z.string(),
  orderNumber: z.string(),
});
/** The validated shape of `OrderRef`. */
export type OrderRef = z.infer<typeof OrderRef>;

/** The `record_label` and toast text of an order: `<store code>/<order number>`, for example `ESS/#1001`. */
export function orderLabelOf(order: { storeCode: string; orderNumber: string }): string {
  return `${order.storeCode}/${order.orderNumber}`;
}

/** One value or a list of them, as a query string or a JSON body carries it. */
const listOf = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
    z.array(item).min(1).max(12).optional(),
  );

const flagOf = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean().optional(),
);

const limitOf = z.preprocess(
  (value) => (typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value),
  z.number().int().min(1).max(100).default(50),
);

/**
 * The order list filters (spec 0013 AC-4), the query of `GET /api/orders` and the body of
 * `POST /api/orders/search` (used whenever `q` is a phone). `q` is a phone in any form
 * `EgyptianPhone` parses, else an order number; `GET` refuses a `q` that parses as a phone.
 * `customerId` finds the orders of every id of a merged customer. `dayFrom` and `dayTo` are
 * operating days (inclusive). Pages are keyset: pass the last answer's `nextCursor`.
 */
export const OrderListQuery = z.strictObject({
  storeId: z.uuid().optional(),
  channelId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  fulfillment: listOf(FulfillmentState),
  cash: listOf(CashState),
  outcome: OrderOutcome.optional(),
  type: OrderType.optional(),
  hold: flagOf,
  short: flagOf,
  /**
   * `true`: only orders with a line awaiting restock (spec 0013 AC-27 g), the lines of an order
   * cancelled with no carrier delivery first, then oldest awaiting first; `false`: none awaiting.
   */
  awaitingRestock: flagOf,
  dayFrom: z.iso.date().optional(),
  dayTo: z.iso.date().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: limitOf,
});
/** The validated shape of `OrderListQuery`, after defaults. */
export type OrderListQuery = z.infer<typeof OrderListQuery>;

/** One row of the order list: the fixed column order of the design system, with the small flags. */
export const OrderListItem = z.object({
  id: z.uuid(),
  storeCode: z.string(),
  orderNumber: z.string(),
  placedAt: Timestamp,
  shipToName: z.string().nullable(),
  channelId: z.uuid(),
  channelName: LocalizedText,
  totalAmount: MoneyString,
  codDueAmount: MoneyString,
  fulfillmentState: FulfillmentState,
  cashState: CashState,
  outcome: OrderOutcome,
  type: OrderType,
  giftReasonCode: GiftReasonCode.nullable(),
  /** `write_back_state <> 'none'`: an edit has not reached the channel yet. */
  hold: z.boolean(),
  /** At least one open line holds less stock than it needs. */
  short: z.boolean(),
  /** Created from an earlier order (`reopened_from`). */
  reopened: z.boolean(),
  /** The main phone did not parse and needs fixing. */
  phoneNeedsFix: z.boolean(),
  /**
   * Which source asked for the stock out of the order's current generation, and when (spec 0013
   * AC-27 g: "Left stock: Shopify fulfillment, 14:05"); null while none did. Optional until the
   * web fixtures carry it; the api always sends it.
   */
  stockOutSource: StockOutSource.nullable().optional(),
  stockOutRequestedAt: Timestamp.nullable().optional(),
  /** Pieces of the order that left stock and are expected back (AC-27 g), 0 when none. */
  awaitingRestockQuantity: z.number().int().min(0).optional(),
  /** Since when the oldest of them awaits (the filter's order); null when none awaits. */
  awaitingRestockSince: Timestamp.nullable().optional(),
});
/** The validated shape of `OrderListItem`. */
export type OrderListItem = z.infer<typeof OrderListItem>;

/** The answer of the order list routes. */
export const OrderListResponse = z.object({
  items: z.array(OrderListItem),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `OrderListResponse`. */
export type OrderListResponse = z.infer<typeof OrderListResponse>;

/** One line on the order page. `unitCost` is present only for a viewer holding `cost.view`. */
export const OrderLineView = z.object({
  id: z.uuid(),
  position: z.number().int(),
  variantId: z.uuid().nullable(),
  skuCode: z.string().nullable(),
  /** The stored line text, a snapshot of the name at the time of sale. */
  title: z.string(),
  /** The SKU's name in both languages from the catalog today; null for a line with no variant. */
  name: LocalizedText.nullable(),
  quantity: z.number().int(),
  unitPrice: MoneyString,
  discountAmount: MoneyString,
  grossAmount: MoneyString,
  prepaidAmount: MoneyString,
  creditAppliedAmount: MoneyString,
  lineState: OrderLineState,
  cancelReasonCode: z.string().nullable(),
  /**
   * How many pieces of the line the stock ledger could not hold yet (AC-13, the orders copy of the
   * reservation's `unfilled_quantity`); above 0 is the page's "short" mark with the missing
   * quantity. Always 0 for a line with no variant, a line that is no longer open, and every line of
   * a cancelled order.
   */
  shortQuantity: z.number().int().min(0),
  unitCost: UnitCostString.nullable().optional(),
  /**
   * What the current stock out generation's posting takes out for the line (spec 0013 AC-27 a);
   * below `quantity` marks the rest not shipped; null while no stock out is requested. Optional
   * until the web fixtures carry it; the api always sends it.
   */
  stockOutQuantity: z.number().int().min(0).nullable().optional(),
  /** Pieces of the line that left stock and are expected back on the shelf (AC-27 b, d). */
  awaitingRestockQuantity: z.number().int().min(0).optional(),
  /** Since when they await; null when none does. */
  awaitingRestockSince: Timestamp.nullable().optional(),
});
/** The validated shape of `OrderLineView`. */
export type OrderLineView = z.infer<typeof OrderLineView>;

/** A stock out posting of an earlier generation that was reversed (spec 0013 AC-27 b, c). */
export const OrderStockOutReversalView = z.object({
  generation: z.number().int().min(1),
  /** `channel_fulfillment_cancelled` (AC-27 c) or `order_cancelled_before_pickup` (*After a cancel* row 4). */
  reasonCode: z.string(),
  reversedAt: Timestamp,
});
/** The validated shape of `OrderStockOutReversalView`. */
export type OrderStockOutReversalView = z.infer<typeof OrderStockOutReversalView>;

/**
 * The stock out block of the order page (spec 0013 AC-5, AC-27 g): the current generation, which
 * source asked for its posting and when, when the posting was booked (null while the job has not
 * run or posted nothing), and the reversals of earlier generations. The awaiting restock
 * quantities are on the lines.
 */
export const OrderStockOutView = z.object({
  generation: z.number().int().min(1),
  source: StockOutSource.nullable(),
  requestedAt: Timestamp.nullable(),
  postedAt: Timestamp.nullable(),
  reversals: z.array(OrderStockOutReversalView),
});
/** The validated shape of `OrderStockOutView`. */
export type OrderStockOutView = z.infer<typeof OrderStockOutView>;

/** One move of either state machine, with the actor's name when a person made it. */
export const OrderEventView = z.object({
  id: z.uuid(),
  machine: OrderMachine,
  fromState: z.string().nullable(),
  toState: z.string(),
  amount: MoneyString.nullable(),
  actorType: OrderActorType,
  actorName: z.string().nullable(),
  reasonCode: z.string().nullable(),
  occurredAt: Timestamp,
});
/** The validated shape of `OrderEventView`. */
export type OrderEventView = z.infer<typeof OrderEventView>;

/** The order this one links to, and how. */
export const OrderRelatedView = OrderRef.extend({
  relation: z.union([OrderRelation, z.literal('replacement_for')]),
});
/** The validated shape of `OrderRelatedView`. */
export type OrderRelatedView = z.infer<typeof OrderRelatedView>;

/** The linked customer on the order page: her name and risk flag, with the id for the customer page. */
export const OrderCustomerView = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  flagKind: CustomerRiskFlag.nullable(),
});
/** The validated shape of `OrderCustomerView`. */
export type OrderCustomerView = z.infer<typeof OrderCustomerView>;

/** The money block of the order page (AC-5). */
export const OrderMoneyView = z.object({
  linesGrossAmount: MoneyString,
  shippingChargedAmount: MoneyString,
  shippingTaxAmount: MoneyString,
  totalAmount: MoneyString,
  paymentMethod: OrderPaymentMethod,
  prepaidAmount: MoneyString,
  prepaidMethod: OrderPaymentMethod.nullable(),
  creditAppliedAmount: MoneyString,
  codExpectedAmount: MoneyString,
  codDueAmount: MoneyString,
  codCollectedAmount: MoneyString,
  remittedAmount: MoneyString,
});
/** The validated shape of `OrderMoneyView`. */
export type OrderMoneyView = z.infer<typeof OrderMoneyView>;

/** Where the parcel goes, as stored. Personal data: `orders.view` holders only. */
export const OrderShipToView = z.object({
  name: z.string().nullable(),
  phone: z.string().nullable(),
  phoneAlt: z.string().nullable(),
  /** The main phone as typed when it did not parse, until a person fixes it. */
  contactPhoneRaw: z.string().nullable(),
  address: z.string().nullable(),
  area: OrderAreaCodes.nullable(),
  courierNote: z.string().nullable(),
});
/** The validated shape of `OrderShipToView`. */
export type OrderShipToView = z.infer<typeof OrderShipToView>;

/** The campaign fields an order carries from its channel. */
export const OrderSourceView = z.object({
  capturedFrom: z.string(),
  campaignId: z.string().nullable(),
  utmSource: z.string().nullable(),
  utmMedium: z.string().nullable(),
  utmCampaign: z.string().nullable(),
  discountCode: z.string().nullable(),
});
/** The validated shape of `OrderSourceView`. */
export type OrderSourceView = z.infer<typeof OrderSourceView>;

/** Where one open write back command of the order stands (spec 0013 AC-5, AC-12). */
export const OrderWriteBackCommandView = z.object({
  id: z.uuid(),
  /** The command kind, for example `shopify.order_edit`. */
  kind: z.string(),
  syncState: z.enum(['waiting', 'failed']),
  /** A provider error code only (`STEP_OFF`), never provider text; null while waiting. */
  failureReason: z.string().nullable(),
  queuedAt: Timestamp,
});
/** The validated shape of `OrderWriteBackCommandView`. */
export type OrderWriteBackCommandView = z.infer<typeof OrderWriteBackCommandView>;

/**
 * `GET /api/orders/:id` and the answer of every order move (spec 0013 AC-5): header, links both
 * ways, ship to, note, customer, lines, money, the open write back commands, and the event
 * timeline. `updatedAt` is the optimistic concurrency token (`expectedUpdatedAt` of the moves),
 * microsecond text.
 */
export const OrderDetail = z.object({
  id: z.uuid(),
  storeId: z.uuid(),
  storeCode: z.string(),
  storeName: LocalizedText,
  channelId: z.uuid(),
  channelName: LocalizedText,
  orderNumber: z.string(),
  type: OrderType,
  giftReasonCode: GiftReasonCode.nullable(),
  relatedOrder: OrderRelatedView.nullable(),
  /**
   * The orders that link to this one (spec 0013 AC-23, the reverse link): a reopened order, a
   * replacement, or a goodwill gift made from it, oldest first. `relation` names how that order
   * relates to this one, as its own page shows it.
   */
  linkedFrom: z.array(OrderRelatedView),
  placedAt: Timestamp,
  operatingDay: z.iso.date(),
  fulfillmentState: FulfillmentState,
  cashState: CashState,
  outcome: OrderOutcome,
  writeBackState: z.enum(['none', 'waiting', 'failed']),
  confirmedAt: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  cancelReasonCode: z.string().nullable(),
  carrierDeliveryCreatedAt: Timestamp.nullable(),
  source: OrderSourceView,
  shipTo: OrderShipToView,
  customerNote: z.string().nullable(),
  customer: OrderCustomerView.nullable(),
  lines: z.array(OrderLineView),
  money: OrderMoneyView,
  /**
   * The open write back commands of the order, oldest first (AC-12: "Edit not synced, hold" with
   * each command's state and reason). The api always sends it, an empty list when none is open.
   */
  writeBackCommands: z.array(OrderWriteBackCommandView),
  /** The stock out block (AC-27 g). Optional until the web fixtures carry it; the api always sends it. */
  stockOut: OrderStockOutView.optional(),
  events: z.array(OrderEventView),
  updatedAt: z.string(),
});
/** The validated shape of `OrderDetail`. */
export type OrderDetail = z.infer<typeof OrderDetail>;

/** A store or channel choice on the new order form. */
export const OrderOptionName = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
});
/** The validated shape of `OrderOptionName`. */
export type OrderOptionName = z.infer<typeof OrderOptionName>;

/**
 * `GET /api/orders/filter-options` (`orders.view`): every store and channel that is not archived,
 * Shopify ones included, for the store and channel filters of the order list.
 */
export const OrderFilterOptions = z.object({
  stores: z.array(OrderOptionName),
  // The channel kind as the `channel_kind` enum spells it. Left a string here: the owner type
  // boundary test keeps some owner type words out of contract files.
  channels: z.array(OrderOptionName.extend({ kind: z.string().min(1) })),
});
/** The validated shape of `OrderFilterOptions`. */
export type OrderFilterOptions = z.infer<typeof OrderFilterOptions>;

/** `GET /api/orders/options` (`orders.confirm`): what the new order form offers. */
export const OrderOptions = z.object({
  stores: z.array(OrderOptionName),
  channels: z.array(OrderOptionName.extend({ kind: z.enum(['manual', 'whatsapp', 'instagram']) })),
  giftReasonCodes: z.array(GiftReasonCode),
  salesTaxRate: z.string(),
  pricesIncludeVat: z.boolean(),
});
/** The validated shape of `OrderOptions`. */
export type OrderOptions = z.infer<typeof OrderOptions>;

/**
 * The concurrency token every order move sends back (spec 0013 API surface): the `updatedAt` the
 * page showed, microsecond text in UTC (the spec 0009 pattern). A move answers 409 `ORDER_STALE`
 * when the order changed since.
 */
export const ExpectedUpdatedAt = z.iso.datetime({ offset: true });

/** The ship to fields an edit may change (AC-9); a field left out stays as it is. */
const shipToEditFields = {
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(1).max(64).optional(),
  /** Null clears the second phone. */
  phoneAlt: z.string().trim().max(64).nullable().optional(),
  address: z.string().trim().min(1).max(500).optional(),
  /** Null clears the courier note. */
  courierNote: z.string().trim().max(500).nullable().optional(),
  /** Null clears the carrier area codes. */
  area: OrderAreaCodes.nullable().optional(),
};

/** The fields of a line an edit adds (the same as a new order line). */
const editLineFields = {
  variantId: z.uuid(),
  quantity: quantityInput({ min: 1, max: 10_000 }),
  unitPrice: Amount,
  discountAmount: Amount.default('0.00'),
};

/**
 * One operation of an order edit (spec 0013 API surface), a union on `kind`: change ship to
 * fields, add a line, replace a line (the old line is cancelled with `edit_removal` and the new
 * one added at the next position: a line is never changed in place), remove a line with a reason,
 * or change the shipping charge.
 */
export const OrderEditOperation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ship_to'), ...shipToEditFields }),
  z.strictObject({ kind: z.literal('add_line'), ...editLineFields }),
  z.strictObject({ kind: z.literal('replace_line'), lineId: z.uuid(), ...editLineFields }),
  z.strictObject({
    kind: z.literal('remove_line'),
    lineId: z.uuid(),
    cancelReasonCode: LineRemovalReasonCode,
  }),
  z.strictObject({ kind: z.literal('shipping'), shippingChargedAmount: Amount }),
]);
/** The validated shape of `OrderEditOperation`. */
export type OrderEditOperation = z.infer<typeof OrderEditOperation>;

/**
 * `POST /api/orders/:id/edits` (`orders.confirm`, AC-9): one or more operations applied in one
 * transaction. A `ship_to` operation names at least one field, and a line is named by at most one
 * replace or remove. Answers the order page (`OrderDetail`).
 */
export const OrderEditBody = z
  .strictObject({
    expectedUpdatedAt: ExpectedUpdatedAt,
    reasonCode: EditReasonCode.optional(),
    operations: z.array(OrderEditOperation).min(1).max(50),
  })
  .superRefine((body, context) => {
    const named = new Set<string>();
    body.operations.forEach((operation, index) => {
      if (operation.kind === 'ship_to' && Object.keys(operation).length === 1) {
        context.addIssue({
          code: 'custom',
          message: 'A ship to change names at least one field',
          path: ['operations', index],
        });
      }
      if (operation.kind === 'replace_line' || operation.kind === 'remove_line') {
        if (named.has(operation.lineId)) {
          context.addIssue({
            code: 'custom',
            message: 'A line is replaced or removed once per edit',
            path: ['operations', index, 'lineId'],
          });
        }
        named.add(operation.lineId);
      }
    });
  });
/** The validated shape of `OrderEditBody`. */
export type OrderEditBody = z.infer<typeof OrderEditBody>;

/**
 * `POST /api/orders/:id/confirm`, `/pack`, and `/unpack` (AC-7): only the concurrency token.
 * Each answers the order page.
 */
export const OrderMoveBody = z.strictObject({ expectedUpdatedAt: ExpectedUpdatedAt });
/** The validated shape of `OrderMoveBody`. */
export type OrderMoveBody = z.infer<typeof OrderMoveBody>;

/**
 * `POST /api/orders/:id/cancel` (`orders.confirm`, AC-7): the cancel reason, and for `duplicate`
 * the order it duplicates (422 `DUPLICATE_TARGET_REQUIRED` without one); no other reason takes a
 * target. Answers the order page.
 */
export const CancelOrderBody = z
  .strictObject({
    expectedUpdatedAt: ExpectedUpdatedAt,
    reasonCode: CancelReasonCode,
    duplicateOfOrderId: z.uuid().nullable().optional(),
  })
  .refine((body) => body.reasonCode === 'duplicate' || !body.duplicateOfOrderId, {
    message: 'Only a duplicate names the order it duplicates',
    path: ['duplicateOfOrderId'],
  });
/** The validated shape of `CancelOrderBody`. */
export type CancelOrderBody = z.infer<typeof CancelOrderBody>;

// ---------------------------------------------------------------------------------------------
// Channel intake (spec 0013 AC-14, AC-23, AC-25, Write paths): the shapes feature 13 builds for
// the in process calls `OrderIntake.createFromChannel` and `applyChannelEdit`. Not routes.
// ---------------------------------------------------------------------------------------------

/** Where an order's campaign was captured. Matches the `order_source_captured_from` enum. */
export const OrderSourceCapturedFrom = z.enum([
  'landing_page',
  'shopify_journey',
  'whatsapp_thread',
  'manual',
  'none',
]);
/** One capture source. */
export type OrderSourceCapturedFrom = z.infer<typeof OrderSourceCapturedFrom>;

const SourceText = z.string().trim().min(1).max(500).nullable().default(null);

/** A tax rate in percent, 0 to 100 (`numeric(5,2)` would hold up to 999.99; security L2). */
const ChannelTaxRate = TaxRateString.refine((rate) => Number(rate) <= 100, {
  message: 'A tax rate is at most 100',
});

/**
 * The campaign fields of spec 0002 an order carries from its channel (`orders.source_*`). Every
 * field defaults to null and `capturedFrom` to `none`, so a channel that knows nothing sends `{}`.
 */
export const OrderSourceInput = z.strictObject({
  capturedFrom: OrderSourceCapturedFrom.default('none'),
  campaignId: SourceText,
  adsetId: SourceText,
  adId: SourceText,
  utmSource: SourceText,
  utmMedium: SourceText,
  utmCampaign: SourceText,
  utmContent: SourceText,
  landingPage: SourceText,
  referrer: SourceText,
  /**
   * The staff user who bought the ad, when the channel knows her. The api stores null for a
   * channel order until it can check the id inside the order transaction (review minor 6).
   */
  mediaBuyerId: z.uuid().nullable().default(null),
  influencerCode: SourceText,
});
/** The validated shape of `OrderSourceInput`. */
export type OrderSourceInput = z.infer<typeof OrderSourceInput>;

/**
 * The channel's own id of the customer (spec 0014's `channelCustomer`): a Shopify customer id
 * issued by one connection. Null when the order has none (a guest checkout).
 */
export const ChannelCustomerInput = z.strictObject({
  kind: z.literal('shopify_customer'),
  connectionId: z.uuid(),
  externalId: z.string().trim().min(1).max(255),
});
/** The validated shape of `ChannelCustomerInput`. */
export type ChannelCustomerInput = z.infer<typeof ChannelCustomerInput>;

/**
 * Where the parcel goes, as the channel sends it. Phones are text and are parsed by the api with
 * `EgyptianPhone`: a main phone that does not parse is kept as typed in `contact_phone_raw` and
 * leaves the order unlinked; a second phone that does not parse is not stored (the api raises
 * `phone_unparseable`). Null means the channel sent nothing; on an edit the stored value is kept.
 * `area` is sent only when the channel knows the carrier codes; absent or null keeps the stored
 * codes. Personal data: never echoed in an error or a log line.
 */
export const ChannelShipToInput = z.strictObject({
  name: z.string().trim().min(1).max(200).nullable(),
  phone: z.string().trim().max(64).nullable(),
  phoneAlt: z.string().trim().max(64).nullable().default(null),
  address: z.string().trim().min(1).max(500).nullable(),
  courierNote: z.string().trim().max(500).nullable().default(null),
  area: OrderAreaCodes.nullable().optional(),
});
/** The validated shape of `ChannelShipToInput`. */
export type ChannelShipToInput = z.infer<typeof ChannelShipToInput>;

/**
 * One line as the channel sends it, already netted (spec 0015 AC-9). `variantId` is null while
 * the channel's product is not mapped to a SKU (`linkChannelLineVariant` maps it later); `title`
 * is the channel's line text, stored on the line. `taxRate` is the line's own rate.
 */
export const ChannelOrderLineInput = z.strictObject({
  channelLineId: z.string().trim().min(1).max(255),
  variantId: z.uuid().nullable(),
  title: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(10_000),
  unitPrice: PriceString,
  discountAmount: PriceString.default('0.00'),
  taxRate: ChannelTaxRate,
});
/** The validated shape of `ChannelOrderLineInput`. */
export type ChannelOrderLineInput = z.infer<typeof ChannelOrderLineInput>;

/**
 * The go live first state (AC-25 a): only a `system_job` actor may send it, for an order placed
 * before the store's go live moment. The order starts `confirmed` with one event of reason
 * `go_live_import`.
 */
export const GoLiveFirstStates = z.strictObject({
  fulfillment: z.literal('confirmed'),
  reasonCode: z.literal('go_live_import'),
});
/** The validated shape of `GoLiveFirstStates`. */
export type GoLiveFirstStates = z.infer<typeof GoLiveFirstStates>;

/**
 * The states an `import` actor found the order in (AC-14, spec 0015 go live for closed orders):
 * both machines' first states and when the carrier delivery was made. A `cancelled` order names
 * its cancel reason and a `refused` one its refusal reason, as the order table requires.
 */
export const ImportFirstStates = z
  .strictObject({
    fulfillment: FulfillmentState,
    cash: CashState,
    carrierDeliveryCreatedAt: Timestamp.nullable().default(null),
    cancelReasonCode: ReasonCode.optional(),
    refusedReasonCode: RefusedReasonCode.optional(),
  })
  .refine((states) => (states.fulfillment === 'cancelled') === !!states.cancelReasonCode, {
    message: 'A cancelled order names its cancel reason, and only it does',
    path: ['cancelReasonCode'],
  })
  .refine((states) => (states.fulfillment === 'refused') === !!states.refusedReasonCode, {
    message: 'A refused order names its refusal reason, and only it does',
    path: ['refusedReasonCode'],
  });
/** The validated shape of `ImportFirstStates`. */
export type ImportFirstStates = z.infer<typeof ImportFirstStates>;

/** The fields an order and every later snapshot of it share. */
const channelOrderFields = {
  type: z.enum(['sale', 'gifted']),
  giftReasonCode: GiftReasonCode.nullable().default(null),
  paymentMethod: OrderPaymentMethod,
  shippingChargedAmount: PriceString,
  /**
   * The tax rate of the shipping charge as the channel's shipping tax lines give it (spec 0013
   * Follow-up, review m8); null falls back to the `sales_tax_rate` setting.
   */
  shippingTaxRate: ChannelTaxRate.nullable().default(null),
  discountCode: z.string().trim().min(1).max(255).nullable().default(null),
  /** The note the customer typed at checkout; on a snapshot, null keeps the stored note. */
  customerNote: z.string().trim().max(2000).nullable().default(null),
  channelCustomer: ChannelCustomerInput.nullable(),
  source: OrderSourceInput.default(() => OrderSourceInput.parse({})),
  shipTo: ChannelShipToInput,
  lines: z.array(ChannelOrderLineInput).min(1).max(250),
};

/** What the shared refinements read of an order or a snapshot. */
interface ChannelOrderShape {
  type: 'sale' | 'gifted';
  giftReasonCode: string | null;
  lines: readonly { channelLineId: string }[];
}

const giftedHasReason = (order: ChannelOrderShape): boolean =>
  (order.type === 'gifted') === (order.giftReasonCode !== null);

const lineIdsUnique = (order: ChannelOrderShape): boolean =>
  new Set(order.lines.map((line) => line.channelLineId)).size === order.lines.length;

/**
 * What feature 13 (and later 15 and 53) hands `OrderIntake.createFromChannel` (spec 0013, Write
 * paths): the channel's identity of the order (store, channel, its own id, its number, its
 * creation time), the payment as the channel's gateway mapping reads it (a deposit is stored as
 * it arrives), and the netted lines. `firstStates` is only for the go live import of a
 * `system_job` actor or the found states of an `import` actor; the api refuses it from any other
 * actor (`InvalidOrderInput`). Personal data (ship to, note) is never echoed in an error.
 */
export const ChannelOrderInput = z
  .strictObject({
    storeId: z.uuid(),
    channelId: z.uuid(),
    /** The channel's own id of the order (the Shopify order id): the idempotency key per store. */
    channelOrderRef: z.string().trim().min(1).max(255),
    /** The channel's order name, for example `#1001`: unique per store. */
    orderNumber: z.string().trim().min(1).max(64),
    placedAt: Timestamp,
    relatedOrder: RelatedOrderInput.nullable().default(null),
    prepaidAmount: PriceString.default('0.00'),
    prepaidMethod: OrderPaymentMethod.nullable().default(null),
    firstStates: z.union([GoLiveFirstStates, ImportFirstStates]).nullable().default(null),
    ...channelOrderFields,
  })
  .refine(giftedHasReason, {
    message: 'A gifted order names its gift reason, and only it does',
    path: ['giftReasonCode'],
  })
  .refine((order) => Money.of(order.prepaidAmount).isZero() === (order.prepaidMethod === null), {
    message: 'A prepayment names its method, and only a prepayment does',
    path: ['prepaidMethod'],
  })
  .refine(lineIdsUnique, { message: 'Each channel line id appears once', path: ['lines'] });
/** The validated shape of `ChannelOrderInput`. */
export type ChannelOrderInput = z.infer<typeof ChannelOrderInput>;

/**
 * What feature 13 hands `OrderIntake.applyChannelEdit`: the order as the channel holds it now,
 * already netted, without its identity fields and without `prepaidAmount`, `prepaidMethod`,
 * `relatedOrder`, and `firstStates` (a snapshot never changes them, review M5). Lines are matched
 * by `channelLineId`.
 */
export const ChannelOrderSnapshot = z
  .strictObject(channelOrderFields)
  .refine(giftedHasReason, {
    message: 'A gifted order names its gift reason, and only it does',
    path: ['giftReasonCode'],
  })
  .refine(lineIdsUnique, { message: 'Each channel line id appears once', path: ['lines'] });
/** The validated shape of `ChannelOrderSnapshot`. */
export type ChannelOrderSnapshot = z.infer<typeof ChannelOrderSnapshot>;

/**
 * What `OrderIntake.rederivePaymentMethod` takes (AC-25 c): the payment as a corrected gateway
 * mapping reads it. A prepayment names its method, and only a prepayment does.
 */
export const RederivePaymentMethodInput = z
  .strictObject({
    paymentMethod: OrderPaymentMethod,
    prepaidAmount: PriceString,
    prepaidMethod: OrderPaymentMethod.nullable(),
  })
  .refine((input) => Money.of(input.prepaidAmount).isZero() === (input.prepaidMethod === null), {
    message: 'A prepayment names its method, and only a prepayment does',
    path: ['prepaidMethod'],
  });
/** The validated shape of `RederivePaymentMethodInput`. */
export type RederivePaymentMethodInput = z.infer<typeof RederivePaymentMethodInput>;

/**
 * `POST /api/orders/hold-open-orders` (`catalog.manage`, AC-26): the location that is about to
 * feed online stock. Every open line with a variant of an order in `new`, `confirmed`, or `packed`
 * that holds no active reservation there is reserved there, oldest order first.
 */
export const HoldOpenOrdersBody = z.strictObject({ locationId: z.uuid() });
/** The validated shape of `HoldOpenOrdersBody`. */
export type HoldOpenOrdersBody = z.infer<typeof HoldOpenOrdersBody>;

/**
 * The answer of `POST /api/orders/hold-open-orders` (AC-26): `linesHeld` lines now held in full at
 * the location, `linesShort` lines reserved there but short (waiting for stock), and `linesLeft`
 * lines that still hold no reservation there after the call (an order changed meanwhile; 0 when
 * the `orders.open_orders_held` check now passes). A repeat holds nothing twice and answers zeros
 * for the first two.
 */
export const HoldOpenOrdersResult = z.strictObject({
  linesHeld: z.number().int().min(0),
  linesShort: z.number().int().min(0),
  linesLeft: z.number().int().min(0),
});
/** The validated shape of `HoldOpenOrdersResult`. */
export type HoldOpenOrdersResult = z.infer<typeof HoldOpenOrdersResult>;

/**
 * `POST /api/orders/:id/lines/:lineId/restock` (`stock.receive`, spec 0013 AC-27 e, "Received on
 * the shelf"): how many of the line's awaiting pieces are back on the shelf, with an
 * `Idempotency-Key` uuid header (a repeat of the key moves nothing). Answers the order page.
 */
export const RestockAwaitingBody = z.strictObject({
  quantity: quantityInput({ min: 1, max: 10_000 }),
});
/** The validated shape of `RestockAwaitingBody`. */
export type RestockAwaitingBody = z.infer<typeof RestockAwaitingBody>;

/**
 * `POST /api/orders/:id/lines/:lineId/close-awaiting-restock` (spec 0013 AC-27 f): closes pieces
 * that never come back with a reason (`stock.correct`), or, from a warehouse hat holding only
 * `stock.receive`, asks a manager to close them. Posts no movement. Answers the order page.
 */
export const CloseAwaitingRestockBody = z.strictObject({
  expectedUpdatedAt: ExpectedUpdatedAt,
  quantity: quantityInput({ min: 1, max: 10_000 }),
  reasonCode: AwaitingRestockCloseReason,
});
/** The validated shape of `CloseAwaitingRestockBody`. */
export type CloseAwaitingRestockBody = z.infer<typeof CloseAwaitingRestockBody>;

/**
 * `POST /api/orders/:id/post-channel-fulfillment` (`stock.correct`, spec 0013 AC-27 a, "Post what
 * Shopify fulfilled"): requests the stock out of exactly the quantities Shopify fulfilled and
 * releases the reservations of the rest. Answers the order page.
 */
export const PostChannelFulfillmentBody = z.strictObject({
  expectedUpdatedAt: ExpectedUpdatedAt,
  reasonCode: ChannelFulfillmentPostReason,
});
/** The validated shape of `PostChannelFulfillmentBody`. */
export type PostChannelFulfillmentBody = z.infer<typeof PostChannelFulfillmentBody>;
