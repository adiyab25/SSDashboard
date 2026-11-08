import { describe, expect, it } from 'vitest';
import { InvalidOrderInput } from '../orders.errors.js';
import { planFirstStates } from './channel-first-states.js';

const placedAt = new Date('2026-10-01T09:00:00.000Z');
const job = { type: 'system_job', job: 'shopify.intake', jobId: 'j1' } as const;
const run = { type: 'import', runId: 'r1' } as const;

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
      cash: 'reconciled',
      carrierDeliveryCreatedAt: null,
    } as const;

    expect(planFirstStates(found, run, placedAt)).toMatchObject({
      fulfillment: 'delivered',
      cash: 'reconciled',
      lineState: 'delivered',
      takesStock: false,
      carrierDeliveryCreatedAt: placedAt,
      collected: true,
      remitted: true,
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
