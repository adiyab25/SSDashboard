import { Injectable } from '@nestjs/common';
import {
  deriveOrderOutcome,
  type CashState,
  type FulfillmentState,
  type OrderLineState,
  type OrderMachine,
  type OrderOutcome,
  type OrderRelation,
  type OrderType,
  type OrderPaymentMethod,
} from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import { pgConstraint, type Transaction } from '../../database/sql.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { actorIdOf, actorTypeOf, type OrderActor } from '../order-actor.js';
import type { OrderTransaction } from '../order-transactions.js';
import { OrderLocked, OrderNotFound, OrderNumberTaken } from '../orders.errors.js';
import { OrderStateChanged } from '../orders.events.js';

/** The campaign columns of an order: a new manual order sets two, a reopened one copies all. */
export interface OrderSourceColumns {
  capturedFrom: 'landing_page' | 'shopify_journey' | 'whatsapp_thread' | 'manual' | 'none';
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  landingPage: string | null;
  referrer: string | null;
  mediaBuyerId: string | null;
  influencerCode: string | null;
}

/** Everything an order row is created with: figures already computed by `totalsOf`. */
export interface NewOrderRow {
  storeId: string;
  channelId: string;
  orderNumber: string;
  channelOrderRef: string | null;
  type: OrderType;
  originalOrderId: string | null;
  relatedOrderId: string | null;
  relatedOrderRelation: OrderRelation | null;
  customerId: string | null;
  placedAt: Date;
  fulfillmentState: FulfillmentState;
  cashState: CashState;
  outcome: OrderOutcome;
  linesGrossAmount: string;
  shippingChargedAmount: string;
  shippingTaxAmount: string;
  totalAmount: string;
  prepaidAmount: string;
  creditAppliedAmount: string;
  shippingPrepaidAmount: string;
  shippingCreditAppliedAmount: string;
  codExpectedAmount: string;
  codDueAmount: string;
  deliveredAmount: string;
  paymentMethod: OrderPaymentMethod;
  prepaidMethod: OrderPaymentMethod | null;
  source: OrderSourceColumns;
  discountCode: string | null;
  giftReasonCode: string | null;
  customerNote: string | null;
  shipToName: string | null;
  shipToPhone: string | null;
  shipToPhoneAlt: string | null;
  contactPhoneRaw: string | null;
  shipToAddress: string | null;
  shipToAreaList: string | null;
  shipToGovernorateCode: string | null;
  shipToCityCode: string | null;
  shipToZoneCode: string | null;
  courierNote: string | null;
}

/** One line of a new order. */
export interface NewLineRow {
  position: number;
  variantId: string | null;
  title: string;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  netAmount: string;
  taxRate: string;
  taxAmount: string;
  grossAmount: string;
  prepaidAmount: string;
  creditAppliedAmount: string;
  lineState: OrderLineState;
  channelLineId: string | null;
}

/** One move to record in `order_events`. */
export interface NewEventRow {
  machine: OrderMachine;
  fromState: string | null;
  toState: string;
  amount: string | null;
  actor: OrderActor;
  reasonCode: string | null;
  sourceType: string | null;
  sourceId: string | null;
  occurredAt: Date;
  /**
   * True for an automatic follow on move (spec 0013 State machines: `unpaid` to
   * `nothing_to_collect` after a cancel): its source is the event written just before it in the
   * same call (`source_type` `order_event`), whose id is only known once written.
   */
  sourceIsPreviousEvent?: boolean;
}

/**
 * The `orders` columns a move may change, by meaning. Only the keys present are written; a
 * timestamp of `'now'` is the transaction's `now()`. Every figure comes from `totalsOf` or the
 * edit plan, never from a caller's own arithmetic. `outcome` is not here: `applyChange` derives
 * it itself with `deriveOrderOutcome` after every change.
 */
export interface OrderColumnChanges {
  fulfillmentState?: FulfillmentState;
  cashState?: CashState;
  customerId?: string | null;
  linesGrossAmount?: string;
  shippingChargedAmount?: string;
  shippingTaxAmount?: string;
  totalAmount?: string;
  shippingPrepaidAmount?: string;
  shippingCreditAppliedAmount?: string;
  codExpectedAmount?: string;
  codDueAmount?: string;
  deliveredAmount?: string;
  confirmedAt?: 'now';
  confirmedBy?: string | null;
  cancelledAt?: 'now';
  cancelReasonCode?: string;
  relatedOrderId?: string;
  relatedOrderRelation?: OrderRelation;
  carrierDeliveryCreatedAt?: Date;
  shipToName?: string;
  shipToPhone?: string | null;
  contactPhoneRaw?: string | null;
  shipToPhoneAlt?: string | null;
  shipToAddress?: string;
  courierNote?: string | null;
  shipToAreaList?: string | null;
  shipToGovernorateCode?: string | null;
  shipToCityCode?: string | null;
  shipToZoneCode?: string | null;
}

