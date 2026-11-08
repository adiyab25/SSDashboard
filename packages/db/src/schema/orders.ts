import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { productVariants } from './catalog.js';
import { channels, stores } from './channels.js';
import {
  createdAt,
  id,
  money,
  reasonCodeShape,
  taxRate,
  tenantId,
  unitCost,
  updatedAt,
} from './columns.js';
import { customers } from './customers.js';

// The orders module (spec 0002, orders child): an order with two state machines (the parcel and
// the money), its lines, and the append only event history of every move. Only the orders module
// writes these tables; `order_events` is append only (trigger and revoke in the rules migration),
// and `operating_day` on `orders` and `order_events` is stamped by trigger, never passed.

// The E.164 pattern of `customer_phones.phone_e164`.
const e164Shape = (column: AnyPgColumn): SQL =>
  sql`${column} IS NULL OR ${column} ~ '^\\+[1-9][0-9]{7,14}$'`;

// A state stored as text is a value of its machine's enum. `pg_input_is_valid` reads the enum
// itself, so a value added to the enum is accepted here without touching this check. The type is
// named with its schema, so a temp type of the same name cannot stand in for it.
const stateOfMachine = (machine: AnyPgColumn, state: AnyPgColumn): SQL =>
  sql`CASE ${machine}
        WHEN 'fulfillment' THEN pg_input_is_valid(${state}, 'public.order_fulfillment_state')
        WHEN 'cash' THEN pg_input_is_valid(${state}, 'public.order_cash_state')
      END`;

/** A sale, the replacement of an exchange, or a gift (total 0). */
export const orderType = pgEnum('order_type', ['sale', 'exchange_replacement', 'gifted']);

/** How an order relates to `related_order_id`: a duplicate of it, reopened from it, or a gifted goodwill replacement making it good. */
export const orderRelation = pgEnum('order_relation', [
  'duplicate_of',
  'reopened_from',
  'goodwill_for',
]);

/** The parcel's state machine; the allowed moves live in `packages/contracts/src/orders/order-states.ts`. */
export const orderFulfillmentState = pgEnum('order_fulfillment_state', [
  'new',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'partially_delivered',
  'failed_attempt',
  'returned_to_origin',
  'exchanged',
  'refused',
  'cancelled',
  'lost',
]);

/** The money's state machine; the allowed moves live in `packages/contracts/src/orders/order-states.ts`. */
export const orderCashState = pgEnum('order_cash_state', [
  'unpaid',
  'collected_by_carrier',
  'remitted',
  'reconciled',
  'prepaid',
  'nothing_to_collect',
]);

/** The derived outcome, written only from `deriveOrderOutcome`. */
export const orderOutcome = pgEnum('order_outcome', [
  'open',
  'kept',
  'cancelled_before_shipping',
  'failed_delivery',
  'refunded',
  'partially_refunded',
]);

/** The orders module's projection of an order's open outbound commands. */
export const orderWriteBackState = pgEnum('order_write_back_state', ['none', 'waiting', 'failed']);

/** How an order is paid, and the tender of a prepayment. */
export const orderPaymentMethod = pgEnum('order_payment_method', [
  'cod',
  'gateway',
  'instapay',
  'bank_transfer',
  'wallet',
  'none',
]);

/** Where the order's source (campaign, ad, UTM) was captured. */
export const orderSourceCapturedFrom = pgEnum('order_source_captured_from', [
  'landing_page',
  'shopify_journey',
  'whatsapp_thread',
  'manual',
  'none',
]);

/**
 * A customer order in one store, arriving on one channel. The number is unique per store. Money
 * is EGP and VAT inclusive; `cod_expected_amount` is what the courier was told to collect and
 * `cod_due_amount` what the customer owes for what she kept. The ship to columns, the phones, and
 * the courier note are personal data, never logged.
 */
