import { Inject, Injectable } from '@nestjs/common';
import type {
  CashState,
  FulfillmentState,
  OrderDetail,
  OrderLineState,
  OrderFilterOptions,
  OrderListItem,
  OrderListQuery,
  OrderListResponse,
  OrderOptions,
  OrderOutcome,
  OrderPaymentMethod,
  OrderRelation,
  OrderType,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { CatalogService } from '../../catalog/catalog.service.js';
import { ChannelsService } from '../../channels/channels.service.js';
import { ConnectorsService } from '../../connectors/connectors.service.js';
import { CustomersService } from '../../customers/customers.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { StaffDirectory } from '../../identity/staff/staff-directory.js';
import { decodeTimeIdKeyset, encodeKeyset } from '../../platform/keyset-cursor.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { OrderNotFound } from '../orders.errors.js';
import { listWhere, MICRO_UTC, phoneOfSearch, type ListLookups } from './order-list-sql.js';

const MICRO = sql.raw(MICRO_UTC);

/** One order as another module may see it: ids, codes, states, and amounts, never a ship to field. */
export interface OrderSummary {
  id: string;
  storeId: string;
  storeCode: string;
  orderNumber: string;
  type: OrderType;
  fulfillmentState: FulfillmentState;
  cashState: CashState;
  outcome: OrderOutcome;
  totalAmount: string;
  codExpectedAmount: string;
  codDueAmount: string;
  codCollectedAmount: string;
}

/** One order on a customer's timeline (spec 0014): number with store, time, states, outcome, total. */
export interface CustomerOrderRow {
  id: string;
  storeCode: string;
  orderNumber: string;
  placedAt: string;
  fulfillmentState: FulfillmentState;
  cashState: CashState;
  outcome: OrderOutcome;
  totalAmount: string;
  paymentMethod: OrderPaymentMethod;
  refusedReasonCode: string | null;
}

/** A page of {@link CustomerOrderRow}, newest first. */
export interface CustomerOrderPage {
  items: CustomerOrderRow[];
  nextCursor: string | null;
}

/** The counts spec 0014 reads: all orders, and the refused and returned ones since a day. */
export interface CustomerOrderCounts {
  orders: number;
  refused: number;
  returned: number;
}

/** What the Shopify write back executor needs of an order (spec 0013 AC-21). Personal data: connectors only. */
export interface WriteBackView {
  orderId: string;
  storeId: string;
  storeCode: string;
  channelOrderRef: string | null;
  lines: {
    id: string;
    channelLineId: string | null;
    variantId: string | null;
    quantity: number;
    unitPrice: string;
    discountAmount: string;
    lineState: OrderLineState;
    cancelReasonCode: string | null;
  }[];
  shipTo: {
    name: string | null;
    phone: string | null;
    phoneAlt: string | null;
    address: string | null;
    courierNote: string | null;
    areaList: string | null;
    governorateCode: string | null;
    cityCode: string | null;
    zoneCode: string | null;
  };
  shippingChargedAmount: string;
}

interface SummaryRow extends Record<string, unknown> {
  id: string;
  store_id: string;
  order_number: string;
  type: OrderType;
  fulfillment_state: FulfillmentState;
  cash_state: CashState;
  outcome: OrderOutcome;
  total_amount: string;
  cod_expected_amount: string;
  cod_due_amount: string;
  cod_collected_amount: string;
}

interface ListRow extends Record<string, unknown> {
  id: string;
  store_id: string;
  order_number: string;
  placed_at: string;
  ship_to_name: string | null;
  channel_id: string;
  total_amount: string;
  cod_due_amount: string;
  fulfillment_state: FulfillmentState;
  cash_state: CashState;
  outcome: OrderOutcome;
  type: OrderType;
  gift_reason_code: OrderListItem['giftReasonCode'];
  hold: boolean;
  short: boolean;
  reopened: boolean;
  phone_needs_fix: boolean;
}

interface DetailRow extends Record<string, unknown> {
  id: string;
  store_id: string;
  channel_id: string;
  order_number: string;
  type: OrderType;
  gift_reason_code: OrderDetail['giftReasonCode'];
  original_order_id: string | null;
  related_order_id: string | null;
  related_order_relation: OrderRelation | null;
  customer_id: string | null;
  placed_at: string;
  operating_day: string;
  fulfillment_state: FulfillmentState;
  cash_state: CashState;
  outcome: OrderOutcome;
  write_back_state: OrderDetail['writeBackState'];
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason_code: string | null;
  carrier_delivery_created_at: string | null;
  source_captured_from: string;
  source_campaign_id: string | null;
  source_utm_source: string | null;
  source_utm_medium: string | null;
  source_utm_campaign: string | null;
  discount_code: string | null;
  ship_to_name: string | null;
  ship_to_phone: string | null;
  ship_to_phone_alt: string | null;
  contact_phone_raw: string | null;
  ship_to_address: string | null;
  ship_to_area_list: string | null;
  ship_to_governorate_code: string | null;
  ship_to_city_code: string | null;
  ship_to_zone_code: string | null;
  courier_note: string | null;
  customer_note: string | null;
  lines_gross_amount: string;
  shipping_charged_amount: string;
  shipping_tax_amount: string;
  total_amount: string;
  payment_method: OrderPaymentMethod;
  prepaid_amount: string;
  prepaid_method: OrderPaymentMethod | null;
  credit_applied_amount: string;
  cod_expected_amount: string;
  cod_due_amount: string;
  cod_collected_amount: string;
  remitted_amount: string;
  updated_at: string;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  position: number;
  variant_id: string | null;
  title: string;
  quantity: number;
  unit_price: string;
  discount_amount: string;
  gross_amount: string;
  prepaid_amount: string;
  credit_applied_amount: string;
  line_state: OrderLineState;
  cancel_reason_code: string | null;
  short_quantity: number;
  unit_cost: string | null;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  machine: 'fulfillment' | 'cash';
  from_state: string | null;
  to_state: string;
  amount: string | null;
  actor_type: 'person' | 'carrier' | 'system_job' | 'import';
  actor_id: string | null;
  reason_code: string | null;
  occurred_at: string;
}

/** The kinds of channel the new order form offers. */
const FORM_CHANNEL_KINDS = ['manual', 'whatsapp', 'instagram'] as const;

/**
 * The read side of orders (spec 0013 AC-4, AC-5, AC-21): the list and search with keyset pages,
 * the order page, the form options, and the reads other modules call (`summaryOf`,
 * `forCustomers`, `countsForCustomers`, `writeBackViewOf`). It reads only the orders tables;
 * store, channel, customer, SKU, and staff names come through their owners' services. It never
 * writes, never logs a ship to field, and never answers `unitCost` (the controller's cost
 * serializer removes it for a viewer without `cost.view`).
 */
@Injectable()
export class OrderQueries {
  /** Takes the connection and the services whose names an order answer shows. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    private readonly channels: ChannelsService,
    private readonly customers: CustomersService,
    private readonly catalog: CatalogService,
    private readonly staff: StaffDirectory,
    private readonly settings: SettingsService,
    private readonly connectors: ConnectorsService,
  ) {}

  /** What the new order form offers: internal stores, manual channels, gift reasons, tax settings. */
  async options(giftReasonCodes: OrderOptions['giftReasonCodes']): Promise<OrderOptions> {
    const stores = await this.channels.listStores({ kind: 'internal' });
    const channels = await this.channels.listChannels({ kinds: FORM_CHANNEL_KINDS });
    return {
      stores: stores.map((store) => ({ id: store.id, code: store.code, name: store.name })),
      channels: channels.flatMap((channel) =>
        channel.kind === 'manual' || channel.kind === 'whatsapp' || channel.kind === 'instagram'
          ? [{ id: channel.id, code: channel.code, name: channel.name, kind: channel.kind }]
          : [],
      ),
      giftReasonCodes,
      salesTaxRate: await this.settings.get('sales_tax_rate'),
      pricesIncludeVat: await this.settings.get('prices_include_vat'),
    };
  }

  /** Every store and channel that is not archived, for the list filters (AC-4), whatever its kind. */
  async filterOptions(): Promise<OrderFilterOptions> {
    const stores = await this.channels.listStores();
    const channels = await this.channels.listChannels();
    return {
      stores: stores.map((store) => ({ id: store.id, code: store.code, name: store.name })),
      channels: channels.map((channel) => ({
        id: channel.id,
        code: channel.code,
        name: channel.name,
        kind: channel.kind,
      })),
    };
  }

  /**
   * One page of orders, newest first, for the filters and search of `query` (AC-4). A search
   * that is a phone also matches any phone of the order's customer; `customerId` matches every id
   * of a merged customer. Throws `InvalidCursorError` for a cursor this endpoint did not issue.
   */
  async list(query: OrderListQuery): Promise<OrderListResponse> {
    const db = this.connection.db;
    const lookups = await this.lookupsFor(query);
    if (lookups.customerIds !== null && lookups.customerIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    const where = listWhere(query, lookups);
    const { rows } = await db.execute<ListRow & { placed_key: string }>(sql`
      SELECT o.id, o.store_id, o.order_number, to_char(o.placed_at AT TIME ZONE 'UTC', ${MICRO}) AS placed_at,
             to_char(o.placed_at AT TIME ZONE 'UTC', ${MICRO}) AS placed_key,
             o.ship_to_name, o.channel_id, o.total_amount, o.cod_due_amount, o.fulfillment_state,
             o.cash_state, o.outcome, o.type, o.gift_reason_code,
             o.write_back_state <> 'none' AS hold,
             EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.short_quantity > 0) AS short,
             o.related_order_relation = 'reopened_from' AS reopened,
             (o.contact_phone_raw IS NOT NULL) AS phone_needs_fix
      FROM orders o ${where}
      ORDER BY o.placed_at DESC NULLS FIRST, o.id DESC NULLS FIRST
      LIMIT ${query.limit + 1}`);
    const page = rows.slice(0, query.limit);
    const stores = new Map(
      (await this.channels.stores([...new Set(page.map((row) => row.store_id))])).map((s) => [
        s.id,
        s,
      ]),
    );
    const channels = new Map(
      (await this.channels.channels([...new Set(page.map((row) => row.channel_id))])).map((c) => [
        c.id,
        c,
      ]),
    );
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        storeCode: stores.get(row.store_id)?.code ?? '',
        orderNumber: row.order_number,
        placedAt: row.placed_at,
        shipToName: row.ship_to_name,
        channelId: row.channel_id,
        channelName: channels.get(row.channel_id)?.name ?? {},
        totalAmount: row.total_amount,
        codDueAmount: row.cod_due_amount,
        fulfillmentState: row.fulfillment_state,
        cashState: row.cash_state,
        outcome: row.outcome,
        type: row.type,
        giftReasonCode: row.gift_reason_code,
        hold: row.hold,
        short: row.short,
        reopened: row.reopened === true,
        phoneNeedsFix: row.phone_needs_fix,
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeKeyset([last.placed_key, last.id]) : null,
    };
  }

  /**
   * The order page (AC-5): header, links, ship to, customer, lines with SKU codes, money, the open
   * write back commands (`ConnectorsService.syncStateFor`), and the event timeline with actor
   * names. `unitCost` is filled here and removed by the controller's cost serializer. Throws
   * `OrderNotFound` for an unknown id. Pass a transaction to read what it wrote.
   */
  async detail(orderId: string, executor: Executor = this.connection.db): Promise<OrderDetail> {
    const { rows } = await executor.execute<DetailRow>(sql`
      SELECT id, store_id, channel_id, order_number, type, gift_reason_code, original_order_id,
             related_order_id, related_order_relation, customer_id,
             to_char(placed_at AT TIME ZONE 'UTC', ${MICRO}) AS placed_at,
             to_char(operating_day, 'YYYY-MM-DD') AS operating_day,
             fulfillment_state, cash_state, outcome, write_back_state,
             to_char(confirmed_at AT TIME ZONE 'UTC', ${MICRO}) AS confirmed_at,
             to_char(cancelled_at AT TIME ZONE 'UTC', ${MICRO}) AS cancelled_at,
             cancel_reason_code,
             to_char(carrier_delivery_created_at AT TIME ZONE 'UTC', ${MICRO}) AS carrier_delivery_created_at,
             source_captured_from, source_campaign_id, source_utm_source, source_utm_medium,
             source_utm_campaign, discount_code, ship_to_name, ship_to_phone, ship_to_phone_alt,
             contact_phone_raw, ship_to_address, ship_to_area_list, ship_to_governorate_code,
             ship_to_city_code, ship_to_zone_code, courier_note, customer_note, lines_gross_amount,
             shipping_charged_amount, shipping_tax_amount, total_amount, payment_method,
             prepaid_amount, prepaid_method, credit_applied_amount, cod_expected_amount,
             cod_due_amount, cod_collected_amount, remitted_amount,
             to_char(updated_at AT TIME ZONE 'UTC', ${MICRO}) AS updated_at
      FROM orders WHERE id = ${orderId}::uuid`);
    const order = rows[0];
    if (!order) throw new OrderNotFound();
    // One after another: a transaction is one connection, and pg 9 drops queued queries.
    const lineRows = await executor.execute<LineRow>(sql`
      SELECT id, position, variant_id, title, quantity, unit_price, discount_amount, gross_amount,
             prepaid_amount, credit_applied_amount, line_state, cancel_reason_code,
             short_quantity, unit_cost
      FROM order_lines WHERE order_id = ${orderId}::uuid ORDER BY position`);
    const eventRows = await executor.execute<EventRow>(sql`
      SELECT id, machine, from_state, to_state, amount, actor_type, actor_id, reason_code,
             to_char(occurred_at AT TIME ZONE 'UTC', ${MICRO}) AS occurred_at
      FROM order_events WHERE order_id = ${orderId}::uuid ORDER BY recorded_at, id`);
    const variantIds = lineRows.rows.flatMap((line) => (line.variant_id ? [line.variant_id] : []));
    const skus = await this.catalog.getSkus(variantIds, executor);
    const names = await this.staff.namesByIds(
      eventRows.rows.flatMap((event) => (event.actor_id ? [event.actor_id] : [])),
    );
    const [store] = await this.channels.stores([order.store_id], executor);
    const [channel] = await this.channels.channels([order.channel_id], executor);
    const [brief] = order.customer_id
      ? await this.customers.briefs([order.customer_id], executor)
      : [];
    const linkedId = order.related_order_id ?? order.original_order_id;
    const related = linkedId ? await this.relatedView(executor, linkedId, order) : null;
    const linkedFrom = await this.linkedFrom(executor, orderId);
    const commands = await this.connectors.syncStateFor('order', orderId, executor);
    const area =
      order.ship_to_area_list &&
      order.ship_to_governorate_code &&
      order.ship_to_city_code &&
      order.ship_to_zone_code
        ? {
            list: order.ship_to_area_list,
            governorateCode: order.ship_to_governorate_code,
            cityCode: order.ship_to_city_code,
            zoneCode: order.ship_to_zone_code,
          }
        : null;
    return {
      id: order.id,
      storeId: order.store_id,
      storeCode: store?.code ?? '',
      storeName: store?.name ?? {},
      channelId: order.channel_id,
      channelName: channel?.name ?? {},
      orderNumber: order.order_number,
      type: order.type,
      giftReasonCode: order.gift_reason_code,
      relatedOrder: related,
      linkedFrom,
      placedAt: order.placed_at,
      operatingDay: order.operating_day,
      fulfillmentState: order.fulfillment_state,
      cashState: order.cash_state,
      outcome: order.outcome,
      writeBackState: order.write_back_state,
      confirmedAt: order.confirmed_at,
      cancelledAt: order.cancelled_at,
      cancelReasonCode: order.cancel_reason_code,
      carrierDeliveryCreatedAt: order.carrier_delivery_created_at,
      source: {
        capturedFrom: order.source_captured_from,
        campaignId: order.source_campaign_id,
        utmSource: order.source_utm_source,
        utmMedium: order.source_utm_medium,
        utmCampaign: order.source_utm_campaign,
        discountCode: order.discount_code,
      },
      shipTo: {
        name: order.ship_to_name,
        phone: order.ship_to_phone,
        phoneAlt: order.ship_to_phone_alt,
        contactPhoneRaw: order.contact_phone_raw,
        address: order.ship_to_address,
        area,
        courierNote: order.courier_note,
      },
      customerNote: order.customer_note,
      customer: brief ? { id: brief.id, name: brief.name, flagKind: brief.flagKind } : null,
      lines: lineRows.rows.map((line) => ({
        id: line.id,
        position: line.position,
        variantId: line.variant_id,
        skuCode: line.variant_id ? (skus.get(line.variant_id)?.code ?? null) : null,
        title: line.title,
        name: line.variant_id ? (skus.get(line.variant_id)?.name ?? null) : null,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        discountAmount: line.discount_amount,
        grossAmount: line.gross_amount,
        prepaidAmount: line.prepaid_amount,
        creditAppliedAmount: line.credit_applied_amount,
        lineState: line.line_state,
        cancelReasonCode: line.cancel_reason_code,
        shortQuantity: line.short_quantity,
        unitCost: line.unit_cost,
      })),
      money: {
        linesGrossAmount: order.lines_gross_amount,
        shippingChargedAmount: order.shipping_charged_amount,
        shippingTaxAmount: order.shipping_tax_amount,
        totalAmount: order.total_amount,
        paymentMethod: order.payment_method,
        prepaidAmount: order.prepaid_amount,
        prepaidMethod: order.prepaid_method,
        creditAppliedAmount: order.credit_applied_amount,
        codExpectedAmount: order.cod_expected_amount,
        codDueAmount: order.cod_due_amount,
        codCollectedAmount: order.cod_collected_amount,
        remittedAmount: order.remitted_amount,
      },
      writeBackCommands: commands.map((command) => ({
        id: command.id,
        kind: command.kind,
        syncState: command.syncState,
        failureReason: command.failureReason,
        queuedAt: command.queuedAt,
      })),
      events: eventRows.rows.map((event) => ({
        id: event.id,
        machine: event.machine,
        fromState: event.from_state,
        toState: event.to_state,
        amount: event.amount,
        actorType: event.actor_type,
        actorName: event.actor_id ? (names.get(event.actor_id) ?? null) : null,
        reasonCode: event.reason_code,
        occurredAt: event.occurred_at,
      })),
      updatedAt: order.updated_at,
    };
  }

  /** Ids, store, number, type, both states, outcome, and amounts of each known order; never a ship to field. */
  async summaryOf(
    orderIds: readonly string[],
    executor: Executor = this.connection.db,
  ): Promise<OrderSummary[]> {
    if (orderIds.length === 0) return [];
    const { rows } = await executor.execute<SummaryRow>(sql`
      SELECT id, store_id, order_number, type, fulfillment_state, cash_state, outcome, total_amount,
             cod_expected_amount, cod_due_amount, cod_collected_amount
      FROM orders WHERE id = ANY(${pgArray(orderIds)}::uuid[])
      ORDER BY id`);
    const stores = new Map(
      (await this.channels.stores([...new Set(rows.map((row) => row.store_id))], executor)).map(
        (store) => [store.id, store.code],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      storeId: row.store_id,
      storeCode: stores.get(row.store_id) ?? '',
      orderNumber: row.order_number,
      type: row.type,
      fulfillmentState: row.fulfillment_state,
      cashState: row.cash_state,
      outcome: row.outcome,
      totalAmount: row.total_amount,
      codExpectedAmount: row.cod_expected_amount,
      codDueAmount: row.cod_due_amount,
      codCollectedAmount: row.cod_collected_amount,
    }));
  }

  /**
   * The orders of a set of customer ids, newest first, keyset paged on (`placed_at`, `id`) and
   * served by `orders_customer_idx` (spec 0014's timeline). Throws `InvalidCursorError` for a
   * cursor this endpoint did not issue.
   */
  async forCustomers(
    customerIds: readonly string[],
    page: { cursor?: string | null; limit: number },
    executor: Executor = this.connection.db,
  ): Promise<CustomerOrderPage> {
    if (customerIds.length === 0) return { items: [], nextCursor: null };
    const after = page.cursor ? this.afterCursor(page.cursor) : sql``;
    const { rows } = await executor.execute<
      {
        id: string;
        store_id: string;
        order_number: string;
        placed_at: string;
        fulfillment_state: FulfillmentState;
        cash_state: CashState;
        outcome: OrderOutcome;
        total_amount: string;
        payment_method: OrderPaymentMethod;
        refused_reason_code: string | null;
      } & Record<string, unknown>
    >(sql`
      SELECT o.id, o.store_id, o.order_number, to_char(o.placed_at AT TIME ZONE 'UTC', ${MICRO}) AS placed_at,
             o.fulfillment_state, o.cash_state, o.outcome, o.total_amount, o.payment_method,
             o.refused_reason_code
      FROM orders o
      WHERE o.customer_id = ANY(${pgArray(customerIds)}::uuid[]) ${after}
      ORDER BY o.placed_at DESC NULLS FIRST, o.id DESC NULLS FIRST
      LIMIT ${page.limit + 1}`);
    const items = rows.slice(0, page.limit);
    const stores = new Map(
      (await this.channels.stores([...new Set(items.map((row) => row.store_id))], executor)).map(
        (store) => [store.id, store.code],
      ),
    );
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        id: row.id,
        storeCode: stores.get(row.store_id) ?? '',
        orderNumber: row.order_number,
        placedAt: row.placed_at,
        fulfillmentState: row.fulfillment_state,
        cashState: row.cash_state,
        outcome: row.outcome,
        totalAmount: row.total_amount,
        paymentMethod: row.payment_method,
        refusedReasonCode: row.refused_reason_code,
      })),
      nextCursor: rows.length > page.limit && last ? encodeKeyset([last.placed_at, last.id]) : null,
    };
  }

  /**
   * Counts for spec 0014: `orders` is every order of the ids (any type, all time); `refused` and
   * `returned` leave gifted orders out and, when `sinceDay` is set, count only those whose refusal
   * happened on or after that operating day (the day of the `refused` event) or, for a returned
   * line, whose order was placed on or after it. Never throws for an empty id list.
   */
  async countsForCustomers(
    customerIds: readonly string[],
    options: { sinceDay: string | null },
    executor: Executor = this.connection.db,
  ): Promise<CustomerOrderCounts> {
    if (customerIds.length === 0) return { orders: 0, refused: 0, returned: 0 };
    const refusedSince = options.sinceDay
      ? sql`AND e.operating_day >= ${options.sinceDay}::date`
      : sql``;
    const placedSince = options.sinceDay
      ? sql`AND o.operating_day >= ${options.sinceDay}::date`
      : sql``;
    const { rows } = await executor.execute<{
      orders: string;
      refused: string;
      returned: string;
    }>(sql`
      SELECT count(*) AS orders,
             count(*) FILTER (WHERE o.type <> 'gifted' AND EXISTS (
               SELECT 1 FROM order_events e
               WHERE e.order_id = o.id AND e.machine = 'fulfillment' AND e.to_state = 'refused' ${refusedSince}
             )) AS refused,
             count(*) FILTER (WHERE o.type <> 'gifted' ${placedSince} AND EXISTS (
               SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.line_state = 'returned'
             )) AS returned
      FROM orders o WHERE o.customer_id = ANY(${pgArray(customerIds)}::uuid[])`);
    const row = rows[0];
    return {
      orders: Number(row?.orders ?? 0),
      refused: Number(row?.refused ?? 0),
      returned: Number(row?.returned ?? 0),
    };
  }

  /**
   * What the Shopify write back executor needs (AC-21): store, `channel_order_ref`, the lines,
   * the ship to fields, and the shipping charge. Personal data; only the connectors module calls
   * it, and it never logs the result. Throws `OrderNotFound` for an unknown id.
   */
  async writeBackViewOf(executor: Executor, orderId: string): Promise<WriteBackView> {
    const { rows } = await executor.execute<
      {
        id: string;
        store_id: string;
        channel_order_ref: string | null;
        ship_to_name: string | null;
        ship_to_phone: string | null;
        ship_to_phone_alt: string | null;
        ship_to_address: string | null;
        courier_note: string | null;
        ship_to_area_list: string | null;
        ship_to_governorate_code: string | null;
        ship_to_city_code: string | null;
        ship_to_zone_code: string | null;
        shipping_charged_amount: string;
      } & Record<string, unknown>
    >(sql`
      SELECT id, store_id, channel_order_ref, ship_to_name, ship_to_phone, ship_to_phone_alt,
             ship_to_address, courier_note, ship_to_area_list, ship_to_governorate_code,
             ship_to_city_code, ship_to_zone_code, shipping_charged_amount
      FROM orders WHERE id = ${orderId}::uuid`);
    const order = rows[0];
    if (!order) throw new OrderNotFound();
    const lines = await executor.execute<LineRow & { channel_line_id: string | null }>(sql`
      SELECT id, channel_line_id, variant_id, quantity, unit_price, discount_amount, line_state,
             cancel_reason_code
      FROM order_lines WHERE order_id = ${orderId}::uuid ORDER BY position`);
    const [store] = await this.channels.stores([order.store_id], executor);
    return {
      orderId: order.id,
      storeId: order.store_id,
      storeCode: store?.code ?? '',
      channelOrderRef: order.channel_order_ref,
      lines: lines.rows.map((line) => ({
        id: line.id,
        channelLineId: line.channel_line_id,
        variantId: line.variant_id,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        discountAmount: line.discount_amount,
        lineState: line.line_state,
        cancelReasonCode: line.cancel_reason_code,
      })),
      shipTo: {
        name: order.ship_to_name,
        phone: order.ship_to_phone,
        phoneAlt: order.ship_to_phone_alt,
        address: order.ship_to_address,
        courierNote: order.courier_note,
        areaList: order.ship_to_area_list,
        governorateCode: order.ship_to_governorate_code,
        cityCode: order.ship_to_city_code,
        zoneCode: order.ship_to_zone_code,
      },
      shippingChargedAmount: order.shipping_charged_amount,
    };
  }

  /** The customer ids and phone the list filters resolve through the customers service. */
  private async lookupsFor(query: OrderListQuery): Promise<ListLookups> {
    let customerIds: string[] | null = null;
    if (query.customerId) {
      const canonical = await this.customers.canonicalOf(query.customerId);
      customerIds = canonical ? await this.customers.idsOf(canonical) : [];
    }
    const phone = query.q !== undefined ? phoneOfSearch(query.q) : null;
    let phoneCustomerIds: string[] = [];
    if (phone !== null) {
      const customerId = await this.customers.findByPhone(phone);
      if (customerId) phoneCustomerIds = await this.customers.idsOf(customerId);
    }
    return { customerIds, phone: phone?.e164 ?? null, phoneCustomerIds };
  }

  private afterCursor(cursor: string) {
    const { at, id } = decodeTimeIdKeyset(cursor);
    return sql`AND (o.placed_at, o.id) < (${at}::timestamptz, ${id}::uuid)`;
  }

  private async relatedView(
    executor: Executor,
    linkedId: string,
    order: DetailRow,
  ): Promise<OrderDetail['relatedOrder']> {
    const { rows } = await executor.execute<{ id: string; store_id: string; order_number: string }>(
      sql`SELECT id, store_id, order_number FROM orders WHERE id = ${linkedId}::uuid`,
    );
    const linked = rows[0];
    if (!linked) return null;
    const [store] = await this.channels.stores([linked.store_id], executor);
    return {
      id: linked.id,
      storeCode: store?.code ?? '',
      orderNumber: linked.order_number,
      relation: relationOf(order.related_order_id, order.related_order_relation),
    };
  }

  /**
   * The orders that link to this one, oldest first (the reverse of `relatedOrder`, AC-23): those
   * whose `related_order_id` or `original_order_id` is this order. Two index lookups
   * (`orders_related_order_idx`, `orders_original_order_idx`), never a scan.
   */
  private async linkedFrom(
    executor: Executor,
    orderId: string,
  ): Promise<OrderDetail['linkedFrom']> {
    const { rows } = await executor.execute<{
      id: string;
      store_id: string;
      order_number: string;
      related_order_id: string | null;
      related_order_relation: OrderRelation | null;
    }>(sql`
      SELECT id, store_id, order_number, related_order_id, related_order_relation, placed_at
      FROM (
        SELECT id, store_id, order_number, related_order_id, related_order_relation, placed_at
        FROM orders WHERE related_order_id = ${orderId}::uuid
        UNION ALL
        SELECT id, store_id, order_number, NULL::uuid, NULL::order_relation, placed_at
        FROM orders WHERE original_order_id = ${orderId}::uuid
      ) linked
      ORDER BY placed_at, id`);
    const stores = new Map(
      (await this.channels.stores([...new Set(rows.map((row) => row.store_id))], executor)).map(
        (store) => [store.id, store.code],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      storeCode: stores.get(row.store_id) ?? '',
      orderNumber: row.order_number,
      relation: relationOf(row.related_order_id, row.related_order_relation),
    }));
  }
}

/**
 * How an order relates to the one it points at: the stored relation when `related_order_id` is
 * set, else `replacement_for` (it points through `original_order_id`). A `related_order_id`
 * with no relation breaks the table check and is never answered quietly.
 */
function relationOf(
  relatedOrderId: string | null,
  relation: OrderRelation | null,
): OrderRelation | 'replacement_for' {
  if (relatedOrderId === null) return 'replacement_for';
  if (relation === null) throw new Error('An order links to another with no relation');
  return relation;
}
