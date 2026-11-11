import { randomUUID } from 'node:crypto';
import {
  CreatedOrder,
  CustomerProfile,
  CustomerSetFlagResponse,
  CustomerTimelinePage,
  PutSettingAnswer,
  SkuDetail,
  personActor,
  type CustomerTimelineEntry,
  type NormalizedPhone,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConnection } from '@ssdashboard/db';
import { CustomersService } from '../src/customers/customers.service.js';
import { CustomerTimelineService } from '../src/customers/profile/customer-timeline.service.js';
import { DATABASE } from '../src/database/database.module.js';
import { Access } from '../src/platform/access/access.js';
import { encodeKeyset } from '../src/platform/keyset-cursor.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0014 milestone 4 (AC-13 to AC-16): one timeline across the orders and the customers'
// own rows, paged by keyset with no gap or repeat, seen through each hat's lens, and the returner
// signal with its one tap apply, against PostgreSQL as the application role through the real routes.
describe('customers timeline and signal', { timeout: 300_000 }, () => {
  let api: InProcessApi;
  let manager = '';
  let support = '';
  let supportId = '';
  let warehouse = '';
  let mediaBuyer = '';
  let partner = '';
  let mainStore = '';
  let manualChannel = '';
  let sku = '';
  let customers: CustomersService;
  let db: DatabaseConnection;
  let n = 0;
  let settingStamp: string | null = null;

  /** A fresh local mobile number, never used before. */
  const phone = () => {
    n += 1;
    return `0101${String(1_000_000 + n)}`;
  };
  const e164Of = (local: string): NormalizedPhone => ({
    e164: `+20${local.slice(1)}`,
    kind: 'mobile',
  });
  const owner = <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => api.owner.pool.query<T>(text, params);

  /** A manual order for this phone, made by support. */
  const order = async (localPhone: string) => {
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: { name: 'Sentinel Name', phone: localPhone, address: '12 Sentinel Street' },
      lines: [{ variantId: sku, quantity: 1, unitPrice: '570.00' }],
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return CreatedOrder.parse(reply.body).id;
  };
  const customerOfOrder = async (orderId: string) =>
    (await owner<{ id: string }>('SELECT customer_id AS id FROM orders WHERE id = $1', [orderId]))
      .rows[0]?.id as string;
  /** A new customer with her own phone, through the service. */
  const newCustomer = async () => {
    const result = await db.db.transaction((tx) =>
      customers.findOrCreate(tx, {
        phone: e164Of(phone()),
        channelCustomer: null,
        name: 'Sentinel Other',
        seenAt: new Date('2026-09-01T08:00:00Z'),
      }),
    );
    return result.customerId as string;
  };
  const merge = async (survivorId: string, mergedId: string) => {
    const reply = await api.call(support, 'POST', '/api/customers/merges', {
      survivorId,
      mergedId,
      reasonCode: 'same_person',
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return (reply.body as { mergeId: string }).mergeId;
  };
  const timeline = async (cookie: string, id: string, query = '') => {
    const reply = await api.call(cookie, 'GET', `/api/customers/${id}/timeline${query}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return CustomerTimelinePage.parse(reply.body);
  };
  /** Every entry of the timeline, page by page. */
  const allPages = async (cookie: string, id: string, limit: number) => {
    const entries: CustomerTimelineEntry[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await timeline(cookie, id, query);
      expect(page.items.length).toBeLessThanOrEqual(limit);
      entries.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 200);
    return { entries, pages };
  };
  const profile = async (cookie: string, id: string) => {
    const reply = await api.call(cookie, 'GET', `/api/customers/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return CustomerProfile.parse(reply.body);
  };
  const putSignal = async (refusalsToSuggest: number) => {
    const reply = await api.call(manager, 'PUT', '/api/settings/customer_risk_signal', {
      value: { windowDays: 180, refusalsToSuggest, returnsToSuggest: 2 },
      expectedUpdatedAt: settingStamp,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    settingStamp = PutSettingAnswer.parse(reply.body).entry.updatedAt;
  };
  /** Marks an order refused at the door now, as the carrier move will (spec 0013 milestone 4). */
  const refuse = async (orderId: string, occurredAt = new Date().toISOString()) => {
    await owner(
      `UPDATE orders SET fulfillment_state = 'refused', refused_reason_code = 'size',
              outcome = 'failed_delivery' WHERE id = $1::uuid`,
      [orderId],
    );
    await owner(
      `INSERT INTO order_events (order_id, machine, from_state, to_state, actor_type, occurred_at)
       VALUES ($1::uuid, 'fulfillment', 'new', 'refused', 'system_job', $2::timestamptz)`,
      [orderId, occurredAt],
    );
  };
  /** The position of an entry in the total order, as the api compares it. */
  const sourceOf = (entry: CustomerTimelineEntry): string => {
    switch (entry.kind) {
      case 'order':
        return 'order';
      case 'merge':
      case 'unmerge':
        return 'merge';
      case 'phone_added':
        return 'phone';
      case 'channel_id_added':
        return 'channel_id';
      case 'flag':
        return 'flag';
    }
  };
  const inOrder = (entries: readonly CustomerTimelineEntry[]) =>
    entries.every((entry, i) => {
      const prev = entries[i - 1];
      if (!prev) return true;
      const at = (value: string) => new Date(value).getTime() * 1000 + Number(value.slice(23, 26));
      if (at(prev.at) !== at(entry.at)) return at(prev.at) > at(entry.at);
      if (sourceOf(prev) !== sourceOf(entry)) return sourceOf(prev) < sourceOf(entry);
      return prev.id > entry.id;
    });

  beforeAll(async () => {
    api = await startInProcessApi();
    manager = await api.signIn((await api.addPerson(['manager'])).email);
    const supportPerson = await api.addPerson(['support']);
    supportId = supportPerson.id;
    support = await api.signIn(supportPerson.email);
    warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
    mediaBuyer = await api.signIn((await api.addPerson(['media_buyer'])).email);
    const account = await api.addParty('TLP');
    partner = await api.signIn(
      (await api.addPerson(['partner'], { partnerAccountId: account })).email,
    );
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    const product = await api.call(manager, 'POST', '/api/products', {
      name: { en: 'Timeline tee' },
      variants: [{ sku: 'TL-TEE', price: '570.00' }],
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    sku = SkuDetail.parse(product.body).id;
    customers = api.app.get(CustomersService);
    db = api.app.get<DatabaseConnection>(DATABASE);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('one timeline across sources (AC-14)', () => {
    let customer = '';
    const orderIds: string[] = [];
    let undoneMerge = '';
    let collisionAt = '';

    beforeAll(async () => {
      // 45 orders, 5 merges (one undone, so one unmerge), 8 phones, and the flag: 60 entries.
      const mine = phone();
      for (let i = 0; i < 45; i += 1) orderIds.push(await order(mine));
      customer = await customerOfOrder(orderIds[0] as string);
      for (const [i, id] of orderIds.entries()) {
        await owner(
          `UPDATE orders SET placed_at = '2026-10-01T00:00:00Z'::timestamptz + $2 * interval '1 hour'
           WHERE id = $1::uuid`,
          [id, i],
        );
      }
      const mergeIds: string[] = [];
      for (let i = 0; i < 5; i += 1) mergeIds.push(await merge(customer, await newCustomer()));
      undoneMerge = mergeIds[0] as string;
      const undo = await api.call(support, 'POST', `/api/customers/merges/${undoneMerge}/undo`, {
        reasonCode: 'wrong_merge',
      });
      expect(undo.status, JSON.stringify(undo.body)).toBe(200);
      for (let i = 0; i < 3; i += 1) {
        await db.db.transaction((tx) =>
          customers.addPhone(tx, customer, e164Of(phone()), personActor(supportId, 'support')),
        );
      }
      const stamp = (await profile(support, customer)).updatedAt;
      const flagged = await api.call(support, 'PUT', `/api/customers/${customer}/flag`, {
        kind: 'returner',
        expectedUpdatedAt: stamp,
      });
      expect(flagged.status, JSON.stringify(flagged.body)).toBe(200);

      // Two entries at one instant from two sources (an order and a merge, plus a phone), and two
      // orders at one instant (the id breaks the tie).
      collisionAt = (
        await owner<{ at: string }>(
          `SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
           FROM customer_merges WHERE id = $1`,
          [mergeIds[2]],
        )
      ).rows[0]?.at as string;
      await owner(`UPDATE orders SET placed_at = $2::timestamptz WHERE id = $1::uuid`, [
        orderIds[10],
        collisionAt,
      ]);
      await owner(
        `UPDATE customer_phones SET first_seen_at = $2::timestamptz
         WHERE id = (SELECT id FROM customer_phones WHERE customer_id = $1 AND NOT is_primary
                     ORDER BY id LIMIT 1)`,
        [customer, collisionAt],
      );
      await owner(
        `UPDATE orders SET placed_at = (SELECT placed_at FROM orders WHERE id = $2::uuid)
         WHERE id = $1::uuid`,
        [orderIds[20], orderIds[21]],
      );
    });

    it('pages 60 entries by 25 with no gap or repeat, newest first', async () => {
      const { entries, pages } = await allPages(support, customer, 25);
      const keys = entries.map((e) => `${e.kind}:${e.id}`);
      const counts = entries.reduce<Record<string, number>>(
        (acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }),
        {},
      );

      expect(pages).toBe(3);
      expect(entries).toHaveLength(60);
      expect(new Set(keys).size).toBe(60);
      expect(counts).toEqual({
        order: 45,
        merge: 5,
        unmerge: 1,
        phone_added: 8,
        flag: 1,
      });
      expect(inOrder(entries)).toBe(true);
      expect(
        entries
          .filter((e) => e.kind === 'order')
          .map((e) => e.id)
          .sort(),
      ).toEqual([...orderIds].sort());
      expect(
        entries
          .filter((e) => e.at === collisionAt)
          .map((e) => e.kind)
          .sort(),
      ).toEqual(['merge', 'order', 'phone_added']);
    });

    it('walks every boundary one entry at a time, the same instant included, to the same list', async () => {
      const byOne = await allPages(support, customer, 1);
      const byTwentyFive = await allPages(support, customer, 25);

      expect(byOne.entries.map((e) => `${e.kind}:${e.id}`)).toEqual(
        byTwentyFive.entries.map((e) => `${e.kind}:${e.id}`),
      );
    });

    it('answers the same timeline for a merged id, and filters by kind', async () => {
      const merged = (
        await owner<{ id: string }>(
          'SELECT id FROM customers WHERE merged_into_id = $1 ORDER BY id LIMIT 1',
          [customer],
        )
      ).rows[0]?.id as string;
      const viaMerged = await timeline(support, merged, '?limit=50');
      const direct = await timeline(support, customer, '?limit=50');
      const merges = await timeline(support, customer, '?kinds=merge,unmerge&limit=50');

      expect(viaMerged.items).toEqual(direct.items);
      expect(merges.items.map((e) => e.kind).sort()).toEqual([
        'merge',
        'merge',
        'merge',
        'merge',
        'merge',
        'unmerge',
      ]);
      expect(merges.nextCursor).toBeNull();
    });

    it('shows support Undo but no audit link, and the manager both (AC-15)', async () => {
      const bySupport = await timeline(support, customer, '?kinds=merge,unmerge&limit=50');
      const byManager = await timeline(manager, customer, '?kinds=merge,unmerge&limit=50');
      const supportMerges = bySupport.items.filter((e) => e.kind === 'merge');
      const managerMerges = byManager.items.filter((e) => e.kind === 'merge');

      expect(supportMerges.every((e) => typeof e.undoable === 'boolean')).toBe(true);
      expect(bySupport.items.every((e) => !('audit' in e))).toBe(true);
      expect(managerMerges.every((e) => typeof e.undoable === 'boolean')).toBe(true);
      expect(
        byManager.items.every(
          (e) => (e.kind === 'merge' || e.kind === 'unmerge') && e.audit?.recordType === 'customer',
        ),
      ).toBe(true);
      // The undone merge is not undoable; the four live ones are.
      expect(supportMerges.find((e) => e.id === undoneMerge)?.undoable).toBe(false);
      expect(supportMerges.filter((e) => e.undoable === true)).toHaveLength(4);
      const merge = supportMerges[0];
      expect(merge?.other.name).toBe('Sentinel Other');
      expect(merge?.otherRole).toBe('merged');
      expect(merge?.reasonCode).toBe('same_person');
      expect(merge?.actorName).not.toBeNull();
    });

    it('gives a built Access with customers.view only no order entry (AC-15)', async () => {
      const viewer = new Access({
        userId: supportId,
        hats: [],
        grants: ['customers.view'],
        partnerAccountId: null,
      });
      const page = await api.app.get(CustomerTimelineService).page(customer, { limit: 50 }, viewer);

      expect(page.items).toHaveLength(15);
      expect(page.items.some((e) => e.kind === 'order')).toBe(false);
      expect(page.items.filter((e) => e.kind === 'merge').every((e) => !('undoable' in e))).toBe(
        true,
      );
    });

    it('carries no cost field key and no-store', async () => {
      const reply = await api.call(manager, 'GET', `/api/customers/${customer}/timeline?limit=50`);
      const text = JSON.stringify(reply.body);

      expect(reply.headers.get('cache-control')).toBe('no-store');
      for (const key of [
        'unitCost',
        'lineTotal',
        'referenceValue',
        'avgUnitCost',
        'totalValue',
        'totalCost',
      ]) {
        expect(text).not.toContain(`"${key}"`);
      }
    });

    it('refuses a forged cursor, a bad query, and an unknown customer', async () => {
      const call = (query: string, id = customer) =>
        api.call(support, 'GET', `/api/customers/${id}/timeline${query}`);
      const forged = [
        'not-a-cursor',
        encodeKeyset(['2026-10-01T00:00:00.000000Z', 'credit', randomUUID()]),
        encodeKeyset(['2026-02-30T00:00:00.000000Z', 'order', randomUUID()]),
        encodeKeyset(['2026-10-01T00:00:00.000000Z', randomUUID()]),
      ];
      for (const cursor of forged) {
        const reply = await call(`?cursor=${cursor}`);
        expect(reply.status, cursor).toBe(400);
        expect(reply.body).toMatchObject({ code: 'INVALID_CURSOR' });
      }
      expect((await call('?limit=51')).body).toMatchObject({ code: 'INVALID_QUERY' });
      expect((await call('?kinds=order,credit')).body).toMatchObject({ code: 'INVALID_QUERY' });
      const unknown = await call('', randomUUID());
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    });

    it('answers 403 to the warehouse, the media buyer, and a partner user (AC-16)', async () => {
      for (const cookie of [warehouse, mediaBuyer, partner]) {
        const reply = await api.call(cookie, 'GET', `/api/customers/${customer}/timeline`);
        expect(reply.status).toBe(403);
        const prof = await api.call(cookie, 'GET', `/api/customers/${customer}`);
        expect(prof.status).toBe(403);
      }
    });
  });

  describe('the returner signal (AC-13)', () => {
    let customer = '';

    beforeAll(async () => {
      const mine = phone();
      const first = await order(mine);
      const second = await order(mine);
      await order(mine);
      customer = await customerOfOrder(first);
      await refuse(first);
      await refuse(second);
    });

    it('suggests refuser after two refusals in 180 days with no flag, with the order count', async () => {
      const read = await profile(support, customer);

      expect(read.signal).toEqual({
        refusals: 2,
        returns: 0,
        windowDays: 180,
        suggestedKind: 'refuser',
      });
      expect(read.orderCount).toBe(3);
    });

    it('removes the suggestion when the setting is raised to 3, and refuses to apply it', async () => {
      await putSignal(3);
      const read = await profile(support, customer);
      const apply = await api.call(support, 'PUT', `/api/customers/${customer}/flag`, {
        kind: 'refuser',
        reasonCode: 'suggestion_applied',
        expectedUpdatedAt: read.updatedAt,
      });

      expect(read.signal?.suggestedKind).toBeNull();
      expect(apply.status).toBe(422);
      expect(apply.body).toMatchObject({ code: 'REASON_INVALID' });
      await putSignal(2);
    });

    it('refuses suggestion_applied for a kind the signal does not suggest', async () => {
      const read = await profile(support, customer);
      const apply = await api.call(support, 'PUT', `/api/customers/${customer}/flag`, {
        kind: 'returner',
        reasonCode: 'suggestion_applied',
        expectedUpdatedAt: read.updatedAt,
      });

      expect(apply.status).toBe(422);
      expect(apply.body).toMatchObject({ code: 'REASON_INVALID' });
    });

    it('applies the suggestion in one tap as a manual flag with the counts in the entry', async () => {
      const read = await profile(support, customer);
      expect(read.signal?.suggestedKind).toBe('refuser');
      const apply = await api.call(support, 'PUT', `/api/customers/${customer}/flag`, {
        kind: 'refuser',
        reasonCode: 'suggestion_applied',
        expectedUpdatedAt: read.updatedAt,
      });
      expect(apply.status, JSON.stringify(apply.body)).toBe(200);
      expect(CustomerSetFlagResponse.parse(apply.body).flag).toMatchObject({
        kind: 'refuser',
        source: 'manual',
      });
      const entry = (
        await owner<{ reason: string; after: unknown }>(
          `SELECT reason, after FROM audit_entries
           WHERE action = 'customer.flagged' AND record_id = $1`,
          [customer],
        )
      ).rows;
      const after = await profile(support, customer);
      const again = await api.call(support, 'PUT', `/api/customers/${customer}/flag`, {
        kind: 'refuser',
        reasonCode: 'suggestion_applied',
        expectedUpdatedAt: after.updatedAt,
      });

      expect(entry).toEqual([
        {
          reason: 'suggestion_applied',
          after: {
            riskFlag: 'refuser',
            riskFlagSource: 'manual',
            refusals: 2,
            returns: 0,
            windowDays: 180,
          },
        },
      ]);
      expect(after.signal?.suggestedKind).toBeNull();
      expect(after.signal?.refusals).toBe(2);
      expect(again.status).toBe(422);
      expect(again.body).toMatchObject({ code: 'REASON_INVALID' });
    });

    it('leaves out a refusal older than the window', async () => {
      const mine = phone();
      const old = await order(mine);
      const recent = await order(mine);
      const id = await customerOfOrder(old);
      await refuse(old, '2025-01-01T10:00:00Z');
      await refuse(recent);

      const read = await profile(support, id);
      expect(read.signal).toMatchObject({ refusals: 1, suggestedKind: null });
    });
  });
});