/** The column, and its cast, of each key of {@link OrderColumnChanges}. */
const ORDER_COLUMNS: Record<keyof OrderColumnChanges, readonly [column: string, cast: string]> = {
  fulfillmentState: ['fulfillment_state', 'order_fulfillment_state'],
  cashState: ['cash_state', 'order_cash_state'],
  customerId: ['customer_id', 'uuid'],
  linesGrossAmount: ['lines_gross_amount', 'numeric'],
  shippingChargedAmount: ['shipping_charged_amount', 'numeric'],
  shippingTaxAmount: ['shipping_tax_amount', 'numeric'],
  totalAmount: ['total_amount', 'numeric'],
  shippingPrepaidAmount: ['shipping_prepaid_amount', 'numeric'],
  shippingCreditAppliedAmount: ['shipping_credit_applied_amount', 'numeric'],
  codExpectedAmount: ['cod_expected_amount', 'numeric'],
  codDueAmount: ['cod_due_amount', 'numeric'],
  deliveredAmount: ['delivered_amount', 'numeric'],
  confirmedAt: ['confirmed_at', 'timestamptz'],
  confirmedBy: ['confirmed_by', 'uuid'],
  cancelledAt: ['cancelled_at', 'timestamptz'],
  cancelReasonCode: ['cancel_reason_code', 'text'],
  relatedOrderId: ['related_order_id', 'uuid'],
  relatedOrderRelation: ['related_order_relation', 'order_relation'],
  carrierDeliveryCreatedAt: ['carrier_delivery_created_at', 'timestamptz'],
  shipToName: ['ship_to_name', 'text'],
  shipToPhone: ['ship_to_phone', 'text'],
  contactPhoneRaw: ['contact_phone_raw', 'text'],
  shipToPhoneAlt: ['ship_to_phone_alt', 'text'],
  shipToAddress: ['ship_to_address', 'text'],
  courierNote: ['courier_note', 'text'],
  shipToAreaList: ['ship_to_area_list', 'text'],
  shipToGovernorateCode: ['ship_to_governorate_code', 'text'],
  shipToCityCode: ['ship_to_city_code', 'text'],
  shipToZoneCode: ['ship_to_zone_code', 'text'],
};

/** One change of an order unit: its row, its lines, and the event rows of its state moves. */
export interface OrderChange {
  columns: OrderColumnChanges;
  /** Open lines to cancel, each with its reason (`edit_removal` for a replace). */
  cancelLines?: readonly { lineId: string; cancelReasonCode: string }[];
  /** The prepaid and credit shares of stored lines after an allocation, by line id. */
  lineShares?: ReadonlyMap<string, { prepaidAmount: string; creditAppliedAmount: string }>;
  /** New lines, inserted after the cancels. */
  addLines?: readonly NewLineRow[];
  /** The event rows of every state column this change moves, in order. */
  events?: readonly NewEventRow[];
}

/**
 * The columns the money freeze holds once `carrier_delivery_created_at` is set (spec 0013 AC-8,
 * Key invariants): `cod_expected_amount` and the allocation, and the totals it is computed from
 * (the table check ties `cod_expected_amount` to the total). Line shares are frozen with them.
 */
const FROZEN_COLUMNS: readonly (keyof OrderColumnChanges)[] = [
  'codExpectedAmount',
  'shippingPrepaidAmount',
  'shippingCreditAppliedAmount',
  'linesGrossAmount',
  'totalAmount',
  'shippingChargedAmount',
  'shippingTaxAmount',
];

/** No share changes: the default of {@link OrderChange.lineShares}. */
const NO_SHARES: ReadonlyMap<string, { prepaidAmount: string; creditAppliedAmount: string }> =
  new Map();

/** What `applyChange` answers: the ids it made. */
export interface AppliedChange {
  lineIds: string[];
  eventIds: string[];
}

/** What `insertOrder` answers: the new ids. */
export interface InsertedOrder {
  id: string;
  lineIds: string[];
}

type Column = readonly [name: string, value: string | number | null];

