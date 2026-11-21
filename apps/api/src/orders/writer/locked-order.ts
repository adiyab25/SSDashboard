import type {
  CashState,
  FulfillmentState,
  OrderLineState,
  OrderRelation,
  OrderType,
  StockOutSource,
} from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import type { PlanLine, PlanOrder } from '../editing/edit-plan.js';
import type { OrderTransaction } from '../order-transactions.js';
import { OrderNotFound, OrderStale } from '../orders.errors.js';

/** An order as a move reads it under its row lock: the plan's view plus what the moves need. */
export interface LockedOrder extends PlanOrder {
  id: string;
  storeId: string;
  /** The channel the order arrived on (the channel calls refuse a manual entry channel). */
  channelId: string;
  orderNumber: string;
  customerId: string | null;
  placedAt: Date;
  cashState: CashState;
  writeBackState: 'none' | 'waiting' | 'failed';
  relatedOrderId: string | null;
  relatedOrderRelation: OrderRelation | null;
  codDueAmount: string;
  codCollectedAmount: string;
  deliveredAmount: string;
  returnedCreditAmount: string;
  exchangeConsumedAmount: string;
  shippingPrepaidAmount: string;
  shippingCreditAppliedAmount: string;
  linesGrossAmount: string;
  /** The note the customer typed at checkout. Personal data, never logged. */
  customerNote: string | null;
  /** The generation of the order's shipment posting key (spec 0013 AC-24, AC-27). */
  stockOutGeneration: number;
  /** Which source asked for the current generation's stock out; null while none did (AC-27). */
  stockOutSource: StockOutSource | null;
  /** False when the caller's `expectedUpdatedAt` does not match `updated_at`. */
  fresh: boolean;
}

interface LockedRow extends Record<string, unknown> {
  id: string;
  store_id: string;
  channel_id: string;
  order_number: string;
  type: OrderType;
  customer_id: string | null;
  placed_at: string;
  fulfillment_state: FulfillmentState;
  cash_state: CashState;
  write_back_state: 'none' | 'waiting' | 'failed';
  carrier_delivery_created: boolean;
  related_order_id: string | null;
  related_order_relation: OrderRelation | null;
  lines_gross_amount: string;
  shipping_charged_amount: string;
  prepaid_amount: string;
  credit_applied_amount: string;
  shipping_prepaid_amount: string;
  shipping_credit_applied_amount: string;
  cod_expected_amount: string;
  cod_due_amount: string;
  cod_collected_amount: string;
  total_amount: string;
  delivered_amount: string;
  returned_credit_amount: string;
  exchange_consumed_amount: string;
  ship_to_name: string | null;
  ship_to_phone: string | null;
  ship_to_phone_alt: string | null;
  contact_phone_raw: string | null;
  ship_to_address: string | null;
  courier_note: string | null;
  ship_to_area_list: string | null;
  ship_to_governorate_code: string | null;
  ship_to_city_code: string | null;
  ship_to_zone_code: string | null;
  customer_note: string | null;
  stock_out_generation: number;
  stock_out_source: StockOutSource | null;
  fresh: boolean;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  position: number;
  variant_id: string | null;
  quantity: number;
  unit_price: string;
  discount_amount: string;
  net_amount: string;
  tax_rate: string;
  tax_amount: string;
  gross_amount: string;
  line_state: OrderLineState;
  channel_line_id: string | null;
  prepaid_amount: string;
  credit_applied_amount: string;
}

/**
 * Locks an order row `FOR UPDATE` and reads what a move needs, with its lines (spec 0013 Write
 * paths: every write path takes the order row lock first). Throws `OrderNotFound` for an unknown
 * id and, when `expectedUpdatedAt` is given, `OrderStale` unless it equals `updated_at` to the
 * microsecond (the spec 0009 pattern, compared in SQL so no precision is lost). It only reads.
 */
