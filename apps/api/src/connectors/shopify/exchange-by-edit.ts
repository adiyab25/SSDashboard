// Exchanges made by editing a delivered Shopify order (spec 0015 task 10: AC-12, Inbound
// processing item 4, Value sourcing `relatedOrder`, owner decision Q-13.5). While a Shopify
// fulfillment of the order is active, the line items added to it become one linked replacement
// order through `OrderIntake.createFromChannel` with `relatedOrder: { orderId, relation:
// 'replacement_for' }` (spec 0013 AC-23), numbered `<Shopify order name>-R<n>` with the ref
// `<order gid>:R<n>`, holding only the added lines. While orders refuses the link because the
// original is not yet `delivered`, `partially_delivered`, or `refused` (`RelatedOrderState`), the
// lines wait on the order's mapping (`state.pendingReplacementLines`) and are tried again on every
// read back and by the hourly check (`retryWaitingReplacements`, task 12). Orders stays the only
// writer of orders; this file writes only the connector's own mapping row.
import { Inject, Injectable } from '@nestjs/common';
import {
  ChannelOrderInput,
  type ChannelOrderLineInput,
  type ChannelShipToInput,
} from '@ssdashboard/contracts';
import { sql } from '@ssdashboard/db';
import type { ChannelActor } from '../../orders/intake/order-intake.service.js';
import { OrderIntake } from '../../orders/intake/order-intake.service.js';
import type { OrderTransaction } from '../../orders/order-transactions.js';
import { RelatedOrderState } from '../../orders/orders.errors.js';
import { OrderQueries } from '../../orders/reading/order-query.service.js';
import {
  replacementInput,
  ShopifyOrderMappingError,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';
import {
  parseOrderMappingState,
  type OrderMappingState,
  type PendingReplacement,
} from './order-mapping-state.js';

/** A replacement to make from one read back: its contract input and how it waits if refused. */
export interface ReplacementPlan {
  /** The replacement order as `createFromChannel` takes it, ship to from the read. */
  readonly input: ChannelOrderInput;
  /** Its lines and the rest of it as the mapping keeps them while it waits (no ship to). */
  readonly pending: {
    readonly lines: readonly ChannelOrderLineInput[];
    readonly replacement: PendingReplacement;
  };
}

/** The Shopify line item ids the app already holds: the original's and every replacement's. */
function knownLineIdsOf(state: OrderMappingState): Set<string> {
  return new Set([...Object.keys(state.appliedLines ?? {}), ...(state.replacementLineIds ?? [])]);
}

/**
 * Plans the replacement of one read back (pure): the line items with a current quantity above 0
 * that neither the original (`state.appliedLines`) nor an earlier replacement
 * (`state.replacementLineIds`) holds, as `replacementInput` maps them (`order-mapper.ts`). Its
 * number is the waiting replacement's (`state.pendingReplacement.n`), else one more than the
 * replacements made so far. Null when no line was added (a waiting replacement whose added lines
 * Shopify removed again is then dropped by the caller). Throws `ShopifyOrderMappingError`.
 */
export function planReplacement(
  order: ShopifyOrder,
  context: ShopifyOrderContext,
  state: OrderMappingState,
  originalOrderId: string,
): ReplacementPlan | null {
  const n = state.pendingReplacement?.n ?? (state.replacementOrderIds?.length ?? 0) + 1;
  const mapped = replacementInput(
    order,
    { originalOrderId, n, knownLineIds: knownLineIdsOf(state) },
    context,
  );
  if (mapped === null) return null;
  const { input } = mapped;
  return {
    input,
    pending: {
      lines: input.lines,
      replacement: {
        n,
        orderNumber: input.orderNumber,
        placedAt: input.placedAt,
        type: input.type,
        giftReasonCode: input.giftReasonCode,
        paymentMethod: input.paymentMethod,
        customerExternalId: input.channelCustomer?.externalId ?? null,
      },
    },
  };
}

/** What a waiting replacement needs from outside the mapping to be made. */
export interface WaitingReplacementContext {
  /** The original app order's store and channel (the connection's). */
  readonly storeId: string;
  readonly channelId: string;
  /** The connection, issuer of the Shopify customer id. */
  readonly connectionId: string;
  /** The Shopify order gid (the mapping's `external_id`). */
  readonly orderGid: string;
  /** The original app order (`replacement_for`). */
  readonly originalOrderId: string;
  /** The original's ship to, read from orders in memory only (never stored by the connector). */
  readonly shipTo: ChannelShipToInput;
}

/**
 * The contract input of a waiting replacement (pure): the stored lines and the rest of it
 * (`PendingReplacement`) with the original's ship to, numbered and linked as `replacementInput`
 * does (no shipping charge, no discount code, no note, nothing prepaid, no campaign fields).
 * Throws `ShopifyOrderMappingError` (`CONTRACT_REFUSED`, paths only) when it does not fit.
 */
export function waitingReplacementInput(
  replacement: PendingReplacement,
  lines: readonly ChannelOrderLineInput[],
  context: WaitingReplacementContext,
): ChannelOrderInput {
  const parsed = ChannelOrderInput.safeParse({
    storeId: context.storeId,
    channelId: context.channelId,
    channelOrderRef: `${context.orderGid}:R${replacement.n}`,
    orderNumber: replacement.orderNumber,
    placedAt: replacement.placedAt,
    relatedOrder: { orderId: context.originalOrderId, relation: 'replacement_for' },
    type: replacement.type,
    giftReasonCode: replacement.giftReasonCode,
    paymentMethod: replacement.paymentMethod,
    shippingChargedAmount: '0.00',
    discountCode: null,
    customerNote: null,
    channelCustomer:
      replacement.customerExternalId === null
        ? null
        : {
            kind: 'shopify_customer',
            connectionId: context.connectionId,
            externalId: replacement.customerExternalId,
          },
    shipTo: context.shipTo,
    lines: [...lines],
  });
  if (!parsed.success) {
    throw new ShopifyOrderMappingError(
      'CONTRACT_REFUSED',
      parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'),
    );
  }
  return parsed.data;
}

/** The mapping state after a replacement order was made: remembered, nothing left waiting. */
export function stateWithReplacement(
  state: OrderMappingState,
  orderId: string,
  lineIds: readonly string[],
): OrderMappingState {
  const next: OrderMappingState = {
    ...state,
    replacementOrderIds: [...new Set([...(state.replacementOrderIds ?? []), orderId])],
    replacementLineIds: [...new Set([...(state.replacementLineIds ?? []), ...lineIds])],
  };
  delete next.pendingReplacementLines;
  delete next.pendingReplacement;
  return next;
}

/** The mapping state while a replacement waits for its original (`replacement_waiting`). */
export function stateWithWaitingReplacement(
  state: OrderMappingState,
  pending: ReplacementPlan['pending'],
): OrderMappingState {
  return {
    ...state,
    pendingReplacementLines: [...pending.lines],
    pendingReplacement: pending.replacement,
  };
}

/** The mapping state with nothing waiting (the added lines were removed in Shopify again). */
export function stateWithoutWaitingReplacement(state: OrderMappingState): OrderMappingState {
  const next: OrderMappingState = { ...state };
  delete next.pendingReplacementLines;
  delete next.pendingReplacement;
  return next;
}

/** How one replacement attempt ended. */
export type ReplacementAttempt =
  /** The replacement order exists (made now, or already under its ref). */
  | { readonly status: 'created'; readonly orderId: string }
  /** Orders refused the link (`RELATED_ORDER_STATE`): the lines wait on the mapping. */
  | { readonly status: 'waiting' };

/** What `retryWaitingReplacements` did. */
export type WaitingReplacementRetry =
  /** The mapping holds no waiting replacement (or is not an order mapping of the connection). */
  | { readonly status: 'nothing_waiting' }
  /** The original is still not replaceable: the lines keep waiting. */
  | { readonly status: 'waiting' }
  /** The replacement order was made and the mapping no longer waits. */
  | { readonly status: 'created'; readonly orderId: string };

/** The order mapping row `retryWaitingReplacements` reads under its row lock. */
interface MappingRow extends Record<string, unknown> {
  id: string;
  external_id: string;
  local_id: string | null;
  state: unknown;
}

/**
 * Makes replacement orders for exchanges made by editing a delivered Shopify order (AC-12). Used
 * by the inbox job on every read back (`fromReadBack`) and by task 12's hourly check
 * (`retryWaitingReplacements`); both run inside one `OrderTransactions.run` unit of work, call no
 * provider, and write only the connector's own mapping row besides the named orders call. It must
 * never write an order table, store a ship to field, or log a read value (Law 151).
 */
@Injectable()
export class ExchangeByEdit {
  /** Takes orders' intake (the one writer of orders) and queries (the original's ship to). */
  constructor(
    @Inject(OrderIntake) private readonly intake: OrderIntake,
    @Inject(OrderQueries) private readonly queries: OrderQueries,
  ) {}

  /**
   * One read back of a known order while a fulfillment is active (the inbox job calls it only
   * then, after the edit and the carrier delivery): plans the replacement of the added lines
   * (`planReplacement`) and asks orders for it. Returns the next mapping state and whether the
   * replacement waits (`replacement_waiting`). With no added line, a waiting replacement is
   * dropped. Throws `ShopifyOrderMappingError` and orders' domain errors other than
   * `RelatedOrderState`, which the inbox job records as a failed event.
   */
  async fromReadBack(
    tx: OrderTransaction,
    args: {
      readonly order: ShopifyOrder;
      readonly context: ShopifyOrderContext;
      readonly state: OrderMappingState;
      readonly originalOrderId: string;
      readonly actor: ChannelActor;
    },
  ): Promise<{ readonly state: OrderMappingState; readonly waiting: boolean }> {
    const plan = planReplacement(args.order, args.context, args.state, args.originalOrderId);
    if (plan === null) return { state: stateWithoutWaitingReplacement(args.state), waiting: false };
    const attempt = await this.attempt(tx, plan.input, args.actor);
    if (attempt.status === 'waiting') {
      return { state: stateWithWaitingReplacement(args.state, plan.pending), waiting: true };
    }
    const lineIds = plan.input.lines.map((line) => line.channelLineId);
    return { state: stateWithReplacement(args.state, attempt.orderId, lineIds), waiting: false };
  }

  /**
   * Tries a waiting replacement again without a Shopify read (spec 0015 AC-12, for task 12's
   * hourly check, which finds the mappings by the partial index on `pendingReplacementLines`).
   * Call it inside `OrderTransactions.run` with that unit's transaction and a `system_job` actor.
   * It locks the order mapping (`mappingId` of `connectionId`), and when it holds a waiting
   * replacement, builds it from the stored lines with the original app order's ship to (read
   * through `OrderQueries.detail` in memory only; Shopify's ship to is read again on the next read
   * back, which supersedes this) and asks `createFromChannel` for it: made, the mapping remembers
   * it and waits no more; refused with `RelatedOrderState`, the lines keep waiting. Idempotent: a
   * replacement already made under its ref is taken as made. Throws `ShopifyOrderMappingError`
   * (`MAPPING_STATE_UNREADABLE`, `CONTRACT_REFUSED`) and orders' other domain errors (for example
   * `VariantUnknown` for a variant archived since), which the caller records and leaves.
   */
  async retryWaitingReplacements(
    tx: OrderTransaction,
    connectionId: string,
    mappingId: string,
    actor: ChannelActor,
  ): Promise<WaitingReplacementRetry> {
    const row = (
      await tx.execute<MappingRow>(sql`
        SELECT id, external_id, local_id, state FROM connection_external_ids
        WHERE id = ${mappingId}::uuid AND connection_id = ${connectionId}::uuid
          AND entity = 'order'
        FOR UPDATE`)
    ).rows[0];
    if (!row?.local_id) return { status: 'nothing_waiting' };
    const state = parseOrderMappingState(row.state);
    const lines = state.pendingReplacementLines;
    const replacement = state.pendingReplacement;
    if (!lines || !replacement) return { status: 'nothing_waiting' };

    const original = await this.queries.detail(row.local_id, tx);
    const input = waitingReplacementInput(replacement, lines, {
      storeId: original.storeId,
      channelId: original.channelId,
      connectionId,
      orderGid: row.external_id,
      originalOrderId: original.id,
      shipTo: {
        name: original.shipTo.name,
        phone: original.shipTo.phone ?? original.shipTo.contactPhoneRaw,
        phoneAlt: original.shipTo.phoneAlt,
        address: original.shipTo.address,
        courierNote: null,
      },
    });
    const attempt = await this.attempt(tx, input, actor);
    if (attempt.status === 'waiting') return { status: 'waiting' };
    const next = stateWithReplacement(
      state,
      attempt.orderId,
      lines.map((line) => line.channelLineId),
    );
    await tx.execute(sql`
      UPDATE connection_external_ids
      SET state = ${JSON.stringify(next)}::jsonb, updated_at = now()
      WHERE id = ${row.id}::uuid`);
    return { status: 'created', orderId: attempt.orderId };
  }

  /**
   * Asks orders for the replacement inside a savepoint, so a `RelatedOrderState` refusal leaves
   * the unit of work as it was and the caller keeps the lines waiting.
   */
  private async attempt(
    tx: OrderTransaction,
    input: ChannelOrderInput,
    actor: ChannelActor,
  ): Promise<ReplacementAttempt> {
    await tx.execute(sql`SAVEPOINT exchange_by_edit`);
    try {
      const created = await this.intake.createFromChannel(tx, input, actor);
      await tx.execute(sql`RELEASE SAVEPOINT exchange_by_edit`);
      return { status: 'created', orderId: created.orderId };
    } catch (error) {
      if (!(error instanceof RelatedOrderState)) throw error;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT exchange_by_edit`);
      return { status: 'waiting' };
    }
  }
}
