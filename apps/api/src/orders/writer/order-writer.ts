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
  type SplittableLine,
  type StockOutSource,
} from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import { pgArray, pgConstraint, type Transaction } from '../../database/sql.js';
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
  /**
   * The columns an order created in a later state carries (spec 0013 AC-25 a, the go live import,
   * and AC-14, the found states of an `import`). Left out, each is null (or 0 for an amount).
   */
  confirmedAt?: Date | null;
  confirmedBy?: string | null;
  cancelledAt?: Date | null;
  cancelReasonCode?: string | null;
  refusedReasonCode?: string | null;
  carrierDeliveryCreatedAt?: Date | null;
  codCollectedAmount?: string;
  remittedAmount?: string;
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
  /** The payment method, prepayment, and its tender: only `rederivePaymentMethod` passes them (AC-25 c). */
  paymentMethod?: OrderPaymentMethod;
  prepaidAmount?: string;
  prepaidMethod?: OrderPaymentMethod | null;
  confirmedAt?: 'now';
  confirmedBy?: string | null;
  cancelledAt?: 'now';
  cancelReasonCode?: string;
  relatedOrderId?: string;
  relatedOrderRelation?: OrderRelation;
  carrierDeliveryCreatedAt?: Date;
  /** The refusal reason a carrier `refused` fact carries (the table check requires it). */
  refusedReasonCode?: string;
  /** The collected total a cash collection or its reversal leaves (AC-17). */
  codCollectedAmount?: string;
  /** The remitted amount a settlement match or its revoke leaves (AC-17). */
  remittedAmount?: string;
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
  /** The note the customer typed at checkout (a channel edit may change it). */
  customerNote?: string | null;
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
  paymentMethod: ['payment_method', 'order_payment_method'],
  prepaidAmount: ['prepaid_amount', 'numeric'],
  prepaidMethod: ['prepaid_method', 'order_payment_method'],
  confirmedAt: ['confirmed_at', 'timestamptz'],
  confirmedBy: ['confirmed_by', 'uuid'],
  cancelledAt: ['cancelled_at', 'timestamptz'],
  cancelReasonCode: ['cancel_reason_code', 'text'],
  relatedOrderId: ['related_order_id', 'uuid'],
  relatedOrderRelation: ['related_order_relation', 'order_relation'],
  carrierDeliveryCreatedAt: ['carrier_delivery_created_at', 'timestamptz'],
  refusedReasonCode: ['refused_reason_code', 'text'],
  codCollectedAmount: ['cod_collected_amount', 'numeric'],
  remittedAmount: ['remitted_amount', 'numeric'],
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
  customerNote: ['customer_note', 'text'],
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
  /**
   * Open lines moved whole by a carrier fact or a partial delivery (spec 0013 AC-15, AC-16):
   * `delivered`, `returned_to_origin`, or `lost`. A state move, not a money move, so the freeze
   * allows it; each moved line's `short_quantity` becomes 0 (AC-13: 0 once the line leaves `open`).
   */
  moveLines?: readonly { lineId: string; to: 'delivered' | 'returned_to_origin' | 'lost' }[];
  /**
   * Open lines a partial delivery splits (AC-16, spec 0002 "Partial delivery splits lines"): the
   * original keeps the delivered quantity and money and becomes `delivered`; a new row at the next
   * position takes the returned quantity and money, `returned_to_origin`, `split_from_line_id`
   * the original, and copies its variant, title, unit price, tax rate, unit cost, and channel line
   * id. Needs `freezeAllowance: 'partial_delivery_split'` (the split lines carry the original's
   * shares, so the frozen figures never move).
   */
  splitLines?: readonly { lineId: string; delivered: SplittableLine; returned: SplittableLine }[];
  /** The event rows of every state column this change moves, in order. */
  events?: readonly NewEventRow[];
  /**
   * The one exception to the rule that line changes are money moves under the freeze: the partial
   * delivery split (`recordPartialDelivery`, AC-16) splits lines of a frozen order and passes
   * `'partial_delivery_split'`, which lets `splitLines` (and any line change of the same call)
   * through. The split keeps each line's share sum: the split rows together carry exactly the
   * prepaid and credit shares of the line they came from, so the frozen order totals and
   * `cod_expected_amount` never move. A frozen column stays refused with it. No other caller
   * passes it.
   */
  freezeAllowance?: 'partial_delivery_split';
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
  'prepaidAmount',
  // How the order is paid moves with the prepayment (security L3).
  'paymentMethod',
  'prepaidMethod',
];

