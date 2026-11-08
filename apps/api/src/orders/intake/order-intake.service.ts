import { Injectable } from '@nestjs/common';
import {
  Money,
  firstCashState,
  orderLabelOf,
  type CreateGiftedOrderBody,
  type CreateManualOrderBody,
  type OrderPaymentMethod,
} from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import { AuditService, type JsonObject } from '../../audit/audit.service.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import { ChannelsService, type ChannelKind } from '../../channels/channels.service.js';
import { CustomersService } from '../../customers/customers.service.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { NumberingService } from '../../platform/numbering.service.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { auditActorOf, type OrderActor } from '../order-actor.js';
import type { OrderTransaction } from '../order-transactions.js';
import {
  ChannelNotAllowed,
  GiftMustStayFree,
  InvalidOrderInput,
  LineFullyDiscounted,
  PartialPrepaymentNotSupported,
  RelatedOrderOtherCustomer,
  StoreNotInternal,
  VariantUnknown,
} from '../orders.errors.js';
import { OrderAttentionRaised, OrderPlaced } from '../orders.events.js';
import { priceLines, totalsOf } from '../writer/order-money.js';
import { OrderWriter, type NewLineRow, type OrderSourceColumns } from '../writer/order-writer.js';
import { assertNotReopened, planRelatedOrder } from './related-order.js';
import { parsePhones } from './ship-to.js';

/** The channel kinds a manual order may arrive on (spec 0013 AC-1). */
const MANUAL_CHANNEL_KINDS: readonly ChannelKind[] = ['manual', 'whatsapp', 'instagram'];

/** What `createManual` answers: the order, and whether this call made it. */
export interface CreatedManualOrder {
  id: string;
  storeCode: string;
  orderNumber: string;
  /** False when the same `clientRef` had already made this order and nothing was written. */
  created: boolean;
}

const NO_SOURCE: OrderSourceColumns = {
  capturedFrom: 'manual',
  campaignId: null,
  adsetId: null,
  adId: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  landingPage: null,
  referrer: null,
  mediaBuyerId: null,
  influencerCode: null,
};

const isGifted = (
  body: CreateManualOrderBody | CreateGiftedOrderBody,
): body is CreateGiftedOrderBody => 'giftReasonCode' in body;

/**
 * How orders come in (spec 0013, write paths). Milestone 1 holds `createManual`, the one write
 * path of the manual, gifted, reopened, and replacement order forms; the channel calls of feature
 * 13 arrive in milestone 3. Every method takes an `OrderTransaction`, so the order, its customer
 * link, its number, its events, and its audit entry commit or roll back together. It must never
 * write an order table itself (`OrderWriter` does), never log or put in an event a ship to field,
 * and never open or commit a transaction.
 */