/** What `applyChange` reads back to derive the outcome. */
interface OutcomeInputs extends Record<string, unknown> {
  fulfillment_state: FulfillmentState;
  delivered_amount: string;
  returned_credit_amount: string;
  exchange_consumed_amount: string;
  outcome: OrderOutcome;
}

/** Builds `INSERT INTO <table> (columns) VALUES (values) RETURNING id` from fixed column names. */
function insertSql(table: 'orders' | 'order_lines' | 'order_events', columns: Column[]): SQL {
  const names = sql.raw(columns.map(([name]) => `"${name}"`).join(', '));
  const values = sql.join(
    columns.map(([, value]) => sql`${value}`),
    sql`, `,
  );
  return sql`INSERT INTO ${sql.raw(table)} (${names}) VALUES (${values}) RETURNING id`;
}

const iso = (at: Date): string => at.toISOString();

/**
 * The only file that issues `INSERT` or `UPDATE` on `orders` and `order_lines`, and `INSERT` on
 * `order_events` (spec 0013 Key invariants; `orders-single-writer.spec.ts` greps the module for
 * it). It writes figures that `totalsOf` computed, writes every state change together with its
 * event row, and publishes one `OrderStateChanged` per event row in the same transaction. It
 * never decides whether a move is allowed (the transition table and the services do), never
 * commits, and never writes `operating_day` or `recorded_at` (the database stamps them).
 */
@Injectable()
export class OrderWriter {
  /** Takes the domain events service that announces each event row. */
  constructor(private readonly events: DomainEvents) {}

  /**
   * Creates an order and its lines in the caller's transaction. The caller then publishes
   * `OrderPlaced` and writes the first events with `insertEvents`, so a listener hears of the
   * order before its state changes. Throws `OrderNumberTaken` when the store already holds the
   * number.
   */
  async insertOrder(
    tx: OrderTransaction,
    order: NewOrderRow,
    lines: readonly NewLineRow[],
  ): Promise<InsertedOrder> {
    const orderId = await this.insertOrderRow(tx, order);
    const lineIds: string[] = [];
    for (const line of lines) lineIds.push(await this.insertLine(tx, orderId, line));
    return { id: orderId, lineIds };
  }

  /**
   * Applies one change to a locked order in the caller's transaction (spec 0013 Write paths):
   * cancels lines, rewrites the allocation shares of stored lines, inserts new lines, updates the
   * order row (the state columns together with their event rows, written right after in the same
   * call), sets `updated_at` to `clock_timestamp()` (the concurrency token), and publishes one
   * `OrderStateChanged` per event row. The caller holds the order row lock (`lockOrderForChange`)
   * and computed every figure with `totalsOf` or the edit plan; this method never changes
   * `prepaid_amount` or `credit_applied_amount`.
   *
   * Two rules live here so no caller can skip them: the money freeze (spec 0013 AC-8) refuses a
   * change of a frozen column or of a line's shares once `carrier_delivery_created_at` is set,
   * with `OrderLocked`, before anything is written; and `outcome` is derived with
   * `deriveOrderOutcome` from the row as the change leaves it, written only when it differs.
   * Throws `OrderNotFound` for an unknown order.
   */
  async applyChange(
    tx: OrderTransaction,
    orderId: string,
    change: OrderChange,
  ): Promise<AppliedChange> {
    const { rows: locked } = await tx.execute<{ frozen: boolean }>(sql`
      SELECT carrier_delivery_created_at IS NOT NULL AS frozen
      FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`);
    const current = locked[0];
    if (!current) throw new OrderNotFound();
    const movesMoney =
      FROZEN_COLUMNS.some((key) => change.columns[key] !== undefined) ||
      (change.lineShares?.size ?? 0) > 0;
    if (current.frozen && movesMoney) throw new OrderLocked();
    for (const line of change.cancelLines ?? []) {
      await tx.execute(sql`
        UPDATE order_lines
        SET line_state = 'cancelled', cancel_reason_code = ${line.cancelReasonCode},
            short_quantity = 0, updated_at = clock_timestamp()
        WHERE id = ${line.lineId}::uuid AND order_id = ${orderId}::uuid AND line_state = 'open'`);
    }
    for (const [lineId, share] of change.lineShares ?? NO_SHARES) {
      await tx.execute(sql`
        UPDATE order_lines
        SET prepaid_amount = ${share.prepaidAmount}::numeric,
            credit_applied_amount = ${share.creditAppliedAmount}::numeric,
            updated_at = clock_timestamp()
        WHERE id = ${lineId}::uuid AND order_id = ${orderId}::uuid
          AND (prepaid_amount, credit_applied_amount)
              IS DISTINCT FROM (${share.prepaidAmount}::numeric, ${share.creditAppliedAmount}::numeric)`);
    }
    const lineIds: string[] = [];
    for (const line of change.addLines ?? [])
      lineIds.push(await this.insertLine(tx, orderId, line));
    const sets: SQL[] = [sql`updated_at = clock_timestamp()`];
    for (const key of Object.keys(change.columns) as (keyof OrderColumnChanges)[]) {
      const value = change.columns[key];
      if (value === undefined) continue;
      const [column, cast] = ORDER_COLUMNS[key];
      const bound =
        value === 'now'
          ? sql`now()`
          : sql`${value instanceof Date ? iso(value) : value}::${sql.raw(cast)}`;
      sets.push(sql`${sql.raw(`"${column}"`)} = ${bound}`);
    }
    const { rows: after } = await tx.execute<OutcomeInputs>(sql`
      UPDATE orders SET ${sql.join(sets, sql`, `)} WHERE id = ${orderId}::uuid
      RETURNING fulfillment_state, delivered_amount, returned_credit_amount,
                exchange_consumed_amount, outcome`);
    const row = after[0];
    if (!row) throw new OrderNotFound();
    const outcome = deriveOrderOutcome({
      fulfillmentState: row.fulfillment_state,
      deliveredAmount: row.delivered_amount,
      returnedCreditAmount: row.returned_credit_amount,
      exchangeConsumedAmount: row.exchange_consumed_amount,
    });
    if (outcome !== row.outcome) {
      await tx.execute(sql`
        UPDATE orders SET outcome = ${outcome}::order_outcome WHERE id = ${orderId}::uuid`);
    }
    const eventIds = await this.insertEvents(tx, orderId, change.events ?? []);
    return { lineIds, eventIds };
  }

