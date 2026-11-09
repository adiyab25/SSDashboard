import { describe, expect, it } from 'vitest';
import {
  assembleBulkOrder,
  BulkObjectGrouper,
  BulkResultUnreadable,
  scannedGatewayNames,
  type BulkObject,
} from './bulk-jsonl.js';

const ORDER = 'gid://shopify/Order/5550001031001';
const LINE = 'gid://shopify/LineItem/6660001031001';

/** Feeds lines to a grouper and collects every whole object, the last one included. */
function group(lines: readonly string[]): BulkObject[] {
  const grouper = new BulkObjectGrouper();
  const out: BulkObject[] = [];
  lines.forEach((text, index) => {
    const done = grouper.push(text, index);
    if (done) out.push(done);
  });
  const last = grouper.end();
  if (last) out.push(last);
  return out;
}

// Spec 0015 AC-17: a bulk result is read one whole object at a time, never stored.
describe('the bulk JSONL reading', () => {
  it('puts each top level node back together with the child lines that follow it', () => {
    const objects = group([
      JSON.stringify({ id: ORDER, name: '#1031' }),
      JSON.stringify({
        __typename: 'DiscountCodeApplication',
        targetType: 'LINE_ITEM',
        __parentId: ORDER,
      }),
      JSON.stringify({ id: LINE, __parentId: ORDER }),
      JSON.stringify({ id: 'gid://shopify/Order/5550001032001', name: '#1032' }),
    ]);
    expect(objects.map((o) => [o.root['id'], o.children.length, o.line])).toEqual([
      [ORDER, 2, 0],
      ['gid://shopify/Order/5550001032001', 0, 3],
    ]);
    expect(objects[0]?.children[1]).toEqual({ id: LINE });
  });

  it('refuses a line that is not an object or a child with no parent before it, naming only the line', () => {
    expect(() => group(['not json'])).toThrow(BulkResultUnreadable);
    expect(() => group([JSON.stringify({ id: LINE, __parentId: ORDER })])).toThrow(
      'BULK_RESULT_UNREADABLE at line 0',
    );
  });

  it('assembles an order in the read back shape with its sales history marked unread (task 10)', () => {
    const [object] = group([
      JSON.stringify({ id: ORDER, name: '#1031' }),
      JSON.stringify({ targetType: 'LINE_ITEM', __parentId: ORDER }),
      JSON.stringify({ id: LINE, __parentId: ORDER }),
    ]);
    expect(assembleBulkOrder(object as BulkObject)).toEqual({
      id: ORDER,
      name: '#1031',
      lineItems: { nodes: [{ id: LINE }], pageInfo: { hasNextPage: false } },
      discountApplications: {
        nodes: [{ targetType: 'LINE_ITEM' }],
        pageInfo: { hasNextPage: false },
      },
      agreements: { nodes: [], pageInfo: { hasNextPage: true } },
    });
  });

  it('answers null for an order with a child it cannot place, so it is never mapped short', () => {
    const [object] = group([
      JSON.stringify({ id: ORDER }),
      JSON.stringify({ id: 'gid://shopify/Fulfillment/1', __parentId: ORDER }),
    ]);
    expect(assembleBulkOrder(object as BulkObject)).toBeNull();
  });

  it('keys scanned gateway names as the config keys them and drops names with no storable key', () => {
    expect(
      scannedGatewayNames({
        paymentGatewayNames: ['Cash on Delivery (COD)', '', 7, 'bad\u0000name', 'x'.repeat(250)],
      }),
    ).toEqual(['Cash on Delivery (COD)', 'x'.repeat(200)]);
    expect(scannedGatewayNames({})).toEqual([]);
  });
});
