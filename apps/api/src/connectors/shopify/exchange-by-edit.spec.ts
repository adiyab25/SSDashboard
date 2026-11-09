import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ChannelOrderInput, OrderDetail } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import type { OrderIntake } from '../../orders/intake/order-intake.service.js';
import type { OrderTransaction } from '../../orders/order-transactions.js';
import { RelatedOrderState, VariantUnknown } from '../../orders/orders.errors.js';
import type { OrderQueries } from '../../orders/reading/order-query.service.js';
import {
  ExchangeByEdit,
  planReplacement,
  stateWithReplacement,
  stateWithWaitingReplacement,
  stateWithoutWaitingReplacement,
  waitingReplacementInput,
} from './exchange-by-edit.js';
import {
  parseShopifyOrder,
  ShopifyOrderMappingError,
  type ShopifyOrder,
  type ShopifyOrderContext,
} from './order-mapper.js';
import { parseOrderMappingState, type OrderMappingState } from './order-mapping-state.js';

// Spec 0015 task 10 (AC-12, owner decision Q-13.5): the replacement order of an exchange made by
// editing a delivered Shopify order, over the synthetic fixtures (to be replaced by recordings).
// The planning is pure; the service runs against fakes of orders and of the unit's transaction.

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(file: string): ShopifyOrder {
  const json = JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8')) as {
    response: { body: { data: { order: unknown } } };
  };
  return parseShopifyOrder(json.response.body.data.order);
}

const ORIGINAL = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e10';
const SKU_L = '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e0b';
const GID = 'gid://shopify/Order/5550000008001';

const CONTEXT: ShopifyOrderContext = {
  storeId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e01',
  channelId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e02',
  connectionId: '0b6f0a52-9a51-4d38-8f63-0a8f3c1d2e03',
  variants: new Map([['gid://shopify/ProductVariant/7770000000102', SKU_L]]),
  altPhoneAttribute: 'alt_phone',
  gatewayMethods: { 'Cash on Delivery (COD)': 'cod', manual: 'cod' },
  giftTags: {},
  goLiveAt: null,
  defaultTaxRate: '14.00',
};

const line = (n: string) => `gid://shopify/LineItem/${n}`;

/** The mapping of the delivered order before the exchange: the M line held. */
const DELIVERED: OrderMappingState = {
  appliedLines: { [line('6660000008001')]: 1 },
  appliedLineIds: [line('6660000008001')],
  deliveryFulfillmentId: 'gid://shopify/Fulfillment/9990000008001',
};

const EXCHANGED = fixture('order-exchange-added-lines/02-order-read.json');

