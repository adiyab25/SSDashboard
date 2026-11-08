import { Injectable } from '@nestjs/common';
import {
  Money,
  PAYMENT_METHOD_REDERIVED,
  firstCashState,
  nextState,
  orderLabelOf,
  type CashState,
  type ChannelCustomerInput,
  type ChannelOrderInput,
  type ChannelOrderSnapshot,
  type CreateGiftedOrderBody,
  type CreateManualOrderBody,
  type OrderPaymentMethod,
  type RederivePaymentMethodInput,
} from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import { AuditService, type JsonObject } from '../../audit/audit.service.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import { ChannelsService, type ChannelKind } from '../../channels/channels.service.js';
import { ConnectorsService } from '../../connectors/connectors.service.js';
import { CustomersService } from '../../customers/customers.service.js';
import { DomainEvents } from '../../platform/events/domain-events.js';
import { NumberingService } from '../../platform/numbering.service.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { auditActorOf, type OrderActor } from '../order-actor.js';
import type { OrderTransaction } from '../order-transactions.js';
import {
  EDITABLE_STATES,
  editAuditDiff,
  planEdit,
  plannedMoneyColumns,
  type EditContext,
  type PlannedEdit,
} from '../editing/edit-plan.js';
import {
  ChannelLineIdConflict,
  ChannelNotAllowed,
  EditChangesPayment,
  EditOverpaid,
  GiftMustStayFree,
  InvalidOrderInput,
  LineAlreadyMapped,
  LineFullyDiscounted,
  OrderLocked,
  OrderNeedsALine,
  OrderNotFound,
  OrderStoreMissing,
  OrdersError,
  PartialPrepaymentNotSupported,
  PaymentMethodLocked,
  RelatedOrderOtherCustomer,
  StoreNotInternal,
  VariantUnknown,
} from '../orders.errors.js';
import { OrderAttentionRaised, OrderEdited, OrderPlaced } from '../orders.events.js';
import { OrderStock } from '../stock/order-stock.js';
import { OrderTransitions } from '../transitions/order-transitions.service.js';
import { lockOrderForChange } from '../writer/locked-order.js';
import { priceLines, totalsOf } from '../writer/order-money.js';
import {
  OrderWriter,
  type NewEventRow,
  type NewLineRow,
  type OrderColumnChanges,
  type OrderSourceColumns,
} from '../writer/order-writer.js';
import { assertFoundAmounts, planFirstStates } from './channel-first-states.js';
import { diffChannelSnapshot } from './channel-snapshot.js';
import { assertNotReopened, planRelatedOrder } from './related-order.js';
import { parseChannelPhones, parsePhones } from './ship-to.js';

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

/** The actor of feature 13's channel calls: its webhook and sweep jobs. */
export type ChannelActor = Extract<OrderActor, { type: 'system_job' }>;

/** Who may create an order from a channel: feature 13's jobs, or an import run (feature 15). */
export type ChannelCreateActor = Extract<OrderActor, { type: 'system_job' | 'import' }>;

/** What `createFromChannel` answers. */
export interface ChannelOrderCreated {
  orderId: string;
  /** False when the store already held an order with that channel ref: nothing was written. */
  created: boolean;
}

/** Why `applyChannelEdit` applied nothing (spec 0013 AC-14). */
export type ChannelEditRefusal =
  | 'write_back_open'
  | 'carrier_delivery_exists'
  | 'not_editable'
  | 'changes_payment'
  | 'overpaid'
  | 'needs_a_line'
  | 'gift_must_stay_free';

/** What `applyChannelEdit` answers. */
export type ChannelEditResult =
  { applied: true; changed: boolean } | { applied: false; why: ChannelEditRefusal };

/** What `cancelFromChannel` answers. */
export type ChannelCancelResult =
  { applied: true } | { applied: false; why: 'already_final' | 'after_pickup' };

/** The `order.edited` reason and the event reason of a channel edit (spec 0013 Audit). */
const CHANNEL_EDIT_REASON = 'channel_edit';

/** The cash states a payment method correction may move between (State machines rule 4). */
const FIRST_CASH_STATES: readonly CashState[] = ['unpaid', 'prepaid', 'nothing_to_collect'];

const NO_SHARE = { prepaidAmount: '0.00', creditAppliedAmount: '0.00' };

/** The `applyChannelEdit` answer of a refusal of the edit plan, or null for any other error. */
function notAppliedReasonOf(error: unknown): Exclude<ChannelEditRefusal, 'write_back_open'> | null {
  if (error instanceof EditChangesPayment) return 'changes_payment';
  if (error instanceof EditOverpaid) return 'overpaid';
  // Unreachable from a snapshot (it holds at least one line, which stays open or is added); kept
  // so a planner refusal never escapes as an error.
  if (error instanceof OrderNeedsALine) return 'needs_a_line';
  if (error instanceof GiftMustStayFree) return 'gift_must_stay_free';
  if (error instanceof OrderLocked) return 'not_editable';
  return null;
}