@Injectable()
export class OrderIntake {
  /** Takes the services this write path calls: never another module's tables. */
  constructor(
    private readonly writer: OrderWriter,
    private readonly channels: ChannelsService,
    private readonly catalog: CatalogService,
    private readonly customers: CustomersService,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  /**
   * Creates a sale, gifted, reopened, or replacement order entered by a person (AC-1, AC-2,
   * AC-23): in one transaction the order gets its number, priced lines, totals, allocation, COD
   * figures, its first fulfillment event (`null` to `new`) and first cash event, the customer link
   * from the main phone, and the `order.created_manually` audit entry. A repeat of the same
   * `clientRef` in the store returns the first order and writes nothing. Throws `StoreNotInternal`,
   * `ChannelNotAllowed`, `VariantUnknown`, `PartialPrepaymentNotSupported`, `GiftMustStayFree`,
   * `RelatedOrderUnknown`, `RelatedOrderState`, `RelatedOrderOtherCustomer`, `AlreadyReopened`,
   * `LineFullyDiscounted`, or `InvalidPhoneAlt`. The caller checks the permission
   * (`orders.confirm`, or `orders.gift` for the gifted body) and says in `options.mayGift`
   * whether the person also holds `orders.gift`: only such a person may enter a sale line whose
   * net is 0, because that is a gift in all but name (security S1).
   */
  async createManual(
    tx: OrderTransaction,
    body: CreateManualOrderBody | CreateGiftedOrderBody,
    person: Extract<OrderActor, { type: 'person' }>,
    options: { mayGift: boolean },
  ): Promise<CreatedManualOrder> {
    // One order per clientRef in a store, also when two requests race: the second waits here.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`orders.client_ref:${body.storeId}:${body.clientRef}`}))`,
    );
    const existing = await this.findByClientRef(tx, body.storeId, body.clientRef);
    if (existing) return { ...existing, created: false };

    const [store] = await this.channels.stores([body.storeId], tx);
    if (!store || store.kind !== 'internal' || store.archived) throw new StoreNotInternal();
    const [channel] = await this.channels.channels([body.channelId], tx);
    if (!channel || channel.archived || !MANUAL_CHANNEL_KINDS.includes(channel.kind)) {
      throw new ChannelNotAllowed();
    }

    const gifted = isGifted(body);
    const variants = await this.catalog.getSkus(
      body.lines.map((line) => line.variantId),
      tx,
    );
    const titles = body.lines.map((line) => {
      const sku = variants.get(line.variantId);
      if (!sku || sku.archived) throw new VariantUnknown();
      return sku.name.en ?? sku.name.ar ?? sku.code;
    });

    const phones = parsePhones(body.shipTo.phone, body.shipTo.phoneAlt);
    const placedAt = await this.transactionNow(tx);
    // The linked order's row lock comes first (spec 0013, Key invariants), then the customer locks.
    const plan = await planRelatedOrder(tx, body.relatedOrder, gifted ? 'gifted' : 'sale');
    const customer = await this.customers.findOrCreate(tx, {
      phone: phones.main,
      channelCustomer: null,
      name: body.shipTo.name,
      seenAt: placedAt,
    });
    if (plan?.asked === 'reopened_from') {
      await this.assertSameCustomer(tx, plan.originalCustomerId, customer.customerId);
      if (plan.relatedOrderId) await assertNotReopened(tx, plan.relatedOrderId);
    }

    const taxRate = await this.settings.get('sales_tax_rate', tx);
    const pricesIncludeVat = await this.settings.get('prices_include_vat', tx);
    const priced = priceLines(
      body.lines.map((line) => ({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
      })),
      taxRate,
      pricesIncludeVat,
    );

    // A sale line with nothing to pay is a gift: only a person who may gift can enter one.
    if (!gifted && !options.mayGift && priced.some((l) => Money.of(l.netAmount).isZero())) {
      throw new LineFullyDiscounted();
    }

    const shippingCharged = body.shippingChargedAmount;
    let paymentMethod: OrderPaymentMethod;
    let prepaid = '0.00';
    if (isGifted(body)) {
      if (
        !Money.of(shippingCharged).isZero() ||
        priced.some((l) => !Money.of(l.grossAmount).isZero())
      ) {
        throw new GiftMustStayFree();
      }
      paymentMethod = 'none';
    } else {
      paymentMethod = body.paymentMethod;
      prepaid = body.prepaidAmount;
    }

    // The total is known before the prepayment is judged: a deposit is not supported (AC-1).
    const unpaid = totalsOf({
      lines: priced,
      shippingChargedAmount: shippingCharged,
      prepaidAmount: '0.00',
      creditAppliedAmount: '0.00',
      taxRate,
      fulfillmentState: 'new',
    });
    if (!Money.of(prepaid).isZero() && !Money.of(prepaid).equals(Money.of(unpaid.totalAmount))) {
      throw new PartialPrepaymentNotSupported();
    }
    const totals = totalsOf({
      lines: priced,
      shippingChargedAmount: shippingCharged,
      prepaidAmount: prepaid,
      creditAppliedAmount: '0.00',
      taxRate,
      fulfillmentState: 'new',
    });
    if (Money.of(totals.totalAmount).isZero() && !gifted) {
      throw new InvalidOrderInput('A sale needs an amount to collect or a prepayment');
    }

    // The counter row stays locked until this transaction ends, so the number is taken last.
    const orderNumber = await this.numbering.next(tx, 'SO', placedAt);

    const cash = firstCashState({
      codExpectedAmount: totals.codExpectedAmount,
      prepaidAmount: prepaid,
    });
    const source: OrderSourceColumns = plan?.copied?.source ?? {
      ...NO_SOURCE,
      capturedFrom: channel.kind === 'whatsapp' ? 'whatsapp_thread' : 'manual',
    };
    const area = body.shipTo.area ?? null;
    const lines: NewLineRow[] = priced.map((line, index) => ({
      position: line.position,
      variantId: body.lines[index]?.variantId ?? null,
      title: titles[index] ?? '',
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      netAmount: line.netAmount,
      taxRate: line.taxRate,
      taxAmount: line.taxAmount,
      grossAmount: line.grossAmount,
      prepaidAmount: totals.lineShares[index]?.prepaidAmount ?? '0.00',
      creditAppliedAmount: totals.lineShares[index]?.creditAppliedAmount ?? '0.00',
      lineState: 'open',
      channelLineId: null,
    }));

    const inserted = await this.writer.insertOrder(
      tx,
      {
        storeId: store.id,
        channelId: channel.id,
        orderNumber,
        channelOrderRef: body.clientRef,
        type: plan?.type ?? (gifted ? 'gifted' : 'sale'),
        originalOrderId: plan?.originalOrderId ?? null,
        relatedOrderId: plan?.relatedOrderId ?? null,
        relatedOrderRelation: plan?.relatedOrderRelation ?? null,
        customerId: customer.customerId,
        placedAt,
        fulfillmentState: 'new',
        cashState: cash,
        outcome: totals.outcome,
        linesGrossAmount: totals.linesGrossAmount,
        shippingChargedAmount: shippingCharged,
        shippingTaxAmount: totals.shippingTaxAmount,
        totalAmount: totals.totalAmount,
        prepaidAmount: prepaid,
        creditAppliedAmount: '0.00',
        shippingPrepaidAmount: totals.shippingPrepaidAmount,
        shippingCreditAppliedAmount: totals.shippingCreditAppliedAmount,
        codExpectedAmount: totals.codExpectedAmount,
        codDueAmount: totals.codDueAmount,
        deliveredAmount: totals.deliveredAmount,
        paymentMethod,
        prepaidMethod: Money.of(prepaid).isZero() ? null : paymentMethod,
        source,
        discountCode: plan?.copied?.discountCode ?? null,
        giftReasonCode: isGifted(body) ? body.giftReasonCode : null,
        customerNote: null,
        shipToName: body.shipTo.name,
        shipToPhone: phones.main?.e164 ?? null,
        shipToPhoneAlt: phones.alt,
        contactPhoneRaw: phones.mainRaw,
        shipToAddress: body.shipTo.address,
        shipToAreaList: area?.list ?? null,
        shipToGovernorateCode: area?.governorateCode ?? null,
        shipToCityCode: area?.cityCode ?? null,
        shipToZoneCode: area?.zoneCode ?? null,
        courierNote: body.shipTo.courierNote ?? null,
      },
      lines,
    );

    await this.events.publish(
      tx,
      new OrderPlaced(
        inserted.id,
        store.id,
        channel.id,
        plan?.type ?? (gifted ? 'gifted' : 'sale'),
        placedAt.toISOString(),
        customer.customerId,
        plan?.relatedOrderId ?? plan?.originalOrderId ?? null,
        plan?.asked ?? null,
      ),
    );
    await this.writer.insertEvents(tx, inserted.id, [
      {
        machine: 'fulfillment',
        fromState: null,
        toState: 'new',
        amount: null,
        actor: person,
        reasonCode: null,
        sourceType: null,
        sourceId: null,
        occurredAt: placedAt,
      },
      {
        machine: 'cash',
        fromState: null,
        toState: cash,
        amount: null,
        actor: person,
        reasonCode: null,
        sourceType: null,
        sourceId: null,
        occurredAt: placedAt,
      },
    ]);

    const label = orderLabelOf({ storeCode: store.code, orderNumber });
    const after: JsonObject = {
      type: plan?.type ?? (gifted ? 'gifted' : 'sale'),
      giftReasonCode: isGifted(body) ? body.giftReasonCode : null,
      relatedOrderId: body.relatedOrder?.orderId ?? null,
      relation: plan?.asked ?? null,
      totalAmount: totals.totalAmount,
      paymentMethod,
      // What was priced, so a manager can see a discount: no name, phone, or address.
      lines: body.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
      })),
      // What a reopened order took from the order it was reopened from.
      copiedFromRelated: plan?.copied
        ? {
            discountCode: plan.copied.discountCode,
            capturedFrom: plan.copied.source.capturedFrom,
            campaignId: plan.copied.source.campaignId,
            adsetId: plan.copied.source.adsetId,
            adId: plan.copied.source.adId,
            utmSource: plan.copied.source.utmSource,
            utmMedium: plan.copied.source.utmMedium,
            utmCampaign: plan.copied.source.utmCampaign,
            utmContent: plan.copied.source.utmContent,
            landingPage: plan.copied.source.landingPage,
            referrer: plan.copied.source.referrer,
            mediaBuyerId: plan.copied.source.mediaBuyerId,
            influencerCode: plan.copied.source.influencerCode,
          }
        : null,
    };
    await this.audit.record(tx, {
      actor: auditActorOf(person),
      action: 'order.created_manually',
      record: { type: 'order', id: inserted.id, label },
      after,
      reason: createdReason(gifted, plan?.asked ?? null, channel.kind),
      correlationId: this.audit.newCorrelationId(auditActorOf(person)),
    });

    if (phones.main === null) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(inserted.id, 'phone_unparseable', 'order', inserted.id),
      );
    }
    return { id: inserted.id, storeCode: store.code, orderNumber, created: true };
  }

  /** The transaction's own `now()`, the order's `placed_at` and the base of its number's year. */
  private async transactionNow(tx: OrderTransaction): Promise<Date> {
    const { rows } = await tx.execute<{ at: string }>(
      sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`,
    );
    const at = rows[0]?.at;
    if (!at) throw new Error('The database returned no time');
    return new Date(at);
  }

  /**
   * A reopened order belongs to the customer of the order it reopens, canonical on both sides
   * (spec 0014): an order with no customer on either side cannot be shown to match and is refused.
   */
  private async assertSameCustomer(
    tx: OrderTransaction,
    originalCustomerId: string | null,
    newCustomerId: string | null,
  ): Promise<void> {
    if (originalCustomerId === null || newCustomerId === null) {
      throw new RelatedOrderOtherCustomer();
    }
    const original = await this.customers.canonicalOf(originalCustomerId, tx);
    const created = await this.customers.canonicalOf(newCustomerId, tx);
    if (original === null || original !== created) throw new RelatedOrderOtherCustomer();
  }

  private async findByClientRef(
    tx: OrderTransaction,
    storeId: string,
    clientRef: string,
  ): Promise<{ id: string; storeCode: string; orderNumber: string } | null> {
    // Names the tenant so the partial unique index (tenant, store, ref) serves the lookup.
    const { rows } = await tx.execute<{ id: string; order_number: string }>(sql`
      SELECT id, order_number FROM orders
      WHERE tenant_id = current_setting('ssd.tenant_id')::uuid
        AND store_id = ${storeId}::uuid AND channel_order_ref = ${clientRef}
        AND channel_order_ref IS NOT NULL`);
    const row = rows[0];
    if (!row) return null;
    const [store] = await this.channels.stores([storeId], tx);
    return { id: row.id, storeCode: store?.code ?? '', orderNumber: row.order_number };
  }
}

/** The `order.created_manually` reason code of a creation (spec 0013, Audit). */
function createdReason(
  gifted: boolean,
  relation: 'reopened_from' | 'replacement_for' | 'goodwill_for' | null,
  channelKind: ChannelKind,
): string {
  if (gifted) return 'gift';
  if (relation === 'reopened_from') return 'reopened';
  if (relation === 'replacement_for') return 'replacement';
  if (channelKind === 'whatsapp') return 'whatsapp_order';
  if (channelKind === 'instagram') return 'instagram_order';
  return 'phone_order';
}