describe('planReplacement (AC-12)', () => {
  it('makes #1009-R1 of only the added L line, linked replacement_for, with no shipping, code, note, or prepayment', () => {
    const plan = planReplacement(EXCHANGED, CONTEXT, DELIVERED, ORIGINAL);
    expect(plan?.input).toMatchObject({
      channelOrderRef: `${GID}:R1`,
      orderNumber: '#1009-R1',
      relatedOrder: { orderId: ORIGINAL, relation: 'replacement_for' },
      shippingChargedAmount: '0.00',
      discountCode: null,
      customerNote: null,
      prepaidAmount: '0.00',
      prepaidMethod: null,
      paymentMethod: 'cod',
    });
    expect(plan?.input.lines).toEqual([
      expect.objectContaining({
        channelLineId: line('6660000008002'),
        variantId: SKU_L,
        quantity: 1,
      }),
    ]);
    expect(plan?.pending.replacement).toEqual({
      n: 1,
      orderNumber: '#1009-R1',
      placedAt: '2026-11-02T09:15:00Z',
      type: 'sale',
      giftReasonCode: null,
      paymentMethod: 'cod',
      customerExternalId: 'gid://shopify/Customer/8880000001001',
    });
    // The waiting lines hold no ship to field (Law 151).
    expect(JSON.stringify(plan?.pending)).not.toContain('شارع');
  });

  it('numbers the next replacement after the ones made, keeps a waiting number, and plans nothing for lines already held', () => {
    const second = planReplacement(
      EXCHANGED,
      CONTEXT,
      { ...DELIVERED, replacementOrderIds: ['a', 'b'] },
      ORIGINAL,
    );
    expect(second?.input.orderNumber).toBe('#1009-R3');
    const waiting = planReplacement(
      EXCHANGED,
      CONTEXT,
      {
        ...DELIVERED,
        replacementOrderIds: ['a', 'b'],
        pendingReplacement: { ...second!.pending.replacement, n: 2 },
      },
      ORIGINAL,
    );
    expect(waiting?.input.channelOrderRef).toBe(`${GID}:R2`);
    expect(
      planReplacement(
        EXCHANGED,
        CONTEXT,
        { ...DELIVERED, replacementLineIds: [line('6660000008002')] },
        ORIGINAL,
      ),
    ).toBeNull();
  });

  it('plans nothing, and never fails NO_OPEN_LINES, when every line was refunded', () => {
    const refunded: ShopifyOrder = {
      ...EXCHANGED,
      lineItems: {
        ...EXCHANGED.lineItems,
        nodes: EXCHANGED.lineItems.nodes.map((item) => ({ ...item, currentQuantity: 0 })),
      },
    };
    expect(planReplacement(refunded, CONTEXT, DELIVERED, ORIGINAL)).toBeNull();
  });
});

describe('the waiting replacement (AC-12)', () => {
  it('builds the same replacement from the stored lines and the original ship to', () => {
    const plan = planReplacement(EXCHANGED, CONTEXT, DELIVERED, ORIGINAL)!;
    const state = parseOrderMappingState(
      JSON.parse(JSON.stringify(stateWithWaitingReplacement(DELIVERED, plan.pending))),
    );
    const input = waitingReplacementInput(
      state.pendingReplacement!,
      state.pendingReplacementLines!,
      {
        storeId: CONTEXT.storeId,
        channelId: CONTEXT.channelId,
        connectionId: CONTEXT.connectionId,
        orderGid: GID,
        originalOrderId: ORIGINAL,
        shipTo: {
          name: 'Fixture',
          phone: '+201000000101',
          phoneAlt: null,
          address: 'x',
          courierNote: null,
        },
      },
    );
    expect(input).toMatchObject({
      channelOrderRef: plan.input.channelOrderRef,
      orderNumber: plan.input.orderNumber,
      relatedOrder: plan.input.relatedOrder,
      lines: plan.input.lines,
      channelCustomer: plan.input.channelCustomer,
      shippingChargedAmount: '0.00',
    });
    expect(() =>
      waitingReplacementInput(state.pendingReplacement!, state.pendingReplacementLines!, {
        storeId: 'not-a-uuid',
        channelId: CONTEXT.channelId,
        connectionId: CONTEXT.connectionId,
        orderGid: GID,
        originalOrderId: ORIGINAL,
        shipTo: { name: null, phone: null, phoneAlt: null, address: null, courierNote: null },
      }),
    ).toThrow(ShopifyOrderMappingError);
  });

  it('moves the state: waiting, made (remembered, nothing waiting), and dropped', () => {
    const plan = planReplacement(EXCHANGED, CONTEXT, DELIVERED, ORIGINAL)!;
    const waiting = stateWithWaitingReplacement(DELIVERED, plan.pending);
    expect(waiting.pendingReplacementLines).toHaveLength(1);
    const made = stateWithReplacement(waiting, 'r1', [line('6660000008002')]);
    expect(made).toMatchObject({
      replacementOrderIds: ['r1'],
      replacementLineIds: [line('6660000008002')],
      appliedLines: DELIVERED.appliedLines,
    });
    expect(made).not.toHaveProperty('pendingReplacementLines');
    expect(made).not.toHaveProperty('pendingReplacement');
    expect(stateWithoutWaitingReplacement(waiting)).not.toHaveProperty('pendingReplacementLines');
  });
});

