import { z } from 'zod';
import { PriceString } from '../catalog.js';
import { CustomerRiskFlag } from '../customers/customer-enums.js';
import { moneyInput, quantityInput } from '../digit-input.js';
import { LocalizedText } from '../localized-text.js';
import { Money, MoneyString, UnitCostString } from '../money.js';
import { OrderOutcome } from './order-outcome.js';
import { GiftReasonCode, OrderRelation, OrderType, RelatedOrderRelation } from './order-reasons.js';
import {
  CashState,
  FulfillmentState,
  OrderActorType,
  OrderLineState,
  OrderMachine,
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
  /** The quantity the line is short of its reservation; 0 until stock holds arrive (milestone 4). */
  shortQuantity: z.number().int(),
  unitCost: UnitCostString.nullable().optional(),
});
/** The validated shape of `OrderLineView`. */
export type OrderLineView = z.infer<typeof OrderLineView>;

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

/**
 * `GET /api/orders/:id` and the answer of every order move (spec 0013 AC-5): header, links both
 * ways, ship to, note, customer, lines, money, and the event timeline. `updatedAt` is the optimistic
 * concurrency token (`expectedUpdatedAt` of the moves of milestone 2), microsecond text. The
 * write back commands block arrives with milestone 2.
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