const isGifted = (
  body: CreateManualOrderBody | CreateGiftedOrderBody,
): body is CreateGiftedOrderBody => 'giftReasonCode' in body;

/**
 * How orders come in (spec 0013, write paths): `createManual`, the one write path of the manual,
 * gifted, reopened, and replacement order forms (milestone 1), and the in process calls of
 * feature 13 (milestone 3): `createFromChannel`, `applyChannelEdit`, `recordChannelLineIds`,
 * `linkChannelLineVariant`, `rederivePaymentMethod`, and `cancelFromChannel`. Every method takes an `OrderTransaction`, so the order, its customer
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
    private readonly connectors: ConnectorsService,
    private readonly transitions: OrderTransitions,
    private readonly stock: OrderStock,
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

    await this.stock.afterCreate(tx, inserted.id, inserted.lineIds);

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

  /**
   * Creates an order from a channel (spec 0013 AC-14, AC-23, AC-25 a; feature 13's Shopify intake,
   * later 15 and 53). Idempotent on (`tenant_id`, `store_id`, `channel_order_ref`): a repeat
   * returns `{ orderId, created: false }` and writes nothing. In one transaction the order gets the
   * channel's number and placed time, lines priced with each line's own tax rate (an unmapped
   * line, `variantId` null, keeps the channel's title), totals and an allocation of whatever was
   * prepaid (a deposit is stored as it arrives), the customer link from the main phone and the
   * channel's customer id, the customer note, the source fields (a `reopened_from` copies the
   * original's), and its first events: `new` and `firstCashState`, or the go live state of a
   * `system_job` (one event `null` to `confirmed`, reason `go_live_import`), or the found states of
   * an `import` (which takes no reservation when found past `packed` or cancelled). Publishes
   * `OrderPlaced`, one `OrderStateChanged` per event, and `phone_unparseable` for a main phone
   * that does not parse (or is missing) and for a second phone that does not parse (not stored).
   * Writes no audit entry (only a person's creation is audited).
   *
   * Throws `OrderNumberTaken` when the store already holds the number under another ref,
   * `InvalidOrderInput` (an unknown or archived store or channel, first states the actor may not
   * send, a prepayment above the total, a link the order type cannot take), `VariantUnknown` (a
   * mapped variant that does not exist), `GiftMustStayFree`, and the link errors of `createManual`
   * (`RelatedOrderState` on the channel path, `RelatedOrderUnknown`, `RelatedOrderOtherCustomer`,
   * `AlreadyReopened`). Never logs or puts in an error a ship to field or the note.
   */
  async createFromChannel(
    tx: OrderTransaction,
    input: ChannelOrderInput,
    actor: ChannelCreateActor,
  ): Promise<ChannelOrderCreated> {
    // The same lock as the manual path: both keep one order per channel ref in a store.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`orders.client_ref:${input.storeId}:${input.channelOrderRef}`}))`,
    );
    const existing = await this.findByClientRef(tx, input.storeId, input.channelOrderRef);
    if (existing) return { orderId: existing.id, created: false };

    const [store] = await this.channels.stores([input.storeId], tx);
    const [channel] = await this.channels.channels([input.channelId], tx);
    if (!store || store.archived || !channel || channel.archived) {
      throw new InvalidOrderInput('The store or channel is unknown or archived');
    }
    // Security M2 (lead ruling): a channel order arrives on a channel bound to its store, never
    // on a manual entry channel, and never takes a number shaped like the store's own numbering.
    if (channel.defaultStoreId !== store.id) {
      throw new InvalidOrderInput('The channel does not belong to the store');
    }
    if (MANUAL_CHANNEL_KINDS.includes(channel.kind)) {
      throw new InvalidOrderInput('A manual entry channel takes orders only from the order form');
    }
    if (store.kind === 'internal' && (await this.isDocumentNumber(tx, input.orderNumber))) {
      throw new InvalidOrderInput('An internal store numbers its own orders');
    }
    const placedAt = new Date(input.placedAt);
    const first = planFirstStates(input.firstStates, actor, placedAt);
    const relation = input.relatedOrder?.relation ?? null;
    if (input.type === 'gifted' ? relation === 'replacement_for' : relation === 'goodwill_for') {
      throw new InvalidOrderInput('This kind of order cannot take that link');
    }
    await this.assertVariantsExist(tx, input.lines);
    const phones = parseChannelPhones(input.shipTo.phone, input.shipTo.phoneAlt);
    const channelCustomer = await this.boundChannelCustomer(tx, input.channelCustomer, store.id);

    // The linked order's row lock comes first (spec 0013, Key invariants), then the customer locks.
    const plan = await planRelatedOrder(tx, input.relatedOrder, input.type);
    const customer = await this.customers.findOrCreate(tx, {
      phone: phones.main,
      channelCustomer,
      name: input.shipTo.name,
      seenAt: placedAt,
    });
    if (plan?.asked === 'reopened_from') {
      await this.assertSameCustomer(tx, plan.originalCustomerId, customer.customerId);
      if (plan.relatedOrderId) await assertNotReopened(tx, plan.relatedOrderId);
    }

    const taxRate = await this.settings.get('sales_tax_rate', tx);
    const pricesIncludeVat = await this.settings.get('prices_include_vat', tx);
    const priced = input.lines.map((line, index) => {
      const [one] = priceLines([line], line.taxRate, pricesIncludeVat);
      if (!one) throw new Error('Pricing one line returned none');
      return { ...one, position: index + 1, lineState: first.lineState };
    });
    if (
      input.type === 'gifted' &&
      (!Money.of(input.shippingChargedAmount).isZero() ||
        priced.some((line) => !Money.of(line.grossAmount).isZero()))
    ) {
      throw new GiftMustStayFree();
    }
    const total = priced
      .reduce((sum, line) => sum.plus(Money.of(line.grossAmount)), Money.zero)
      .plus(Money.of(input.shippingChargedAmount));
    if (Money.of(input.prepaidAmount).cents > total.cents) {
      throw new InvalidOrderInput('The prepayment is above the order total');
    }
    const totals = totalsOf({
      lines: priced,
      shippingChargedAmount: input.shippingChargedAmount,
      prepaidAmount: input.prepaidAmount,
      creditAppliedAmount: '0.00',
      // The channel's shipping tax rate when it sends one (review minor 7), else the setting.
      taxRate: input.shippingTaxRate ?? taxRate,
      fulfillmentState: first.fulfillment,
    });
    assertFoundAmounts(first, {
      codExpectedAmount: totals.codExpectedAmount,
      codDueAmount: totals.codDueAmount,
      prepaidAmount: input.prepaidAmount,
    });
    const cash =
      first.cash ??
      firstCashState({
        codExpectedAmount: totals.codExpectedAmount,
        prepaidAmount: input.prepaidAmount,
      });
    // A media buyer id from a channel is not stored until it can be checked in this transaction
    // (review minor 6): an unknown id would fail the foreign key and poison the webhook.
    const source: OrderSourceColumns = plan?.copied?.source ?? {
      ...input.source,
      mediaBuyerId: null,
    };
    const type = plan?.type ?? input.type;
    const area = input.shipTo.area ?? null;
    const lines: NewLineRow[] = priced.map((line, index) => ({
      position: line.position,
      variantId: input.lines[index]?.variantId ?? null,
      title: input.lines[index]?.title ?? '',
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      netAmount: line.netAmount,
      taxRate: line.taxRate,
      taxAmount: line.taxAmount,
      grossAmount: line.grossAmount,
      prepaidAmount: totals.lineShares[index]?.prepaidAmount ?? '0.00',
      creditAppliedAmount: totals.lineShares[index]?.creditAppliedAmount ?? '0.00',
      lineState: line.lineState,
      channelLineId: input.lines[index]?.channelLineId ?? null,
    }));

    const inserted = await this.writer.insertOrder(
      tx,
      {
        storeId: store.id,
        channelId: channel.id,
        orderNumber: input.orderNumber,
        channelOrderRef: input.channelOrderRef,
        type,
        originalOrderId: plan?.originalOrderId ?? null,
        relatedOrderId: plan?.relatedOrderId ?? null,
        relatedOrderRelation: plan?.relatedOrderRelation ?? null,
        customerId: customer.customerId,
        placedAt,
        fulfillmentState: first.fulfillment,
        cashState: cash,
        outcome: totals.outcome,
        linesGrossAmount: totals.linesGrossAmount,
        shippingChargedAmount: input.shippingChargedAmount,
        shippingTaxAmount: totals.shippingTaxAmount,
        totalAmount: totals.totalAmount,
        prepaidAmount: input.prepaidAmount,
        creditAppliedAmount: '0.00',
        shippingPrepaidAmount: totals.shippingPrepaidAmount,
        shippingCreditAppliedAmount: totals.shippingCreditAppliedAmount,
        codExpectedAmount: totals.codExpectedAmount,
        codDueAmount: totals.codDueAmount,
        deliveredAmount: totals.deliveredAmount,
        paymentMethod: input.paymentMethod,
        prepaidMethod: input.prepaidMethod,
        source,
        discountCode: plan?.copied?.discountCode ?? input.discountCode,
        giftReasonCode: input.giftReasonCode,
        customerNote: input.customerNote,
        shipToName: input.shipTo.name,
        shipToPhone: phones.main?.e164 ?? null,
        shipToPhoneAlt: phones.alt,
        contactPhoneRaw: phones.mainRaw,
        shipToAddress: input.shipTo.address,
        shipToAreaList: area?.list ?? null,
        shipToGovernorateCode: area?.governorateCode ?? null,
        shipToCityCode: area?.cityCode ?? null,
        shipToZoneCode: area?.zoneCode ?? null,
        courierNote: input.shipTo.courierNote,
        confirmedAt: first.confirmedAt,
        cancelledAt: first.cancelledAt,
        cancelReasonCode: first.cancelReasonCode,
        refusedReasonCode: first.refusedReasonCode,
        carrierDeliveryCreatedAt: first.carrierDeliveryCreatedAt,
        codCollectedAmount: first.collected ? totals.codDueAmount : '0.00',
        remittedAmount: first.remitted ? totals.codDueAmount : '0.00',
      },
      lines,
    );

    await this.events.publish(
      tx,
      new OrderPlaced(
        inserted.id,
        store.id,
        channel.id,
        type,
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
        toState: first.fulfillment,
        amount: null,
        actor,
        reasonCode: first.fulfillmentReason,
        sourceType: first.eventSource?.type ?? null,
        sourceId: first.eventSource?.id ?? null,
        occurredAt: placedAt,
      },
      {
        machine: 'cash',
        fromState: null,
        toState: cash,
        amount: null,
        actor,
        reasonCode: null,
        sourceType: first.eventSource?.type ?? null,
        sourceId: first.eventSource?.id ?? null,
        occurredAt: placedAt,
      },
    ]);
    if (first.takesStock) await this.stock.afterCreate(tx, inserted.id, inserted.lineIds);
    await this.raisePhoneAttentions(tx, inserted.id, phones.main === null, phones.altUnparseable);
    return { orderId: inserted.id, created: true };
  }

  /**
   * Applies a channel's netted snapshot of an order (spec 0013 AC-14, AC-11): diffs it by
   * `channel_line_id` and the ship to fields (`diffChannelSnapshot`) and plans it with the same
   * `planEdit` as a person's edit, with the channel's rules: a main phone that does not parse is
   * kept as typed and unlinks the customer, a second one that does not parse is dropped, both
   * raise `phone_unparseable`; a new main phone relinks the customer; `packed` goes back to
   * `confirmed` (actor `system_job`); a snapshot never changes `prepaid_amount` or
   * `credit_applied_amount`. An applied change writes one `order.edited` entry (actor
   * `system_job`, reason `channel_edit`, `after.origin = 'channel'`) and publishes `OrderEdited`
   * with `origin: 'channel'`; lines matched by variant, quantity, and price take the channel's id.
   *
   * Applies nothing and answers `{ applied: false, why }`: `write_back_open` while an outbound
   * command on the order is open (no attention; feature 13 reads the order again once it
   * settles); and, raising `channel_edit_not_applied`, `carrier_delivery_exists` (the freeze) or
   * `not_editable` (past `packed`, or cancelled) when the snapshot would change anything,
   * `changes_payment`, `overpaid`, `needs_a_line`, and `gift_must_stay_free`. A snapshot that
   * changes nothing answers `{ applied: true, changed: false }` and writes nothing but matched
   * channel ids. Throws `OrderNotFound` and `VariantUnknown` (a mapped variant that does not exist).
   */
  async applyChannelEdit(
    tx: OrderTransaction,
    orderId: string,
    snapshot: ChannelOrderSnapshot,
    actor: ChannelActor,
  ): Promise<ChannelEditResult> {
    const order = await lockOrderForChange(tx, orderId);
    await this.assertChannelOrder(tx, order.channelId);
    const open = await this.connectors.openCommandsFor('order', orderId, tx);
    if (open.length > 0) return { applied: false, why: 'write_back_open' };
    const [store] = await this.channels.stores([order.storeId], tx);
    if (!store) throw new OrderStoreMissing();
    await this.assertVariantsExist(tx, snapshot.lines);

    const diff = diffChannelSnapshot(order.lines, snapshot);
    const context: EditContext = {
      // Channel lines carry their own rate; this one prices the shipping (review minor 7).
      taxRate: snapshot.shippingTaxRate ?? (await this.settings.get('sales_tax_rate', tx)),
      pricesIncludeVat: await this.settings.get('prices_include_vat', tx),
      // Every channel line carries its own title, so the plan needs no catalog name.
      titles: new Map(),
      allowZeroNetLines: true,
      unparseablePhone: 'keep_raw',
      unparseablePhoneAlt: 'drop',
    };
    const note = snapshot.customerNote;
    const noteChanged = note !== null && note !== order.customerNote;
    const locked =
      order.carrierDeliveryCreated || !EDITABLE_STATES.includes(order.fulfillmentState);
    if (locked) {
      const why = order.carrierDeliveryCreated ? 'carrier_delivery_exists' : 'not_editable';
      // Only a snapshot that would change something is refused; an echo is not a change.
      const relaxed = {
        ...order,
        carrierDeliveryCreated: false,
        fulfillmentState: 'confirmed' as const,
      };
      let changed = true;
      try {
        changed = planEdit(relaxed, diff.operations, context).changed || noteChanged;
      } catch (error) {
        if (!(error instanceof OrdersError)) throw error;
      }
      if (changed) return this.channelEditNotApplied(tx, orderId, why);
      await this.writer.setChannelLineIds(tx, orderId, diff.matchedIds);
      return { applied: true, changed: false };
    }

    let plan: PlannedEdit;
    try {
      plan = planEdit(order, diff.operations, context);
    } catch (error) {
      const why = notAppliedReasonOf(error);
      if (why === null) throw error;
      return this.channelEditNotApplied(tx, orderId, why);
    }
    if (!plan.changed && !noteChanged) {
      await this.writer.setChannelLineIds(tx, orderId, diff.matchedIds);
      // A valid stored second phone kept against text that does not parse (security L9).
      await this.raisePhoneAttentions(tx, orderId, false, plan.phoneAltUnparseable);
      return { applied: true, changed: false };
    }

    const columns: OrderColumnChanges = { ...plan.shipToColumns, ...plannedMoneyColumns(plan) };
    if (noteChanged) columns.customerNote = note;
    if (plan.phone !== null) {
      const customer = await this.customers.findOrCreate(tx, {
        phone: plan.phone,
        channelCustomer: await this.boundChannelCustomer(
          tx,
          snapshot.channelCustomer,
          order.storeId,
        ),
        name: plan.shipToColumns.shipToName ?? order.shipTo.name,
        seenAt: order.placedAt,
      });
      columns.customerId = customer.customerId;
    }
    // A main phone that stopped parsing names no customer any more (review N4).
    if (plan.phoneUnparseable) columns.customerId = null;
    const events: NewEventRow[] = [];
    if (plan.backToConfirmed) {
      nextState({
        machine: 'fulfillment',
        from: 'packed',
        to: 'confirmed',
        actor: 'system_job',
        reasonCode: CHANNEL_EDIT_REASON,
        carrierDeliveryCreated: order.carrierDeliveryCreated,
      });
      columns.fulfillmentState = 'confirmed';
      events.push({
        machine: 'fulfillment',
        fromState: 'packed',
        toState: 'confirmed',
        amount: null,
        actor,
        reasonCode: CHANNEL_EDIT_REASON,
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
    await this.writer.setChannelLineIds(tx, orderId, diff.matchedIds);
    const cancelledLineIds = plan.cancelLines.map((line) => line.lineId);
    await this.stock.afterEdit(tx, orderId, { addedLineIds: applied.lineIds, cancelledLineIds });

    const auditActor = auditActorOf(actor);
    const correlationId = this.audit.newCorrelationId(auditActor);
    const diffed = editAuditDiff(order, plan, applied.lineIds, 'channel');
    if (noteChanged) {
      diffed.before.customerNote = order.customerNote;
      diffed.after.customerNote = note;
    }
    await this.audit.record(tx, {
      actor: auditActor,
      action: 'order.edited',
      record: {
        type: 'order',
        id: orderId,
        label: orderLabelOf({ storeCode: store.code, orderNumber: order.orderNumber }),
      },
      before: diffed.before,
      after: diffed.after,
      reason: CHANNEL_EDIT_REASON,
      correlationId,
    });
    await this.events.publish(
      tx,
      new OrderEdited(
        orderId,
        order.storeId,
        'channel',
        applied.lineIds,
        cancelledLineIds,
        plan.changedShipToFields,
        plan.shippingChanged,
        correlationId,
      ),
    );
    await this.raisePhoneAttentions(tx, orderId, plan.phoneUnparseable, plan.phoneAltUnparseable);
    return { applied: true, changed: true };
  }

  /**
   * Writes the channel's own line ids onto lines that have none (spec 0013 AC-14): the write back
   * executor calls it when its command syncs, so the next snapshot matches those lines instead of
   * duplicating them. An id the line already carries is skipped. Writes no event, no audit entry,
   * and leaves `updated_at` alone. Throws `OrderNotFound`, `InvalidOrderInput` for a line that is
   * not a line of the order, and `ChannelLineIdConflict` when a line already carries another id or
   * another line of the order already carries that one (nothing is written then). An order of a
   * manual entry channel is refused with `InvalidOrderInput` (security R2).
   */
  async recordChannelLineIds(
    tx: OrderTransaction,
    orderId: string,
    ids: readonly { lineId: string; channelLineId: string }[],
    _actor: OrderActor,
  ): Promise<{ recorded: number }> {
    const order = await lockOrderForChange(tx, orderId);
    await this.assertChannelOrder(tx, order.channelId);
    // Only open lines hold an id against another (review R1): a replaced line, cancelled with
    // `edit_removal`, keeps the id Shopify also keeps for the new line.
    const holder = new Map<string, string>();
    for (const line of order.lines) {
      if (line.channelLineId !== null && line.lineState === 'open') {
        holder.set(line.channelLineId, line.id);
      }
    }
    const assigned = new Map<string, string>();
    const toWrite: { lineId: string; channelLineId: string }[] = [];
    for (const { lineId, channelLineId } of ids) {
      const line = order.lines.find((candidate) => candidate.id === lineId.toLowerCase());
      if (!line) throw new InvalidOrderInput('A line is not a line of this order');
      const current = line.channelLineId ?? assigned.get(line.id) ?? null;
      if (current === channelLineId) continue;
      const taken = holder.get(channelLineId);
      if (current !== null || (taken !== undefined && taken !== line.id)) {
        throw new ChannelLineIdConflict();
      }
      holder.set(channelLineId, line.id);
      assigned.set(line.id, channelLineId);
      toWrite.push({ lineId: line.id, channelLineId });
    }
    return { recorded: await this.writer.setChannelLineIds(tx, orderId, toWrite) };
  }

  /**
   * Maps a line that arrived unmapped to the variant feature 13's product mapper resolved (spec
   * 0013 AC-25 b): sets `variant_id` from null and, while the order is `new`, `confirmed`, or
   * `packed` and the line open, reserves it (`OrderStock.afterLink`, milestone 4). On an order
   * past `packed` it sets the variant only and raises `shipped_with_unmapped_lines` for the
   * warehouse, because the carrier shipment was booked without that line (task 15 adds the same
   * for an order whose stock out is requested). Never cancels or adds a line, writes no
   * `OrderEdited` and no audit entry, and counts as no edit (`updated_at` kept). Throws
   * `OrderNotFound`, `InvalidOrderInput` when no line carries that channel id, `LineAlreadyMapped`,
   * and `VariantUnknown`.
   */
  async linkChannelLineVariant(
    tx: OrderTransaction,
    orderId: string,
    channelLineId: string,
    variantId: string,
  ): Promise<{ lineId: string; reserved: boolean }> {
    const order = await lockOrderForChange(tx, orderId);
    const carrying = order.lines.filter((line) => line.channelLineId === channelLineId);
    const line = carrying.find((candidate) => candidate.lineState === 'open') ?? carrying[0];
    if (!line) throw new InvalidOrderInput('No line of this order carries that channel line id');
    if (line.variantId !== null) throw new LineAlreadyMapped();
    const [sku] = (await this.catalog.getSkus([variantId], tx)).values();
    // A mapping names a SKU still sold (security L6); an order may still carry a retired one.
    if (!sku || sku.archived) throw new VariantUnknown();
    if (!(await this.writer.setLineVariant(tx, orderId, line.id, variantId))) {
      throw new LineAlreadyMapped();
    }
    const holding = EDITABLE_STATES.includes(order.fulfillmentState);
    if (holding && line.lineState === 'open') {
      await this.stock.afterLink(tx, orderId, line.id);
      return { lineId: line.id, reserved: true };
    }
    if (!holding && order.fulfillmentState !== 'cancelled') {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'shipped_with_unmapped_lines', 'order_line', line.id),
      );
    }
    return { lineId: line.id, reserved: false };
  }

  /**
   * Corrects the payment method a gateway mapping got wrong (spec 0013 AC-25 c, State machines
   * rule 4): only while `carrier_delivery_created_at` is null, `cod_collected_amount` is 0, the
   * order is `new`, `confirmed`, or `packed`, and the cash is still in a first state (`unpaid`,
   * `prepaid`, or `nothing_to_collect`); else `PaymentMethodLocked` and nothing applied. It
   * recomputes the allocation, `cod_expected_amount`, and `cod_due_amount`, moves the cash to
   * `firstCashState` of the corrected amounts with one `system_job` event of reason
   * `payment_method_rederived` when that differs, and writes `order.payment_method_rederived`
   * (reason `gateway_mapping_changed`; `before` and `after` hold the payment method, prepaid
   * amount and method, and `codExpectedAmount`). A correction that changes nothing writes nothing.
   * Throws `OrderNotFound`, `InvalidOrderInput` for a prepayment above what is left after credit,
   * and `InvalidTransition` for a cash move the table does not list.
   */
  async rederivePaymentMethod(
    tx: OrderTransaction,
    orderId: string,
    input: RederivePaymentMethodInput,
    actor: ChannelActor,
  ): Promise<{ changed: boolean }> {
    const order = await lockOrderForChange(tx, orderId);
    await this.assertChannelOrder(tx, order.channelId);
    if (
      order.carrierDeliveryCreated ||
      !Money.of(order.codCollectedAmount).isZero() ||
      !EDITABLE_STATES.includes(order.fulfillmentState) ||
      !FIRST_CASH_STATES.includes(order.cashState)
    ) {
      throw new PaymentMethodLocked();
    }
    const before = await this.paymentOf(tx, orderId);
    const prepaid = Money.of(input.prepaidAmount).toString();
    if (
      before.paymentMethod === input.paymentMethod &&
      Money.of(before.prepaidAmount).equals(Money.of(prepaid)) &&
      before.prepaidMethod === input.prepaidMethod
    ) {
      return { changed: false };
    }
    const room = Money.of(order.totalAmount).minus(Money.of(order.creditAppliedAmount));
    if (Money.of(prepaid).cents > room.cents) {
      throw new InvalidOrderInput('The prepayment is above the order total');
    }
    const totals = totalsOf({
      lines: order.lines,
      shippingChargedAmount: order.shippingChargedAmount,
      prepaidAmount: prepaid,
      creditAppliedAmount: order.creditAppliedAmount,
      taxRate: await this.settings.get('sales_tax_rate', tx),
      fulfillmentState: order.fulfillmentState,
    });
    const cash = firstCashState({
      codExpectedAmount: totals.codExpectedAmount,
      prepaidAmount: prepaid,
    });
    const events: NewEventRow[] = [];
    if (cash !== order.cashState) {
      nextState({
        machine: 'cash',
        from: order.cashState,
        to: cash,
        actor: 'system_job',
        reasonCode: PAYMENT_METHOD_REDERIVED,
      });
      events.push({
        machine: 'cash',
        fromState: order.cashState,
        toState: cash,
        amount: null,
        actor,
        reasonCode: PAYMENT_METHOD_REDERIVED,
        sourceType: null,
        sourceId: null,
        occurredAt: new Date(),
      });
    }
    await this.writer.applyChange(tx, orderId, {
      columns: {
        paymentMethod: input.paymentMethod,
        prepaidAmount: prepaid,
        prepaidMethod: input.prepaidMethod,
        shippingPrepaidAmount: totals.shippingPrepaidAmount,
        shippingCreditAppliedAmount: totals.shippingCreditAppliedAmount,
        codExpectedAmount: totals.codExpectedAmount,
        codDueAmount: totals.codDueAmount,
        ...(cash !== order.cashState ? { cashState: cash } : {}),
      },
      lineShares: new Map(
        order.lines.map((line, index) => [line.id, totals.lineShares[index] ?? NO_SHARE]),
      ),
      events,
    });
    const [store] = await this.channels.stores([order.storeId], tx);
    if (!store) throw new OrderStoreMissing();
    const auditActor = auditActorOf(actor);
    await this.audit.record(tx, {
      actor: auditActor,
      action: 'order.payment_method_rederived',
      record: {
        type: 'order',
        id: orderId,
        label: orderLabelOf({ storeCode: store.code, orderNumber: order.orderNumber }),
      },
      before: {
        paymentMethod: before.paymentMethod,
        prepaidAmount: Money.of(before.prepaidAmount).toString(),
        prepaidMethod: before.prepaidMethod,
        codExpectedAmount: Money.of(order.codExpectedAmount).toString(),
      },
      after: {
        paymentMethod: input.paymentMethod,
        prepaidAmount: prepaid,
        prepaidMethod: input.prepaidMethod,
        codExpectedAmount: totals.codExpectedAmount,
      },
      reason: 'gateway_mapping_changed',
      correlationId: this.audit.newCorrelationId(auditActor),
    });
    return { changed: true };
  }

  /**
   * A channel's cancel (spec 0013 AC-14, `channel.` reason code, actor `system_job`): cancels as a
   * person's cancel does (`OrderTransitions.cancel`, which task 15 makes enqueue the after cancel
   * job) while the order is `new`, `confirmed`, or `packed`; applies nothing and raises nothing
   * when it is already `cancelled`, `refused`, `returned_to_origin`, or `lost` (the brand's
   * bookkeeping echo, `already_final`); applies nothing and raises `channel_cancel_after_pickup`
   * while it is `shipped`, `failed_attempt`, `delivered`, `partially_delivered`, or `exchanged`
   * (`after_pickup`). Throws `OrderNotFound`, `InvalidOrderInput` for an order of a manual entry
   * channel (security R2), and `InvalidTransition` for a reason code that does not start with
   * `channel.`.
   */
  async cancelFromChannel(
    tx: OrderTransaction,
    orderId: string,
    reasonCode: string,
    actor: ChannelActor,
  ): Promise<ChannelCancelResult> {
    const order = await lockOrderForChange(tx, orderId);
    await this.assertChannelOrder(tx, order.channelId);
    switch (order.fulfillmentState) {
      case 'new':
      case 'confirmed':
      case 'packed':
        await this.transitions.cancel(tx, orderId, { reasonCode }, actor);
        return { applied: true };
      case 'cancelled':
      case 'refused':
      case 'returned_to_origin':
      case 'lost':
        return { applied: false, why: 'already_final' };
      case 'shipped':
      case 'failed_attempt':
      case 'delivered':
      case 'partially_delivered':
      case 'exchanged':
        await this.events.publish(
          tx,
          new OrderAttentionRaised(orderId, 'channel_cancel_after_pickup', 'order', orderId),
        );
        return { applied: false, why: 'after_pickup' };
      default: {
        const unreachable: never = order.fulfillmentState;
        return unreachable;
      }
    }
  }

  /** Raises `channel_edit_not_applied` and answers why the snapshot was not applied. */
  private async channelEditNotApplied(
    tx: OrderTransaction,
    orderId: string,
    why: Exclude<ChannelEditRefusal, 'write_back_open'>,
  ): Promise<ChannelEditResult> {
    await this.events.publish(
      tx,
      new OrderAttentionRaised(orderId, 'channel_edit_not_applied', 'order', orderId),
    );
    return { applied: false, why };
  }

  /** Raises `phone_unparseable` for a main phone, and again for a second phone, that did not parse. */
  private async raisePhoneAttentions(
    tx: OrderTransaction,
    orderId: string,
    main: boolean,
    alt: boolean,
  ): Promise<void> {
    if (main) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'phone_unparseable', 'order', orderId),
      );
    }
    if (alt) {
      await this.events.publish(
        tx,
        new OrderAttentionRaised(orderId, 'phone_unparseable', 'ship_to_phone_alt', orderId),
      );
    }
  }

  /**
   * Refuses an order whose channel is a manual entry kind (security M2): the channel edit and the
   * payment correction belong to channel orders. Read by the channel's kind, never by
   * `channel_order_ref` (a manual order stores its `clientRef` there).
   */
  private async assertChannelOrder(tx: OrderTransaction, channelId: string): Promise<void> {
    const [channel] = await this.channels.channels([channelId], tx);
    if (!channel || MANUAL_CHANNEL_KINDS.includes(channel.kind)) {
      throw new InvalidOrderInput('This call is for orders that came from a channel');
    }
  }

  /**
   * The channel's customer id, kept only when its connection belongs to the order's store
   * (security L7); otherwise the order links by phone only. Asks `ConnectorsService`, the owner of
   * `connections`.
   */
  private async boundChannelCustomer(
    tx: OrderTransaction,
    channelCustomer: ChannelCustomerInput | null,
    storeId: string,
  ): Promise<ChannelCustomerInput | null> {
    if (channelCustomer === null) return null;
    const owner = await this.connectors.storeOfConnection(channelCustomer.connectionId, tx);
    return owner === storeId ? channelCustomer : null;
  }

  /**
   * True when a number has the shape of this install's own sales order numbers
   * (`<SO prefix>-<year>-<six or more digits>`, `NumberingService`), which only the order form
   * may take in an internal store (security M2).
   */
  private async isDocumentNumber(tx: OrderTransaction, orderNumber: string): Promise<boolean> {
    const prefixes = await this.settings.get('document_prefixes', tx);
    return new RegExp(`^${prefixes.SO}-\\d{4}-\\d{6,}$`).test(orderNumber);
  }

  /** Refuses a channel line that names a variant the catalog does not know. */
  private async assertVariantsExist(
    tx: OrderTransaction,
    lines: readonly { variantId: string | null }[],
  ): Promise<void> {
    const ids = [...new Set(lines.flatMap((line) => (line.variantId ? [line.variantId] : [])))];
    const skus = await this.catalog.getSkus(ids, tx);
    if (ids.some((id) => !skus.has(id))) throw new VariantUnknown();
  }

  /** The stored payment of an order, read under the row lock the caller holds. */
  private async paymentOf(
    tx: OrderTransaction,
    orderId: string,
  ): Promise<{
    paymentMethod: OrderPaymentMethod;
    prepaidAmount: string;
    prepaidMethod: OrderPaymentMethod | null;
  }> {
    const { rows } = await tx.execute<{
      payment_method: OrderPaymentMethod;
      prepaid_amount: string;
      prepaid_method: OrderPaymentMethod | null;
    }>(sql`
      SELECT payment_method, prepaid_amount, prepaid_method FROM orders WHERE id = ${orderId}::uuid`);
    const row = rows[0];
    if (!row) throw new OrderNotFound();
    return {
      paymentMethod: row.payment_method,
      prepaidAmount: row.prepaid_amount,
      prepaidMethod: row.prepaid_method,
    };
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