/** A fake unit transaction: records each statement's SQL text and answers the queued rows. */
function fakeTx(answers: Record<string, unknown>[][] = []) {
  const statements: string[] = [];
  const tx = {
    execute: (query: { queryChunks?: unknown[] }) => {
      const text = (query.queryChunks ?? [])
        .map((chunk) =>
          typeof chunk === 'object' && chunk !== null && 'value' in chunk
            ? (chunk as { value: string[] }).value.join('')
            : '$',
        )
        .join('');
      statements.push(text.replace(/\s+/g, ' ').trim());
      return Promise.resolve({ rows: /^SELECT/.test(text.trim()) ? (answers.shift() ?? []) : [] });
    },
  };
  return { tx: tx as unknown as OrderTransaction, statements };
}

/** An `OrderIntake` whose `createFromChannel` answers with `answer` and records its inputs. */
function fakeIntake(answer: () => Promise<{ orderId: string; created: boolean }>) {
  const inputs: ChannelOrderInput[] = [];
  const intake = {
    createFromChannel: async (_tx: OrderTransaction, input: ChannelOrderInput) => {
      inputs.push(input);
      return answer();
    },
  };
  return { intake: intake as unknown as OrderIntake, inputs };
}

const DETAIL = {
  id: ORIGINAL,
  storeId: CONTEXT.storeId,
  channelId: CONTEXT.channelId,
  shipTo: {
    name: 'Fixture Person',
    phone: null,
    phoneAlt: null,
    contactPhoneRaw: '0100000',
    address: 'Fixture street',
    area: null,
    courierNote: 'not copied',
  },
} as unknown as OrderDetail;
const queries = { detail: () => Promise.resolve(DETAIL) } as unknown as OrderQueries;
const ACTOR = { type: 'system_job', job: 'test', jobId: 'job-1' } as const;