  /**
   * Projects `orders.write_back_state` from the order's open outbound commands (spec 0013 AC-12):
   * locks the order row `FOR UPDATE` first, then asks `stateOf` (which reads the commands), then
   * writes the answer, so two command changes in parallel serialize on the row and the later one
   * reads the earlier one's commit (READ COMMITTED takes a fresh snapshot per statement). It writes
   * this one column only, and only when it differs: no state move, no event, `updated_at` kept,
   * so a command settling never makes a person's open edit stale. An unknown order writes nothing.
   *
   * The one writer method that takes a plain `Transaction` (spec 0013 Key invariants records the
   * exception): it runs in a domain event handler inside the connectors' unit of work, which an
   * executor opens itself and is not an order transaction.
   */
  async projectWriteBackState(
    tx: Transaction,
    orderId: string,
    stateOf: () => Promise<'none' | 'waiting' | 'failed'>,
  ): Promise<void> {
    const { rows } = await tx.execute<{ id: string }>(
      sql`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`,
    );
    if (rows.length === 0) return;
    const state = await stateOf();
    await tx.execute(sql`
      UPDATE orders SET write_back_state = ${state}::order_write_back_state
      WHERE id = ${orderId}::uuid AND write_back_state <> ${state}::order_write_back_state`);
  }

  private async insertLine(
    tx: OrderTransaction,
    orderId: string,
    line: NewLineRow,
  ): Promise<string> {
    const columns: Column[] = [
      ['order_id', orderId],
      ['position', line.position],
      ['variant_id', line.variantId],
      ['title', line.title],
      ['quantity', line.quantity],
      ['unit_price', line.unitPrice],
      ['discount_amount', line.discountAmount],
      ['net_amount', line.netAmount],
      ['tax_rate', line.taxRate],
      ['tax_amount', line.taxAmount],
      ['gross_amount', line.grossAmount],
      ['prepaid_amount', line.prepaidAmount],
      ['credit_applied_amount', line.creditAppliedAmount],
      ['line_state', line.lineState],
      ['channel_line_id', line.channelLineId],
    ];
    const { rows } = await tx.execute<{ id: string }>(insertSql('order_lines', columns));
    return requireId(rows);
  }

