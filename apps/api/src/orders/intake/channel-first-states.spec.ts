import { describe, expect, it } from 'vitest';
import { InvalidOrderInput } from '../orders.errors.js';
import { assertFoundAmounts, planFirstStates } from './channel-first-states.js';

const placedAt = new Date('2026-10-01T09:00:00.000Z');
const job = { type: 'system_job', job: 'shopify.intake', jobId: 'j1' } as const;
const run = { type: 'import', runId: '01937f3a-0000-7000-8000-0000000000aa' } as const;

describe('planFirstStates (spec 0013 AC-14, AC-25 a)', () => {
  it('starts every order without first states at new, holding stock', () => {
    expect(planFirstStates(null, job, placedAt)).toMatchObject({
      fulfillment: 'new',
      fulfillmentReason: null,
      cash: null,
      lineState: 'open',
      takesStock: true,
      confirmedAt: null,
      carrierDeliveryCreatedAt: null,
    });
  });

  it('starts a go live import confirmed at its placed time, for a system job only', () => {
    const goLive = { fulfillment: 'confirmed', reasonCode: 'go_live_import' } as const;

    expect(planFirstStates(goLive, job, placedAt)).toMatchObject({
      fulfillment: 'confirmed',
      fulfillmentReason: 'go_live_import',
      cash: null,
      confirmedAt: placedAt,
      takesStock: true,
    });
    expect(() => planFirstStates(goLive, run, placedAt)).toThrow(InvalidOrderInput);
    expect(() =>
      planFirstStates(goLive, { type: 'person', userId: 'u', hat: 'support' }, placedAt),
    ).toThrow(InvalidOrderInput);
  });

  it('takes the found states of an import only, delivered lines and the freeze included', () => {
    const found = {
      fulfillment: 'delivered',
      cash: 'unpaid',
      carrierDeliveryCreatedAt: null,
    } as const;

    expect(planFirstStates(found, run, placedAt)).toMatchObject({
      fulfillment: 'delivered',
      cash: 'unpaid',
      lineState: 'delivered',
      takesStock: false,
      carrierDeliveryCreatedAt: placedAt,
      collected: false,
      remitted: false,
    });
    expect(() => planFirstStates(found, job, placedAt)).toThrow(InvalidOrderInput);
  });

  it('keeps a found open order holding stock, and a cancelled one with its reason and open lines', () => {
    expect(
      planFirstStates(
        { fulfillment: 'new', cash: 'unpaid', carrierDeliveryCreatedAt: null },
        run,
        placedAt,
      ),
    ).toMatchObject({ takesStock: true, lineState: 'open', carrierDeliveryCreatedAt: null });
    expect(
      planFirstStates(
        {
          fulfillment: 'cancelled',
          cash: 'nothing_to_collect',
          carrierDeliveryCreatedAt: null,
          cancelReasonCode: 'channel.customer',
        },
        run,
        placedAt,
      ),
    ).toMatchObject({
      takesStock: false,
      lineState: 'open',
      cancelledAt: placedAt,
      cancelReasonCode: 'channel.customer',
      fulfillmentReason: 'channel.customer',
    });
  });

  it('maps refused and returned orders to lines back at origin, and refuses a partial delivery', () => {
    expect(
      planFirstStates(
        {
          fulfillment: 'refused',
          cash: 'nothing_to_collect',
          carrierDeliveryCreatedAt: null,
          refusedReasonCode: 'size',
        },
        run,
        placedAt,
      ),
    ).toMatchObject({ lineState: 'returned_to_origin', refusedReasonCode: 'size' });
    expect(() =>
      planFirstStates(
        { fulfillment: 'partially_delivered', cash: 'unpaid', carrierDeliveryCreatedAt: null },
        run,
        placedAt,
      ),
    ).toThrow(InvalidOrderInput);
  });
});

