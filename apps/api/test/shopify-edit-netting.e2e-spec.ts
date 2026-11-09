import { createHmac, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { SkuDetail } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionSecrets } from '../src/connectors/connections/connection-secrets.js';
import { ChannelEditNetted, ChannelRefundRecorded } from '../src/connectors/connectors.events.js';
import { ExchangeByEdit } from '../src/connectors/shopify/exchange-by-edit.js';
import { OrderTransactions } from '../src/orders/order-transactions.js';
import { OrderAttentionRaised } from '../src/orders/orders.events.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { WorkerModule } from '../src/worker.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import {
  readShopifyFixture,
  remainingShopifyExchanges,
  useShopifyScenarios,
} from './shopify-fixture-fetch.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0015 task 10 (AC-11, AC-12; *Critical test scenarios* "Netting" and "Exchange by edit").
// Signed webhooks reach the real api in process; the real worker's inbox job reads the order back
// from the synthetic fixtures (to be replaced by recordings, task 1) through the refusing fetch,
// nets its sales history with one `ssd_operating_day` call, and makes replacement orders through
// the real orders module. Each test plants its own store, so the fixtures' names never collide.

// Load the root .env before the api saves the environment (the worker reads it after).
devDatabaseUrl();

/** The webhook secret of every connection here (a test value, never a real one). */
const SECRET = `edit-netting-secret-${randomUUID()}`;

/** The fixtures' gateways mapped as a manager would; "mark as paid" (`manual`) is cash. */
const CONFIG = JSON.stringify({
  appOwner: 'organization',
  altPhoneAttribute: 'alt_phone',
  gatewayMethods: { 'Cash on Delivery (COD)': 'cod', manual: 'cod' },
});

/** Personal fixture values that must never reach an event or the mapping state. */
const PERSONAL = ['مها تجريبية', '12 شارع الاختبار', '+201000000101', 'maha.fixture'];

interface Planted {
  id: string;
  shopDomain: string;
  storeId: string;
}

interface EventRow {
  id: string;
  status: string;
  outcome: string | null;
  failure_code: string | null;
}

const restId = (gid: string) => Number(gid.split('/').pop());
const line = (n: string) => `gid://shopify/LineItem/${n}`;