export const orders = pgTable(
  'orders',
  {
    id: id(),
    tenantId: tenantId(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    orderNumber: text('order_number').notNull(),
    type: orderType('type').notNull().default('sale'),
    originalOrderId: uuid('original_order_id'),
    /** The exchange that created a replacement; its foreign key arrives with feature 34. */
    exchangeId: uuid('exchange_id'),
    relatedOrderId: uuid('related_order_id'),
    relatedOrderRelation: orderRelation('related_order_relation'),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    /** The brand's Cairo day of `placedAt`, stamped by trigger `ssd_stamp_operating_day`; never passed by a writer. */
    operatingDay: date('operating_day').notNull(),
    fulfillmentState: orderFulfillmentState('fulfillment_state').notNull(),
    cashState: orderCashState('cash_state').notNull(),
    outcome: orderOutcome('outcome').notNull(),
    writeBackState: orderWriteBackState('write_back_state').notNull().default('none'),
    linesGrossAmount: money('lines_gross_amount').notNull().default('0'),
    shippingChargedAmount: money('shipping_charged_amount').notNull().default('0'),
    shippingTaxAmount: money('shipping_tax_amount').notNull().default('0'),
    totalAmount: money('total_amount').notNull().default('0'),
    prepaidAmount: money('prepaid_amount').notNull().default('0'),
    creditAppliedAmount: money('credit_applied_amount').notNull().default('0'),
    shippingPrepaidAmount: money('shipping_prepaid_amount').notNull().default('0'),
    shippingCreditAppliedAmount: money('shipping_credit_applied_amount').notNull().default('0'),
    codExpectedAmount: money('cod_expected_amount').notNull().default('0'),
    codDueAmount: money('cod_due_amount').notNull().default('0'),
    codCollectedAmount: money('cod_collected_amount').notNull().default('0'),
    remittedAmount: money('remitted_amount').notNull().default('0'),
    deliveredAmount: money('delivered_amount').notNull().default('0'),
    returnedCreditAmount: money('returned_credit_amount').notNull().default('0'),
    exchangeConsumedAmount: money('exchange_consumed_amount').notNull().default('0'),
    paymentMethod: orderPaymentMethod('payment_method').notNull(),
    /** The tender of the prepaid part (`prepaidAmount`); set exactly when `prepaidAmount > 0`, null otherwise. */
    prepaidMethod: orderPaymentMethod('prepaid_method'),
    sourceCapturedFrom: orderSourceCapturedFrom('source_captured_from').notNull().default('none'),
    sourceCampaignId: text('source_campaign_id'),
    sourceAdsetId: text('source_adset_id'),
    sourceAdId: text('source_ad_id'),
    sourceUtmSource: text('source_utm_source'),
    sourceUtmMedium: text('source_utm_medium'),
    sourceUtmCampaign: text('source_utm_campaign'),
    sourceUtmContent: text('source_utm_content'),
    sourceLandingPage: text('source_landing_page'),
    sourceReferrer: text('source_referrer'),
    /** The code the customer used, as the channel reports it (the first one when several). */
    discountCode: text('discount_code'),
    sourceMediaBuyerId: uuid('source_media_buyer_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    sourceInfluencerCode: text('source_influencer_code'),
    shipToName: text('ship_to_name'),
    /** Normalized E.164. */
    shipToPhone: text('ship_to_phone'),
    /** The second number COD forms carry, normalized. */
    shipToPhoneAlt: text('ship_to_phone_alt'),
    /** The phone as received when it does not parse; cleared when a person fixes it. */
    contactPhoneRaw: text('contact_phone_raw'),
    shipToAddress: text('ship_to_address'),
    /** Whose geography the next three codes come from, for example `bosta`. */
    shipToAreaList: text('ship_to_area_list'),
    shipToGovernorateCode: text('ship_to_governorate_code'),
    shipToCityCode: text('ship_to_city_code'),
    shipToZoneCode: text('ship_to_zone_code'),
    courierNote: text('courier_note'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'restrict' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReasonCode: text('cancel_reason_code'),
    refusedReasonCode: text('refused_reason_code'),
    /** Set by the first carrier fact about the order; edits, `cod_expected_amount`, and the allocation freeze here. */
    carrierDeliveryCreatedAt: timestamp('carrier_delivery_created_at', { withTimezone: true }),
    giftReasonCode: text('gift_reason_code'),
    /**
     * The channel's own id of the order (a Shopify order id, or the manual form's `clientRef`):
     * the idempotency key of intake, unique per store when set.
     */
    channelOrderRef: text('channel_order_ref'),
    /** The note the customer typed at checkout. Personal data, never logged. */
    customerNote: text('customer_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('orders_store_number_unique').on(t.tenantId, t.storeId, t.orderNumber),
    foreignKey({ columns: [t.originalOrderId], foreignColumns: [t.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.relatedOrderId], foreignColumns: [t.id] }).onDelete('restrict'),
    check(
      'orders_replacement_has_original',
      sql`(${t.type} = 'exchange_replacement') = (${t.originalOrderId} IS NOT NULL)`,
    ),
    check(
      'orders_related_order_pair',
      sql`(${t.relatedOrderId} IS NULL) = (${t.relatedOrderRelation} IS NULL)`,
    ),
    // A gift costs the customer nothing: no line gross, no shipping charge, a total of 0, and a reason.
    check(
      'orders_gifted_total_zero',
      sql`${t.type} <> 'gifted' OR (${t.totalAmount} = 0 AND ${t.linesGrossAmount} = 0 AND ${t.shippingChargedAmount} = 0 AND ${t.giftReasonCode} IS NOT NULL)`,
    ),
    check(
      'orders_amounts_not_negative',
      sql`${t.linesGrossAmount} >= 0 AND ${t.shippingChargedAmount} >= 0 AND ${t.shippingTaxAmount} >= 0
        AND ${t.totalAmount} >= 0 AND ${t.prepaidAmount} >= 0 AND ${t.creditAppliedAmount} >= 0
        AND ${t.shippingPrepaidAmount} >= 0 AND ${t.shippingCreditAppliedAmount} >= 0
        AND ${t.codExpectedAmount} >= 0 AND ${t.codDueAmount} >= 0 AND ${t.codCollectedAmount} >= 0
        AND ${t.remittedAmount} >= 0 AND ${t.deliveredAmount} >= 0
        AND ${t.returnedCreditAmount} >= 0 AND ${t.exchangeConsumedAmount} >= 0`,
    ),
    check(
      'orders_cod_expected',
      sql`${t.codExpectedAmount} = ${t.totalAmount} - ${t.prepaidAmount} - ${t.creditAppliedAmount}`,
    ),
    check(
      'orders_shipping_shares_within_charge',
      sql`${t.shippingPrepaidAmount} + ${t.shippingCreditAppliedAmount} <= ${t.shippingChargedAmount}`,
    ),
    check(
      'orders_refused_has_reason',
      sql`${t.fulfillmentState} <> 'refused' OR ${t.refusedReasonCode} IS NOT NULL`,
    ),
    check(
      'orders_prepaid_method_when_prepaid',
      sql`(${t.prepaidAmount} = 0) = (${t.prepaidMethod} IS NULL)`,
    ),
    check(
      'orders_total_is_lines_plus_shipping',
      sql`${t.totalAmount} = ${t.linesGrossAmount} + ${t.shippingChargedAmount}`,
    ),
    check('orders_ship_to_phone_e164', e164Shape(t.shipToPhone)),
    check('orders_ship_to_phone_alt_e164', e164Shape(t.shipToPhoneAlt)),
    check(
      'orders_contact_phone_raw_length',
      sql`${t.contactPhoneRaw} IS NULL OR length(${t.contactPhoneRaw}) <= 64`,
    ),
    check(
      'orders_cancelled_has_reason',
      sql`${t.fulfillmentState} <> 'cancelled' OR ${t.cancelReasonCode} IS NOT NULL`,
    ),
    // Feature 19 maps an unknown carrier reason to `other`.
    check(
      'orders_refused_reason_known',
      sql`${t.refusedReasonCode} IS NULL OR ${t.refusedReasonCode} IN ('size', 'changed_mind', 'price', 'not_ordered', 'damaged', 'other')`,
    ),
    check(
      'orders_channel_order_ref_length',
      sql`${t.channelOrderRef} IS NULL OR length(${t.channelOrderRef}) <= 255`,
    ),
    check(
      'orders_customer_note_length',
      sql`${t.customerNote} IS NULL OR length(${t.customerNote}) <= 2000`,
    ),
    check('orders_cancel_reason_code_shape', reasonCodeShape(t.cancelReasonCode)),
    check('orders_refused_reason_code_shape', reasonCodeShape(t.refusedReasonCode)),
    check('orders_gift_reason_code_shape', reasonCodeShape(t.giftReasonCode)),
    // A store's order list, newest first.
    index('orders_store_placed_idx').on(
      t.storeId,
      t.placedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // One order per channel id per store (the idempotency key of intake).
    uniqueIndex('orders_store_channel_ref_unique')
      .on(t.tenantId, t.storeId, t.channelOrderRef)
      .where(sql`${t.channelOrderRef} IS NOT NULL`),
    // The all stores list, newest first (the store index above leads with `store_id`).
    index('orders_placed_idx').on(t.placedAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    // The fulfillment state filter, rare states included.
    index('orders_fulfillment_placed_idx').on(
      t.fulfillmentState,
      t.placedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // The search box across stores (the unique key leads with `store_id`).
    index('orders_order_number_idx').on(t.orderNumber),
    index('orders_ship_to_phone_idx')
      .on(t.shipToPhone)
      .where(sql`${t.shipToPhone} IS NOT NULL`),
    index('orders_ship_to_phone_alt_idx')
      .on(t.shipToPhoneAlt)
      .where(sql`${t.shipToPhoneAlt} IS NOT NULL`),
    // The confirmation queue, oldest first.
    index('orders_confirmation_queue_idx')
      .on(t.placedAt, t.id)
      .where(sql`${t.fulfillmentState} = 'new'`),
    index('orders_customer_idx').on(t.customerId),
    index('orders_operating_day_store_idx').on(t.operatingDay, t.storeId),
    index('orders_original_order_idx').on(t.originalOrderId),
    index('orders_related_order_idx').on(t.relatedOrderId),
    index('orders_open_cash_idx')
      .on(t.cashState)
      .where(sql`${t.cashState} NOT IN ('reconciled', 'nothing_to_collect')`),
    index('orders_write_back_idx')
      .on(t.writeBackState)
      .where(sql`${t.writeBackState} <> 'none'`),
    index('orders_discount_code_idx')
      .on(t.discountCode)
      .where(sql`${t.discountCode} IS NOT NULL`),
    index('orders_channel_idx').on(t.channelId),
    index('orders_source_media_buyer_idx').on(t.sourceMediaBuyerId),
    index('orders_confirmed_by_idx').on(t.confirmedBy),
  ],
);

/** Where one order line stands. `lost` is a parcel the carrier lost; `returned` came back after delivery. */
export const orderLineState = pgEnum('order_line_state', [
  'open',
  'cancelled',
  'delivered',
  'returned_to_origin',
  'returned',
  'lost',
]);

/**
 * One line of an order, VAT inclusive (`gross = net + tax`). `prepaidAmount` and
 * `creditAppliedAmount` are the line's share of the order's prepayment and credit. A partial
 * delivery splits a line into two rows (`splitFromLineId`) that always sum to the original. A line
 * is never edited to another variant: it is cancelled (`edit_removal`) and a new one added.
 */
export const orderLines = pgTable(
  'order_lines',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    /** Null only while an imported line is not mapped to a SKU. */
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'restrict' }),
    /** The channel's line text, kept for unmapped lines and history. */
    title: text('title').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    discountAmount: money('discount_amount').notNull().default('0'),
    netAmount: money('net_amount').notNull(),
    taxRate: taxRate('tax_rate').notNull(),
    taxAmount: money('tax_amount').notNull(),
    grossAmount: money('gross_amount').notNull(),
    prepaidAmount: money('prepaid_amount').notNull().default('0'),
    creditAppliedAmount: money('credit_applied_amount').notNull().default('0'),
    /** Frozen from the shipment's ledger movement; null until shipped. */
    unitCost: unitCost('unit_cost'),
    lineState: orderLineState('line_state').notNull().default('open'),
    /** Set exactly when the line is cancelled: `edit_removal`, `customer_cancelled`, `out_of_stock`, `duplicate`. */
    cancelReasonCode: text('cancel_reason_code'),
    splitFromLineId: uuid('split_from_line_id'),
    /** The channel's own line id. */
    channelLineId: text('channel_line_id'),
    /** The orders module's copy of the line's unfilled reservation quantity; 0 once the line leaves `open`. */
    shortQuantity: integer('short_quantity').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('order_lines_order_position_unique').on(t.tenantId, t.orderId, t.position),
    foreignKey({ columns: [t.splitFromLineId], foreignColumns: [t.id] }).onDelete('restrict'),
    // The target of composite keys that keep a line on its own order (credit entries, match rows).
    unique('order_lines_id_order_unique').on(t.id, t.orderId),
    index('order_lines_order_idx').on(t.orderId),
    index('order_lines_variant_idx').on(t.variantId),
    index('order_lines_split_from_idx').on(t.splitFromLineId),
    // The "short" list filter and flag.
    index('order_lines_short_idx')
      .on(t.orderId)
      .where(sql`${t.shortQuantity} > 0`),
    check(
      'order_lines_short_within_quantity',
      sql`${t.shortQuantity} >= 0 AND ${t.shortQuantity} <= ${t.quantity}`,
    ),
    check('order_lines_quantity_positive', sql`${t.quantity} > 0`),
    check(
      'order_lines_amounts_not_negative',
      sql`${t.unitPrice} >= 0 AND ${t.discountAmount} >= 0 AND ${t.netAmount} >= 0
        AND ${t.taxRate} >= 0 AND ${t.taxAmount} >= 0 AND ${t.grossAmount} >= 0
        AND ${t.prepaidAmount} >= 0 AND ${t.creditAppliedAmount} >= 0
        AND (${t.unitCost} IS NULL OR ${t.unitCost} >= 0)`,
    ),
    check(
      'order_lines_gross_is_net_plus_tax',
      sql`${t.grossAmount} = ${t.netAmount} + ${t.taxAmount}`,
    ),
    check(
      'order_lines_shares_within_gross',
      sql`${t.prepaidAmount} + ${t.creditAppliedAmount} <= ${t.grossAmount}`,
    ),
    check(
      'order_lines_cancel_reason_when_cancelled',
      sql`(${t.lineState} = 'cancelled') = (${t.cancelReasonCode} IS NOT NULL)`,
    ),
    check('order_lines_cancel_reason_code_shape', reasonCodeShape(t.cancelReasonCode)),
  ],
);

/** Which state machine an order event moves. */
export const orderMachine = pgEnum('order_machine', ['fulfillment', 'cash']);

/** Who moved an order: a person, the carrier, a system job, or an import. */
export const orderActorType = pgEnum('order_actor_type', [
  'person',
  'carrier',
  'system_job',
  'import',
]);

/**
 * Every move of either state machine, one row per move. Append only: a correction is a later
 * event. Replaying an order's events rebuilds both of its states.
 */
export const orderEvents = pgTable(
  'order_events',
  {
    id: id(),
    tenantId: tenantId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    machine: orderMachine('machine').notNull(),
    /** Null for an order's first event. */
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    /** Cash events: the amount the event records. */
    amount: money('amount'),
    actorType: orderActorType('actor_type').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    reasonCode: text('reason_code'),
    /** The carrier event, settlement match, or exchange that caused the move. */
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    /** The carrier's event time, or now. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /** The brand's Cairo day of `occurredAt`, stamped by trigger `ssd_stamp_operating_day`; never passed by a writer. */
    operatingDay: date('operating_day').notNull(),
  },
  (t) => [
    // Replay reads ORDER BY recorded_at, id. The trigger order_events_0_stamp_recorded_at sets
    // recorded_at to clock_timestamp() (security review S1), so events keep their insert order;
    // uuidv7() (monotonic within a session) breaks an equal instant.
    index('order_events_order_recorded_idx').on(t.orderId, t.recordedAt, t.id),
    // "Shipped yesterday" style reports.
    index('order_events_day_machine_state_idx').on(t.operatingDay, t.machine, t.toState),
    index('order_events_recorded_brin').using('brin', t.recordedAt),
    index('order_events_actor_idx').on(t.actorId),
    check('order_events_to_state_of_machine', stateOfMachine(t.machine, t.toState)),
    check(
      'order_events_from_state_of_machine',
      sql`${t.fromState} IS NULL OR ${stateOfMachine(t.machine, t.fromState)}`,
    ),
    check(
      'order_events_amount_on_cash_only',
      sql`${t.amount} IS NULL OR (${t.machine} = 'cash' AND ${t.amount} >= 0)`,
    ),
    check(
      'order_events_person_has_actor',
      sql`${t.actorType} <> 'person' OR ${t.actorId} IS NOT NULL`,
    ),
    check('order_events_reason_code_shape', reasonCodeShape(t.reasonCode)),
  ],
);