describe('planFirstStates: the found states allow list (security M1)', () => {
  const found = (fulfillment: string, cash: string, over: Record<string, unknown> = {}) =>
    ({ fulfillment, cash, carrierDeliveryCreatedAt: null, ...over }) as Parameters<
      typeof planFirstStates
    >[0];

  it.each([
    ['new', 'remitted'],
    ['confirmed', 'collected_by_carrier'],
    ['packed', 'reconciled'],
    ['cancelled', 'collected_by_carrier'],
    ['cancelled', 'prepaid'],
  ])('refuses %s with %s', (fulfillment, cash) => {
    const over = fulfillment === 'cancelled' ? { cancelReasonCode: 'channel.customer' } : {};
    expect(() => planFirstStates(found(fulfillment, cash, over), run, placedAt)).toThrow(
      InvalidOrderInput,
    );
  });

  it('needs the carrier delivery time once the cash is past a first state', () => {
    expect(() =>
      planFirstStates(found('delivered', 'collected_by_carrier'), run, placedAt),
    ).toThrow(InvalidOrderInput);
    expect(
      planFirstStates(
        found('delivered', 'remitted', { carrierDeliveryCreatedAt: '2026-10-02T09:00:00.000Z' }),
        run,
        placedAt,
      ),
    ).toMatchObject({ collected: true, remitted: true });
  });

  it('records the import run on the events, and refuses a run id that is not a uuid', () => {
    expect(planFirstStates(found('new', 'unpaid'), run, placedAt).eventSource).toEqual({
      type: 'import_run',
      id: run.runId,
    });
    expect(planFirstStates(null, job, placedAt).eventSource).toBeNull();
    expect(() =>
      planFirstStates(found('new', 'unpaid'), { type: 'import', runId: 'r1' }, placedAt),
    ).toThrow(InvalidOrderInput);
  });
});

describe('assertFoundAmounts (security M1)', () => {
  const plan = (fulfillment: string, cash: string) =>
    planFirstStates(
      {
        fulfillment,
        cash,
        carrierDeliveryCreatedAt: '2026-10-02T09:00:00.000Z',
        ...(fulfillment === 'cancelled' ? { cancelReasonCode: 'channel.customer' } : {}),
      } as Parameters<typeof planFirstStates>[0],
      run,
      placedAt,
    );
  const cod = { codExpectedAmount: '500.00', codDueAmount: '500.00', prepaidAmount: '0.00' };
  const prepaid = { codExpectedAmount: '0.00', codDueAmount: '0.00', prepaidAmount: '500.00' };
  const nothingDue = { codExpectedAmount: '500.00', codDueAmount: '0.00', prepaidAmount: '0.00' };

  it.each([
    ['new', 'unpaid', cod],
    ['new', 'prepaid', prepaid],
    ['cancelled', 'nothing_to_collect', nothingDue],
    ['returned_to_origin', 'nothing_to_collect', nothingDue],
    ['delivered', 'collected_by_carrier', cod],
    ['delivered', 'reconciled', prepaid],
  ])('accepts %s with %s and matching amounts', (fulfillment, cash, amounts) => {
    expect(() => assertFoundAmounts(plan(fulfillment, cash), amounts)).not.toThrow();
  });

  it.each([
    ['new', 'unpaid', prepaid, 'nothing to collect'],
    ['new', 'prepaid', cod, 'no prepayment'],
    ['new', 'nothing_to_collect', cod, 'an amount due'],
    ['delivered', 'collected_by_carrier', nothingDue, 'nothing due'],
    ['delivered', 'remitted', prepaid, 'nothing due'],
  ])('refuses %s with %s when %#', (fulfillment, cash, amounts) => {
    expect(() => assertFoundAmounts(plan(fulfillment, cash), amounts)).toThrow(InvalidOrderInput);
  });

  it('checks nothing without found cash (a plain or go live order)', () => {
    expect(() => assertFoundAmounts(planFirstStates(null, job, placedAt), prepaid)).not.toThrow();
  });
});
