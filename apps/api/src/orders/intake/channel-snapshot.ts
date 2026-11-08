import {
  Money,
  type ChannelOrderLineInput,
  type ChannelOrderSnapshot,
} from '@ssdashboard/contracts';
import type { PlanLine, PlanOperation } from '../editing/edit-plan.js';

/** The cancel reason of a line the channel no longer holds (a `ReasonCode`, never a note). */
export const CHANNEL_EDIT_REMOVAL = 'channel_edit';

/** What a channel snapshot changes, as the edit plan's operations. */
export interface ChannelSnapshotDiff {
  /** The ship to change (fields the channel gave), the line changes, then the shipping charge. */
  operations: PlanOperation[];
  /**
   * Open lines with no channel id that the snapshot matched by variant, quantity, and unit price
   * and that stay as they are: they take the channel's id (spec 0013 AC-14 b).
   */
  matchedIds: { lineId: string; channelLineId: string }[];
}

/**
 * Diffs a netted channel snapshot against the order's stored lines (spec 0013 AC-14), so
 * `applyChannelEdit` can plan it with the same `planEdit` a person's edit uses. Pure.
 *
 * A snapshot line is matched to the open line with its `channel_line_id`; one that matches none is
 * first matched to an open line with no channel id and the same variant, quantity, and unit price
 * (lowest position first), which takes that id, before anything is added. A matched line whose
 * variant, quantity, unit price, discount, or tax rate differs is replaced (a line is never
 * changed in place); an unmatched snapshot line is added. Every open line the snapshot does not
 * hold is cancelled with `channel_edit`, a line with no channel id included: the snapshot is what
 * the channel holds. A variant never goes back to unmapped, and an unmapped line whose snapshot
 * now names a variant is left to `linkChannelLineVariant` (AC-25 b), so neither is a change. Ship
 * to fields the channel sent as null are left out (kept as stored); the shipping charge is always
 * sent and `planEdit` compares it. The payment, type, source, and discount code are not diffed: a
 * snapshot never changes them (`rederivePaymentMethod` corrects the payment).
 */
export function diffChannelSnapshot(
  stored: readonly PlanLine[],
  snapshot: ChannelOrderSnapshot,
): ChannelSnapshotDiff {
  const open = stored.filter((line) => line.lineState === 'open');
  const byChannelId = new Map<string, PlanLine>();
  for (const line of open) {
    if (line.channelLineId !== null) byChannelId.set(line.channelLineId, line);
  }
  const unclaimed = open
    .filter((line) => line.channelLineId === null)
    .sort((a, b) => a.position - b.position);
  const kept = new Set<string>();
  const lineOperations: PlanOperation[] = [];
  const matchedIds: ChannelSnapshotDiff['matchedIds'] = [];

  for (const incoming of snapshot.lines) {
    let line = byChannelId.get(incoming.channelLineId);
    let matched = false;
    if (!line) {
      const index = unclaimed.findIndex((candidate) => sameIdentity(candidate, incoming));
      line = index >= 0 ? unclaimed.splice(index, 1)[0] : undefined;
      matched = line !== undefined;
    }
    if (!line) {
      lineOperations.push({ kind: 'add_line', ...addedFields(incoming) });
      continue;
    }
    kept.add(line.id);
    if (sameLine(line, incoming)) {
      if (matched) matchedIds.push({ lineId: line.id, channelLineId: incoming.channelLineId });
    } else {
      lineOperations.push({ kind: 'replace_line', lineId: line.id, ...addedFields(incoming) });
    }
  }
  for (const line of open) {
    if (!kept.has(line.id)) {
      lineOperations.push({
        kind: 'remove_line',
        lineId: line.id,
        cancelReasonCode: CHANNEL_EDIT_REMOVAL,
      });
    }
  }

  const operations: PlanOperation[] = [];
  const shipTo = shipToOperation(snapshot.shipTo);
  if (shipTo) operations.push(shipTo);
  operations.push(...lineOperations, {
    kind: 'shipping',
    shippingChargedAmount: snapshot.shippingChargedAmount,
  });
  return { operations, matchedIds };
}

/** The fields of the line an add or replace puts in. */
function addedFields(incoming: ChannelOrderLineInput) {
  return {
    variantId: incoming.variantId,
    title: incoming.title,
    quantity: incoming.quantity,
    unitPrice: incoming.unitPrice,
    discountAmount: incoming.discountAmount,
    taxRate: incoming.taxRate,
    channelLineId: incoming.channelLineId,
  };
}

/** The match of a line with no channel id (AC-14 b): same variant, quantity, and unit price. */
function sameIdentity(line: PlanLine, incoming: ChannelOrderLineInput): boolean {
  return (
    line.variantId === incoming.variantId &&
    line.quantity === incoming.quantity &&
    Money.of(line.unitPrice).equals(Money.of(incoming.unitPrice))
  );
}

/** True when the snapshot line asks for nothing new of the stored one. */
function sameLine(line: PlanLine, incoming: ChannelOrderLineInput): boolean {
  const variantChanged =
    line.variantId !== null && incoming.variantId !== null && line.variantId !== incoming.variantId;
  return (
    !variantChanged &&
    line.quantity === incoming.quantity &&
    Money.of(line.unitPrice).equals(Money.of(incoming.unitPrice)) &&
    Money.of(line.discountAmount).equals(Money.of(incoming.discountAmount)) &&
    Number(line.taxRate) === Number(incoming.taxRate)
  );
}

/** The `ship_to` operation of the fields the channel sent, or null when it sent none. */
function shipToOperation(
  shipTo: ChannelOrderSnapshot['shipTo'],
): Extract<PlanOperation, { kind: 'ship_to' }> | null {
  const operation: Extract<PlanOperation, { kind: 'ship_to' }> = { kind: 'ship_to' };
  if (shipTo.name !== null) operation.name = shipTo.name;
  if (shipTo.phone !== null && shipTo.phone !== '') operation.phone = shipTo.phone;
  if (shipTo.phoneAlt !== null) operation.phoneAlt = shipTo.phoneAlt;
  if (shipTo.address !== null) operation.address = shipTo.address;
  if (shipTo.courierNote !== null) operation.courierNote = shipTo.courierNote;
  if (shipTo.area !== undefined && shipTo.area !== null) operation.area = shipTo.area;
  return Object.keys(operation).length > 1 ? operation : null;
}
