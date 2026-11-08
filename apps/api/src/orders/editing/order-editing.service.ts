import { Injectable } from '@nestjs/common';
import { nextState, orderLabelOf, type OrderEditBody } from '@ssdashboard/contracts';
import { AuditService } from '../../audit/audit.service.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import { ChannelsService } from '../../channels/channels.service.js';
import { ConnectorsService } from '../../connectors/connectors.service.js';
import { CustomersService } from '../../customers/customers.service.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { auditActorOf, type OrderActor } from '../order-actor.js';
import type { OrderTransaction } from '../order-transactions.js';
import { EditInShopify, GiftNotAllowed, OrderLocked, OrderStoreMissing } from '../orders.errors.js';
import { OrderEdited } from '../orders.events.js';
import { OrderStock } from '../stock/order-stock.js';
import { lockOrderForChange } from '../writer/locked-order.js';
import { OrderWriter, type NewEventRow, type OrderColumnChanges } from '../writer/order-writer.js';
import { EDITABLE_STATES, editAuditDiff, planEdit, plannedMoneyColumns } from './edit-plan.js';

/** What `edit` answers. */
export interface EditOutcome {
  orderId: string;
  /** False when every operation named the value already stored: nothing was written. */
  changed: boolean;
}

/**
 * A person's edit of an order (spec 0013 AC-2, AC-8 to AC-11): `edit` is the one write path of
 * the edit dialog and of feature 18's queue. It locks the order, checks the concurrency token,
 * the freeze, the Shopify write back, and the gift right, plans the change with the pure
 * `planEdit`, relinks the customer when the main phone changed, writes it all through
 * `OrderWriter` with `packed` back to `confirmed` when needed (one event), and records one
 * `order.edited` audit entry and one `OrderEdited` event, all in the caller's order transaction.
 * It never writes an order table itself, never logs or puts in an event a ship to value, and
 * never opens or commits a transaction.
 */
@Injectable()
export class OrderEditing {
  /** Takes the services this write path calls: never another module's tables. */
  constructor(
    private readonly writer: OrderWriter,
    private readonly channels: ChannelsService,
    private readonly catalog: CatalogService,
    private readonly customers: CustomersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly connectors: ConnectorsService,
    private readonly stock: OrderStock,
  ) {}

