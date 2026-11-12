import { randomUUID } from 'node:crypto';
import { personActor, type ReservedLine } from '@ssdashboard/contracts';
import { APP_ROLE, sql } from '@ssdashboard/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { CatalogService } from '../src/catalog/catalog.service.js';
import { DATABASE } from '../src/database/database.module.js';
import {
  ReservationFilled,
  ReservationShortened,
  StockOverdrawn,
} from '../src/inventory/inventory.events.js';
import { LedgerError } from '../src/inventory/ledger/ledger.errors.js';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { ReconciliationService } from '../src/inventory/ledger/reconciliation.service.js';
import type { StockTransaction } from '../src/inventory/ledger/stock-transaction.js';
import { OnlineStockService } from '../src/inventory/online-stock/online-stock.service.js';
import type { Transaction } from '../src/database/sql.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import type { DatabaseConnection } from '@ssdashboard/db';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { driftedBalances, fixtures, level, posting } from './ledger.js';

// Spec 0011 milestone 2 (AC-5, AC-6, AC-7, AC-21, AC-22, AC-29): the stock transaction, holding
// stock for document lines with waiting demand, carrier shipments that are never refused, the
// order thread end to end, concurrency, and a posting read by its key.

describe('stock reservations and carrier shipments', { timeout: 180_000 }, () => {
  let api: InProcessApi;
  let make: ReturnType<typeof fixtures>;
  let ledger: LedgerService;
  let online: OnlineStockService;
  let audit: AuditService;
  let events: DomainEvents;
  let connection: DatabaseConnection;
  let onlineLocation: string;
  let userId: string;

  const filled: ReservationFilled[] = [];
  const shortened: ReservationShortened[] = [];
  const overdrawn: StockOverdrawn[] = [];
  /** A test sets this to make the `ReservationFilled` handler do something inside the posting. */
  let onFilled: ((tx: Transaction) => Promise<void>) | null = null;

  beforeAll(async () => {
    api = await startInProcessApi();
    make = fixtures(api.owner);
    ledger = api.app.get(LedgerService);
    online = api.app.get(OnlineStockService);
    audit = api.app.get(AuditService);
    events = api.app.get(DomainEvents);
    connection = api.app.get<DatabaseConnection>(DATABASE);
    events.on(
      ReservationFilled,
      async (tx, event) => {
        filled.push(event);
        await onFilled?.(tx);
      },
      'test',
    );
    events.on(ReservationShortened, (_tx, event) => void shortened.push(event), 'test');
    events.on(StockOverdrawn, (_tx, event) => void overdrawn.push(event), 'test');

    // The fixture "order" table the caller of a stock transaction writes itself.
    await api.owner.pool.query(
      `CREATE TABLE fixture_orders (id uuid PRIMARY KEY, label text NOT NULL)`,
    );
    await api.owner.pool.query(`GRANT SELECT, INSERT ON fixture_orders TO ${APP_ROLE}`);
    userId = await make.user();
    onlineLocation = await make.location();
    await api.owner.pool.query('UPDATE locations SET sellable_online = true WHERE id = $1', [
      onlineLocation,
    ]);
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(() => {
    filled.length = 0;
    shortened.length = 0;
    overdrawn.length = 0;
  });

  // The balances still equal their movement sums after every test.
  afterEach(async () => {
    expect(await driftedBalances(api.owner)).toEqual([]);
  });

  /** A fresh SKU at a fresh sellable location that does not allow negative stock. */
  async function key(options: { allowNegative?: boolean } = {}) {
    return { variantId: await make.variant(), locationId: await make.location(options) };
  }

  /** A fresh SKU at the online location. */
  async function onlineKey() {
    return { variantId: await make.variant(), locationId: onlineLocation };
  }

  async function stock(at: { variantId: string; locationId: string }, quantity: number) {
    return ledger.post(
      posting([{ ...at, quantity, unitCost: '5.0000' }], { sourceType: 'opening_balance' }),
    );
  }

  /** Holds stock for lines of one order in its own stock transaction. */
  function reserve(
    orderId: string,
    shortage: 'reserve_available' | 'refuse',
    lines: { sourceLineId?: string; variantId: string; locationId: string; quantity: number }[],
  ): Promise<ReservedLine[]> {
    return ledger.transaction((tx) =>
      ledger.reserveLines(tx, {
        sourceType: 'order',
        sourceId: orderId,
        shortage,
        lines: lines.map((line) => ({ ...line, sourceLineId: line.sourceLineId ?? randomUUID() })),
      }),
    );
  }

  async function rows(sourceId: string) {
    const { rows: found } = await api.owner.pool.query<{
      source_line_id: string;
      quantity: number;
      open_quantity: number;
      unfilled_quantity: number;
      status: string;
      updated_at: string;
    }>(
      `SELECT source_line_id, quantity, open_quantity, unfilled_quantity, status, updated_at::text
       FROM reservations WHERE source_id = $1 ORDER BY created_at, id`,
      [sourceId],
    );
    return found;
  }

  async function count(table: string, where: string, values: unknown[]): Promise<number> {
    const { rows: found } = await api.owner.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
      values,
    );
    return Number(found[0]?.n);
  }

  async function failure(promise: Promise<unknown>): Promise<LedgerError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LedgerError);
    return error as LedgerError;
  }

  async function dbNow(): Promise<string> {
    const { rows: found } = await api.owner.pool.query<{ now: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    );
    return found[0]?.now ?? '';
  }

  const fixtureOrder = (tx: StockTransaction, id: string) =>
    tx.execute(sql`INSERT INTO fixture_orders (id, label) VALUES (${id}, 'order')`);

  describe('reserve lines (AC-5, AC-6)', () => {
    it('refuses every line when one is short, and writes nothing', async () => {
      const at = await key();
      await stock(at, 10);
      const orderId = randomUUID();

      const error = await failure(
        reserve(orderId, 'refuse', [
          { ...at, quantity: 6 },
          { ...at, quantity: 5 },
        ]),
      );

      expect(error.code).toBe('InsufficientStock');
      expect(error.details).toMatchObject({ lines: [{ index: 1, available: 4, requested: 5 }] });
      expect(await rows(orderId)).toEqual([]);
    });

    it('holds 6 and 4 with 1 unfilled for reserve_available, and a repeat writes nothing', async () => {
      const at = await key();
      await stock(at, 10);
      const orderId = randomUUID();
      const lines = [
        { sourceLineId: randomUUID(), ...at, quantity: 6 },
        { sourceLineId: randomUUID(), ...at, quantity: 5 },
      ];

      const first = await reserve(orderId, 'reserve_available', lines);

      expect(first).toMatchObject([
        { requested: 6, held: 6, unfilled: 0, short: false },
        { requested: 5, held: 4, unfilled: 1, short: true },
      ]);
      const stored = await rows(orderId);
      expect(stored.map((r) => [r.quantity, r.open_quantity, r.unfilled_quantity])).toEqual([
        [6, 6, 0],
        [4, 4, 1],
      ]);

      const repeat = await reserve(orderId, 'reserve_available', lines);

      expect(repeat).toEqual(first);
      expect(await rows(orderId)).toEqual(stored);
    });

    it('raises a repeat toward the request and never lowers it', async () => {
      const at = await key();
      await stock(at, 2);
      const orderId = randomUUID();
      const line = { sourceLineId: randomUUID(), ...at };

      await reserve(orderId, 'reserve_available', [{ ...line, quantity: 3 }]);
      const lower = await reserve(orderId, 'reserve_available', [{ ...line, quantity: 1 }]);
      const higher = await reserve(orderId, 'reserve_available', [{ ...line, quantity: 5 }]);

      expect(lower[0]).toMatchObject({ requested: 1, held: 2, unfilled: 1 });
      expect(higher[0]).toMatchObject({ requested: 5, held: 2, unfilled: 3 });
      expect((await rows(orderId)).map((r) => [r.open_quantity, r.unfilled_quantity])).toEqual([
        [2, 3],
      ]);
    });

    it('refuses another key for a line that already holds one', async () => {
      const at = await key();
      await stock(at, 5);
      const other = await key();
      await stock(other, 5);
      const orderId = randomUUID();
      const line = { sourceLineId: randomUUID(), quantity: 1 };
      await reserve(orderId, 'refuse', [{ ...line, ...at }]);

      const error = await failure(reserve(orderId, 'refuse', [{ ...line, ...other }]));

      expect(error.code).toBe('DuplicateReservation');
    });

    it('holds the full request where negative stock is allowed', async () => {
      const at = await key({ allowNegative: true });
      const orderId = randomUUID();

      const [line] = await reserve(orderId, 'refuse', [{ ...at, quantity: 4 }]);

      expect(line).toMatchObject({ held: 4, unfilled: 0, short: false });
    });

    it('rejects a bad line before writing: unknown SKU, too many lines, repeated line id', async () => {
      const at = await key();
      const lineId = randomUUID();

      expect(
        (
          await failure(
            reserve(randomUUID(), 'refuse', [{ ...at, variantId: randomUUID(), quantity: 1 }]),
          )
        ).code,
      ).toBe('UnknownReference');
      expect(
        (
          await failure(
            reserve(randomUUID(), 'refuse', [
              { ...at, sourceLineId: lineId, quantity: 1 },
              { ...at, sourceLineId: lineId, quantity: 1 },
            ]),
          )
        ).code,
      ).toBe('InvalidInput');
      expect(
        (
          await failure(
            reserve(
              randomUUID(),
              'refuse',
              Array.from({ length: 201 }, () => ({ ...at, quantity: 1 })),
            ),
          )
        ).code,
      ).toBe('InvalidInput');
    });

    it('rolls back the caller row and the reservations when work throws', async () => {
      const at = await key();
      await stock(at, 5);
      const orderId = randomUUID();

      await expect(
        ledger.transaction(async (tx) => {
          await fixtureOrder(tx, orderId);
          await ledger.reserveLines(tx, {
            sourceType: 'order',
            sourceId: orderId,
            shortage: 'refuse',
            lines: [{ sourceLineId: randomUUID(), ...at, quantity: 2 }],
          });
          throw new Error('order write failed');
        }),
      ).rejects.toThrow('order write failed');

      expect(await count('fixture_orders', 'id = $1', [orderId])).toBe(0);
      expect(await rows(orderId)).toEqual([]);
    });

    it('refuses a transaction the runner did not open', async () => {
      const at = await key();
      await stock(at, 5);

      const error = await failure(
        connection.db.transaction((tx) =>
          ledger.reserveLines(tx as unknown as StockTransaction, {
            sourceType: 'order',
            sourceId: randomUUID(),
            shortage: 'refuse',
            lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
          }),
        ),
      );

      expect(error.code).toBe('InvalidInput');
    });

    it('raises NestedStockTransaction and rolls the outer transaction back', async () => {
      const orderId = randomUUID();

      const nested = await failure(
        ledger.transaction(async (tx) => {
          await fixtureOrder(tx, orderId);
          await ledger.transaction(() => Promise.resolve());
        }),
      );
      // Even when work swallows the inner error, the unit still fails and rolls back.
      const swallowed = await failure(
        ledger.transaction(async (tx) => {
          await fixtureOrder(tx, orderId);
          await ledger.transaction(() => Promise.resolve()).catch(() => undefined);
        }),
      );
      // A posting inside a stock transaction is a second connection too.
      const at = await key();
      const posted = await failure(
        ledger.transaction(async (tx) => {
          await fixtureOrder(tx, orderId);
          await stock(at, 1);
        }),
      );

      expect([nested.code, swallowed.code, posted.code]).toEqual([
        'NestedStockTransaction',
        'NestedStockTransaction',
        'NestedStockTransaction',
      ]);
      expect(await count('fixture_orders', 'id = $1', [orderId])).toBe(0);
    });

    it('lets AuditService.record and DomainEvents.publish take the stock transaction', async () => {
      const orderId = randomUUID();
      const locationId = await make.location();
      const before = await count('audit_entries', `record_id = $1`, [locationId]);

      await ledger.transaction(async (tx) => {
        await fixtureOrder(tx, orderId);
        await audit.record(tx, {
          actor: personActor(userId, 'manager'),
          action: 'location.stock_confirmed',
          record: { type: 'location', id: locationId, label: 'FIXTURE' },
          after: { confirmed: true },
          correlationId: audit.newCorrelationId(),
        });
        await events.publish(
          tx,
          new ReservationFilled(randomUUID(), 'order', orderId, randomUUID(), 1, 0),
        );
      });

      expect(await count('audit_entries', `record_id = $1`, [locationId])).toBe(before + 1);
      expect(filled.map((event) => event.sourceId)).toEqual([orderId]);
    });

    it('leaves M held when a size swap fails as a whole', async () => {
      const medium = await key();
      await stock(medium, 1);
      const large = await key();
      const orderId = randomUUID();
      const lineId = randomUUID();
      await reserve(orderId, 'refuse', [{ sourceLineId: lineId, ...medium, quantity: 1 }]);

      const error = await failure(
        ledger.transaction(async (tx) => {
          await ledger.releaseLines(tx, { sourceType: 'order', sourceLineIds: [lineId] });
          await ledger.reserveLines(tx, {
            sourceType: 'order',
            sourceId: orderId,
            shortage: 'refuse',
            lines: [{ sourceLineId: randomUUID(), ...large, quantity: 1 }],
          });
        }),
      );

      expect(error.code).toBe('InsufficientStock');
      expect((await rows(orderId)).map((r) => [r.status, r.open_quantity])).toEqual([
        ['active', 1],
      ]);
    });

    it('releases lines and whole documents, and reads each line back', async () => {
      const at = await key();
      await stock(at, 3);
      const orderId = randomUUID();
      const [a, b] = [randomUUID(), randomUUID()];
      await reserve(orderId, 'reserve_available', [
        { sourceLineId: a, ...at, quantity: 2 },
        { sourceLineId: b, ...at, quantity: 2 },
      ]);

      const read = await ledger.reservationsFor({ sourceType: 'order', sourceId: orderId });
      expect(
        read.map((r) => [r.sourceLineId, r.quantity, r.openQuantity, r.unfilledQuantity, r.status]),
      ).toEqual([
        [a, 2, 2, 0, 'active'],
        [b, 1, 1, 1, 'active'],
      ]);

      const releasedOne = await ledger.transaction((tx) =>
        ledger.releaseLines(tx, { sourceType: 'order', sourceLineIds: [b] }),
      );
      const releasedRest = await ledger.transaction((tx) =>
        ledger.releaseSource(tx, { sourceType: 'order', sourceId: orderId }),
      );
      const nothing = await ledger.transaction((tx) =>
        ledger.releaseSource(tx, { sourceType: 'order', sourceId: orderId }),
      );

      expect(
        releasedOne.map((r) => [r.sourceLineId, r.status, r.openQuantity, r.unfilledQuantity]),
      ).toEqual([[b, 'released', 0, 0]]);
      expect(releasedRest.map((r) => r.sourceLineId)).toEqual([a]);
      expect(nothing).toEqual([]);
      expect(
        (await ledger.reservationsFor({ sourceType: 'order', sourceId: orderId })).map(
          (r) => r.status,
        ),
      ).toEqual(['released', 'released']);
    });
  });

  describe('waiting demand is filled first (AC-21)', () => {
    it('fills the older order on a restock and the next one on a cancel, never offering the piece', async () => {
      const at = await onlineKey();
      await stock(at, 3);
      const [orderC, orderA, orderB] = [randomUUID(), randomUUID(), randomUUID()];
      await reserve(orderC, 'refuse', [{ ...at, quantity: 1 }]);
      await reserve(orderA, 'reserve_available', [{ ...at, quantity: 3 }]);
      await reserve(orderB, 'reserve_available', [{ ...at, quantity: 1 }]);
      expect((await rows(orderA))[0]).toMatchObject({ open_quantity: 2, unfilled_quantity: 1 });
      expect((await rows(orderB))[0]).toMatchObject({ open_quantity: 0, unfilled_quantity: 1 });

      await stock(at, 1);

      expect((await rows(orderA))[0]).toMatchObject({ open_quantity: 3, unfilled_quantity: 0 });
      expect((await rows(orderB))[0]).toMatchObject({ open_quantity: 0, unfilled_quantity: 1 });
      expect(filled.map((e) => [e.sourceId, e.quantity, e.stillUnfilled])).toEqual([
        [orderA, 1, 0],
      ]);
      expect(await online.forVariants([at.variantId])).toMatchObject([
        { onHand: 4, reserved: 4, unfilledDemand: 1, available: 0, pushable: 0 },
      ]);

      filled.length = 0;
      await ledger.transaction((tx) =>
        ledger.releaseSource(tx, { sourceType: 'order', sourceId: orderC }),
      );

      expect((await rows(orderB))[0]).toMatchObject({ open_quantity: 1, unfilled_quantity: 0 });
      expect(filled.map((e) => [e.sourceId, e.quantity, e.stillUnfilled])).toEqual([
        [orderB, 1, 0],
      ]);
      expect(await online.forVariants([at.variantId])).toMatchObject([
        { onHand: 4, reserved: 4, unfilledDemand: 0, available: 0, pushable: 0 },
      ]);
    });

    it('fills from a reversal of an outbound posting too, oldest first', async () => {
      const at = await key();
      await stock(at, 1);
      const shipped = await ledger.post(
        posting([{ ...at, quantity: -1 }], { sourceType: 'order_shipment' }),
      );
      const [first, second] = [randomUUID(), randomUUID()];
      await reserve(first, 'reserve_available', [{ ...at, quantity: 1 }]);
      await reserve(second, 'reserve_available', [{ ...at, quantity: 1 }]);

      await ledger.reverse({
        groupId: shipped.groupId,
        idempotencyKey: randomUUID(),
        postedBy: null,
        reasonCode: 'test',
      });

      expect((await rows(first))[0]).toMatchObject({ open_quantity: 1, unfilled_quantity: 0 });
      expect((await rows(second))[0]).toMatchObject({ open_quantity: 0, unfilled_quantity: 1 });
    });
  });

  describe('carrier shipment (AC-22)', () => {
    it('books a short line below zero where negative is not allowed, and says so', async () => {
      const at = await key();
      await stock(at, 1);
      const orderId = randomUUID();
      const lineId = randomUUID();
      const [held] = await reserve(orderId, 'reserve_available', [
        { sourceLineId: lineId, ...at, quantity: 2 },
      ]);
      expect(held).toMatchObject({ held: 1, unfilled: 1 });

      const result = await ledger.postCarrierShipment({
        orderId,
        lines: [
          {
            sourceLineId: lineId,
            ...at,
            quantity: 2,
            reservationId: held?.reservationId,
          },
        ],
      });

      expect(result.replayed).toBe(false);
      expect(result.sourceType).toBe('order_shipment');
      expect(result.movements).toMatchObject([
        { quantity: -2, unitCost: '5.0000', totalCost: '-10.00', sourceLineId: lineId },
      ]);
      expect((await level(api.owner, at)).onHand).toBe(-1);
      expect(await rows(orderId)).toMatchObject([
        { status: 'fulfilled', open_quantity: 0, unfilled_quantity: 0 },
      ]);
      expect(overdrawn).toEqual([
        new StockOverdrawn(at.variantId, at.locationId, -1, result.groupId),
      ]);
      expect(shortened).toEqual([]);
    });

    it('shortens the newest other order when the shipped piece is held by orders', async () => {
      const at = await key();
      await stock(at, 2);
      const [older, newer, carrierOrder] = [randomUUID(), randomUUID(), randomUUID()];
      await reserve(older, 'refuse', [{ ...at, quantity: 1 }]);
      await reserve(newer, 'refuse', [{ ...at, quantity: 1 }]);
      const newerRow = (await rows(newer))[0];

      const result = await ledger.postCarrierShipment({
        orderId: carrierOrder,
        lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
      });

      expect(await rows(older)).toMatchObject([{ open_quantity: 1, unfilled_quantity: 0 }]);
      expect(await rows(newer)).toMatchObject([
        { quantity: 0, open_quantity: 0, unfilled_quantity: 1, status: 'active' },
      ]);
      expect(shortened).toEqual([
        new ReservationShortened(
          expect.any(String) as string,
          'order',
          newer,
          newerRow?.source_line_id as string,
          at.variantId,
          at.locationId,
          1,
          'carrier_shipment',
          result.groupId,
        ),
      ]);
      expect(overdrawn).toEqual([]);
      expect(await ledger.reservationsFor({ sourceType: 'order', sourceId: newer })).toMatchObject([
        { quantity: 0, openQuantity: 0, unfilledQuantity: 1, status: 'active' },
      ]);
    });

    it('lets a fully shortened reservation be released afterwards', async () => {
      const at = await key();
      await stock(at, 1);
      const holder = randomUUID();
      await reserve(holder, 'refuse', [{ ...at, quantity: 1 }]);
      await ledger.postCarrierShipment({
        orderId: randomUUID(),
        lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
      });

      const released = await ledger.transaction((tx) =>
        ledger.releaseSource(tx, { sourceType: 'order', sourceId: holder }),
      );

      expect(released).toMatchObject([
        { status: 'released', openQuantity: 0, unfilledQuantity: 0 },
      ]);
    });

    it('replays to the stored result and publishes nothing twice', async () => {
      const at = await key();
      await stock(at, 1);
      const holder = randomUUID();
      await reserve(holder, 'refuse', [{ ...at, quantity: 1 }]);
      const input = {
        orderId: randomUUID(),
        lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
      };

      const first = await ledger.postCarrierShipment(input);
      const replay = await ledger.postCarrierShipment(input);

      expect(replay).toEqual({ ...first, replayed: true });
      expect(shortened).toHaveLength(1);
      expect((await level(api.owner, at)).onHand).toBe(0);
      await expect(
        ledger.postCarrierShipment({
          ...input,
          lines: [{ ...input.lines[0]!, quantity: 2 }],
        }),
      ).rejects.toMatchObject({ code: 'IdempotencyConflict' });
    });

    it('keys a later generation apart from the first', async () => {
      const at = await key();
      await stock(at, 2);
      const orderId = randomUUID();
      const line = { sourceLineId: randomUUID(), ...at, quantity: 1 };

      const first = await ledger.postCarrierShipment({ orderId, lines: [line] });
      const second = await ledger.postCarrierShipment({ orderId, generation: 2, lines: [line] });

      expect(second.groupId).not.toBe(first.groupId);
      expect((await ledger.postingFor(`order_shipment:${orderId}:2`))?.groupId).toBe(
        second.groupId,
      );
      expect((await level(api.owner, at)).onHand).toBe(0);
    });

    it('is never refused for an archived SKU or location, or a locked period', async () => {
      const at = await key();
      await stock(at, 1);
      await make.archive('product_variants', at.variantId);
      await make.archive('locations', at.locationId);
      await api.owner.pool.query(
        `UPDATE settings SET value = to_jsonb((now() AT TIME ZONE 'Africa/Cairo')::date::text)
         WHERE key = 'inventory_lock_date'`,
      );
      try {
        const result = await ledger.postCarrierShipment({
          orderId: randomUUID(),
          effectiveAt: new Date(Date.now() - 3 * 86_400_000),
          lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
        });

        // Dated now instead of three days ago.
        expect(Date.now() - Date.parse(result.effectiveAt)).toBeLessThan(60_000);
        expect((await level(api.owner, at)).onHand).toBe(0);
      } finally {
        await api.owner.pool.query(
          "UPDATE settings SET value = 'null' WHERE key = 'inventory_lock_date'",
        );
      }
    });

    it('books a never stocked piece with an unknown cost, and records no discrepancy', async () => {
      const at = await key();
      const holder = randomUUID();
      await reserve(holder, 'reserve_available', [{ ...at, quantity: 1 }]);

      const result = await ledger.postCarrierShipment({
        orderId: randomUUID(),
        lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
      });

      expect(result.movements).toMatchObject([{ costUnknown: true, totalCost: '0.00' }]);
      expect((await level(api.owner, at)).onHand).toBe(-1);
      await api.app.get(ReconciliationService).reconcile();
      const found = await api.owner.pool.query(
        'SELECT kind, expected, actual FROM stock_level_discrepancies WHERE variant_id = $1',
        [at.variantId],
      );
      expect(found.rows).toEqual([]);
    });
  });

  describe('the order thread holds together (AC-7)', () => {
    it('keeps every number right after each step', async () => {
      const lineA = await onlineKey();
      const lineB = await onlineKey();
      await stock(lineA, 2);
      await stock(lineB, 1);
      const orderId = randomUUID();
      const [idA, idB] = [randomUUID(), randomUUID()];
      const numbers = async (at: { variantId: string }) =>
        (await online.forVariants([at.variantId]))[0];
      const changed = async (since: string) =>
        (await online.changedSince({ since })).rows.map((row) => row.variantId);
      const mine = [lineA.variantId, lineB.variantId];

      // 1. One stock transaction writes the order row and reserves two lines, one short.
      let since = await dbNow();
      const held = await ledger.transaction(async (tx) => {
        await fixtureOrder(tx, orderId);
        return ledger.reserveLines(tx, {
          sourceType: 'order',
          sourceId: orderId,
          shortage: 'reserve_available',
          lines: [
            { sourceLineId: idA, ...lineA, quantity: 2 },
            { sourceLineId: idB, ...lineB, quantity: 3 },
          ],
        });
      });
      expect(held.map((line) => line.short)).toEqual([false, true]);
      expect(await count('fixture_orders', 'id = $1', [orderId])).toBe(1);
      expect(await numbers(lineA)).toMatchObject({
        onHand: 2,
        reserved: 2,
        unfilledDemand: 0,
        pushable: 0,
      });
      expect(await numbers(lineB)).toMatchObject({
        onHand: 1,
        reserved: 1,
        unfilledDemand: 2,
        pushable: 0,
      });
      expect(await changed(since)).toEqual(expect.arrayContaining(mine));

      // 2. A receipt fills the short line before anything counts as pushable.
      since = await dbNow();
      await stock(lineB, 2);
      expect(await numbers(lineB)).toMatchObject({
        onHand: 3,
        reserved: 3,
        unfilledDemand: 0,
        pushable: 0,
      });
      expect(await changed(since)).toContain(lineB.variantId);

      // 3. A carrier fact ships line A.
      since = await dbNow();
      await ledger.postCarrierShipment({
        orderId,
        lines: [
          {
            sourceLineId: idA,
            ...lineA,
            quantity: 2,
            reservationId: held[0]?.reservationId,
          },
        ],
      });
      expect(await numbers(lineA)).toMatchObject({
        onHand: 0,
        reserved: 0,
        unfilledDemand: 0,
        pushable: 0,
      });
      expect(await changed(since)).toContain(lineA.variantId);

      // 4. releaseSource frees the other line, which is now pushable.
      since = await dbNow();
      const released = await ledger.transaction((tx) =>
        ledger.releaseSource(tx, { sourceType: 'order', sourceId: orderId }),
      );
      expect(released.map((r) => r.sourceLineId)).toEqual([idB]);
      expect(await numbers(lineB)).toMatchObject({
        onHand: 3,
        reserved: 0,
        available: 3,
        pushable: 3,
      });
      expect(await changed(since)).toContain(lineB.variantId);

      // 5. A reconciliation run records no discrepancy for the thread.
      expect(shortened).toEqual([]);
      await api.app.get(ReconciliationService).reconcile();
      expect(await count('stock_level_discrepancies', 'variant_id = ANY($1)', [mine])).toBe(0);
    });

    it('reruns the whole work once after a forced deadlock, leaving one row and one set of reservations', async () => {
      const at = await key();
      await stock(at, 5);
      const orderId = randomUUID();
      const lineId = randomUUID();
      const attempts = { count: 0 };

      await ledger.transaction(async (tx) => {
        attempts.count += 1;
        await fixtureOrder(tx, orderId);
        await ledger.reserveLines(tx, {
          sourceType: 'order',
          sourceId: orderId,
          shortage: 'refuse',
          lines: [{ sourceLineId: lineId, ...at, quantity: 2 }],
        });
        if (attempts.count === 1) {
          await tx.execute(
            sql.raw(`DO $$ BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = '40P01'; END $$`),
          );
        }
      });

      expect(attempts.count).toBe(2);
      expect(await count('fixture_orders', 'id = $1', [orderId])).toBe(1);
      expect(await rows(orderId)).toMatchObject([{ open_quantity: 2, status: 'active' }]);
    });
  });

  describe('concurrency (AC-5)', () => {
    it('hands out exactly the free stock to 20 parallel refuse calls', async () => {
      const at = await key();
      await stock(at, 10);

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => reserve(randomUUID(), 'refuse', [{ ...at, quantity: 1 }])),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ code: 'InsufficientStock' });
        }
      }
      expect(
        await count('reservations', 'variant_id = $1 AND open_quantity = 1', [at.variantId]),
      ).toBe(10);
    });

    it('holds exactly 10 of 20 parallel reserve_available calls and keeps the rest waiting', async () => {
      const at = await key();
      await stock(at, 10);

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          reserve(randomUUID(), 'reserve_available', [{ ...at, quantity: 1 }]),
        ),
      );

      const lines = results.map((r) => r[0]);
      expect(lines.filter((line) => line?.held === 1)).toHaveLength(10);
      expect(lines.filter((line) => line?.unfilled === 1)).toHaveLength(10);
    });

    it('never deadlocks when lines are reserved in opposite orders', async () => {
      const a = await key();
      const b = { variantId: await make.variant(), locationId: a.locationId };
      await stock(a, 100);
      await stock(b, 100);

      const results = await Promise.allSettled(
        Array.from({ length: 100 }, (_, i) =>
          reserve(
            randomUUID(),
            'refuse',
            i % 2
              ? [
                  { ...a, quantity: 1 },
                  { ...b, quantity: 1 },
                ]
              : [
                  { ...b, quantity: 1 },
                  { ...a, quantity: 1 },
                ],
          ),
        ),
      );

      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      expect(
        await count('reservations', 'variant_id = ANY($1)', [[a.variantId, b.variantId]]),
      ).toBe(200);
    });
  });

  describe('a posting read by its key (AC-29)', () => {
    it('answers the stored result with the groupId a replay gives, or null', async () => {
      const at = await key();
      await stock(at, 1);
      const orderId = randomUUID();
      const input = { orderId, lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }] };
      const posted = await ledger.postCarrierShipment(input);

      const stored = await ledger.postingFor(`order_shipment:${orderId}`);

      expect(stored?.groupId).toBe(posted.groupId);
      const { replayed: _replayed, ...result } = posted;
      expect(stored).toEqual(result);
      expect((await ledger.postCarrierShipment(input)).groupId).toBe(stored?.groupId);
      expect(await ledger.postingFor(`order_shipment:${randomUUID()}`)).toBeNull();
    });

    it('raises InvalidInput for an empty key and a 201 character key', async () => {
      await expect(ledger.postingFor('')).rejects.toMatchObject({ code: 'InvalidInput' });
      await expect(ledger.postingFor('k'.repeat(201))).rejects.toMatchObject({
        code: 'InvalidInput',
      });
      expect(await ledger.postingFor('k'.repeat(200))).toBeNull();
    });
  });

  describe('fix round F1: posting hooks, nesting, and carrier rules', () => {
    const shipment = (
      orderId: string,
      at: { variantId: string; locationId: string },
      quantity = 1,
      extra: { reservationId?: string; sourceLineId?: string } = {},
    ) => ({
      orderId,
      lines: [{ sourceLineId: extra.sourceLineId ?? randomUUID(), ...at, quantity, ...extra }],
    });

    it('runs within on a carrier posting, rolls the posting back when it throws, and skips it on a replay', async () => {
      const at = await key();
      await stock(at, 3);
      const orderId = randomUUID();
      const input = shipment(orderId, at);
      const calls = { count: 0 };

      await expect(
        ledger.postCarrierShipment(input, {
          within: async (tx) => {
            await fixtureOrder(tx, orderId);
            throw new Error('cost write failed');
          },
        }),
      ).rejects.toThrow('cost write failed');
      expect(await count('fixture_orders', 'id = $1', [orderId])).toBe(0);
      expect(await ledger.postingFor(`order_shipment:${orderId}`)).toBeNull();
      expect((await level(api.owner, at)).onHand).toBe(3);

      const first = await ledger.postCarrierShipment(input, {
        within: async (tx, result) => {
          calls.count += 1;
          await fixtureOrder(tx, orderId);
          expect(result.sourceType).toBe('order_shipment');
        },
      });
      const replay = await ledger.postCarrierShipment(input, {
        within: () => {
          calls.count += 1;
          return Promise.resolve();
        },
      });

      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(calls.count).toBe(1);
      expect(await count('fixture_orders', 'id = $1', [orderId])).toBe(1);
    });

    it('hands within a stock unit that can release lines', async () => {
      const at = await key();
      await stock(at, 2);
      const holder = randomUUID();
      await reserve(holder, 'refuse', [{ ...at, quantity: 1 }]);

      await ledger.postCarrierShipment(shipment(randomUUID(), at, 1), {
        within: async (tx) => {
          const released = await ledger.releaseSource(tx, {
            sourceType: 'order',
            sourceId: holder,
          });
          expect(released).toHaveLength(1);
        },
      });

      expect(await rows(holder)).toMatchObject([{ status: 'released' }]);
    });

    it('refuses a ledger transaction opened from within or from an event handler, rolling the outer back', async () => {
      const at = await key();
      await stock(at, 1);
      const orderId = randomUUID();

      const fromWithin = await failure(
        ledger.postCarrierShipment(shipment(orderId, at), {
          within: async () => {
            await ledger.transaction(() => Promise.resolve());
          },
        }),
      );
      expect(fromWithin.code).toBe('NestedStockTransaction');
      expect(await ledger.postingFor(`order_shipment:${orderId}`)).toBeNull();
      expect((await level(api.owner, at)).onHand).toBe(1);

      // A handler of an event published inside a posting: a restock that fills waiting demand.
      const waiting = await key();
      await reserve(randomUUID(), 'reserve_available', [{ ...waiting, quantity: 1 }]);
      onFilled = () =>
        ledger.post(posting([{ ...at, quantity: 1, unitCost: '1.0000' }])).then(() => undefined);
      try {
        const fromHandler = await failure(stock(waiting, 1));
        expect(fromHandler.code).toBe('NestedStockTransaction');
      } finally {
        onFilled = null;
      }
      expect((await level(api.owner, waiting)).onHand).toBe(0);
      expect((await level(api.owner, at)).onHand).toBe(1);
    });

    it('refuses nesting from the other ledger transaction callers too', async () => {
      const at = await key();
      const error = await failure(
        ledger.transaction(async () => {
          await ledger.reverse({
            groupId: randomUUID(),
            idempotencyKey: randomUUID(),
            postedBy: null,
            reasonCode: 'test',
          });
          await ledger.postingFor(`k-${at.variantId}`);
        }),
      );
      expect(error.code).toBe('NestedStockTransaction');
    });

    it('keeps the reservation functions refused outside the runner after a unit ended', async () => {
      let kept: StockTransaction | undefined;
      await ledger.transaction((tx) => {
        kept = tx;
        return Promise.resolve();
      });
      const at = await key();

      const error = await failure(
        ledger.reserveLines(kept as StockTransaction, {
          sourceType: 'order',
          sourceId: randomUUID(),
          shortage: 'refuse',
          lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
        }),
      );

      expect(error.code).toBe('InvalidInput');
    });

    it('refuses a plain posting or reversal under a carrier key', async () => {
      const at = await key();
      const orderId = randomUUID();

      const posted = await failure(
        ledger.post(
          posting([{ ...at, quantity: 1, unitCost: '1.0000' }], {
            idempotencyKey: `order_shipment:${orderId}`,
          }),
        ),
      );
      const reversed = await failure(
        ledger.reverse({
          groupId: randomUUID(),
          idempotencyKey: `order_shipment:${orderId}:2`,
          postedBy: null,
          reasonCode: 'test',
        }),
      );

      expect([posted.code, reversed.code]).toEqual(['InvalidInput', 'InvalidInput']);
    });

    it('does not shorten at a location that allows negative stock, but still says so when on hand goes below zero', async () => {
      const at = await key({ allowNegative: true });
      const holder = randomUUID();
      await reserve(holder, 'refuse', [{ ...at, quantity: 2 }]);

      const result = await ledger.postCarrierShipment(shipment(randomUUID(), at, 1));

      expect(shortened).toEqual([]);
      expect(await rows(holder)).toMatchObject([{ open_quantity: 2, unfilled_quantity: 0 }]);
      expect(overdrawn).toEqual([
        new StockOverdrawn(at.variantId, at.locationId, -1, result.groupId),
      ]);
    });

    it('moves a carrier time more than 5 minutes ahead to now instead of refusing it', async () => {
      const at = await key();
      await stock(at, 1);

      const result = await ledger.postCarrierShipment({
        ...shipment(randomUUID(), at),
        effectiveAt: new Date(Date.now() + 86_400_000),
      });

      expect(Math.abs(Date.now() - Date.parse(result.effectiveAt))).toBeLessThan(60_000);
    });

    it('replays to the stored result when only the carrier time differs', async () => {
      const at = await key();
      await stock(at, 2);
      const input = shipment(randomUUID(), at);

      const first = await ledger.postCarrierShipment({
        ...input,
        effectiveAt: new Date(Date.now() - 3600_000),
      });
      const replay = await ledger.postCarrierShipment({ ...input, effectiveAt: new Date() });
      const noTime = await ledger.postCarrierShipment(input);

      expect(replay).toEqual({ ...first, replayed: true });
      expect(noTime.groupId).toBe(first.groupId);
    });

    it("ignores a named reservation that is another order's, closed, missing, or on another key", async () => {
      const at = await key();
      await stock(at, 4);
      const other = await key();
      await stock(other, 4);
      const otherOrder = randomUUID();
      const [theirs] = await reserve(otherOrder, 'refuse', [{ ...at, quantity: 1 }]);
      const [elsewhere] = await reserve(randomUUID(), 'refuse', [{ ...other, quantity: 1 }]);
      const closedOrder = randomUUID();
      const [closed] = await reserve(closedOrder, 'refuse', [{ ...at, quantity: 1 }]);
      await ledger.transaction((tx) =>
        ledger.releaseSource(tx, { sourceType: 'order', sourceId: closedOrder }),
      );

      for (const reservationId of [
        theirs?.reservationId,
        elsewhere?.reservationId,
        closed?.reservationId,
        randomUUID(),
      ]) {
        await ledger.postCarrierShipment(shipment(randomUUID(), at, 1, { reservationId }));
      }

      // The other order's hold was never consumed by a shipment naming it; stock fell by 4 and
      // the one real hold was then shortened to fit what is left.
      expect((await level(api.owner, at)).onHand).toBe(0);
      expect(await rows(otherOrder)).toMatchObject([
        { status: 'active', open_quantity: 0, unfilled_quantity: 1 },
      ]);
    });

    it('lets a carrier line fulfil its own reservation without shortening the others', async () => {
      const at = await key();
      await stock(at, 2);
      const [mine, other] = [randomUUID(), randomUUID()];
      const lineId = randomUUID();
      const [own] = await reserve(mine, 'refuse', [{ sourceLineId: lineId, ...at, quantity: 1 }]);
      await reserve(other, 'refuse', [{ ...at, quantity: 1 }]);

      await ledger.postCarrierShipment(
        shipment(mine, at, 1, { sourceLineId: lineId, reservationId: own?.reservationId }),
      );

      expect(shortened).toEqual([]);
      expect(await rows(mine)).toMatchObject([{ status: 'fulfilled' }]);
      expect(await rows(other)).toMatchObject([{ open_quantity: 1, status: 'active' }]);
    });

    it('shortens the newest reservations first, fully then partly', async () => {
      const at = await key();
      await stock(at, 4);
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      await reserve(a, 'refuse', [{ ...at, quantity: 1 }]);
      await reserve(b, 'refuse', [{ ...at, quantity: 2 }]);
      await reserve(c, 'refuse', [{ ...at, quantity: 1 }]);

      await ledger.postCarrierShipment(shipment(randomUUID(), at, 3));

      expect(shortened.map((e) => [e.sourceId, e.quantity])).toEqual([
        [c, 1],
        [b, 2],
      ]);
      expect(await rows(a)).toMatchObject([{ open_quantity: 1 }]);

      const partial = await key();
      await stock(partial, 3);
      const [x, y] = [randomUUID(), randomUUID()];
      await reserve(x, 'refuse', [{ ...partial, quantity: 1 }]);
      await reserve(y, 'refuse', [{ ...partial, quantity: 2 }]);
      shortened.length = 0;

      await ledger.postCarrierShipment(shipment(randomUUID(), partial, 1));

      expect(shortened.map((e) => [e.sourceId, e.quantity])).toEqual([[y, 1]]);
      expect(await rows(y)).toMatchObject([
        { quantity: 1, open_quantity: 1, unfilled_quantity: 1 },
      ]);
    });

    it('keeps its own leftover hold when on hand still covers it', async () => {
      const at = await key();
      await stock(at, 2);
      const mine = randomUUID();
      const lineId = randomUUID();
      const [own] = await reserve(mine, 'refuse', [{ sourceLineId: lineId, ...at, quantity: 2 }]);

      await ledger.postCarrierShipment(
        shipment(mine, at, 1, { sourceLineId: lineId, reservationId: own?.reservationId }),
      );

      // One piece shipped from a hold of two: on hand 1, one still held, no excess to shorten.
      expect(shortened).toEqual([]);
      expect(await rows(mine)).toMatchObject([{ open_quantity: 1, status: 'active' }]);
    });

    it('refuses a carrier line for a lot or serial tracked SKU', async () => {
      const at = {
        variantId: await make.variant({ tracking: 'serial' }),
        locationId: await make.location(),
      };

      const error = await failure(ledger.postCarrierShipment(shipment(randomUUID(), at)));

      expect(error.code).toBe('TrackingMismatch');
    });

    it('refuses a line id another document already holds', async () => {
      const at = await key();
      await stock(at, 5);
      const lineId = randomUUID();
      await reserve(randomUUID(), 'refuse', [{ sourceLineId: lineId, ...at, quantity: 1 }]);

      const error = await failure(
        reserve(randomUUID(), 'refuse', [{ sourceLineId: lineId, ...at, quantity: 1 }]),
      );

      expect(error.code).toBe('DuplicateReservation');
    });

    it('fills another order with the piece a successful size swap frees', async () => {
      const medium = await key();
      await stock(medium, 1);
      const large = await key();
      await stock(large, 1);
      const [swapper, waiter] = [randomUUID(), randomUUID()];
      const lineId = randomUUID();
      await reserve(swapper, 'refuse', [{ sourceLineId: lineId, ...medium, quantity: 1 }]);
      await reserve(waiter, 'reserve_available', [{ ...medium, quantity: 1 }]);
      filled.length = 0;

      await ledger.transaction(async (tx) => {
        await ledger.releaseLines(tx, { sourceType: 'order', sourceLineIds: [lineId] });
        await ledger.reserveLines(tx, {
          sourceType: 'order',
          sourceId: swapper,
          shortage: 'refuse',
          lines: [{ sourceLineId: randomUUID(), ...large, quantity: 1 }],
        });
      });

      expect(await rows(waiter)).toMatchObject([{ open_quantity: 1, unfilled_quantity: 0 }]);
      expect(filled.map((e) => e.sourceId)).toEqual([waiter]);
    });

    it('splits a restock across three waiting orders, oldest first', async () => {
      const at = await key();
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [a, b, c]) await reserve(id, 'reserve_available', [{ ...at, quantity: 1 }]);

      await stock(at, 2);

      expect(filled.map((e) => e.sourceId)).toEqual([a, b]);
      expect(await rows(c)).toMatchObject([{ open_quantity: 0, unfilled_quantity: 1 }]);
    });

    it("reads reservations through the caller's transaction", async () => {
      const at = await key();
      await stock(at, 1);
      const orderId = randomUUID();

      const seen = await ledger.transaction(async (tx) => {
        await ledger.reserveLines(tx, {
          sourceType: 'order',
          sourceId: orderId,
          shortage: 'refuse',
          lines: [{ sourceLineId: randomUUID(), ...at, quantity: 1 }],
        });
        return {
          inside: await ledger.reservationsFor({ sourceType: 'order', sourceId: orderId }, tx),
          outside: await ledger.reservationsFor({ sourceType: 'order', sourceId: orderId }),
        };
      });

      expect(seen.inside).toHaveLength(1);
      expect(seen.outside).toEqual([]);
    });
  });

  describe('catalog row locks (AC-18)', () => {
    it('locks SKU rows and answers kind, tracking, and archived; absent ids are absent', async () => {
      const catalog = api.app.get(CatalogService);
      const plain = await make.variant();
      const serial = await make.variant({ tracking: 'serial' });
      const archived = await make.variant();
      await make.archive('product_variants', archived);
      const missing = randomUUID();

      const { share, update } = await connection.db.transaction(async (tx) => ({
        share: await catalog.lockForShare(tx, [plain, serial, archived, missing, plain]),
        update: await catalog.lockForUpdate(tx, [archived]),
      }));

      expect([...share.keys()].sort()).toEqual([plain, serial, archived].sort());
      expect(share.get(serial)).toMatchObject({
        kind: 'stocked',
        tracking: 'serial',
        archived: false,
      });
      expect(share.get(archived)?.archived).toBe(true);
      expect([...update.keys()]).toEqual([archived]);
      expect(await catalog.serialTrackedVariantIds()).toContain(serial);
      expect(await catalog.serialTrackedVariantIds()).not.toContain(plain);
    });

    it('makes a share lock wait for an update lock held by another transaction', async () => {
      const catalog = api.app.get(CatalogService);
      const variant = await make.variant();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const lockedIt = new Promise<void>((resolve) => (locked = resolve));
      const holder = connection.db.transaction(async (tx) => {
        await catalog.lockForUpdate(tx, [variant]);
        locked();
        await held;
      });
      await lockedIt;
      const order: string[] = [];
      const waiter = connection.db
        .transaction((tx) => catalog.lockForShare(tx, [variant]))
        .then(() => order.push('share'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push('release');
      release();
      await holder;
      await waiter;

      expect(order).toEqual(['release', 'share']);
    });
  });
});
