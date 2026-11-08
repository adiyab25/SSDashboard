import { describe, expect, it } from 'vitest';
import { DomainEvents } from '../../platform/events/domain-events.js';
import type { OrderTransaction } from '../order-transactions.js';
import { OrderLocked, OrderNotFound } from '../orders.errors.js';
import { OrderWriter, type NewLineRow } from './order-writer.js';

const ORDER = '01937f3a-0000-7000-8000-000000000001';
const LINE = '01937f3a-0000-7000-8000-000000000101';

/** A transaction that answers each statement from a script, in order, and counts them. */
function scripted(answers: Record<string, unknown>[][]): {
  tx: OrderTransaction;
  calls: () => number;
  log: string[];
} {
  let calls = 0;
  const log: string[] = [];
  const tx = {
    execute: () => {
      const rows = answers[calls] ?? [];
      calls += 1;
      log.push(`statement ${calls}`);
      return Promise.resolve({ rows });
    },
  } as unknown as OrderTransaction;
  return { tx, calls: () => calls, log };
}

const writer = () => new OrderWriter(new DomainEvents());
const newLine: NewLineRow = {
  position: 9,
  variantId: null,
  title: 'Tee',
  quantity: 1,
  unitPrice: '10.00',
  discountAmount: '0.00',
  netAmount: '8.77',
  taxRate: '14.00',
  taxAmount: '1.23',
  grossAmount: '10.00',
  prepaidAmount: '0.00',
  creditAppliedAmount: '0.00',
  lineState: 'open',
  channelLineId: null,
};
const row = (fulfillment: string, outcome: string) => ({
  fulfillment_state: fulfillment,
  delivered_amount: '0.00',
  returned_credit_amount: '0.00',
  exchange_consumed_amount: '0.00',
  outcome,
});

describe('OrderWriter.applyChange: the money freeze (spec 0013 AC-8, security M1)', () => {
  it.each([
    ['cod_expected_amount', { codExpectedAmount: '10.00' }],
    ['the total', { totalAmount: '10.00' }],
    ['the shipping shares', { shippingPrepaidAmount: '0.00' }],
  ])(
    'refuses a change of %s once the carrier delivery exists, writing nothing',
    async (_name, columns) => {
      const { tx, calls } = scripted([[{ frozen: true }]]);

      await expect(writer().applyChange(tx, ORDER, { columns })).rejects.toThrow(OrderLocked);
      expect(calls()).toBe(1);
    },
  );

  it('refuses new line shares once the carrier delivery exists', async () => {
    const { tx, calls } = scripted([[{ frozen: true }]]);
    const lineShares = new Map([[LINE, { prepaidAmount: '0.00', creditAppliedAmount: '0.00' }]]);

    await expect(writer().applyChange(tx, ORDER, { columns: {}, lineShares })).rejects.toThrow(
      OrderLocked,
    );
    expect(calls()).toBe(1);
  });

  it.each([
    ['a line cancel alone', { cancelLines: [{ lineId: LINE, cancelReasonCode: 'channel_edit' }] }],
    ['a new line alone', { addLines: [newLine] }],
    ['a prepayment change', { columns: { prepaidAmount: '10.00' } }],
  ])(
    'counts %s as a money move once the carrier delivery exists (security N1)',
    async (_name, change) => {
      const { tx, calls } = scripted([[{ frozen: true }]]);

      await expect(writer().applyChange(tx, ORDER, { columns: {}, ...change })).rejects.toThrow(
        OrderLocked,
      );
      expect(calls()).toBe(1);
    },
  );

  it('lets the partial delivery split change lines of a frozen order, never a frozen column', async () => {
    const split = scripted([[{ frozen: true }], [], [{ id: LINE }], [row('shipped', 'open')]]);

    await writer().applyChange(split.tx, ORDER, {
      columns: { codDueAmount: '0.00' },
      cancelLines: [{ lineId: LINE, cancelReasonCode: 'split' }],
      addLines: [newLine],
      freezeAllowance: 'partial_delivery_split',
    });
    const frozenColumn = scripted([[{ frozen: true }]]);

    expect(split.calls()).toBe(4);
    await expect(
      writer().applyChange(frozenColumn.tx, ORDER, {
        columns: { totalAmount: '1.00' },
        freezeAllowance: 'partial_delivery_split',
      }),
    ).rejects.toThrow(OrderLocked);
  });

  it('still lets a frozen order move its state and its amount due (a cancel before pickup)', async () => {
    const { tx, calls } = scripted([
      [{ frozen: true }],
      [row('cancelled', 'cancelled_before_shipping')],
    ]);

    await writer().applyChange(tx, ORDER, {
      columns: { fulfillmentState: 'cancelled', codDueAmount: '0.00' },
    });

    expect(calls()).toBe(2);
  });

  it('answers OrderNotFound for an order that is not there', async () => {
    const { tx } = scripted([[]]);

    await expect(writer().applyChange(tx, ORDER, { columns: {} })).rejects.toThrow(OrderNotFound);
  });
});

describe('OrderWriter.applyChange: the outcome (spec 0013 AC-6, review low 4)', () => {
  it('writes the outcome deriveOrderOutcome gives when the change moves it', async () => {
    const { tx, calls } = scripted([[{ frozen: false }], [row('cancelled', 'open')], []]);

    await writer().applyChange(tx, ORDER, { columns: { fulfillmentState: 'cancelled' } });

    expect(calls()).toBe(3);
  });

  it('writes no outcome when it is already the derived one', async () => {
    const { tx, calls } = scripted([[{ frozen: false }], [row('confirmed', 'open')]]);

    await writer().applyChange(tx, ORDER, { columns: { fulfillmentState: 'confirmed' } });

    expect(calls()).toBe(2);
  });
});

describe('OrderWriter.projectWriteBackState (spec 0013 AC-12, review R1)', () => {
  it('locks the order row before it reads the commands, then writes', async () => {
    const { tx, log } = scripted([[{ id: ORDER }], []]);

    await writer().projectWriteBackState(tx, ORDER, () => {
      log.push('read commands');
      return Promise.resolve('waiting');
    });

    expect(log).toEqual(['statement 1', 'read commands', 'statement 2']);
  });

  it('writes nothing for an order that is not there', async () => {
    const { tx, log } = scripted([[]]);

    await writer().projectWriteBackState(tx, ORDER, () => {
      log.push('read commands');
      return Promise.resolve('none');
    });

    expect(log).toEqual(['statement 1']);
  });
});