/** No share changes: the default of {@link OrderChange.lineShares}. */
const NO_SHARES: ReadonlyMap<string, { prepaidAmount: string; creditAppliedAmount: string }> =
  new Map();

/** What `applyChange` answers: the ids it made. */
export interface AppliedChange {
  /** The ids of `addLines`, in order. */
  lineIds: string[];
  /** The ids of the returned rows `splitLines` made, in order. */
  splitLineIds: string[];
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
   * and computed every figure with `totalsOf` or the edit plan; it never changes
   * `credit_applied_amount`, and `prepaid_amount` only when `rederivePaymentMethod` passes it.
   *
   * Two rules live here so no caller can skip them: the money freeze (spec 0013 AC-8) refuses a
   * change of a frozen column, a line's shares, a line cancel, or a new line once
   * `carrier_delivery_created_at` is set, with `OrderLocked`, before anything is written (only the
   * partial delivery split's `freezeAllowance` lets lines move under it); and `outcome` is derived with
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
    // A cancelled or added line moves the totals as surely as a total does (security N1).
    const movesLines =
      (change.lineShares?.size ?? 0) > 0 ||
      (change.cancelLines?.length ?? 0) > 0 ||
      (change.addLines?.length ?? 0) > 0 ||
      (change.splitLines?.length ?? 0) > 0;
    const movesMoney =
      FROZEN_COLUMNS.some((key) => change.columns[key] !== undefined) ||
      (movesLines && change.freezeAllowance !== 'partial_delivery_split');
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
    for (const move of change.moveLines ?? []) {
      await tx.execute(sql`
        UPDATE order_lines
        SET line_state = ${move.to}::order_line_state, short_quantity = 0,
            updated_at = clock_timestamp()
        WHERE id = ${move.lineId}::uuid AND order_id = ${orderId}::uuid AND line_state = 'open'`);
    }
    const splitLineIds: string[] = [];
    for (const split of change.splitLines ?? []) {
      splitLineIds.push(await this.splitLine(tx, orderId, split));
    }
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
    return { lineIds, splitLineIds, eventIds };
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

  /**
   * Writes the channel's own ids onto lines of a locked order that have none (spec 0013 AC-14:
   * `recordChannelLineIds`, and the line match of `applyChannelEdit`). Each id is written only
   * from null (`channel_line_id IS NULL` in the update, Key invariants); the caller has already
   * refused a conflicting id. Writes no event and leaves `orders.updated_at` alone, because the
   * channel's id is not a business change of the order. Answers how many lines took an id.
   */
  async setChannelLineIds(
    tx: OrderTransaction,
    orderId: string,
    ids: readonly { lineId: string; channelLineId: string }[],
  ): Promise<number> {
    let written = 0;
    for (const { lineId, channelLineId } of ids) {
      const { rows } = await tx.execute<{ id: string }>(sql`
        UPDATE order_lines SET channel_line_id = ${channelLineId}, updated_at = clock_timestamp()
        WHERE id = ${lineId}::uuid AND order_id = ${orderId}::uuid AND channel_line_id IS NULL
        RETURNING id`);
      written += rows.length;
    }
    return written;
  }

  /**
   * Sets the variant of a line that arrived unmapped (spec 0013 AC-25 b, `linkChannelLineVariant`),
   * only from null (Key invariants: a mapped variant never changes in place). Writes no event and
   * leaves `orders.updated_at` alone: it counts as no edit. Answers false when the line already
   * had a variant (nothing written).
   */
  async setLineVariant(
    tx: OrderTransaction,
    orderId: string,
    lineId: string,
    variantId: string,
  ): Promise<boolean> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE order_lines SET variant_id = ${variantId}::uuid, updated_at = clock_timestamp()
      WHERE id = ${lineId}::uuid AND order_id = ${orderId}::uuid AND variant_id IS NULL
      RETURNING id`);
    return rows.length > 0;
  }

  /**
   * Splits one open line of a locked order (see {@link OrderChange.splitLines}): inserts the
   * returned row at the order's next position, copying the original's fixed columns, then updates
   * the original to the delivered quantity and money. Answers the new row's id; throws when the
   * line is not an open line of the order (the caller planned from the locked lines, so this is
   * a fault, never a refusal).
   */
  private async splitLine(
    tx: OrderTransaction,
    orderId: string,
    split: { lineId: string; delivered: SplittableLine; returned: SplittableLine },
  ): Promise<string> {
    const { returned: r, delivered: d } = split;
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO order_lines (order_id, position, variant_id, title, quantity, unit_price,
                               discount_amount, net_amount, tax_rate, tax_amount, gross_amount,
                               prepaid_amount, credit_applied_amount, unit_cost, line_state,
                               split_from_line_id, channel_line_id, stock_out_quantity)
      SELECT l.order_id,
             (SELECT max(position) + 1 FROM order_lines WHERE order_id = ${orderId}::uuid),
             l.variant_id, l.title, ${r.quantity}::int, l.unit_price,
             ${r.discountAmount}::numeric, ${r.netAmount}::numeric, l.tax_rate,
             ${r.taxAmount}::numeric, ${r.grossAmount}::numeric, ${r.prepaidAmount}::numeric,
             ${r.creditAppliedAmount}::numeric, l.unit_cost, 'returned_to_origin', l.id,
             l.channel_line_id,
             -- A requested stock out follows the split: the delivered row keeps up to its quantity.
             CASE WHEN l.stock_out_quantity IS NULL THEN NULL
                  ELSE LEAST(GREATEST(l.stock_out_quantity - ${d.quantity}::int, 0), ${r.quantity}::int)
             END
      FROM order_lines l
      WHERE l.id = ${split.lineId}::uuid AND l.order_id = ${orderId}::uuid AND l.line_state = 'open'
      RETURNING id`);
    const id = requireId(rows);
    await tx.execute(sql`
      UPDATE order_lines
      SET quantity = ${d.quantity}::int, discount_amount = ${d.discountAmount}::numeric,
          net_amount = ${d.netAmount}::numeric, tax_amount = ${d.taxAmount}::numeric,
          gross_amount = ${d.grossAmount}::numeric, prepaid_amount = ${d.prepaidAmount}::numeric,
          credit_applied_amount = ${d.creditAppliedAmount}::numeric, line_state = 'delivered',
          stock_out_quantity = LEAST(stock_out_quantity, ${d.quantity}::int),
          short_quantity = 0, updated_at = clock_timestamp()
      WHERE id = ${split.lineId}::uuid AND order_id = ${orderId}::uuid`);
    return id;
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

