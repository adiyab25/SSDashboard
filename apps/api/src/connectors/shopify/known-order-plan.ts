// What a newer read back of a known Shopify order asks of the app (spec 0015 task 9: AC-9, AC-11,
// AC-13, AC-14, Inbound processing item 4, Value sourcing, lead decision D10). Pure: no database,
// clock, log, or Shopify call. The inbox job reads the mapping row and the variant mappings, asks
// this planner, then makes the named orders calls inside its one `OrderTransactions.run` unit.
import type { ChannelOrderSnapshot, RederivePaymentMethodInput } from '@ssdashboard/contracts';
import {
  cancelReasonCodeOf,
  creationPaymentOf,
  firstActiveFulfillmentOf,
  gatewayMethodOf,
  mapShopifyOrderSnapshot,
  type ShopifyMappingNotes,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';
import { appliedLinesOf, unionOfCodes, type OrderMappingState } from './order-mapping-state.js';

/** A line that arrived unmapped and whose Shopify variant now maps (`linkChannelLineVariant`). */
export interface PlannedLink {
  readonly channelLineId: string;
  readonly variantGid: string;
  readonly variantId: string;
}

/**
 * The named calls a newer read back of a known order asks for. The job makes them in this order:
 * the cancel (alone), else the late links, the edit, the carrier delivery, and the rederive.
 */
export interface KnownOrderPlan {
  /**
   * A Shopify cancel: `cancelFromChannel` with this reason code (AC-13). When set, nothing else is
   * planned: a cancelled order takes no edit, link, delivery, or payment correction.
   */
  readonly cancelReasonCode: string | null;
  /**
   * The first active fulfillment (AC-13), for `recordCarrierDelivery` with source
   * `shopify_fulfillment` at its `createdAt`; orders ignores it when a delivery is recorded.
   */
  readonly carrierDelivery: { readonly id: string; readonly at: string } | null;
  /**
   * True on the read where that fulfillment first appears (it is not `state.deliveryFulfillmentId`
   * yet): the full snapshot is applied before the carrier delivery freezes the order (code review
   * m1), because Shopify allowed those changes before the fulfillment.
   */
  readonly firstFulfillmentRead: boolean;
  /** Late variant links to make before the edit (Inbound processing item 4). */
  readonly links: readonly PlannedLink[];
  /**
   * The snapshot for `applyChannelEdit`: every line with a current quantity above 0 while no
   * fulfillment is active, and on the read where the first one appears; afterwards, while one is
   * active, the lines the app holds at their applied quantities, so only ship to and other changes
   * reach it (added lines and refunds are task 10's). Null when nothing may be sent: a milestone 1
   * mapping (no `appliedLines`) whose fulfillment is already reported (code review m4).
   */
  readonly snapshot: ChannelOrderSnapshot | null;
  /** The notes of the read (unmapped lines and gateways, discount codes); null after a cancel. */
  readonly notes: ShopifyMappingNotes | null;
  /**
   * The payment derived again from the facts at creation (lead decision D10), when the current
   * config maps one of `state.creationGateways` to another method; null otherwise, and always for
   * a mapping without the creation facts (written before D10) or one already locked.
   */
  readonly rederive: RederivePaymentMethodInput | null;
}

/**
 * The rederive of lead decision D10: only when the mapping holds the creation facts, is not
 * locked, and the current config maps a creation gateway to another method; then the creation
 * rules over the creation gateways and transactions only.
 */
function rederiveOf(
  order: ShopifyOrder,
  context: ShopifyOrderContext,
  state: OrderMappingState,
): RederivePaymentMethodInput | null {
  const gateways = state.creationGateways;
  const transactionIds = state.creationTransactionIds;
  if (state.paymentMethodLocked || !gateways || !transactionIds) return null;
  const changed = Object.entries(gateways).some(
    ([name, method]) => gatewayMethodOf(context, name) !== method,
  );
  if (!changed) return null;
  return creationPaymentOf(order, context, {
    gatewayNames: Object.keys(gateways),
    transactionIds,
  });
}

/**
 * Plans a newer read back of a known order (see `KnownOrderPlan`). `context.variants` holds the
 * current variant mappings, including those of `state.unmappedLines`. Throws
 * `ShopifyOrderMappingError` (a truncated read, no open line, a contract refusal).
 */
export function planKnownOrder(
  order: ShopifyOrder,
  context: ShopifyOrderContext,
  state: OrderMappingState,
): KnownOrderPlan {
  const first = firstActiveFulfillmentOf(order);
  const cancelReasonCode = order.cancelledAt !== null ? cancelReasonCodeOf(order) : null;
  if (cancelReasonCode !== null) {
    return {
      cancelReasonCode,
      carrierDelivery: null,
      firstFulfillmentRead: false,
      links: [],
      snapshot: null,
      notes: null,
      rederive: null,
    };
  }
  const links = (state.unmappedLines ?? []).flatMap((line): PlannedLink[] => {
    const variantId = line.variantGid === null ? undefined : context.variants.get(line.variantGid);
    return line.variantGid !== null && variantId !== undefined
      ? [{ channelLineId: line.channelLineId, variantGid: line.variantGid, variantId }]
      : [];
  });
  const firstFulfillmentRead = first !== null && state.deliveryFulfillmentId !== first.id;
  const milestone1 = state.appliedLines === undefined;
  let snapshot: ChannelOrderSnapshot | null;
  let notes: ShopifyMappingNotes;
  if (first === null || firstFulfillmentRead) {
    ({ snapshot, ...notes } = mapShopifyOrderSnapshot(order, context));
  } else if (milestone1) {
    // A milestone 1 mapping knows no applied quantities: a refund must never look like an edit.
    ({ snapshot, ...notes } = mapShopifyOrderSnapshot(order, context));
    snapshot = null;
  } else {
    const held = new Map(Object.entries(state.appliedLines ?? {}));
    ({ snapshot, ...notes } = mapShopifyOrderSnapshot(order, context, held));
  }
  return {
    cancelReasonCode: null,
    carrierDelivery: first === null ? null : { id: first.id, at: first.createdAt },
    firstFulfillmentRead,
    links,
    snapshot,
    notes,
    rederive: rederiveOf(order, context, state),
  };
}

/** What the orders calls of a plan answered, for the next mapping state. */
export interface KnownOrderResult {
  /** `applyChannelEdit` applied the snapshot (changed or not). */
  readonly editApplied: boolean;
  /** Line item ids `linkChannelLineVariant` linked, or found already mapped or gone. */
  readonly linked: ReadonlySet<string>;
  /** `rederivePaymentMethod` answered `PaymentMethodLocked`: recorded and left. */
  readonly paymentLocked: boolean;
}

/**
 * The mapping state after an applied read back (the version moves with it): an applied snapshot
 * becomes the held lines and their quantities; unmapped lines drop the linked ones (or follow
 * the snapshot); discount codes are the union of every code seen (code review m3); unmapped
 * gateways follow the read; the reported fulfillment is remembered; `paymentMethodLocked` is set
 * when orders refused the rederive. The creation facts of D10 and keys of later tasks are kept.
 */
export function nextKnownOrderState(
  state: OrderMappingState,
  plan: KnownOrderPlan,
  result: KnownOrderResult,
): OrderMappingState {
  const next: OrderMappingState = { ...state };
  if (plan.snapshot !== null && result.editApplied) {
    next.appliedLines = appliedLinesOf(plan.snapshot.lines);
    next.appliedLineIds = plan.snapshot.lines.map((line) => line.channelLineId);
  }
  const unmapped =
    plan.notes !== null && plan.snapshot !== null && result.editApplied
      ? plan.notes.unmappedLines.filter((line) => !result.linked.has(line.channelLineId))
      : (state.unmappedLines ?? []).filter((line) => !result.linked.has(line.channelLineId));
  if (unmapped.length > 0) next.unmappedLines = [...unmapped];
  else delete next.unmappedLines;
  if (plan.notes !== null) {
    next.discountCodes = unionOfCodes(state.discountCodes, plan.notes.discountCodes);
    next.unmappedGateways = [...plan.notes.unmappedGateways];
  }
  if (plan.carrierDelivery !== null) next.deliveryFulfillmentId = plan.carrierDelivery.id;
  if (result.paymentLocked) next.paymentMethodLocked = true;
  return next;
}