describe('ExchangeByEdit (AC-12)', () => {
  it('keeps the lines waiting when orders refuses the link, rolling back to its savepoint', async () => {
    const { intake } = fakeIntake(() => Promise.reject(new RelatedOrderState()));
    const { tx, statements } = fakeTx();
    const result = await new ExchangeByEdit(intake, queries).fromReadBack(tx, {
      order: EXCHANGED,
      context: CONTEXT,
      state: DELIVERED,
      originalOrderId: ORIGINAL,
      actor: ACTOR,
    });
    expect(result.waiting).toBe(true);
    expect(result.state.pendingReplacementLines?.map((l) => l.channelLineId)).toEqual([
      line('6660000008002'),
    ]);
    expect(statements).toEqual([
      'SAVEPOINT exchange_by_edit',
      'ROLLBACK TO SAVEPOINT exchange_by_edit',
    ]);
  });

  it('remembers the replacement it made, and lets any other orders error through', async () => {
    const { intake, inputs } = fakeIntake(() => Promise.resolve({ orderId: 'r1', created: true }));
    const { tx } = fakeTx();
    const result = await new ExchangeByEdit(intake, queries).fromReadBack(tx, {
      order: EXCHANGED,
      context: CONTEXT,
      state: stateWithWaitingReplacement(
        DELIVERED,
        planReplacement(EXCHANGED, CONTEXT, DELIVERED, ORIGINAL)!.pending,
      ),
      originalOrderId: ORIGINAL,
      actor: ACTOR,
    });
    expect(result).toMatchObject({
      waiting: false,
      state: { replacementOrderIds: ['r1'], replacementLineIds: [line('6660000008002')] },
    });
    expect(result.state).not.toHaveProperty('pendingReplacementLines');
    expect(inputs).toHaveLength(1);

    const failing = fakeIntake(() => Promise.reject(new VariantUnknown()));
    await expect(
      new ExchangeByEdit(failing.intake, queries).fromReadBack(fakeTx().tx, {
        order: EXCHANGED,
        context: CONTEXT,
        state: DELIVERED,
        originalOrderId: ORIGINAL,
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(VariantUnknown);
  });

  it('drops a waiting replacement whose added lines Shopify removed again', async () => {
    const { intake, inputs } = fakeIntake(() => Promise.resolve({ orderId: 'r1', created: true }));
    const before = fixture('order-exchange-added-lines/01-order-read.json');
    const waiting = stateWithWaitingReplacement(
      DELIVERED,
      planReplacement(EXCHANGED, CONTEXT, DELIVERED, ORIGINAL)!.pending,
    );
    const result = await new ExchangeByEdit(intake, queries).fromReadBack(fakeTx().tx, {
      order: before,
      context: CONTEXT,
      state: waiting,
      originalOrderId: ORIGINAL,
      actor: ACTOR,
    });
    expect(result.waiting).toBe(false);
    expect(result.state).not.toHaveProperty('pendingReplacementLines');
    expect(inputs).toEqual([]);
  });

  it('retryWaitingReplacements makes the waiting replacement with the original ship to and saves the mapping', async () => {
    const plan = planReplacement(EXCHANGED, CONTEXT, DELIVERED, ORIGINAL)!;
    const stored: unknown = JSON.parse(
      JSON.stringify(stateWithWaitingReplacement(DELIVERED, plan.pending)),
    );
    const { intake, inputs } = fakeIntake(() => Promise.resolve({ orderId: 'r1', created: true }));
    const { tx, statements } = fakeTx([
      [{ id: 'm1', external_id: GID, local_id: ORIGINAL, state: stored }],
    ]);
    const result = await new ExchangeByEdit(intake, queries).retryWaitingReplacements(
      tx,
      CONTEXT.connectionId,
      'm1',
      ACTOR,
    );
    expect(result).toEqual({ status: 'created', orderId: 'r1' });
    expect(inputs[0]).toMatchObject({
      orderNumber: '#1009-R1',
      channelOrderRef: `${GID}:R1`,
      relatedOrder: { orderId: ORIGINAL, relation: 'replacement_for' },
      shipTo: {
        name: 'Fixture Person',
        phone: '0100000',
        address: 'Fixture street',
        courierNote: null,
      },
    });
    expect(statements.at(-1)).toMatch(/^UPDATE connection_external_ids SET state = /);
  });

  it('retryWaitingReplacements leaves the lines waiting while the original is not replaceable, and does nothing without them', async () => {
    const plan = planReplacement(EXCHANGED, CONTEXT, DELIVERED, ORIGINAL)!;
    const stored: unknown = JSON.parse(
      JSON.stringify(stateWithWaitingReplacement(DELIVERED, plan.pending)),
    );
    const refused = fakeIntake(() => Promise.reject(new RelatedOrderState()));
    const waiting = fakeTx([[{ id: 'm1', external_id: GID, local_id: ORIGINAL, state: stored }]]);
    expect(
      await new ExchangeByEdit(refused.intake, queries).retryWaitingReplacements(
        waiting.tx,
        CONTEXT.connectionId,
        'm1',
        ACTOR,
      ),
    ).toEqual({ status: 'waiting' });
    expect(waiting.statements.some((s) => s.startsWith('UPDATE'))).toBe(false);

    const none = fakeTx([[{ id: 'm1', external_id: GID, local_id: ORIGINAL, state: DELIVERED }]]);
    expect(
      await new ExchangeByEdit(refused.intake, queries).retryWaitingReplacements(
        none.tx,
        CONTEXT.connectionId,
        'm1',
        ACTOR,
      ),
    ).toEqual({ status: 'nothing_waiting' });
    expect(refused.inputs).toHaveLength(1);
  });
});