  /**
   * Writes the short quantity the stock ledger answered for lines of an order the caller locked
   * (spec 0013 AC-13: `short_quantity` from every `reserveLines` answer, its `unfilled`). Each value
   * is capped at the line's quantity and written only to an open line, only when it differs; no
   * event, `orders.updated_at` kept (a hold is not a business change of the order). Never decides
   * the value: `OrderStock` passes what the ledger said.
   */
  async setShortQuantities(
    tx: OrderTransaction,
    orderId: string,
    lines: readonly { lineId: string; shortQuantity: number }[],
  ): Promise<void> {
    if (!lines.length) return;
    // One statement for every line of the answer.
    await tx.execute(sql`
      UPDATE order_lines l
      SET short_quantity = LEAST(GREATEST(w.short, 0), l.quantity), updated_at = clock_timestamp()
      FROM unnest(${pgArray(lines.map((line) => line.lineId))}::uuid[],
                  ${pgArray(lines.map((line) => line.shortQuantity))}::int[]) AS w(id, short)
      WHERE l.id = w.id AND l.order_id = ${orderId}::uuid AND l.line_state = 'open'
        AND l.short_quantity <> LEAST(GREATEST(w.short, 0), l.quantity)`);
  }

  /**
   * Brings every line of a locked order to `short_quantity` 0 (spec 0013 AC-13: 0 once the order
   * leaves `open`, written by a cancel after its reservations were released). No event,
   * `orders.updated_at` kept.
   */
  async clearShortQuantities(tx: OrderTransaction, orderId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE order_lines SET short_quantity = 0, updated_at = clock_timestamp()
      WHERE order_id = ${orderId}::uuid AND short_quantity > 0`);
  }

  /**
   * Projects a reservation event of the stock ledger onto one order line (spec 0013 Who opens the
   * transaction, Domain events): `ReservationFilled` sets `short_quantity` to the event's
   * `stillUnfilled` (`{ to }`), `ReservationShortened` raises it by the event's quantity
   * (`{ add }`), capped between 0 and the line's quantity. It writes only an open line of an order
   * still in `new`, `confirmed`, or `packed`, and answers whether it wrote one.
   *
   * It runs in the ledger's own transaction (handed over through the one sanctioned ledger
   * adapter of `order-transactions.ts`) and must never take the order row lock: the ledger holds
   * pair locks there, so it locks only the one line row it writes (a deadlock with an order write
   * is broken by the ledger's single retry). No event, `orders.updated_at` kept.
   */
  async projectShortQuantity(
    tx: OrderTransaction,
    orderId: string,
    lineId: string,
    change: { to: number } | { add: number },
  ): Promise<boolean> {
    const next =
      'to' in change
        ? sql`LEAST(GREATEST(${change.to}::int, 0), quantity)`
        : sql`LEAST(GREATEST(short_quantity + ${change.add}::int, 0), quantity)`;
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE order_lines SET short_quantity = ${next}, updated_at = clock_timestamp()
      WHERE id = ${lineId}::uuid AND order_id = ${orderId}::uuid AND line_state = 'open'
        AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ${orderId}::uuid
                    AND o.fulfillment_state IN ('new', 'confirmed', 'packed'))
      RETURNING id`);
    return rows.length > 0;
  }

  /**
   * Records the stock out request of the order's current generation (spec 0013 AC-27 a), once:
   * `stock_out_source` and `stock_out_requested_at` on the order, and each named line's
   * `stock_out_quantity`, only while no request is recorded. No event, no audit entry, and
   * `orders.updated_at` kept (no state machine moves). The caller holds the order row lock and
   * names only lines of the order. Answers whether it recorded the request.
   */
  async requestStockOut(
    tx: OrderTransaction,
    orderId: string,
    request: {
      source: StockOutSource;
      at: Date;
      lines: readonly { lineId: string; quantity: number }[];
    },
  ): Promise<boolean> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE orders
      SET stock_out_source = ${request.source}::stock_out_source,
          stock_out_requested_at = ${iso(request.at)}::timestamptz
      WHERE id = ${orderId}::uuid AND stock_out_requested_at IS NULL
      RETURNING id`);
    if (rows.length === 0) return false;
    if (request.lines.length > 0) {
      await tx.execute(sql`
        UPDATE order_lines l
        SET stock_out_quantity = LEAST(GREATEST(w.quantity, 0), l.quantity),
            updated_at = clock_timestamp()
        FROM unnest(${pgArray(request.lines.map((line) => line.lineId))}::uuid[],
                    ${pgArray(request.lines.map((line) => line.quantity))}::int[]) AS w(id, quantity)
        WHERE l.id = w.id AND l.order_id = ${orderId}::uuid`);
    }
    return true;
  }

  /**
   * Writes the `unit_cost` the shipment posting gave each line (spec 0013 AC-15, Value sourcing:
   * once, from null), to the line and to any split row of it whose cost is still null. Runs in
   * the posting's own `within` (the ledger's transaction, through the one sanctioned adapter), so
   * it takes no order row lock: it locks only the line rows it writes, after the ledger's locks
   * (a deadlock with an order write is broken by the ledger's single retry). No event,
   * `orders.updated_at` kept.
   */
  async setUnitCosts(
    tx: OrderTransaction,
    orderId: string,
    costs: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (costs.size === 0) return;
    const lineIds = [...costs.keys()];
    await tx.execute(sql`
      UPDATE order_lines l
      SET unit_cost = w.cost, updated_at = clock_timestamp()
      FROM unnest(${pgArray(lineIds)}::uuid[],
                  ${pgArray(lineIds.map((id) => costs.get(id) ?? '0'))}::numeric[]) AS w(id, cost)
      WHERE l.order_id = ${orderId}::uuid AND l.unit_cost IS NULL
        AND (l.id = w.id OR l.split_from_line_id = w.id)`);
  }

  /**
   * Puts each named line's posted `stock_out_quantity` on `awaiting_restock_quantity`, since now
   * (spec 0013 *After a cancel* row 5), for lines not already awaiting. The caller holds the order
   * row lock. No event, `orders.updated_at` kept. Answers the lines it put on the list.
   */
  async awaitRestock(
    tx: OrderTransaction,
    orderId: string,
    lineIds: readonly string[],
  ): Promise<string[]> {
    if (lineIds.length === 0) return [];
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE order_lines
      SET awaiting_restock_quantity = stock_out_quantity, awaiting_restock_since = now(),
          updated_at = clock_timestamp()
      WHERE order_id = ${orderId}::uuid AND id = ANY(${pgArray(lineIds)}::uuid[])
        AND stock_out_quantity > 0 AND awaiting_restock_quantity = 0
      RETURNING id`);
    return rows.map((row) => row.id);
  }

  /**
   * Closes every awaiting restock quantity of the order with no movement (spec 0013 AC-15: a late
   * carrier `shipped` on a cancelled order; the posting stands and the courier has the pieces).
   * The caller holds the order row lock. No event, `orders.updated_at` kept. Answers how many
   * lines it closed.
   */
  async closeAwaitingRestock(tx: OrderTransaction, orderId: string): Promise<number> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE order_lines
      SET awaiting_restock_quantity = 0, awaiting_restock_since = NULL,
          updated_at = clock_timestamp()
      WHERE order_id = ${orderId}::uuid AND awaiting_restock_quantity > 0
      RETURNING id`);
    return rows.length;
  }

  /**
   * Moves the order from stock out generation `from` to `from + 1` and clears the request and the
   * lines' `stock_out_quantity` (spec 0013 *After a cancel* row 4, after its reversal), only while
   * the order is still at `from`; a line still awaiting restock keeps its quantity (the cap of what
   * may come back). Runs in the reversal's own `within` (the ledger's transaction), so the row
   * lock it takes comes after the ledger's locks. No event, `orders.updated_at` kept. Answers
   * whether it moved the order.
   */
  async advanceStockOutGeneration(
    tx: OrderTransaction,
    orderId: string,
    from: number,
  ): Promise<boolean> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE orders
      SET stock_out_generation = ${from + 1}::smallint, stock_out_source = NULL,
          stock_out_requested_at = NULL
      WHERE id = ${orderId}::uuid AND stock_out_generation = ${from}::smallint
      RETURNING id`);
    if (rows.length === 0) return false;
    await tx.execute(sql`
      UPDATE order_lines SET stock_out_quantity = NULL, updated_at = clock_timestamp()
      WHERE order_id = ${orderId}::uuid AND stock_out_quantity IS NOT NULL
        AND awaiting_restock_quantity = 0`);
    return true;
  }

  /**
   * Adds returned pieces to each named line's `awaiting_restock_quantity` (spec 0013 AC-27 d: a
   * Shopify refund or return of an order that left stock through a Shopify fulfillment), capped
   * at what the line's posting took out (`stock_out_quantity`), since now when nothing awaited.
   * The caller holds the order row lock. No event, `orders.updated_at` kept. Answers each line it
   * raised with the quantity it added.
   */
  async awaitReturn(
    tx: OrderTransaction,
    orderId: string,
    lines: readonly { lineId: string; quantity: number }[],
  ): Promise<{ lineId: string; added: number }[]> {
    if (lines.length === 0) return [];
    const { rows } = await tx.execute<{ id: string; added: number }>(sql`
      WITH wanted AS (
        SELECT w.id, sum(w.quantity)::int AS quantity
        FROM unnest(${pgArray(lines.map((line) => line.lineId))}::uuid[],
                    ${pgArray(lines.map((line) => line.quantity))}::int[]) AS w(id, quantity)
        GROUP BY w.id
      ), before AS (
        SELECT l.id, l.awaiting_restock_quantity AS was,
               LEAST(l.awaiting_restock_quantity + GREATEST(wanted.quantity, 0),
                     coalesce(l.stock_out_quantity, 0)) AS now_awaiting
        FROM order_lines l JOIN wanted ON wanted.id = l.id
        WHERE l.order_id = ${orderId}::uuid
      )
      UPDATE order_lines l
      SET awaiting_restock_quantity = before.now_awaiting,
          awaiting_restock_since = CASE WHEN before.was = 0 THEN now() ELSE l.awaiting_restock_since END,
          updated_at = clock_timestamp()
      FROM before
      WHERE l.id = before.id AND before.now_awaiting > before.was
      RETURNING l.id, (before.now_awaiting - before.was)::int AS added`);
    return rows.map((row) => ({ lineId: row.id, added: row.added }));
  }

  /**
   * Lowers one line's `awaiting_restock_quantity` by `quantity` with a conditional update (spec
   * 0013 AC-27 e, f: `awaiting_restock_quantity >= quantity`), clearing `awaiting_restock_since`
   * when nothing is left. Runs in a restock posting's `within` (the line row lock comes after the
   * ledger's locks) or in a close's order transaction. No event, `orders.updated_at` kept. Answers
   * the quantity before and after, or null when no row matched (the caller throws
   * `NothingAwaiting`).
   */
  async lowerAwaitingRestock(
    tx: OrderTransaction,
    orderId: string,
    lineId: string,
    quantity: number,
  ): Promise<{ before: number; after: number } | null> {
    const { rows } = await tx.execute<{ after: number }>(sql`
      UPDATE order_lines
      SET awaiting_restock_quantity = awaiting_restock_quantity - ${quantity}::int,
          awaiting_restock_since = CASE WHEN awaiting_restock_quantity - ${quantity}::int = 0
                                        THEN NULL ELSE awaiting_restock_since END,
          updated_at = clock_timestamp()
      WHERE id = ${lineId}::uuid AND order_id = ${orderId}::uuid
        AND ${quantity}::int > 0 AND awaiting_restock_quantity >= ${quantity}::int
      RETURNING awaiting_restock_quantity AS after`);
    const row = rows[0];
    return row ? { before: row.after + quantity, after: row.after } : null;
  }

  /**
   * Clears `carrier_delivery_created_at` (spec 0013 AC-27 c: every Shopify fulfillment of an order
   * with no carrier delivery was cancelled), so the order is back to before its first fulfillment
   * and an edit applies again: the one exception to the money freeze, accepted by the owner on
   * 2026-11-08. The caller holds the order row lock and writes `order.carrier_delivery_cleared`.
   * No event, `orders.updated_at` kept. Answers whether it cleared it.
   */
  async clearCarrierDelivery(tx: OrderTransaction, orderId: string): Promise<boolean> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE orders SET carrier_delivery_created_at = NULL
      WHERE id = ${orderId}::uuid AND carrier_delivery_created_at IS NOT NULL
      RETURNING id`);
    return rows.length > 0;
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
      ['confirmed_at', order.confirmedAt ? iso(order.confirmedAt) : null],
      ['confirmed_by', order.confirmedBy ?? null],
      ['cancelled_at', order.cancelledAt ? iso(order.cancelledAt) : null],
      ['cancel_reason_code', order.cancelReasonCode ?? null],
      ['refused_reason_code', order.refusedReasonCode ?? null],
      [
        'carrier_delivery_created_at',
        order.carrierDeliveryCreatedAt ? iso(order.carrierDeliveryCreatedAt) : null,
      ],
      ['cod_collected_amount', order.codCollectedAmount ?? '0.00'],
      ['remitted_amount', order.remittedAmount ?? '0.00'],
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