  /**
   * Applies the operations of `body` to the order in one transaction (AC-9). Throws
   * `OrderNotFound`; `OrderStale` (409 `ORDER_STALE`) when `expectedUpdatedAt` is not the stored
   * `updated_at`; `OrderLocked` once the carrier delivery exists or the order left `new`,
   * `confirmed`, and `packed`; `EditInShopify` for a Shopify store order while
   * `writeBackAvailable(orderId, 'shopify.order_edit')` is false (AC-10); `GiftNotAllowed` for a
   * line or shipping operation on a gifted order when `options.mayGift` is false (a `ship_to`
   * change needs only `orders.confirm`, AC-2); and every refusal of `planEdit`. The caller checks
   * `orders.confirm` and says in `options.mayGift` whether the person also holds `orders.gift`.
   */
  async edit(
    tx: OrderTransaction,
    orderId: string,
    body: OrderEditBody,
    person: Extract<OrderActor, { type: 'person' }>,
    options: { mayGift: boolean },
  ): Promise<EditOutcome> {
    const order = await lockOrderForChange(tx, orderId, body.expectedUpdatedAt);
    if (order.carrierDeliveryCreated || !EDITABLE_STATES.includes(order.fulfillmentState)) {
      throw new OrderLocked();
    }
    const [store] = await this.channels.stores([order.storeId], tx);
    if (!store) throw new OrderStoreMissing();
    if (
      store.kind === 'shopify' &&
      !(await this.connectors.writeBackAvailable(orderId, 'shopify.order_edit'))
    ) {
      throw new EditInShopify();
    }
    if (
      order.type === 'gifted' &&
      !options.mayGift &&
      body.operations.some((operation) => operation.kind !== 'ship_to')
    ) {
      throw new GiftNotAllowed();
    }

    const variantIds = body.operations.flatMap((operation) =>
      operation.kind === 'add_line' || operation.kind === 'replace_line'
        ? [operation.variantId]
        : [],
    );
    const skus = await this.catalog.getSkus(variantIds, tx);
    const titles = new Map<string, string>();
    for (const [id, sku] of skus) {
      if (!sku.archived) titles.set(id, sku.name.en ?? sku.name.ar ?? sku.code);
    }
    const plan = planEdit(order, body.operations, {
      taxRate: await this.settings.get('sales_tax_rate', tx),
      pricesIncludeVat: await this.settings.get('prices_include_vat', tx),
      titles,
      allowZeroNetLines: options.mayGift,
      // A person's edit exists to fix the phone: one that does not parse is refused (review R3).
      unparseablePhone: 'refuse',
      unparseablePhoneAlt: 'refuse',
    });
    if (!plan.changed) return { orderId, changed: false };

    const columns: OrderColumnChanges = { ...plan.shipToColumns, ...plannedMoneyColumns(plan) };
    if (plan.phone !== null) {
      const customer = await this.customers.findOrCreate(tx, {
        phone: plan.phone,
        channelCustomer: null,
        name: plan.shipToColumns.shipToName ?? order.shipTo.name,
        seenAt: order.placedAt,
      });
      columns.customerId = customer.customerId;
    }
    const events: NewEventRow[] = [];
    if (plan.backToConfirmed) {
      nextState({
        machine: 'fulfillment',
        from: 'packed',
        to: 'confirmed',
        actor: 'person',
        reasonCode: body.reasonCode ?? null,
        carrierDeliveryCreated: order.carrierDeliveryCreated,
      });
      columns.fulfillmentState = 'confirmed';
      events.push({
        machine: 'fulfillment',
        fromState: 'packed',
        toState: 'confirmed',
        amount: null,
        actor: person,
        reasonCode: body.reasonCode ?? null,
        sourceType: null,
        sourceId: null,
        occurredAt: new Date(),
      });
    }

    const applied = await this.writer.applyChange(tx, orderId, {
      columns,
      cancelLines: plan.cancelLines,
      lineShares: plan.moneyChanged ? plan.lineShares : undefined,
      addLines: plan.addLines.map((line) => ({
        position: line.position,
        variantId: line.variantId,
        title: line.title,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
        netAmount: line.netAmount,
        taxRate: line.taxRate,
        taxAmount: line.taxAmount,
        grossAmount: line.grossAmount,
        prepaidAmount: line.prepaidAmount,
        creditAppliedAmount: line.creditAppliedAmount,
        lineState: 'open',
        channelLineId: line.channelLineId,
      })),
      events,
    });
    const cancelledLineIds = plan.cancelLines.map((line) => line.lineId);
    await this.stock.afterEdit(tx, orderId, {
      addedLineIds: applied.lineIds,
      cancelledLineIds,
    });

    const actor = auditActorOf(person);
    const correlationId = this.audit.newCorrelationId(actor);
    const diff = editAuditDiff(order, plan, applied.lineIds, 'person');
    await this.audit.record(tx, {
      actor,
      action: 'order.edited',
      record: {
        type: 'order',
        id: orderId,
        label: orderLabelOf({ storeCode: store.code, orderNumber: order.orderNumber }),
      },
      before: diff.before,
      after: diff.after,
      ...(body.reasonCode ? { reason: body.reasonCode } : {}),
      correlationId,
    });
    await this.events.publish(
      tx,
      new OrderEdited(
        orderId,
        order.storeId,
        'person',
        applied.lineIds,
        cancelledLineIds,
        plan.changedShipToFields,
        plan.shippingChanged,
        correlationId,
      ),
    );
    return { orderId, changed: true };
  }
}
