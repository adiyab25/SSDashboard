import { Injectable } from '@nestjs/common';
import type {
  CashState,
  FulfillmentState,
  OrderLineState,
  OrderMachine,
  OrderOutcome,
  OrderRelation,
  OrderType,
  OrderPaymentMethod,
} from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import { pgConstraint } from '../../database/sql.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { actorIdOf, actorTypeOf, type OrderActor } from '../order-actor.js';
import type { OrderTransaction } from '../order-transactions.js';
import { OrderNumberTaken } from '../orders.errors.js';
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
}

/** What `insertOrder` answers: the new ids. */
export interface InsertedOrder {
  id: string;
  lineIds: string[];
}

type Column = readonly [name: string, value: string | number | null];

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
    for (const line of lines) {
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
      lineIds.push(requireId(rows));
    }
    return { id: orderId, lineIds };
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
      const columns: Column[] = [
        ['order_id', orderId],
        ['machine', event.machine],
        ['from_state', event.fromState],
        ['to_state', event.toState],
        ['amount', event.amount],
        ['actor_type', actorTypeOf(event.actor)],
        ['actor_id', actorIdOf(event.actor)],
        ['reason_code', event.reasonCode],
        ['source_type', event.sourceType],
        ['source_id', event.sourceId],
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
