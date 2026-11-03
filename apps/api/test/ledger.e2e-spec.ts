import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LedgerError } from '../src/inventory/ledger/ledger.errors.js';
import {
  driftedBalances,
  fixtures,
  level,
  ledgerHarness,
  posting,
  type LedgerHarness,
} from './ledger.js';

// Spec 0002, Milestone 2: posting, costing, dates, reversals, and reads, against PostgreSQL.
describe('inventory ledger: posting core', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let make: ReturnType<typeof fixtures>;

  beforeAll(async () => {
    h = await ledgerHarness();
    make = fixtures(h.owner);
  });

  afterAll(async () => {
    await h?.close();
  });

  // AC-1 holds after every test: each balance equals the sum of its movements.
  afterEach(async () => {
    expect(await driftedBalances(h.owner)).toEqual([]);
  });

  async function rejects(promise: Promise<unknown>, code: string): Promise<LedgerError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe(code);
    return error as LedgerError;
  }

  async function sku(options: { allowNegative?: boolean } = {}) {
    return { variantId: await make.variant(), locationId: await make.location(options) };
  }

  describe('the happy path (AC-1, AC-3, AC-12)', () => {
    it('receives, ships to empty at exactly 0.00, and receives again', async () => {
      const key = await sku();

      const received = await h.ledger.post(
        posting([{ ...key, quantity: 10, unitCost: '3.3333', sourceLineId: randomUUID() }], {
          sourceType: 'purchase_receipt',
        }),
      );
      await h.ledger.post(posting([{ ...key, quantity: -4 }], { sourceType: 'sales_shipment' }));
      const emptied = await h.ledger.post(
        posting([{ ...key, quantity: -6 }], { sourceType: 'sales_shipment' }),
      );

      expect(received.movements[0]).toMatchObject({
        quantity: 10,
        unitCost: '3.3333',
        totalCost: '33.33',
        costVariance: '0.00',
        costUnknown: false,
      });
      expect(emptied.movements[0]?.totalCost).toBe('-20.00');
      expect(await level(h.owner, key)).toEqual({
        onHand: 0,
        totalValue: '0.00',
        avgUnitCost: '3.3330',
      });

      await h.ledger.post(posting([{ ...key, quantity: 2, unitCost: '5.0000' }]));
      expect(await level(h.owner, key)).toEqual({
        onHand: 2,
        totalValue: '10.00',
        avgUnitCost: '5.0000',
      });
    });

    it('records the source, dates, and poster on every movement (AC-3)', async () => {
      const key = await sku();
      const sourceId = randomUUID();
      const sourceLineId = randomUUID();
      const postedBy = randomUUID();

      const result = await h.ledger.post(
        posting([{ ...key, quantity: 3, unitCost: '1.5', sourceLineId, reasonCode: 'found' }], {
          sourceType: 'count',
          sourceId,
          postedBy,
        }),
      );

      expect(result).toMatchObject({ sourceType: 'count', sourceId, postedBy });
      expect(result.movements[0]).toMatchObject({ sourceLineId, reasonCode: 'found' });
      expect(Date.parse(result.effectiveAt)).toBeGreaterThan(Date.now() - 60_000);
      const { rows } = await h.owner.pool.query(
        `SELECT m.effective_at = g.effective_at AND m.recorded_at = g.recorded_at AS same
         FROM stock_movements m JOIN movement_groups g ON g.id = m.group_id WHERE g.id = $1`,
        [result.groupId],
      );
      expect(rows).toEqual([{ same: true }]);
    });

    it('rejects a unit cost on an outbound line and a missing one on an inbound line', async () => {
      const key = await sku();

      await rejects(h.ledger.post(posting([{ ...key, quantity: 1 }])), 'InvalidCost');
      await rejects(
        h.ledger.post(posting([{ ...key, quantity: -1, unitCost: '1.0000' }])),
        'InvalidCost',
      );
      await rejects(
        h.ledger.post(posting([{ ...key, quantity: 1, unitCost: '1.00001' }])),
        'InvalidInput',
      );
    });
  });

  describe('negative stock (AC-4, AC-12)', () => {
    async function shortBy2() {
      const key = await sku({ allowNegative: true });
      await h.ledger.post(posting([{ ...key, quantity: 3, unitCost: '10.0000' }]));
      await h.ledger.post(posting([{ ...key, quantity: -5 }]));
      expect(await level(h.owner, key)).toMatchObject({ onHand: -2, totalValue: '-20.00' });
      return key;
    }

    it('rejects an outbound below zero where negative stock is not allowed', async () => {
      const key = await sku();
      await h.ledger.post(posting([{ ...key, quantity: 3, unitCost: '1.0000' }]));

      await rejects(h.ledger.post(posting([{ ...key, quantity: -4 }])), 'InsufficientStock');
      expect((await level(h.owner, key)).onHand).toBe(3);
    });

    it('closes the shortfall at its value and costs the rest at the receipt price', async () => {
      const key = await shortBy2();

      const received = await h.ledger.post(posting([{ ...key, quantity: 5, unitCost: '12.0000' }]));

      expect(received.movements[0]).toMatchObject({
        unitCost: '12.0000',
        totalCost: '56.00',
        costVariance: '4.00',
      });
      expect(await level(h.owner, key)).toEqual({
        onHand: 3,
        totalValue: '36.00',
        avgUnitCost: '12.0000',
      });
    });

    it('lands on exactly 0.00 when a receipt fills the shortfall', async () => {
      const key = await shortBy2();

      const received = await h.ledger.post(posting([{ ...key, quantity: 2, unitCost: '12.0000' }]));

      expect(received.movements[0]?.costVariance).toBe('4.00');
      expect(await level(h.owner, key)).toMatchObject({ onHand: 0, totalValue: '0.00' });
    });

    it('takes a proportional share when a receipt does not fill the shortfall', async () => {
      const key = await shortBy2();

      await h.ledger.post(posting([{ ...key, quantity: 1, unitCost: '12.0000' }]));

      expect(await level(h.owner, key)).toEqual({
        onHand: -1,
        totalValue: '-10.00',
        avgUnitCost: '10.0000',
      });
    });

    it('flags an outbound from a never costed balance as cost unknown, keeping the reason', async () => {
      const key = await sku({ allowNegative: true });

      const shipped = await h.ledger.post(
        posting([{ ...key, quantity: -2, reasonCode: 'oversold' }]),
      );

      expect(shipped.movements[0]).toMatchObject({
        totalCost: '0.00',
        costUnknown: true,
        reasonCode: 'oversold',
      });
    });
  });

  describe('lines on one balance (AC-3, AC-7)', () => {
    it('writes one movement per line, never merged, each with its own source line', async () => {
      const key = await sku();
      const [inId, outId] = [randomUUID(), randomUUID()];

      const result = await h.ledger.post(
        posting([
          { ...key, quantity: 5, unitCost: '12.0000', sourceLineId: inId },
          { ...key, quantity: -3, sourceLineId: outId },
        ]),
      );

      expect(result.movements.map((m) => [m.sourceLineId, m.quantity, m.totalCost])).toEqual([
        [inId, 5, '60.00'],
        [outId, -3, '-36.00'],
      ]);
      expect(await level(h.owner, key)).toMatchObject({ onHand: 2, totalValue: '24.00' });
    });

    it('is atomic: when the second line fails, nothing from the first lands', async () => {
      const from = await sku();
      const to = { variantId: from.variantId, locationId: await make.location() };
      await h.ledger.post(posting([{ ...from, quantity: 2, unitCost: '1.0000' }]));
      const key = randomUUID();

      await rejects(
        h.ledger.post(
          posting(
            [
              { ...to, quantity: 5, unitCost: '1.0000' },
              { ...from, quantity: -5 },
            ],
            { idempotencyKey: key },
          ),
        ),
        'InsufficientStock',
      );

      expect((await level(h.owner, to)).onHand).toBe(0);
      expect((await level(h.owner, from)).onHand).toBe(2);
      const { rows } = await h.owner.pool.query(
        'SELECT 1 FROM movement_groups WHERE idempotency_key = $1',
        [key],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('idempotency (AC-5)', () => {
    it('moves stock once and returns the first result when a key is posted twice', async () => {
      const key = await sku();
      const input = posting([{ ...key, quantity: 4, unitCost: '2.5000' }]);

      const first = await h.ledger.post(input);
      const second = await h.ledger.post(input);

      expect(second).toEqual(first);
      expect((await level(h.owner, key)).onHand).toBe(4);
    });

    it('still matches a retry that leaves the date to default', async () => {
      const key = await sku();
      const input = posting([{ ...key, quantity: 1, unitCost: '1.0000' }]);
      const first = await h.ledger.post(input);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const retry = await h.ledger.post({ ...input, postedBy: randomUUID() });

      expect(retry.groupId).toBe(first.groupId);
    });

    it('returns the stored result without checking stock or the lock date again', async () => {
      const key = await sku();
      await h.ledger.post(posting([{ ...key, quantity: 1, unitCost: '1.0000' }]));
      const input = posting([{ ...key, quantity: -1 }]);
      const first = await h.ledger.post(input);

      // Now there is no stock, and the period is locked: the replay still succeeds.
      await h.owner.pool.query(
        `UPDATE settings SET value = to_jsonb((now() AT TIME ZONE 'Africa/Cairo')::date::text)
         WHERE key = 'inventory_lock_date'`,
      );
      try {
        expect(await h.ledger.post(input)).toEqual(first);
      } finally {
        await h.owner.pool.query(
          "UPDATE settings SET value = 'null' WHERE key = 'inventory_lock_date'",
        );
      }
    });

    it('rejects the same key with a different quantity', async () => {
      const key = await sku();
      const input = posting([{ ...key, quantity: 4, unitCost: '2.5000' }]);
      await h.ledger.post(input);

      await rejects(
        h.ledger.post({ ...input, lines: [{ ...key, quantity: 5, unitCost: '2.5000' }] }),
        'IdempotencyConflict',
      );
      expect((await level(h.owner, key)).onHand).toBe(4);
    });

    it('rejects a posting key reused for a reversal', async () => {
      const key = await sku();
      const input = posting([{ ...key, quantity: 1, unitCost: '1.0000' }]);
      const first = await h.ledger.post(input);

      await rejects(
        h.ledger.reverse({
          groupId: first.groupId,
          idempotencyKey: input.idempotencyKey,
          reasonCode: 'mistake',
        }),
        'IdempotencyConflict',
      );
    });
  });

  describe('dates (AC-6)', () => {
    async function cairo(day: 'yesterday' | 'today' | 'tomorrow', time: string): Promise<Date> {
      const offset = { yesterday: -1, today: 0, tomorrow: 1 }[day];
      const { rows } = await h.owner.pool.query<{ at: Date }>(
        `SELECT (((now() AT TIME ZONE 'Africa/Cairo')::date + $1::int) + $2::time)
                AT TIME ZONE 'Africa/Cairo' AS at`,
        [offset, time],
      );
      const at = rows[0]?.at;
      if (!at) throw new Error('no date');
      return new Date(at);
    }

    it('applies the lock date in Cairo time, and refuses future dates', async () => {
      const key = await sku();
      await h.owner.pool.query(
        `UPDATE settings
         SET value = to_jsonb(((now() AT TIME ZONE 'Africa/Cairo')::date - 1)::text)
         WHERE key = 'inventory_lock_date'`,
      );
      try {
        const line = { ...key, quantity: 1, unitCost: '1.0000' };
        await rejects(
          h.ledger.post(posting([line], { effectiveAt: await cairo('yesterday', '23:30') })),
          'PeriodLocked',
        );
        const today = await h.ledger.post(
          posting([line], { effectiveAt: await cairo('today', '00:30') }),
        );
        expect(today.movements).toHaveLength(1);
        await rejects(
          h.ledger.post(posting([line], { effectiveAt: await cairo('tomorrow', '12:00') })),
          'FutureDate',
        );
      } finally {
        await h.owner.pool.query(
          "UPDATE settings SET value = 'null' WHERE key = 'inventory_lock_date'",
        );
      }
    });

    it('accepts a date a little ahead of the clock, within 5 minutes', async () => {
      const key = await sku();

      const result = await h.ledger.post(
        posting([{ ...key, quantity: 1, unitCost: '1.0000' }], {
          effectiveAt: new Date(Date.now() + 2 * 60_000),
        }),
      );

      expect(result.movements).toHaveLength(1);
    });
  });

  describe('reversals (AC-2, AC-12)', () => {
    it('costs a reversed receipt by the outbound rule and records the gap as variance', async () => {
      const key = await sku();
      await h.ledger.post(posting([{ ...key, quantity: 5, unitCost: '10.0000' }]));
      const receipt = await h.ledger.post(posting([{ ...key, quantity: 5, unitCost: '20.0000' }]));
      await h.ledger.post(posting([{ ...key, quantity: -5 }]));
      await h.ledger.post(posting([{ ...key, quantity: 3, unitCost: '1.0000' }]));
      expect(await level(h.owner, key)).toMatchObject({ onHand: 8, totalValue: '78.00' });

      const reversal = await h.ledger.reverse({
        groupId: receipt.groupId,
        idempotencyKey: randomUUID(),
        reasonCode: 'wrong supplier',
      });

      expect(reversal).toMatchObject({
        reversesGroupId: receipt.groupId,
        sourceType: receipt.sourceType,
        sourceId: receipt.sourceId,
      });
      expect(reversal.movements[0]).toMatchObject({
        quantity: -5,
        totalCost: '-48.75',
        costVariance: '-51.25',
        reasonCode: 'wrong supplier',
      });
      expect(await level(h.owner, key)).toMatchObject({ onHand: 3, totalValue: '29.25' });
    });

    it('returns a reversed shipment at its original cost and lands on exactly 0.00', async () => {
      const key = await sku({ allowNegative: true });
      await h.ledger.post(posting([{ ...key, quantity: 3, unitCost: '3.3333' }]));
      const shipment = await h.ledger.post(posting([{ ...key, quantity: -5 }]));
      await h.ledger.post(posting([{ ...key, quantity: 2, unitCost: '3.0000' }]));
      expect((await level(h.owner, key)).onHand).toBe(0);
      await h.ledger.post(posting([{ ...key, quantity: -5 }]));

      await h.ledger.reverse({
        groupId: shipment.groupId,
        idempotencyKey: randomUUID(),
        reasonCode: 'cancelled',
      });

      expect(await level(h.owner, key)).toMatchObject({ onHand: 0, totalValue: '0.00' });
    });

    it('reverses a group once, and never a reversal', async () => {
      const key = await sku();
      const receipt = await h.ledger.post(posting([{ ...key, quantity: 2, unitCost: '1.0000' }]));
      const reversal = await h.ledger.reverse({
        groupId: receipt.groupId,
        idempotencyKey: randomUUID(),
        reasonCode: 'mistake',
      });

      await rejects(
        h.ledger.reverse({
          groupId: receipt.groupId,
          idempotencyKey: randomUUID(),
          reasonCode: 'x',
        }),
        'AlreadyReversed',
      );
      await rejects(
        h.ledger.reverse({
          groupId: reversal.groupId,
          idempotencyKey: randomUUID(),
          reasonCode: 'x',
        }),
        'CannotReverseReversal',
      );
    });

    it('replays a reversal by its key', async () => {
      const key = await sku();
      const receipt = await h.ledger.post(posting([{ ...key, quantity: 2, unitCost: '1.0000' }]));
      const input = {
        groupId: receipt.groupId,
        idempotencyKey: randomUUID(),
        reasonCode: 'mistake',
      };

      const first = await h.ledger.reverse(input);

      expect(await h.ledger.reverse(input)).toEqual(first);
      expect((await level(h.owner, key)).onHand).toBe(0);
    });

    it('needs a current date to reverse a movement from a locked month', async () => {
      const key = await sku();
      const receipt = await h.ledger.post(
        posting([{ ...key, quantity: 2, unitCost: '1.0000' }], {
          effectiveAt: new Date(Date.now() - 40 * 86_400_000),
        }),
      );
      await h.owner.pool.query(
        `UPDATE settings SET value = to_jsonb(((now() AT TIME ZONE 'Africa/Cairo')::date - 10)::text)
         WHERE key = 'inventory_lock_date'`,
      );
      try {
        await rejects(
          h.ledger.reverse({
            groupId: receipt.groupId,
            idempotencyKey: randomUUID(),
            reasonCode: 'late',
            effectiveAt: new Date(Date.now() - 30 * 86_400_000),
          }),
          'PeriodLocked',
        );
        const reversal = await h.ledger.reverse({
          groupId: receipt.groupId,
          idempotencyKey: randomUUID(),
          reasonCode: 'late',
        });
        expect(reversal.movements).toHaveLength(1);
      } finally {
        await h.owner.pool.query(
          "UPDATE settings SET value = 'null' WHERE key = 'inventory_lock_date'",
        );
      }
    });
  });

  describe('concurrency (AC-4)', () => {
    it('lets exactly 10 of 20 parallel single unit shipments take 10 on hand', async () => {
      const key = await sku();
      await h.ledger.post(posting([{ ...key, quantity: 10, unitCost: '1.0000' }]));

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => h.ledger.post(posting([{ ...key, quantity: -1 }]))),
      );

      const failures = results.filter((r) => r.status === 'rejected');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
      expect(failures).toHaveLength(10);
      for (const failure of failures) {
        expect(failure.reason).toMatchObject({
          code: 'InsufficientStock',
        });
      }
      expect(await level(h.owner, key)).toMatchObject({ onHand: 0, totalValue: '0.00' });
    });

    it('never deadlocks when postings touch the same balances in opposite orders', async () => {
      const a = await sku();
      const b = { variantId: await make.variant(), locationId: a.locationId };

      const results = await Promise.allSettled(
        Array.from({ length: 100 }, (_, i) =>
          h.ledger.post(
            posting(
              i % 2
                ? [
                    { ...a, quantity: 1, unitCost: '1.0000' },
                    { ...b, quantity: 1, unitCost: '1.0000' },
                  ]
                : [
                    { ...b, quantity: 1, unitCost: '1.0000' },
                    { ...a, quantity: 1, unitCost: '1.0000' },
                  ],
            ),
          ),
        ),
      );

      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      expect((await level(h.owner, a)).onHand).toBe(100);
      expect((await level(h.owner, b)).onHand).toBe(100);
    });
  });

  describe('input and reference errors', () => {
    it('rejects a zero quantity before touching the database (covers: AC-3)', async () => {
      const key = await sku();

      await rejects(h.ledger.post(posting([{ ...key, quantity: 0 }])), 'InvalidInput');
    });

    it('rejects a bin that belongs to another location', async () => {
      const key = await sku();
      const elsewhere = await make.bin(await make.location());

      await rejects(
        h.ledger.post(posting([{ ...key, binId: elsewhere, quantity: 1, unitCost: '1' }])),
        'UnknownReference',
      );
    });

    it('rejects an unknown SKU', async () => {
      const locationId = await make.location();

      await rejects(
        h.ledger.post(
          posting([{ variantId: randomUUID(), locationId, quantity: 1, unitCost: '1' }]),
        ),
        'UnknownReference',
      );
    });

    it('rejects reversing a group that does not exist', async () => {
      await rejects(
        h.ledger.reverse({ groupId: randomUUID(), idempotencyKey: randomUUID(), reasonCode: 'x' }),
        'NotFound',
      );
    });

    it('keeps a unit cost exactly as given, to 4 decimals (covers: AC-3)', async () => {
      const key = await sku();

      const result = await h.ledger.post(posting([{ ...key, quantity: 3, unitCost: '0.0001' }]));

      expect(result.movements[0]).toMatchObject({ unitCost: '0.0001', totalCost: '0.00' });
    });
  });

  describe('concurrent repeats of one key (AC-5)', () => {
    it('moves stock once when the same key arrives many times at once (covers: AC-5)', async () => {
      const key = await sku();
      const input = posting([{ ...key, quantity: 7, unitCost: '1.0000' }]);

      const results = await Promise.all(Array.from({ length: 10 }, () => h.ledger.post(input)));

      expect(new Set(results.map((r) => r.groupId)).size).toBe(1);
      expect((await level(h.owner, key)).onHand).toBe(7);
    });
  });

  describe('reads (AC-1, AC-9)', () => {
    it('filters balances by location', async () => {
      const variantId = await make.variant();
      const [here, there] = [await make.location(), await make.location()];
      await h.ledger.post(
        posting([
          { variantId, locationId: here, quantity: 1, unitCost: '1' },
          { variantId, locationId: there, quantity: 2, unitCost: '1' },
        ]),
      );

      const page = await h.ledger.getLevels({ variantId, locationId: there });

      expect(page.levels.map((l) => [l.locationId, l.onHand])).toEqual([[there, 2]]);
    });

    it('pages balances by cursor with reserved and available per SKU, location, and lot', async () => {
      const variantId = await make.variant();
      const locations = [await make.location(), await make.location(), await make.location()];
      for (const locationId of locations) {
        await h.ledger.post(posting([{ variantId, locationId, quantity: 4, unitCost: '1.0000' }]));
      }

      const first = await h.ledger.getLevels({ variantId, limit: 2 });
      const second = await h.ledger.getLevels({
        variantId,
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });

      expect(first.levels).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      expect(second.levels).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect([...first.levels, ...second.levels].map((l) => l.locationId).sort()).toEqual(
        [...locations].sort(),
      );
      expect(first.availability).toHaveLength(2);
      expect(first.availability[0]).toMatchObject({ onHand: 4, reserved: 0, available: 4 });
    });

    it('counts only sellable bins of sellable locations as available', async () => {
      const variantId = await make.variant();
      const shop = await make.location();
      const backroom = await make.location({ isSellable: false });
      const shelf = await make.bin(shop);
      const quarantine = await make.bin(shop, { isSellable: false });
      await h.ledger.post(
        posting([
          { variantId, locationId: shop, binId: shelf, quantity: 3, unitCost: '1.0000' },
          { variantId, locationId: shop, binId: quarantine, quantity: 5, unitCost: '1.0000' },
          { variantId, locationId: backroom, quantity: 7, unitCost: '1.0000' },
        ]),
      );

      const available = await h.ledger.getAvailable({ variantId });

      expect(available).toEqual([
        { variantId, locationId: shop, lotId: null, onHand: 3, reserved: 0, available: 3 },
      ]);
    });
  });
});