  /**
   * Writes event rows one at a time, in the order given (so `recorded_at` and the monotonic
   * `uuidv7()` keep it for replay), and publishes `OrderStateChanged` for each. Returns the ids.
   */
  async insertEvents(
    tx: OrderTransaction,
    orderId: string,
    events: readonly NewEventRow[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const event of events) {
      const previous = ids.at(-1);
      const linked = event.sourceIsPreviousEvent === true && previous !== undefined;
      const columns: Column[] = [
        ['order_id', orderId],
        ['machine', event.machine],
        ['from_state', event.fromState],
        ['to_state', event.toState],
        ['amount', event.amount],
        ['actor_type', actorTypeOf(event.actor)],
        ['actor_id', actorIdOf(event.actor)],
        ['reason_code', event.reasonCode],
        ['source_type', linked ? 'order_event' : event.sourceType],
        ['source_id', linked ? previous : event.sourceId],
        ['occurred_at', iso(event.occurredAt)],
      ];
      const { rows } = await tx.execute<{ id: string }>(insertSql('order_events', columns));
      const id = requireId(rows);
      ids.push(id);
      await this.events.publish(
        tx,
        new OrderStateChanged(
          orderId,
          id,
          event.machine,
          event.fromState,
          event.toState,
          actorTypeOf(event.actor),
          iso(event.occurredAt),
        ),
      );
    }
    return ids;
  }

  /** Locks an order row `FOR UPDATE` and answers whether it exists. Every write path calls it first. */
  async lockOrder(tx: OrderTransaction, orderId: string): Promise<boolean> {
    const { rows } = await tx.execute<{ id: string }>(
      sql`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`,
    );
    return rows.length > 0;
  }

  private async insertOrderRow(tx: OrderTransaction, order: NewOrderRow): Promise<string> {
    const { source } = order;
    const columns: Column[] = [
      ['store_id', order.storeId],
      ['channel_id', order.channelId],
      ['order_number', order.orderNumber],
      ['channel_order_ref', order.channelOrderRef],
      ['type', order.type],
      ['original_order_id', order.originalOrderId],
      ['related_order_id', order.relatedOrderId],
      ['related_order_relation', order.relatedOrderRelation],
      ['customer_id', order.customerId],
      ['placed_at', iso(order.placedAt)],
      ['fulfillment_state', order.fulfillmentState],
      ['cash_state', order.cashState],
      ['outcome', order.outcome],
      ['lines_gross_amount', order.linesGrossAmount],
      ['shipping_charged_amount', order.shippingChargedAmount],
      ['shipping_tax_amount', order.shippingTaxAmount],
      ['total_amount', order.totalAmount],
      ['prepaid_amount', order.prepaidAmount],
      ['credit_applied_amount', order.creditAppliedAmount],
      ['shipping_prepaid_amount', order.shippingPrepaidAmount],
      ['shipping_credit_applied_amount', order.shippingCreditAppliedAmount],
      ['cod_expected_amount', order.codExpectedAmount],
      ['cod_due_amount', order.codDueAmount],
      ['delivered_amount', order.deliveredAmount],
      ['payment_method', order.paymentMethod],
      ['prepaid_method', order.prepaidMethod],
      ['source_captured_from', source.capturedFrom],
      ['source_campaign_id', source.campaignId],
      ['source_adset_id', source.adsetId],
      ['source_ad_id', source.adId],
      ['source_utm_source', source.utmSource],
      ['source_utm_medium', source.utmMedium],
      ['source_utm_campaign', source.utmCampaign],
      ['source_utm_content', source.utmContent],
      ['source_landing_page', source.landingPage],
      ['source_referrer', source.referrer],
      ['source_media_buyer_id', source.mediaBuyerId],
      ['source_influencer_code', source.influencerCode],
      ['discount_code', order.discountCode],
      ['gift_reason_code', order.giftReasonCode],
      ['customer_note', order.customerNote],
      ['ship_to_name', order.shipToName],
      ['ship_to_phone', order.shipToPhone],
      ['ship_to_phone_alt', order.shipToPhoneAlt],
      ['contact_phone_raw', order.contactPhoneRaw],
      ['ship_to_address', order.shipToAddress],
      ['ship_to_area_list', order.shipToAreaList],
      ['ship_to_governorate_code', order.shipToGovernorateCode],
      ['ship_to_city_code', order.shipToCityCode],
      ['ship_to_zone_code', order.shipToZoneCode],
      ['courier_note', order.courierNote],
    ];
    try {
      const { rows } = await tx.execute<{ id: string }>(insertSql('orders', columns));
      return requireId(rows);
    } catch (error) {
      if (pgConstraint(error) === 'orders_store_number_unique') throw new OrderNumberTaken();
      throw error;
    }
  }
}

function requireId(rows: readonly { id: string }[]): string {
  const id = rows[0]?.id;
  if (!id) throw new Error('An insert returned no id');
  return id;
}
