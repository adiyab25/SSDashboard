// What a newer read back of a known Shopify order asks of the app (spec 0015 task 9: AC-9, AC-11,
// AC-13, AC-14, Inbound processing item 4, Value sourcing). Pure: no database, clock, log, or
// Shopify call. The inbox job reads the mapping row and the variant mappings, asks this planner,
// then makes the named orders calls inside its one `OrderTransactions.run` unit.
import type {
  ChannelOrderSnapshot,
  OrderPaymentMethod,
  RederivePaymentMethodInput,
} from '@ssdashboard/contracts';
import {
  cancelReasonCodeOf,
  firstActiveFulfillmentOf,
  gatewayMappingOf,
  mapShopifyOrderSnapshot,
  shopifyPaymentOf,
  type ShopifyMappingNotes,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';
import { appliedLinesOf, type OrderMappingState } from './order-mapping-state.js';

/** A line that arrived unmapped and whose Shopify variant now maps (`linkChannelLineVariant`). */
export interface PlannedLink {
  readonly channelLineId: string;
  readonly variantGid: string;
  readonly variantId: string;
}

/** The named calls a newer read back of a known order asks for, in the order the job makes them. */
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
  /** Late variant links to make before the edit (Inbound processing item 4). */
  readonly links: readonly PlannedLink[];
  /**
   * The snapshot for `applyChannelEdit`: every line with a current quantity above 0 while no
   * fulfillment is active; while one is, the lines the app holds at their applied quantities, so
   * only ship to and other changes reach it (added lines and refunds are task 10's).
   */
  readonly snapshot: ChannelOrderSnapshot | null;
  /** The notes of that snapshot (unmapped lines and gateways, discount codes). */
  readonly notes: ShopifyMappingNotes | null;
  /**
   * The payment derived again, when a gateway the order was derived with now maps to another
   * method (spec 0013 AC-25 c, `rederivePaymentMethod`); null otherwise. A new transaction (a
   * "mark as paid") is no mapping change, so it never asks for one.
   */
  readonly rederive: RederivePaymentMethodInput | null;
  /** The order's gateway names and what each maps to now (stored once a rederive was tried). */
  readonly gatewayMethods: Readonly<Record<string, OrderPaymentMethod | null>>;
}

/**
 * The line items the app order holds and their quantities, from the mapping state: the applied
 * quantities task 9 writes, else (a milestone 1 mapping) the recorded ids at their current
 * Shopify quantity.
 */
function heldLinesOf(order: ShopifyOrder, state: OrderMappingState): Map<string, number> {
  if (state.appliedLines) return new Map(Object.entries(state.appliedLines));
  const ids = new Set(state.appliedLineIds ?? []);
  return new Map(
    order.lineItems.nodes
      .filter((line) => ids.has(line.id) && line.currentQuantity > 0)
      .map((line) => [line.id, line.currentQuantity]),
  );
}

/**
 * Whether a gateway the payment was derived with now maps to another method. Names recorded in
 * `state.gatewayMethods` are compared with the current mapping; a milestone 1 mapping recorded
 * only its unmapped names, which count as mapped to nothing.
 */
function gatewayMappingChanged(
  state: OrderMappingState,
  current: Readonly<Record<string, OrderPaymentMethod | null>>,
): boolean {
  const recorded: Record<string, OrderPaymentMethod | null> =
    state.gatewayMethods ??
    Object.fromEntries((state.unmappedGateways ?? []).map((name) => [name, null]));
  return Object.entries(recorded).some(
    ([name, method]) => Object.hasOwn(current, name) && current[name] !== method,
  );
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
  const gatewayMethods = gatewayMappingOf(order, context);
  const first = firstActiveFulfillmentOf(order);
  const cancelReasonCode = order.cancelledAt !== null ? cancelReasonCodeOf(order) : null;
  if (cancelReasonCode !== null) {
    return {
      cancelReasonCode,
      carrierDelivery: null,
      links: [],
      snapshot: null,
      notes: null,
      rederive: null,
      gatewayMethods,
    };
  }
  const links = (state.unmappedLines ?? []).flatMap((line): PlannedLink[] => {
    const variantId = line.variantGid === null ? undefined : context.variants.get(line.variantGid);
    return line.variantGid !== null && variantId !== undefined
      ? [{ channelLineId: line.channelLineId, variantGid: line.variantGid, variantId }]
      : [];
  });
  const mapped = mapShopifyOrderSnapshot(
    order,
    context,
    first === null ? undefined : heldLinesOf(order, state),
  );
  const { snapshot, ...notes } = mapped;
  const rederive =
    !state.paymentMethodLocked && gatewayMappingChanged(state, gatewayMethods)
      ? shopifyPaymentOf(order, context)
      : null;
  return {
    cancelReasonCode: null,
    carrierDelivery: first === null ? null : { id: first.id, at: first.createdAt },
    links,
    snapshot,
    notes,
    rederive,
    gatewayMethods,
  };
}

/** What the orders calls of a plan answered, for the next mapping state. */
export interface KnownOrderResult {
  /** `applyChannelEdit` applied the snapshot (changed or not). */
  readonly editApplied: boolean;
  /** Line item ids `linkChannelLineVariant` linked, or found already mapped or gone. */
  readonly linked: ReadonlySet<string>;
  /** `rederivePaymentMethod` was called (applied or not). */
  readonly rederiveTried: boolean;
  /** It answered `PaymentMethodLocked`: recorded and left. */
  readonly paymentLocked: boolean;
}

/**
 * The mapping state after an applied read back (the version moves with it): an applied snapshot
 * becomes the held lines and their quantities; unmapped lines drop the linked ones (or follow
 * the snapshot); discount codes and unmapped gateways follow the read; the gateway mapping is
 * stored once a rederive was tried, with `paymentMethodLocked` when orders refused it. Keys of
 * later tasks are kept.
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
    plan.notes !== null && result.editApplied
      ? plan.notes.unmappedLines.filter((line) => !result.linked.has(line.channelLineId))
      : (state.unmappedLines ?? []).filter((line) => !result.linked.has(line.channelLineId));
  if (unmapped.length > 0) next.unmappedLines = [...unmapped];
  else delete next.unmappedLines;
  if (plan.notes !== null) {
    next.discountCodes = [...plan.notes.discountCodes];
    next.unmappedGateways = [...plan.notes.unmappedGateways];
  }
  if (result.rederiveTried) next.gatewayMethods = { ...plan.gatewayMethods };
  if (result.paymentLocked) next.paymentMethodLocked = true;
  return next;
}