describe(
  'Shopify edit netting and exchange by edit (spec 0015 task 10)',
  { timeout: 300_000 },
  () => {
    let api: InProcessApi;
    let worker: TestingModule;
    let refusingFetch: typeof fetch;
    let manager = '';
    const netted: ChannelEditNetted[] = [];
    const refunds: ChannelRefundRecorded[] = [];
    const attentions: OrderAttentionRaised[] = [];

    /** Plants a Shopify store, its own channel, and an active connection sealed with `SECRET`. */
    const plant = async (): Promise<Planted> => {
      const t = randomUUID().slice(0, 8);
      const storeCode = `EN${t.toUpperCase()}`;
      const shopDomain = `nettingfx-${t}.myshopify.com`;
      const id = randomUUID();
      const store = await api.owner.pool.query<{ id: string }>(
        `INSERT INTO stores (code, name, public_name, kind)
       VALUES ($1, '{"en":"Netting store"}', '{"en":"Netting store"}', 'shopify') RETURNING id`,
        [storeCode],
      );
      const storeId = store.rows[0]?.id as string;
      await api.owner.pool.query(
        `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ($1, '{"en":"Netting store"}', 'shopify', $2::uuid)`,
        [storeCode, storeId],
      );
      const sealed = api.app
        .get(ConnectionSecrets)
        .seal(
          { kind: 'client_credentials', clientId: `client-${t}-WXYZ`, clientSecret: SECRET },
          id,
        );
      await api.owner.pool.query(
        `INSERT INTO connections (id, provider, label, store_id, status, shop_domain,
                                credentials_ciphertext, credentials_key_version, credentials_hint,
                                credentials_updated_at, config, health)
       VALUES ($1::uuid, 'shopify', 'Netting store', $2::uuid, 'active', $3, $4, $5, 'WXYZ', now(),
               $6::jsonb, 'ok')`,
        [id, storeId, shopDomain, sealed.ciphertext, sealed.keyVersion, CONFIG],
      );
      return { id, shopDomain, storeId };
    };

    /** Sends one signed delivery for the order and waits until its event left `received`. */
    const arrive = async (c: Planted, topic: string, gid: string, updatedAt: string) => {
      const webhookId = randomUUID();
      const raw = Buffer.from(
        JSON.stringify({ id: restId(gid), admin_graphql_api_id: gid, updated_at: updatedAt }),
        'utf8',
      );
      const response = await fetch(`${api.base}/api/hooks/shopify/${c.id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': topic,
          'x-shopify-webhook-id': webhookId,
          'x-shopify-shop-domain': c.shopDomain,
          'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64'),
          'x-shopify-api-version': '2026-10',
        },
        body: new Uint8Array(raw),
      });
      expect(response.status).toBe(200);
      return eventually(
        async () => {
          const { rows } = await api.owner.pool.query<EventRow>(
            `SELECT id, status, outcome, failure_code FROM inbound_events
           WHERE connection_id = $1::uuid AND dedupe_key = $2`,
            [c.id, webhookId],
          );
          const row = rows[0];
          return row && row.status !== 'received' ? row : undefined;
        },
        { timeoutMs: 60_000, what: `event ${webhookId} to settle` },
      );
    };

    /** The order of a channel ref in a store. */
    const orderOf = async (c: Planted, ref: string) =>
      (
        await api.owner.pool.query<{
          id: string;
          order_number: string;
          type: string;
          original_order_id: string | null;
          fulfillment_state: string;
          ship_to_address: string | null;
        }>(
          `SELECT id, order_number, type, original_order_id, fulfillment_state, ship_to_address
         FROM orders WHERE store_id = $1::uuid AND channel_order_ref = $2`,
          [c.storeId, ref],
        )
      ).rows[0];

    /** The lines of an order, in position order, with what the sum check needs. */
    const linesOf = async (orderId: string) =>
      (
        await api.owner.pool.query<{
          channel_line_id: string;
          variant_id: string | null;
          line_state: string;
          cancel_reason_code: string | null;
          quantity: number;
          unit_price: string;
          discount_amount: string;
        }>(
          `SELECT channel_line_id, variant_id, line_state, cancel_reason_code, quantity,
                unit_price::text, discount_amount::text
         FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
          [orderId],
        )
      ).rows;

    const mappingOf = async (c: Planted, gid: string) =>
      (
        await api.owner.pool.query<{ id: string; state: Record<string, unknown> }>(
          `SELECT id, state FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity = 'order' AND external_id = $2`,
          [c.id, gid],
        )
      ).rows[0];

    const nettedFor = (orderId: string) => netted.filter((event) => event.orderId === orderId);
    const refundsFor = (orderId: string) => refunds.filter((event) => event.orderId === orderId);
    const attentionKindsFor = (orderId: string) =>
      attentions.filter((event) => event.orderId === orderId).map((event) => event.kind);

    /** A SKU made through the catalog route. */
    const sku = async (code: string): Promise<string> => {
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '450.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };

    /** Maps a Shopify variant to an app variant on the connection, as task 8 will. */
    const mapVariant = (c: Planted, variantGid: string, variantId: string) =>
      api.owner.pool.query(
        `INSERT INTO connection_external_ids (connection_id, entity, external_id, local_id)
       VALUES ($1::uuid, 'variant', $2, $3::uuid)`,
        [c.id, variantGid, variantId],
      );

    /** Moves an order to `delivered`, the app's fact a carrier (feature 19) will record. */
    const deliver = (orderId: string) =>
      api.owner.pool.query(
        `UPDATE orders SET fulfillment_state = 'delivered' WHERE id = $1::uuid`,
        [orderId],
      );

    beforeAll(async () => {
      api = await startInProcessApi();
      worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      const events = worker.get(DomainEvents);
      events.on(ChannelEditNetted, (_tx, event) => void netted.push(event), 'edit-netting-e2e');
      events.on(
        ChannelRefundRecorded,
        (_tx, event) => void refunds.push(event),
        'edit-netting-e2e',
      );
      events.on(
        OrderAttentionRaised,
        (_tx, event) => void attentions.push(event),
        'edit-netting-e2e',
      );
      await worker.init();

      // The token exchange is answered from the recorded `connect-ok` grant; every other request
      // goes to the refusing fetch.
      refusingFetch = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === '/admin/oauth/access_token') {
          const grant = readShopifyFixture('connect-ok/01-access-token.json').response;
          return new Response(JSON.stringify(grant.body), {
            status: grant.status,
            headers: grant.headers,
          });
        }
        return refusingFetch(input, init);
      };
      const boss = await api.addPerson(['manager']);
      manager = await api.signIn(boss.email);
      // The operating day cutoff of every test here is 0 (spec 0015 "Netting": "with the cutoff
      // set to 0"), whatever the default becomes.
      await api.owner.pool.query(
        `UPDATE settings SET value = to_jsonb(0) WHERE key = 'operating_day_cutoff_hour'`,
      );
    }, 180_000);

    afterAll(async () => {
      if (refusingFetch) globalThis.fetch = refusingFetch;
      await worker?.close();
      await api?.close();
    });

    it('applies a size change as one edit removal and one added line, never a return, and nets the M placed and removed that day once (AC-11)', async () => {
      useShopifyScenarios('order-edited-size-swap');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000002001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      expect(await arrive(c, 'orders/edited', gid, '2026-11-02T11:40:09Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const order = await orderOf(c, gid);
      const orderId = order?.id as string;
      const lines = await linesOf(orderId);
      expect(lines.map((l) => [l.channel_line_id, l.line_state, l.cancel_reason_code])).toEqual([
        [line('6660000002001'), 'cancelled', 'edit_removal'],
        [line('6660000002002'), 'open', null],
        [line('6660000002003'), 'open', null],
      ]);
      expect(nettedFor(orderId)).toEqual([
        expect.objectContaining({
          channelLineIds: [line('6660000002001')],
          operatingDay: '2026-11-02',
        }),
      ]);
      expect(refundsFor(orderId)).toEqual([]);

      // 03 is stale, 04 is newer and identical: no pair is netted twice.
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T11:40:09Z')).toMatchObject({
        status: 'ignored',
        outcome: 'stale',
      });
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T11:40:12Z')).toMatchObject({
        status: 'processed',
      });
      expect(nettedFor(orderId)).toHaveLength(1);
      expect((await mappingOf(c, gid))?.state['nettedSaleIds']).toEqual([
        'gid://shopify/ProductSale/5000000002003',
        'gid://shopify/ProductSale/5000000002001',
      ]);
      expect(remainingShopifyExchanges()).toEqual([]);

      // AC-11's sum check over this synthetic day (to run again on task 1's recordings): units and
      // net sales of the app's lines (every line it made, cancelled ones too) minus the addition
      // half of each netted pair equal the day's product ORDER and UPDATE sales in Shopify's own
      // sales history. The day holds no refund, so no RETURN sale enters either side.
      const history = readShopifyFixture('order-edited-size-swap/04-order-read.json').response
        .body as {
        data: {
          order: {
            agreements: {
              nodes: {
                happenedAt: string;
                sales: {
                  nodes: {
                    actionType: string;
                    lineType: string;
                    quantity: number;
                    totalAmount: { shopMoney: { amount: string } };
                  }[];
                };
              }[];
            };
          };
        };
      };
      const cents = (amount: string) => Math.round(Number(amount) * 100);
      let shopifyUnits = 0;
      let shopifyCents = 0;
      for (const agreement of history.data.order.agreements.nodes) {
        const day = await api.owner.pool.query<{ day: string }>(
          `SELECT to_char(ssd_operating_day($1::timestamptz), 'YYYY-MM-DD') AS day`,
          [agreement.happenedAt],
        );
        if (day.rows[0]?.day !== '2026-11-02') continue;
        for (const sale of agreement.sales.nodes) {
          if (sale.lineType !== 'PRODUCT' || !['ORDER', 'UPDATE'].includes(sale.actionType))
            continue;
          shopifyUnits += sale.quantity;
          shopifyCents += cents(sale.totalAmount.shopMoney.amount);
        }
      }
      const lineCents = (l: (typeof lines)[number]) =>
        cents(l.unit_price) * l.quantity - cents(l.discount_amount);
      const additions = nettedFor(orderId).map((event) => event.channelLineIds.at(-1));
      const nettedLines = lines.filter((l) => additions.includes(l.channel_line_id));
      const appUnits =
        lines.reduce((sum, l) => sum + l.quantity, 0) -
        nettedLines.reduce((sum, l) => sum + l.quantity, 0);
      const appCents =
        lines.reduce((sum, l) => sum + lineCents(l), 0) -
        nettedLines.reduce((sum, l) => sum + lineCents(l), 0);
      expect([appUnits, appCents]).toEqual([shopifyUnits, shopifyCents]);
      expect([appUnits, appCents]).toEqual([2, 81_000]);
    });

    it('nets the same day pair of two line items of one variant once, keeps the live lines, and nets nothing on a repeat read (AC-11)', async () => {
      useShopifyScenarios('order-same-variant-lines');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000028001';
      await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
      expect(await arrive(c, 'orders/edited', gid, '2026-11-02T11:00:05Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const orderId = (await orderOf(c, gid))?.id as string;
      expect(
        (await linesOf(orderId)).map((l) => [l.channel_line_id, l.line_state, l.quantity]),
      ).toEqual([
        [line('6660000028001'), 'open', 1],
        [line('6660000028002'), 'open', 1],
      ]);
      expect(nettedFor(orderId)).toEqual([
        expect.objectContaining({
          channelLineIds: [line('6660000028003'), line('6660000028001')],
          operatingDay: '2026-11-02',
        }),
      ]);
      expect(await arrive(c, 'orders/updated', gid, '2026-11-02T11:30:00Z')).toMatchObject({
        status: 'processed',
      });
      expect(nettedFor(orderId)).toHaveLength(1);
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('does not net a removal at 00:10 Cairo time against the addition at 23:50 the day before, with the cutoff at 0 (AC-11)', async () => {
      useShopifyScenarios('order-edit-pair-across-midnight');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000029001';
      await arrive(c, 'orders/create', gid, '2026-11-02T21:50:04Z');
      expect(await arrive(c, 'orders/edited', gid, '2026-11-02T22:10:05Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const orderId = (await orderOf(c, gid))?.id as string;
      expect(
        (await linesOf(orderId)).map((l) => [
          l.channel_line_id,
          l.line_state,
          l.cancel_reason_code,
        ]),
      ).toEqual([
        [line('6660000029001'), 'cancelled', 'edit_removal'],
        [line('6660000029002'), 'open', null],
      ]);
      expect(nettedFor(orderId)).toEqual([]);
      expect((await mappingOf(c, gid))?.state).not.toHaveProperty('nettedSaleIds');
    });

    it('makes #1009-R1 of the L added to a delivered order, linked replacement_for, records the M refund, and raises no channel_edit_not_applied (AC-12)', async () => {
      useShopifyScenarios('order-exchange-added-lines');
      const c = await plant();
      const skuL = await sku(`EXL-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, 'gid://shopify/ProductVariant/7770000000102', skuL);
      const gid = 'gid://shopify/Order/5550000008001';
      await arrive(c, 'orders/create', gid, '2026-11-04T10:00:01Z');
      const original = await orderOf(c, gid);
      const originalId = original?.id as string;
      await deliver(originalId);
      const before = await linesOf(originalId);

      expect(await arrive(c, 'orders/edited', gid, '2026-11-07T15:05:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      const replacement = await orderOf(c, `${gid}:R1`);
      expect(replacement).toMatchObject({
        order_number: '#1009-R1',
        type: 'exchange_replacement',
        original_order_id: originalId,
      });
      expect(replacement?.ship_to_address).toContain('12 شارع الاختبار');
      expect(
        (await linesOf(replacement?.id as string)).map((l) => [
          l.channel_line_id,
          l.variant_id,
          l.line_state,
        ]),
      ).toEqual([[line('6660000008002'), skuL, 'open']]);
      expect(await linesOf(originalId)).toEqual(before);
      expect(refundsFor(originalId)).toEqual([
        expect.objectContaining({
          externalRefundId: 'gid://shopify/Refund/1110000008001',
          amount: '450.00',
          occurredAt: '2026-11-07T15:02:00.000Z',
        }),
      ]);
      expect(attentionKindsFor(originalId)).not.toContain('channel_edit_not_applied');
      const state = (await mappingOf(c, gid))?.state;
      expect(state).toMatchObject({
        replacementOrderIds: [replacement?.id],
        replacementLineIds: [line('6660000008002')],
        recordedRefundIds: ['gid://shopify/Refund/1110000008001'],
      });
      expect(state).not.toHaveProperty('pendingReplacementLines');
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('keeps the added lines waiting while the original is still shipped, then retryWaitingReplacements makes the replacement once it is delivered (AC-12)', async () => {
      useShopifyScenarios('order-exchange-added-lines');
      const c = await plant();
      const skuL = await sku(`EXW-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, 'gid://shopify/ProductVariant/7770000000102', skuL);
      const gid = 'gid://shopify/Order/5550000008001';
      await arrive(c, 'orders/create', gid, '2026-11-04T10:00:01Z');
      const originalId = (await orderOf(c, gid))?.id as string;
      expect((await orderOf(c, gid))?.fulfillment_state).not.toBe('delivered');

      expect(await arrive(c, 'orders/edited', gid, '2026-11-07T15:05:00Z')).toMatchObject({
        status: 'processed',
        outcome: 'replacement_waiting',
      });
      expect(await orderOf(c, `${gid}:R1`)).toBeUndefined();
      const mapping = await mappingOf(c, gid);
      expect(mapping?.state['pendingReplacementLines']).toEqual([
        expect.objectContaining({ channelLineId: line('6660000008002'), variantId: skuL }),
      ]);
      expect(mapping?.state['pendingReplacement']).toMatchObject({ n: 1, orderNumber: '#1009-R1' });
      expect(refundsFor(originalId)).toHaveLength(1);
      expect(attentionKindsFor(originalId)).not.toContain('channel_edit_not_applied');
      for (const value of PERSONAL) expect(JSON.stringify(mapping?.state)).not.toContain(value);

      const run = () =>
        worker.get(OrderTransactions).run((tx) =>
          worker.get(ExchangeByEdit).retryWaitingReplacements(tx, c.id, mapping?.id as string, {
            type: 'system_job',
            job: 'connectors.shopify.hourly_check',
            jobId: randomUUID(),
          }),
        );
      expect(await run()).toEqual({ status: 'waiting' });
      await deliver(originalId);
      const made = await run();
      expect(made).toMatchObject({ status: 'created' });
      const replacement = await orderOf(c, `${gid}:R1`);
      expect(replacement).toMatchObject({
        id: made.status === 'created' ? made.orderId : '',
        order_number: '#1009-R1',
        type: 'exchange_replacement',
        original_order_id: originalId,
      });
      expect(replacement?.ship_to_address).toContain('12 شارع الاختبار');
      expect(
        (await linesOf(replacement?.id as string)).map((l) => [l.channel_line_id, l.variant_id]),
      ).toEqual([[line('6660000008002'), skuL]]);
      const after = (await mappingOf(c, gid))?.state;
      expect(after).toMatchObject({ replacementOrderIds: [replacement?.id] });
      expect(after).not.toHaveProperty('pendingReplacementLines');
      expect(await run()).toEqual({ status: 'nothing_waiting' });
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('records a refund made after the fulfillment as ChannelRefundRecorded once, never as an edit (AC-11)', async () => {
      useShopifyScenarios('order-refunded-after-fulfillment');
      const c = await plant();
      const gid = 'gid://shopify/Order/5550000030001';
      await arrive(c, 'orders/create', gid, '2026-11-03T08:30:05Z');
      const orderId = (await orderOf(c, gid))?.id as string;
      const before = await linesOf(orderId);
      expect(await arrive(c, 'orders/updated', gid, '2026-11-05T10:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect(await arrive(c, 'orders/updated', gid, '2026-11-05T11:00:00Z')).toMatchObject({
        status: 'processed',
        outcome: null,
      });
      expect(refundsFor(orderId)).toEqual([
        expect.objectContaining({
          externalRefundId: 'gid://shopify/Refund/1110000030001',
          amount: '405.00',
          occurredAt: '2026-11-05T09:58:00.000Z',
        }),
      ]);
      expect(await linesOf(orderId)).toEqual(before);
      expect(attentionKindsFor(orderId)).not.toContain('channel_edit_not_applied');
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    // QA (check verify, spec 0015 task 10): a fulfillment cancelled after an exchange by edit must
    // never leave the same added piece on two orders (the original's full snapshot and a
    // replacement), or reserve it twice.
    const heldCount = async (c: Planted, gid: string, lineGid: string) => {
      const original = await orderOf(c, gid);
      const replacement = await orderOf(c, `${gid}:R1`);
      const state = (await mappingOf(c, gid))?.state ?? {};
      const originalHas = (await linesOf(original?.id as string)).some(
        (l) => l.channel_line_id === lineGid && l.line_state === 'open',
      );
      const replacementHas =
        replacement !== undefined &&
        (await linesOf(replacement.id)).some((l) => l.channel_line_id === lineGid);
      const waiting = Array.isArray(state['pendingReplacementLines'])
        ? (state['pendingReplacementLines'] as { channelLineId: string }[]).some(
            (l) => l.channelLineId === lineGid,
          )
        : false;
      return { originalHas, replacementHas, waiting };
    };

    it('QA: drops a waiting replacement when the fulfillment is cancelled and the added line reaches the original by edit instead (AC-11, AC-12)', async () => {
      useShopifyScenarios('order-exchange-fulfillment-cancelled');
      const c = await plant();
      const skuL = await sku(`EXQ-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, 'gid://shopify/ProductVariant/7770000000102', skuL);
      const gid = 'gid://shopify/Order/5550000047001';
      await arrive(c, 'orders/create', gid, '2026-11-04T10:00:01Z');
      expect(await arrive(c, 'orders/edited', gid, '2026-11-07T15:05:00Z')).toMatchObject({
        outcome: 'replacement_waiting',
      });
      await arrive(c, 'orders/updated', gid, '2026-11-08T09:00:00Z');
      const held = await heldCount(c, gid, line('6660000008002'));
      // The piece is on exactly one order, or still waiting alone; never on the original and
      // waiting (or made) at once. The owner rule (F1): with no active fulfillment the added
      // line is a normal edit of the original and the waiting replacement is dropped once that
      // edit applies; orders refuses it here (the original is frozen after its carrier delivery),
      // so the line keeps waiting and the original does not hold it.
      expect(
        [held.originalHas, held.replacementHas, held.waiting].filter(Boolean).length,
        JSON.stringify(held),
      ).toBe(1);
      expect(held.replacementHas, JSON.stringify(held)).toBe(false);
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('QA: does not add a line already made into #R1 to the original when the fulfillment is cancelled (AC-12)', async () => {
      useShopifyScenarios('order-exchange-fulfillment-cancelled');
      const c = await plant();
      const skuL = await sku(`EXR-${randomUUID().slice(0, 6)}`);
      await mapVariant(c, 'gid://shopify/ProductVariant/7770000000102', skuL);
      const gid = 'gid://shopify/Order/5550000047001';
      await arrive(c, 'orders/create', gid, '2026-11-04T10:00:01Z');
      await deliver((await orderOf(c, gid))?.id as string);
      await arrive(c, 'orders/edited', gid, '2026-11-07T15:05:00Z');
      expect(await orderOf(c, `${gid}:R1`)).toBeDefined();
      await arrive(c, 'orders/updated', gid, '2026-11-08T09:00:00Z');
      const held = await heldCount(c, gid, line('6660000008002'));
      expect(held.replacementHas).toBe(true);
      expect(held.originalHas, JSON.stringify(held)).toBe(false);
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('publishes no refund event for an order imported with a refund made before go live, keeping its id recorded (security review M2)', async () => {
      useShopifyScenarios('order-imported-refund-before-go-live');
      const c = await plant();
      await api.owner.pool.query(
        `UPDATE connections SET go_live_at = '2026-11-06T00:00:00Z' WHERE id = $1::uuid`,
        [c.id],
      );
      const gid = 'gid://shopify/Order/5550001049001';
      expect(await arrive(c, 'orders/create', gid, '2026-11-05T10:00:00Z')).toMatchObject({
        status: 'processed',
      });
      const order = await orderOf(c, gid);
      expect(order?.fulfillment_state).toBe('shipped');
      expect(refundsFor(order?.id as string)).toEqual([]);
      expect((await mappingOf(c, gid))?.state).toMatchObject({
        imported: true,
        recordedRefundIds: ['gid://shopify/Refund/1110001049001'],
      });
      expect(remainingShopifyExchanges()).toEqual([]);
    });

    it('keeps every netting and refund event free of a name, a phone, or an address (Law 151)', () => {
      const published = JSON.stringify([...netted, ...refunds]);
      expect(netted.length + refunds.length).toBeGreaterThan(0);
      for (const value of PERSONAL) expect(published).not.toContain(value);
    });
  },
);
