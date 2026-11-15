import { randomUUID } from 'node:crypto';
import {
  LocationDetail,
  OnlineGateView,
  OnlineStatusResponse,
  type OnlineStockChangedRow,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/inventory/ledger/ledger.service.js';
import { OnlineStockGate } from '../src/inventory/online-stock/online-stock-gate.js';
import {
  ONLINE_FLAG_KEY,
  ONLINE_FLAG_LOCK,
  OnlineStockService,
} from '../src/inventory/online-stock/online-stock.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { fixtures, posting } from './ledger.js';

// Spec 0011 milestone 1 (AC-1, AC-2, AC-3, AC-4, AC-19, AC-20): the one online location held by
// the database, the gated actions that move it, and the online stock read a channel calls. The
// audit codes location.stock_confirmed, location.online_moved, and location.online_stopped are
// proven here (the registry's proof file for them).

describe('online stock and the online gate', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let make: ReturnType<typeof fixtures>;
  let ledger: LedgerService;
  let online: OnlineStockService;
  let cookie: string;
  let supportCookie: string;
  let counter = 0;
  /** A fixture check other modules would register: flips between passing and failing. */
  const fixtureCheck = { passes: true };

  beforeAll(async () => {
    api = await startInProcessApi();
    make = fixtures(api.owner);
    ledger = api.app.get(LedgerService);
    online = api.app.get(OnlineStockService);
    api.app.get(OnlineStockGate).register({
      key: 'fixture.orders_held',
      run: () =>
        Promise.resolve({
          label: 'inventory.onlineGate.checks.stockCounted',
          passed: fixtureCheck.passes,
          count: 3,
          action: {
            method: 'POST',
            path: '/api/orders/hold-open-orders',
            label: 'inventory.onlineGate.checks.stockCounted',
          },
        }),
    });
    cookie = await api.signIn((await api.addPerson(['manager'])).email);
    supportCookie = await api.signIn((await api.addPerson(['support'])).email);
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    fixtureCheck.passes = true;
    // Every test starts with no online location; a test builds the state it names.
    await api.owner.pool.query('UPDATE locations SET sellable_online = false');
  });

  const call = (method: string, path: string, body?: unknown, who = cookie) =>
    api.call(who, method, path, body);

  /** Waits until `count` transactions wait for the online flag lock (spec 0013 review N3). */
  async function waitForFlagWaiters(count: number): Promise<void> {
    for (let tries = 0; tries < 200; tries += 1) {
      const { rows } = await api.owner.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted
           AND classid = $1::int::oid AND objid = $2::int::oid AND objsubid = 2`,
        [ONLINE_FLAG_LOCK, ONLINE_FLAG_KEY],
      );
      if ((rows[0]?.n ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Fewer than ${String(count)} moves waited for the online flag lock`);
  }

  /** A warehouse as the owner plants it, optionally with stock confirmed counted. */
  async function warehouse(options: { verified?: boolean } = {}): Promise<string> {
    // An upper case code, as the location rules store it (the audit label must match that pattern).
    counter += 1;
    const { rows } = await api.owner.pool.query<{ id: string }>(
      `INSERT INTO locations (code, name, kind) VALUES ($1, '{"en": "Warehouse"}', 'warehouse') RETURNING id`,
      [`OW-${counter}`],
    );
    const id = rows[0]?.id as string;
    if (options.verified) {
      await api.owner.pool.query('UPDATE locations SET stock_verified_at = now() WHERE id = $1', [
        id,
      ]);
    }
    return id;
  }

  async function stock(
    variantId: string,
    locationId: string,
    quantity: number,
    lotId?: string,
  ): Promise<void> {
    await ledger.post(
      posting([{ variantId, locationId, quantity, unitCost: '5.0000', ...(lotId && { lotId }) }], {
        sourceType: 'opening_balance',
      }),
    );
  }

  /** Reservation rows as the owner plants them (reserveLines is milestone 2). */
  async function reservation(
    variantId: string,
    locationId: string,
    held: number,
    unfilled: number,
  ): Promise<string> {
    const { rows } = await api.owner.pool.query<{ id: string }>(
      `INSERT INTO reservations (variant_id, location_id, quantity, open_quantity, unfilled_quantity,
                                 source_type, source_id, source_line_id)
       VALUES ($1, $2, $3, $3, $4, 'order', $5, $6) RETURNING id`,
      [variantId, locationId, held, unfilled, randomUUID(), randomUUID()],
    );
    return rows[0]?.id ?? '';
  }

  /** Puts a warehouse online through the real gate routes. */
  async function goOnline(locationId: string, variantCount: number): Promise<void> {
    const confirmed = await call('POST', `/api/locations/${locationId}/confirm-stock`, {});
    if (confirmed.status !== 200 && confirmed.status !== 409) {
      throw new Error(`confirm failed ${confirmed.status}`);
    }
    const moved = await call('POST', `/api/locations/${locationId}/make-online`, {
      confirmedVariantCount: variantCount,
      reason: 'Test go live',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }

  async function auditActions(locationId: string): Promise<string[]> {
    const { rows } = await api.owner.pool.query<{ action: string }>(
      `SELECT action FROM audit_entries WHERE record_id = $1 AND record_type = 'location'
       ORDER BY recorded_at`,
      [locationId],
    );
    return rows.map((row) => row.action);
  }

  describe('the one online location (AC-1)', () => {
    it('lets the database refuse an online shop, and a second online warehouse', async () => {
      const shop = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO locations (code, name, kind) VALUES ('SHOP-ON', '{"en": "Shop"}', 'shop') RETURNING id`,
      );
      await expect(
        api.owner.pool.query('UPDATE locations SET sellable_online = true WHERE id = $1', [
          shop.rows[0]?.id,
        ]),
      ).rejects.toThrow(/locations_online_needs_warehouse/);
      const unsellable = await make.location({ isSellable: false });
      await expect(
        api.owner.pool.query('UPDATE locations SET sellable_online = true WHERE id = $1', [
          unsellable,
        ]),
      ).rejects.toThrow(/locations_online_needs_warehouse/);

      const first = await warehouse();
      const second = await warehouse();
      await api.owner.pool.query('UPDATE locations SET sellable_online = true WHERE id = $1', [
        first,
      ]);
      await expect(
        api.owner.pool.query('UPDATE locations SET sellable_online = true WHERE id = $1', [second]),
      ).rejects.toThrow(/locations_one_online/);
    });

    it('holds the race between two writers: the second waits, then is refused', async () => {
      const first = await warehouse();
      const second = await warehouse();
      const one = await api.owner.pool.connect();
      const two = await api.owner.pool.connect();
      try {
        await one.query('BEGIN');
        await one.query('UPDATE locations SET sellable_online = true WHERE id = $1', [first]);
        const blocked = two.query('UPDATE locations SET sellable_online = true WHERE id = $1', [
          second,
        ]);
        const outcome = blocked.then(
          () => 'moved',
          (error: { constraint?: string }) => error.constraint,
        );
        await one.query('COMMIT');
        expect(await outcome).toBe('locations_one_online');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });

    it('gives one success and one 409 for two parallel moves of the same location', async () => {
      const id = await warehouse({ verified: true });
      const body = { confirmedVariantCount: 0, reason: 'Parallel' };

      const replies = await Promise.all([
        call('POST', `/api/locations/${id}/make-online`, body),
        call('POST', `/api/locations/${id}/make-online`, body),
      ]);

      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      // Timing decides the loser's code: it read "nothing online" before the winner committed
      // (stale), or it read the winner's committed flag (already online). Both are a 409.
      const loser = replies.find((reply) => reply.status === 409)?.body as { code?: string };
      expect(['ONLINE_GATE_STALE', 'ALREADY_ONLINE']).toContain(loser.code);
    });

    it('gives one success and one ONLINE_GATE_STALE for parallel moves of two different warehouses', async () => {
      const first = await warehouse({ verified: true });
      const second = await warehouse({ verified: true });
      const body = { confirmedVariantCount: 0, reason: 'Race' };
      // Both moves read "nothing online", then queue on the online flag lock this connection
      // holds (spec 0013 review N3). Once both wait, it lets go: the first to take the lock
      // moves the flag, the second finds the flag moved since its read and answers stale.
      const holder = await api.owner.pool.connect();
      let replies: { status: number; body: unknown }[] = [];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
          ONLINE_FLAG_LOCK,
          ONLINE_FLAG_KEY,
        ]);
        const moves = Promise.all([
          call('POST', `/api/locations/${first}/make-online`, body),
          call('POST', `/api/locations/${second}/make-online`, body),
        ]);
        await waitForFlagWaiters(2);
        await holder.query('COMMIT');
        replies = await moves;
      } finally {
        holder.release();
      }

      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(replies.find((reply) => reply.status === 409)?.body).toMatchObject({
        code: 'ONLINE_GATE_STALE',
      });
      const online = await api.owner.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM locations WHERE sellable_online',
      );
      expect(online.rows[0]?.n).toBe(1);
    });

    it('answers ALREADY_ONLINE for the location that already feeds online stock', async () => {
      const id = await warehouse({ verified: true });
      await goOnline(id, 0);

      const again = await call('POST', `/api/locations/${id}/make-online`, {
        confirmedVariantCount: 0,
        reason: 'Again',
      });

      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'ALREADY_ONLINE' });
    });

    it('refuses a kind change of the online location, and allows it once it is off', async () => {
      const id = await warehouse({ verified: true });
      await goOnline(id, 0);
      const current = (await call('GET', '/api/locations')).body as { items: LocationDetail[] };
      const row = current.items.find((item) => item.id === id) as LocationDetail;

      const refused = await call('PATCH', `/api/locations/${id}`, {
        updatedAt: row.updatedAt,
        kind: 'shop',
      });

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'ONLINE_NEEDS_WAREHOUSE' });
      const kept = await api.owner.pool.query<{ kind: string }>(
        'SELECT kind FROM locations WHERE id = $1',
        [id],
      );
      expect(kept.rows[0]?.kind).toBe('warehouse');

      await call('POST', '/api/locations/online/stop', { reason: 'Switching' });
      const stopped = (await call('GET', '/api/locations')).body as { items: LocationDetail[] };
      const off = stopped.items.find((item) => item.id === id) as LocationDetail;
      const allowed = await call('PATCH', `/api/locations/${id}`, {
        updatedAt: off.updatedAt,
        kind: 'shop',
      });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    });

    it('never brings an unarchived location back online, and records the flag the archive cleared', async () => {
      const id = await warehouse({ verified: true });
      await goOnline(id, 0);
      await call('POST', `/api/locations/${id}/archive`);
      const entry = await api.owner.pool.query<{ before: unknown; after: unknown }>(
        `SELECT before, after FROM audit_entries WHERE record_id = $1 AND action = 'location.archived'`,
        [id],
      );
      expect(entry.rows[0]).toEqual({
        before: { archived: false, online: true },
        after: { archived: true, online: false },
      });

      const back = await call('POST', `/api/locations/${id}/unarchive`);

      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(back.body).toMatchObject({ archived: false, online: false, sellableOnline: false });
      expect(await online.onlineLocation()).toBeNull();
    });

    it('refuses an archived location online even when written past the api', async () => {
      const id = await warehouse();
      await api.owner.pool.query('UPDATE locations SET archived_at = now() WHERE id = $1', [id]);
      await expect(
        api.owner.pool.query('UPDATE locations SET sellable_online = true WHERE id = $1', [id]),
      ).rejects.toThrow(/locations_online_not_archived/);
    });

    it('refuses a shop and a partner warehouse with their own codes', async () => {
      const shop = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO locations (code, name, kind) VALUES ('SHOP-NW', '{"en": "Shop"}', 'shop') RETURNING id`,
      );
      const refusedShop = await call('POST', `/api/locations/${shop.rows[0]?.id}/make-online`, {
        confirmedVariantCount: 0,
        reason: 'x',
      });
      expect(refusedShop.status).toBe(422);
      expect(refusedShop.body).toMatchObject({ code: 'ONLINE_NEEDS_WAREHOUSE' });

      const partner = await api.addParty('PT-ONLINE', { consignment: true });
      const partnerWarehouse = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO locations (code, name, kind, owner_type, party_id)
         VALUES ('PW-1', '{"en": "Partner"}', 'warehouse', 'consignment_partner', $1) RETURNING id`,
        [partner],
      );
      const refusedPartner = await call(
        'POST',
        `/api/locations/${partnerWarehouse.rows[0]?.id}/make-online`,
        { confirmedVariantCount: 0, reason: 'x' },
      );
      expect(refusedPartner.status).toBe(422);
      expect(refusedPartner.body).toMatchObject({ code: 'NOT_SELLABLE_ONLINE' });
    });

    it('turns the flag off when the online location is archived', async () => {
      const id = await warehouse({ verified: true });
      await goOnline(id, 0);
      expect(await online.onlineLocation()).toMatchObject({ id });

      const archived = await call('POST', `/api/locations/${id}/archive`);

      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
      expect(archived.body).toMatchObject({ archived: true, online: false, sellableOnline: false });
      expect(await online.onlineLocation()).toBeNull();
    });

    it('no longer takes sellableOnline on create or edit', async () => {
      const created = await call('POST', '/api/locations', {
        code: 'NOSELL',
        name: { en: 'x' },
        kind: 'warehouse',
        sellableOnline: true,
      });
      expect(created.status).toBe(400);
      const plain = await call('POST', '/api/locations', {
        code: 'PLAIN',
        name: { en: 'x' },
        kind: 'warehouse',
      });
      const location = LocationDetail.parse(plain.body);
      expect(location).toMatchObject({ online: false, stockVerifiedAt: null });
      const edited = await call('PATCH', `/api/locations/${location.id}`, {
        updatedAt: location.updatedAt,
        sellableOnline: true,
      });
      expect(edited.status).toBe(400);
    });
  });

  describe('the online gate (AC-19) and the status read (AC-20)', () => {
    it('fails without a count, passes after "Confirm stock", and shows the counts', async () => {
      const id = await warehouse();
      const [a, b] = [await make.variant(), await make.variant()];
      await stock(a, id, 4);
      await stock(b, id, 6);

      const before = OnlineGateView.parse(
        (await call('GET', `/api/locations/${id}/online-gate`)).body,
      );
      expect(before.canGoOnline).toBe(false);
      expect(before.checks[0]).toEqual({
        key: 'stock_counted',
        label: 'inventory.onlineGate.checks.stockCounted',
        passed: false,
        count: 2,
      });
      expect(before).toMatchObject({
        variantsWithStock: 2,
        totalOnHand: 10,
        reservationsAtOldLocation: 0,
        currentOnlineLocation: null,
      });

      const refused = await call('POST', `/api/locations/${id}/make-online`, {
        confirmedVariantCount: 2,
        reason: 'Go live',
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'ONLINE_GATE_FAILED',
        failedKeys: ['stock_counted'],
      });

      const confirmed = await call('POST', `/api/locations/${id}/confirm-stock`, {
        reason: 'Counted on the shelf',
      });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect(LocationDetail.parse(confirmed.body).stockVerifiedAt).not.toBeNull();
      const again = await call('POST', `/api/locations/${id}/confirm-stock`, {});
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'ALREADY_CONFIRMED' });

      const after = OnlineGateView.parse(
        (await call('GET', `/api/locations/${id}/online-gate`)).body,
      );
      expect(after.canGoOnline).toBe(true);
      // The orders module registers its own check at start (spec 0013 AC-26); no order is open here.
      expect(after.checks.map((check) => [check.key, check.passed])).toEqual([
        ['stock_counted', true],
        ['orders.open_orders_held', true],
        ['fixture.orders_held', true],
      ]);
      expect(await auditActions(id)).toEqual(['location.stock_confirmed']);
    });

    it('blocks a move with the key of a registered failing check, and links its action', async () => {
      const id = await warehouse({ verified: true });
      fixtureCheck.passes = false;

      const view = OnlineGateView.parse(
        (await call('GET', `/api/locations/${id}/online-gate`)).body,
      );
      expect(view.canGoOnline).toBe(false);
      expect(view.checks.find((check) => check.key === 'fixture.orders_held')).toMatchObject({
        passed: false,
        count: 3,
        action: { method: 'POST', path: '/api/orders/hold-open-orders' },
      });
      const refused = await call('POST', `/api/locations/${id}/make-online`, {
        confirmedVariantCount: 0,
        reason: 'Go live',
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'ONLINE_GATE_FAILED',
        failedKeys: ['fixture.orders_held'],
      });
      expect(await online.onlineLocation()).toBeNull();
    });

    it('gives ONLINE_GATE_STALE when stock is posted between the gate read and the move', async () => {
      const id = await warehouse({ verified: true });
      await stock(await make.variant(), id, 3);
      const view = OnlineGateView.parse(
        (await call('GET', `/api/locations/${id}/online-gate`)).body,
      );
      expect(view.variantsWithStock).toBe(1);

      await stock(await make.variant(), id, 2);
      const stale = await call('POST', `/api/locations/${id}/make-online`, {
        confirmedVariantCount: view.variantsWithStock,
        reason: 'Go live',
      });

      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'ONLINE_GATE_STALE' });
      expect(await online.onlineLocation()).toBeNull();
    });

    it('asks for a written reason on a move and on a stop', async () => {
      const id = await warehouse({ verified: true });
      const none = await call('POST', `/api/locations/${id}/make-online`, {
        confirmedVariantCount: 0,
      });
      expect(none.status).toBe(422);
      expect(none.body).toMatchObject({ code: 'REASON_REQUIRED' });
      const blank = await call('POST', `/api/locations/${id}/make-online`, {
        confirmedVariantCount: 0,
        reason: '   ',
      });
      expect(blank.body).toMatchObject({ code: 'REASON_REQUIRED' });
      expect(await online.onlineLocation()).toBeNull();

      await goOnline(id, 0);
      const noStopReason = await call('POST', '/api/locations/online/stop', {});
      expect(noStopReason.status).toBe(422);
      expect(noStopReason.body).toMatchObject({ code: 'REASON_REQUIRED' });
      expect(await online.onlineLocation()).toMatchObject({ id });
    });

    it('moves from A to B leaving A reservations in place, then stops', async () => {
      const a = await warehouse({ verified: true });
      const b = await warehouse({ verified: true });
      const variant = await make.variant();
      await stock(variant, a, 8);
      await goOnline(a, 1);
      const held = await reservation(variant, a, 2, 0);
      await reservation(variant, a, 0, 1);

      const view = OnlineGateView.parse(
        (await call('GET', `/api/locations/${b}/online-gate`)).body,
      );
      expect(view.reservationsAtOldLocation).toBe(2);
      expect(view.currentOnlineLocation).toMatchObject({ id: a });

      const moved = await call('POST', `/api/locations/${b}/make-online`, {
        confirmedVariantCount: 0,
        reason: 'Moving to the new warehouse',
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(moved.body).toMatchObject({ id: b, online: true });
      expect(await online.onlineLocation()).toMatchObject({ id: b });
      const { rows } = await api.owner.pool.query<{ status: string; location_id: string }>(
        'SELECT status, location_id FROM reservations WHERE id = $1',
        [held],
      );
      expect(rows[0]).toEqual({ status: 'active', location_id: a });
      const oldOnline = await api.owner.pool.query<{ sellable_online: boolean }>(
        'SELECT sellable_online FROM locations WHERE id = $1',
        [a],
      );
      expect(oldOnline.rows[0]?.sellable_online).toBe(false);

      const status = OnlineStatusResponse.parse(
        (await call('GET', '/api/stock/online-status')).body,
      );
      expect(status.onlineLocation).toMatchObject({ id: b });

      const stopped = await call('POST', '/api/locations/online/stop', { reason: 'Pause Shopify' });
      expect(stopped.status).toBe(200);
      expect(stopped.body).toEqual({ onlineLocation: null });
      const off = await call('GET', '/api/stock/online-status');
      expect(off.body).toEqual({ onlineLocation: null });
      const again = await call('POST', '/api/locations/online/stop', { reason: 'Again' });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'NO_ONLINE_LOCATION' });

      expect(await auditActions(b)).toEqual(['location.online_moved', 'location.online_stopped']);
      expect(await auditActions(a)).toEqual(['location.online_moved']);
    });

    it('answers 403 to a person without catalog.manage, and the status to stock.view', async () => {
      const id = await warehouse();
      const gate = await call('GET', `/api/locations/${id}/online-gate`, undefined, supportCookie);
      expect(gate.status).toBe(403);
      const move = await call(
        'POST',
        `/api/locations/${id}/make-online`,
        { confirmedVariantCount: 0, reason: 'x' },
        supportCookie,
      );
      expect(move.status).toBe(403);
      const status = await call('GET', '/api/stock/online-status', undefined, supportCookie);
      expect(status.status).toBe(200);
    });

    it('answers 404 for a missing location', async () => {
      const missing = await call('GET', `/api/locations/${randomUUID()}/online-gate`);
      expect(missing.status).toBe(404);
    });
  });

  describe('the online stock read (AC-2, AC-3)', () => {
    it('never counts a partner or a shop: 10 online, 30 at a partner, 5 at a shop', async () => {
      const wh = await warehouse({ verified: true });
      const partner = await api.addParty('PT-STOCK', { consignment: true });
      const partnerLocation = (
        await api.owner.pool.query<{ id: string }>(
          `INSERT INTO locations (code, name, kind, owner_type, party_id)
           VALUES ('PS-1', '{"en": "Partner shop"}', 'shop', 'consignment_partner', $1) RETURNING id`,
          [partner],
        )
      ).rows[0]?.id as string;
      const shop = (
        await api.owner.pool.query<{ id: string }>(
          `INSERT INTO locations (code, name, kind) VALUES ('OWN-SHOP', '{"en": "Shop"}', 'shop') RETURNING id`,
        )
      ).rows[0]?.id as string;
      const variant = await make.variant();
      await stock(variant, wh, 10);
      await stock(variant, partnerLocation, 30);
      await stock(variant, shop, 5);
      await goOnline(wh, 1);

      expect(await online.forVariants([variant])).toEqual([
        {
          variantId: variant,
          onHand: 10,
          reserved: 0,
          unfilledDemand: 0,
          available: 10,
          pushable: 10,
        },
      ]);

      await reservation(variant, wh, 3, 0);
      await reservation(variant, wh, 0, 2);
      expect(await online.forVariants([variant])).toEqual([
        {
          variantId: variant,
          onHand: 10,
          reserved: 3,
          unfilledDemand: 2,
          available: 7,
          pushable: 5,
        },
      ]);
    });

    it('answers zeros for a variant with no balance, and floors pushable at 0', async () => {
      const wh = await warehouse({ verified: true });
      const empty = await make.variant();
      const oversold = await make.variant();
      await stock(oversold, wh, 2);
      await goOnline(wh, 1);
      await reservation(oversold, wh, 2, 0);
      await api.owner.pool.query(
        `INSERT INTO reservations (variant_id, location_id, quantity, open_quantity, unfilled_quantity, source_type, source_id, source_line_id)
         VALUES ($1, $2, 0, 0, 4, 'order', $3, $4)`,
        [oversold, wh, randomUUID(), randomUUID()],
      );

      const rows = await online.forVariants([empty, oversold, empty]);

      expect(rows).toEqual([
        { variantId: empty, onHand: 0, reserved: 0, unfilledDemand: 0, available: 0, pushable: 0 },
        {
          variantId: oversold,
          onHand: 2,
          reserved: 2,
          unfilledDemand: 4,
          available: 0,
          pushable: 0,
        },
      ]);
    });

    it('sums the lots of a lot tracked variant at the online location', async () => {
      const wh = await warehouse({ verified: true });
      const variant = await make.variant({ tracking: 'lot' });
      await stock(variant, wh, 4, await make.lot(variant));
      await stock(variant, wh, 6, await make.lot(variant));
      const view = OnlineGateView.parse(
        (await call('GET', `/api/locations/${wh}/online-gate`)).body,
      );
      expect(view).toMatchObject({ variantsWithStock: 1, totalOnHand: 10 });
      await goOnline(wh, 1);

      expect(await online.forVariants([variant])).toEqual([
        {
          variantId: variant,
          onHand: 10,
          reserved: 0,
          unfilledDemand: 0,
          available: 10,
          pushable: 10,
        },
      ]);
    });

    it('agrees between the gate and forCandidate: stock in an unsellable bin is not counted', async () => {
      const wh = await warehouse({ verified: true });
      const variant = await make.variant();
      const bin = await make.bin(wh, { isSellable: false });
      await ledger.post(
        posting(
          [{ variantId: variant, locationId: wh, binId: bin, quantity: 5, unitCost: '5.0000' }],
          {
            sourceType: 'opening_balance',
          },
        ),
      );
      await stock(await make.variant(), wh, 2);

      const view = OnlineGateView.parse(
        (await call('GET', `/api/locations/${wh}/online-gate`)).body,
      );
      const candidate = await online.forCandidate(wh);

      expect(view.variantsWithStock).toBe(candidate.rows.filter((row) => row.onHand > 0).length);
      expect(view).toMatchObject({ variantsWithStock: 1, totalOnHand: 2, variantsPushedZero: 1 });
    });

    it('refuses forCandidate for a location that could never be online', async () => {
      const shop = (
        await api.owner.pool.query<{ id: string }>(
          `INSERT INTO locations (code, name, kind) VALUES ('CAND-SHOP', '{"en": "Shop"}', 'shop') RETURNING id`,
        )
      ).rows[0]?.id as string;
      const partner = await api.addParty('PT-CAND', { consignment: true });
      const partnerWarehouse = (
        await api.owner.pool.query<{ id: string }>(
          `INSERT INTO locations (code, name, kind, owner_type, party_id)
           VALUES ('CAND-PW', '{"en": "Partner"}', 'warehouse', 'consignment_partner', $1) RETURNING id`,
          [partner],
        )
      ).rows[0]?.id as string;
      const unsellable = await make.location({ isSellable: false });

      for (const id of [shop, partnerWarehouse, unsellable]) {
        await expect(online.forCandidate(id)).rejects.toMatchObject({
          code: 'NotOnlineCandidate',
        });
      }
    });

    it('raises NoOnlineLocation on every read when no location is online, never zeros', async () => {
      const variant = await make.variant();

      await expect(online.forVariants([variant])).rejects.toMatchObject({
        code: 'NoOnlineLocation',
      });
      await expect(online.list({})).rejects.toMatchObject({ code: 'NoOnlineLocation' });
      await expect(online.changedSince({ since: null })).rejects.toMatchObject({
        code: 'NoOnlineLocation',
      });
      await expect(online.forVariants([])).rejects.toMatchObject({ code: 'InvalidInput' });
    });

    it('reads a location that is not online yet with forCandidate', async () => {
      const candidate = await warehouse();
      const variant = await make.variant();
      await stock(variant, candidate, 7);
      await reservation(variant, candidate, 1, 1);

      const named = await online.forCandidate(candidate, { variantIds: [variant] });
      expect(named.rows).toEqual([
        {
          variantId: variant,
          onHand: 7,
          reserved: 1,
          unfilledDemand: 1,
          available: 6,
          pushable: 5,
        },
      ]);
      const paged = await online.forCandidate(candidate);
      expect(paged).toMatchObject({ locationId: candidate, nextAfterVariantId: null });
      expect(paged.rows.map((row) => row.variantId)).toEqual([variant]);

      await expect(online.forCandidate(randomUUID())).rejects.toMatchObject({
        code: 'UnknownReference',
      });
      await api.owner.pool.query('UPDATE locations SET archived_at = now() WHERE id = $1', [
        candidate,
      ]);
      await expect(online.forCandidate(candidate)).rejects.toMatchObject({
        code: 'UnknownReference',
      });
    });

    it('pages every variant with a balance or a reservation, by variant id', async () => {
      const wh = await warehouse({ verified: true });
      const variants = [await make.variant(), await make.variant(), await make.variant()];
      await stock(variants[0] as string, wh, 1);
      await stock(variants[1] as string, wh, 2);
      // A variant with only waiting demand and no balance still has a row.
      await reservation(variants[2] as string, wh, 0, 3);
      await goOnline(wh, 2);

      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = await online.list({ limit: 2, ...(after && { afterVariantId: after }) });
        expect(page.onlineLocationId).toBe(wh);
        seen.push(...page.rows.map((row) => row.variantId));
        after = page.nextAfterVariantId ?? undefined;
        pages += 1;
      } while (after);

      expect(pages).toBe(2);
      expect(seen).toEqual([...variants].sort());
      const whole = await online.list({});
      expect(whole.rows.find((row) => row.variantId === variants[2])).toMatchObject({
        onHand: 0,
        unfilledDemand: 3,
        pushable: 0,
      });
    });
  });

  describe('the change feed (AC-4)', () => {
    const idsOf = (rows: OnlineStockChangedRow[]) => rows.map((row) => row.variantId);

    it('reports a changed variant with its numbers, then nothing, then the next change', async () => {
      const wh = await warehouse({ verified: true });
      const variant = await make.variant();
      await stock(variant, wh, 5);
      await goOnline(wh, 1);

      const first = await online.changedSince({ since: null });
      expect(first.onlineLocationId).toBe(wh);
      expect(idsOf(first.rows)).toEqual([variant]);
      expect(first.rows[0]).toMatchObject({ onHand: 5, pushable: 5 });
      expect(first.nextAfter).toBeNull();
      // The watermark trails the database clock by five minutes, so it is older than a fresh change.
      expect(first.watermark < (first.rows[0]?.changedAt ?? '')).toBe(true);

      const lastChange = first.rows[0]?.changedAt ?? '';
      expect(idsOf((await online.changedSince({ since: lastChange })).rows)).toEqual([]);

      await reservation(variant, wh, 2, 0);
      const next = await online.changedSince({ since: lastChange });
      expect(idsOf(next.rows)).toEqual([variant]);
      expect(next.rows[0]).toMatchObject({ reserved: 2, pushable: 3 });
    });

    it('sees a late commit in the next run: held open after its now(), not in one run, in the next', async () => {
      const wh = await warehouse({ verified: true });
      const variant = await make.variant();
      await stock(variant, wh, 5);
      const held = await reservation(variant, wh, 1, 0);
      await goOnline(wh, 1);
      const baseline = await online.changedSince({ since: null });
      expect(baseline.watermark < (baseline.rows.at(-1)?.changedAt ?? '')).toBe(true);

      const client = await api.owner.pool.connect();
      let during: Awaited<ReturnType<typeof online.changedSince>>;
      const other = await make.variant();
      try {
        await client.query('BEGIN');
        // The change is stamped with this transaction's start and stays uncommitted.
        await client.query('UPDATE reservations SET updated_at = now() WHERE id = $1', [held]);
        // Another change commits meanwhile and a run reads past the held open one.
        await stock(other, wh, 1);
        during = await online.changedSince({ since: baseline.watermark });
        expect(idsOf(during.rows)).toContain(other);
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }

      // The caller stored the in-between run's watermark as its next `since`: the next run sees
      // the change that committed late, although its stamp is older than a change the in-between
      // run already returned (so a `since` of the last seen `changedAt` would have lost it).
      const later = await online.changedSince({ since: during.watermark });
      const late = later.rows.find((row) => row.variantId === variant);
      const seenBefore = during.rows.find((row) => row.variantId === other);
      expect(late).toBeDefined();
      expect((late?.changedAt ?? '') < (seenBefore?.changedAt ?? '')).toBe(true);
    });

    it('pages through every change with after, each variant once', async () => {
      const wh = await warehouse({ verified: true });
      const variants: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const variant = await make.variant();
        variants.push(variant);
        await stock(variant, wh, i + 1);
      }
      await goOnline(wh, 5);

      const seen: string[] = [];
      let after: { changedAt: string; variantId: string } | undefined;
      let pages = 0;
      let watermark = '';
      do {
        const page = await online.changedSince({
          since: null,
          limit: 2,
          ...(after && { after }),
        });
        if (pages === 0) watermark = page.watermark;
        seen.push(...idsOf(page.rows));
        after = page.nextAfter ?? undefined;
        pages += 1;
      } while (after);

      expect(pages).toBe(3);
      expect([...seen].sort()).toEqual([...variants].sort());
      expect(new Set(seen).size).toBe(5);
      expect(watermark).toMatch(/Z$/);
    });
  });
});