export async function lockOrderForChange(
  tx: OrderTransaction,
  orderId: string,
  expectedUpdatedAt?: string,
): Promise<LockedOrder> {
  const fresh =
    expectedUpdatedAt === undefined
      ? sql`true`
      : sql`coalesce(updated_at = ${expectedUpdatedAt}::timestamptz, false)`;
  const { rows } = await tx.execute<LockedRow>(sql`
    SELECT id, store_id, channel_id, order_number, type, customer_id,
           to_char(placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS placed_at,
           fulfillment_state, cash_state, write_back_state,
           carrier_delivery_created_at IS NOT NULL AS carrier_delivery_created,
           related_order_id, related_order_relation, lines_gross_amount, shipping_charged_amount,
           prepaid_amount, credit_applied_amount, shipping_prepaid_amount,
           shipping_credit_applied_amount, cod_expected_amount, cod_due_amount,
           cod_collected_amount, total_amount, delivered_amount, returned_credit_amount,
           exchange_consumed_amount, ship_to_name, ship_to_phone, ship_to_phone_alt,
           contact_phone_raw, ship_to_address, courier_note, ship_to_area_list,
           ship_to_governorate_code, ship_to_city_code, ship_to_zone_code, customer_note,
           stock_out_generation, stock_out_source,
           ${fresh} AS fresh
    FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`);
  const row = rows[0];
  if (!row) throw new OrderNotFound();
  if (!row.fresh) throw new OrderStale();
  const lineRows = await tx.execute<LineRow>(sql`
    SELECT id, position, variant_id, quantity, unit_price, discount_amount, net_amount, tax_rate,
           tax_amount, gross_amount, line_state, channel_line_id, prepaid_amount,
           credit_applied_amount
    FROM order_lines WHERE order_id = ${orderId}::uuid ORDER BY position`);
  const lines: PlanLine[] = lineRows.rows.map((line) => ({
    id: line.id,
    position: line.position,
    variantId: line.variant_id,
    quantity: line.quantity,
    unitPrice: line.unit_price,
    discountAmount: line.discount_amount,
    netAmount: line.net_amount,
    taxRate: line.tax_rate,
    taxAmount: line.tax_amount,
    grossAmount: line.gross_amount,
    lineState: line.line_state,
    channelLineId: line.channel_line_id,
    prepaidAmount: line.prepaid_amount,
    creditAppliedAmount: line.credit_applied_amount,
  }));
  const area =
    row.ship_to_area_list &&
    row.ship_to_governorate_code &&
    row.ship_to_city_code &&
    row.ship_to_zone_code
      ? {
          list: row.ship_to_area_list,
          governorateCode: row.ship_to_governorate_code,
          cityCode: row.ship_to_city_code,
          zoneCode: row.ship_to_zone_code,
        }
      : null;
  return {
    id: row.id,
    storeId: row.store_id,
    channelId: row.channel_id,
    orderNumber: row.order_number,
    type: row.type,
    customerId: row.customer_id,
    placedAt: new Date(row.placed_at),
    fulfillmentState: row.fulfillment_state,
    cashState: row.cash_state,
    writeBackState: row.write_back_state,
    carrierDeliveryCreated: row.carrier_delivery_created,
    relatedOrderId: row.related_order_id,
    relatedOrderRelation: row.related_order_relation,
    linesGrossAmount: row.lines_gross_amount,
    shippingChargedAmount: row.shipping_charged_amount,
    prepaidAmount: row.prepaid_amount,
    creditAppliedAmount: row.credit_applied_amount,
    shippingPrepaidAmount: row.shipping_prepaid_amount,
    shippingCreditAppliedAmount: row.shipping_credit_applied_amount,
    codExpectedAmount: row.cod_expected_amount,
    codDueAmount: row.cod_due_amount,
    codCollectedAmount: row.cod_collected_amount,
    totalAmount: row.total_amount,
    deliveredAmount: row.delivered_amount,
    returnedCreditAmount: row.returned_credit_amount,
    exchangeConsumedAmount: row.exchange_consumed_amount,
    shipTo: {
      name: row.ship_to_name,
      phone: row.ship_to_phone,
      phoneAlt: row.ship_to_phone_alt,
      contactPhoneRaw: row.contact_phone_raw,
      address: row.ship_to_address,
      courierNote: row.courier_note,
      area,
    },
    customerNote: row.customer_note,
    stockOutGeneration: row.stock_out_generation,
    stockOutSource: row.stock_out_source,
    lines,
    fresh: row.fresh,
  };
}

/** The order a link names (a `duplicate` cancel's target), as read under its row lock. */
export interface LinkTarget {
  id: string;
  fulfillmentState: FulfillmentState;
  relatedOrderId: string | null;
  relatedOrderRelation: OrderRelation | null;
}

/**
 * Locks the order a link names `FOR UPDATE` and reads its state and its own link, or answers null
 * for an unknown id. The caller keeps the ascending id order of two order locks (spec 0013 Key
 * invariants). It only reads.
 */
export async function lockLinkTarget(
  tx: OrderTransaction,
  orderId: string,
): Promise<LinkTarget | null> {
  const { rows } = await tx.execute<{
    id: string;
    fulfillment_state: FulfillmentState;
    related_order_id: string | null;
    related_order_relation: OrderRelation | null;
  }>(sql`
    SELECT id, fulfillment_state, related_order_id, related_order_relation
    FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fulfillmentState: row.fulfillment_state,
    relatedOrderId: row.related_order_id,
    relatedOrderRelation: row.related_order_relation,
  };
}
