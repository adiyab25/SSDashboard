import { gatewayKeyOf } from './order-mapper.js';

/**
 * The pure reading of a Shopify bulk operation's JSONL result (spec 0015 AC-17, *Backfill, go
 * live, and sweeps*; read on `https://shopify.dev/docs/api/usage/bulk-operations/queries` on
 * 2026-11-08): each line is one node; a node of a nested connection is its own line after its
 * parent and names it in `__parentId`. `BulkObjectGrouper` puts each top level node back together
 * with the lines that follow it, so a caller handles one whole object at a time and can stop
 * between two objects, resuming at the line where the next one starts. No database, clock, log, or
 * Shopify call; errors carry a code and a line number, never a value of the file.
 */

/**
 * The most child lines one object may hold (security review L2): an order's line items and
 * discount applications are far fewer. Past it the result is unreadable, never kept growing.
 */
export const BULK_OBJECT_MAX_CHILDREN = 2_000;

/**
 * A line that is not a JSON object, a child line that does not follow its parent, or an object
 * with more than `BULK_OBJECT_MAX_CHILDREN` children.
 */
export class BulkResultUnreadable extends Error {
  /** @param line - the line's index in the file (from 0). */
  constructor(readonly line: number) {
    super(`BULK_RESULT_UNREADABLE at line ${line}`);
    this.name = 'BulkResultUnreadable';
  }
}

/** One top level node and the nested connection nodes written after it. */
export interface BulkObject {
  /** The top level node, as written (without `__parentId`, which a top level node never has). */
  readonly root: Readonly<Record<string, unknown>>;
  /** Every child line that followed it, in file order, each without its `__parentId`. */
  readonly children: readonly Readonly<Record<string, unknown>>[];
  /** The index of the root's line. */
  readonly line: number;
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Groups JSONL lines into whole objects. `push` a line with its index: it answers the object the
 * line completed (a new top level line completes the one before it), else null. `end` answers the
 * last object at the end of the file. A child line is accepted when its `__parentId` names the
 * current root or one of the current object's children (two nested levels, the most bulk allows).
 */
export class BulkObjectGrouper {
  private current: {
    root: Record<string, unknown>;
    children: Record<string, unknown>[];
    ids: Set<string>;
    line: number;
  } | null = null;

  /** Feeds one line; throws `BulkResultUnreadable` for a line it cannot place. */
  push(text: string, line: number): BulkObject | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new BulkResultUnreadable(line);
    }
    if (!isRecord(parsed)) throw new BulkResultUnreadable(line);
    const { __parentId: parentId, ...node } = parsed;
    if (parentId === undefined) {
      const done = this.end();
      const id = typeof node['id'] === 'string' ? node['id'] : null;
      this.current = { root: node, children: [], ids: new Set(id ? [id] : []), line };
      return done;
    }
    if (typeof parentId !== 'string' || !this.current || !this.current.ids.has(parentId)) {
      throw new BulkResultUnreadable(line);
    }
    if (this.current.children.length >= BULK_OBJECT_MAX_CHILDREN) {
      throw new BulkResultUnreadable(line);
    }
    this.current.children.push(node);
    if (typeof node['id'] === 'string') this.current.ids.add(node['id']);
    return null;
  }

  /** The object still open at the end of the file, or null. */
  end(): BulkObject | null {
    const open = this.current;
    this.current = null;
    return open ? { root: open.root, children: open.children, line: open.line } : null;
  }
}

/** The gid prefix of a Shopify order line item. */
const LINE_ITEM_GID = 'gid://shopify/LineItem/';

/**
 * One order of the orders backfill's bulk result in the shape `ORDER_READ` answers, so the one
 * mapper (`parseShopifyOrder`) reads it unchanged (AC-7): the line item children become
 * `lineItems.nodes` and the discount application children (no `id`: `DiscountApplication` is not a
 * `Node`) become `discountApplications.nodes`, each with `pageInfo.hasNextPage` false (a bulk
 * result holds every node). A child that is neither makes the order unreadable (null), so it is
 * never mapped short. The bulk query does not read the sales history (`agreements`, task 10: a
 * third nested connection level), so the order carries an empty one marked as truncated
 * (`hasNextPage` true): the inbox job keeps `salesHistoryTruncated` on the mapping and nets
 * nothing, and the next read back of the order nets its whole history. Never claims a history it
 * did not read.
 */
export function assembleBulkOrder(object: BulkObject): Record<string, unknown> | null {
  const lineItems: Record<string, unknown>[] = [];
  const discountApplications: Record<string, unknown>[] = [];
  for (const child of object.children) {
    const id = child['id'];
    if (typeof id === 'string' && id.startsWith(LINE_ITEM_GID)) lineItems.push({ ...child });
    else if (id === undefined && 'targetType' in child) discountApplications.push({ ...child });
    else return null;
  }
  return {
    ...object.root,
    lineItems: { nodes: lineItems, pageInfo: { hasNextPage: false } },
    discountApplications: { nodes: discountApplications, pageInfo: { hasNextPage: false } },
    agreements: { nodes: [], pageInfo: { hasNextPage: true } },
  };
}

/**
 * The payment gateway names of one gateway scan line (`Order.paymentGatewayNames`), each keyed as
 * `config.gatewayMethods` keys them (`gatewayKeyOf`: the raw name cut to 200 characters, security
 * review N1), so the scan, the `GATEWAYS_UNMAPPED` check, and the mapper compare one key. Anything
 * that is not a non empty string is dropped, and so is a name with no storable key (U+0000 or an
 * unpaired surrogate, security review N3): it can never be a config key, so it is never listed.
 */
export function scannedGatewayNames(root: Readonly<Record<string, unknown>>): string[] {
  const names = root['paymentGatewayNames'];
  if (!Array.isArray(names)) return [];
  return names
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .map(gatewayKeyOf)
    .filter((key): key is string => key !== null);
}
