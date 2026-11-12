import { createHmac, randomUUID } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProductUnlink } from '../src/connectors/connections/product-unlink.js';
import {
  ChannelProductNeedsAttention,
  InboundEventFailed,
} from '../src/connectors/connectors.events.js';
import { ConnectionSecrets } from '../src/connectors/connections/connection-secrets.js';
import { OrderIntake } from '../src/orders/intake/order-intake.service.js';
import { DATABASE } from '../src/database/database.module.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import { WorkerModule } from '../src/worker.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import {
  readShopifyFixture,
  remainingShopifyExchanges,
  resetShopifyScenarios,
  useShopifyScenarios,
} from './shopify-fixture-fetch.js';
import { devDatabaseUrl, eventually } from './support.js';

// Spec 0015 task 8 (AC-16, AC-9; *Critical test scenarios* "Products" and the AC-9 lines of
// "Orders"). Signed product and order webhooks reach the real api in process; the real worker's
// inbox job reads the product (or the order, then its product) back from the synthetic fixtures
// (to be replaced by recordings) through the refusing fetch, and applies it through the real
// catalog (`CatalogChannelSync`) and orders modules. Each test plants its own store and
// connection; the catalog is shared by the suite's scratch database, so each fixture's SKUs are
// its own.

// Load the root .env before the api saves the environment (the worker reads it after).
devDatabaseUrl();

/** The webhook secret of every connection here (a test value, never a real one). */
const SECRET = `products-secret-${randomUUID()}`;

/** The config of every planted connection: the order fixtures' gateway mapped. */
const CONFIG = JSON.stringify({
  appOwner: 'organization',
  gatewayMethods: { 'Cash on Delivery (COD)': 'cod' },
});

/** The linen shirt of `product-three-variants`. */
const LINEN = 'gid://shopify/Product/2220000081001';
const variantGid = (n: number) => `gid://shopify/ProductVariant/77700000810${n}`;

/** Every log line either process writes while the suite runs. */
const logLines: string[] = [];
const capture: LoggerService = {
  log: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  warn: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  error: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  debug: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
  verbose: (...args: unknown[]) => void logLines.push(args.map(String).join(' ')),
};

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
  subject_label: string | null;
}

interface MappingRow {
  entity: string;
  external_id: string;
  local_id: string | null;
  removed: boolean;
  state: Record<string, unknown>;
}

const restId = (gid: string) => Number(gid.split('/').pop());

describe('Shopify products (spec 0015 task 8)', { timeout: 300_000 }, () => {
  let api: InProcessApi;
  let worker: TestingModule;
  let refusingFetch: typeof fetch;
  /** Every `ChannelProductNeedsAttention` the worker published, as plain objects. */
  const attention: ChannelProductNeedsAttention[] = [];
  const failedEvents: InboundEventFailed[] = [];
  let manager = '';

  /** Plants a Shopify store, its own channel, and an active connection sealed with `SECRET`. */
  const plant = async (options: { productsSwept?: boolean } = {}): Promise<Planted> => {
    const t = randomUUID().slice(0, 8);
    const storeCode = `PR${t.toUpperCase()}`;
    const shopDomain = `productsfx-${t}.myshopify.com`;
    const id = randomUUID();
    const store = await api.owner.pool.query<{ id: string }>(
      `INSERT INTO stores (code, name, public_name, kind)
       VALUES ($1, '{"en":"Products store"}', '{"en":"Products store"}', 'shopify') RETURNING id`,
      [storeCode],
    );
    const storeId = store.rows[0]?.id as string;
    await api.owner.pool.query(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ($1, '{"en":"Products store"}', 'shopify', $2::uuid)`,
      [storeCode, storeId],
    );
    const sealed = api.app
      .get(ConnectionSecrets)
      .seal({ kind: 'client_credentials', clientId: `client-${t}-WXYZ`, clientSecret: SECRET }, id);
    await api.owner.pool.query(
      `INSERT INTO connections (id, provider, label, store_id, status, shop_domain,
                                credentials_ciphertext, credentials_key_version, credentials_hint,
                                credentials_updated_at, config, health, products_swept_through)
       VALUES ($1::uuid, 'shopify', 'Products store', $2::uuid, 'active', $3, $4, $5, 'WXYZ',
               now(), $6::jsonb, 'ok',
               CASE WHEN $7::boolean THEN '2026-11-01T00:00:00Z'::timestamptz END)`,
      [
        id,
        storeId,
        shopDomain,
        sealed.ciphertext,
        sealed.keyVersion,
        CONFIG,
        options.productsSwept ?? false,
      ],
    );
    return { id, shopDomain, storeId };
  };

  /** Sends one signed delivery (a REST shaped body with the gid) and answers its webhook id. */
  const deliver = async (c: Planted, topic: string, gid: string, updatedAt: string | null) => {
    const webhookId = randomUUID();
    const payload =
      updatedAt === null
        ? { id: restId(gid) }
        : { id: restId(gid), admin_graphql_api_id: gid, updated_at: updatedAt, title: 'any' };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
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
    return webhookId;
  };

  /** Delivers and waits until the event left `received`. */
  const arrive = async (c: Planted, topic: string, gid: string, updatedAt: string | null) => {
    const webhookId = await deliver(c, topic, gid, updatedAt);
    return eventually(
      async () => {
        const { rows } = await api.owner.pool.query<EventRow>(
          `SELECT id, status, outcome, failure_code, subject_label FROM inbound_events
           WHERE connection_id = $1::uuid AND dedupe_key = $2`,
          [c.id, webhookId],
        );
        const row = rows[0];
        return row && row.status !== 'received' ? row : undefined;
      },
      { timeoutMs: 60_000, what: `event ${webhookId} to settle` },
    );
  };

  /** The connection's product and variant mappings, by external id. */
  const mappingsOf = async (c: Planted) =>
    (
      await api.owner.pool.query<MappingRow>(
        `SELECT entity, external_id, local_id, removed_at IS NOT NULL AS removed, state
         FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity IN ('product', 'variant')
         ORDER BY entity, external_id`,
        [c.id],
      )
    ).rows;

  const variantRow = async (id: string) =>
    (
      await api.owner.pool.query<{
        sku: string;
        product_id: string;
        weight_grams: number | null;
        price: string | null;
        linked: boolean;
        updated_at: Date;
      }>(
        `SELECT sku, product_id, weight_grams, price::text AS price,
                channel_linked_at IS NOT NULL AS linked, updated_at
         FROM product_variants WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0];

  const styleLinked = async (id: string) =>
    (
      await api.owner.pool.query<{ linked: boolean }>(
        `SELECT channel_linked_at IS NOT NULL AS linked FROM products WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0]?.linked;

  const catalogEntries = async () =>
    Number(
      (
        await api.owner.pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_entries
           WHERE action LIKE 'style.channel_%' OR action LIKE 'sku.channel_%'`,
        )
      ).rows[0]?.n,
    );

  const orderOf = async (c: Planted, gid: string) =>
    (
      await api.owner.pool.query<{ id: string; updated_at: Date }>(
        `SELECT id, updated_at FROM orders WHERE store_id = $1::uuid AND channel_order_ref = $2`,
        [c.storeId, gid],
      )
    ).rows[0];

  const lineVariants = async (orderId: string) =>
    (
      await api.owner.pool.query<{ variant_id: string | null }>(
        `SELECT variant_id FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
        [orderId],
      )
    ).rows.map((row) => row.variant_id);

  const auditActions = async (recordId: string) =>
    (
      await api.owner.pool.query<{ action: string }>(
        `SELECT action FROM audit_entries WHERE record_id = $1::uuid ORDER BY recorded_at, id`,
        [recordId],
      )
    ).rows.map((row) => row.action);

  beforeAll(async () => {
    api = await startInProcessApi();
    api.app.useLogger(capture);
    worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    worker.useLogger(capture);
    const events = worker.get(DomainEvents);
    events.on(
      ChannelProductNeedsAttention,
      (_tx, event) => void attention.push(event),
      'products-e2e',
    );
    events.on(InboundEventFailed, (_tx, event) => void failedEvents.push(event), 'products-e2e');
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
  }, 180_000);

  afterAll(async () => {
    if (refusingFetch) globalThis.fetch = refusingFetch;
    await worker?.close();
    await api?.close();
  });

  it('maps three variants and lists one needs_sku with one ChannelProductNeedsAttention; applying it again changes nothing and publishes nothing; a delete marks the mappings removed and leaves the catalog untouched (AC-16)', async () => {
    useShopifyScenarios('product-three-variants');
    const c = await plant();
    attention.length = 0;

    // 01 and 02: the read back pages the variants (S, M, L, then XL on page 2).
    expect(await arrive(c, 'products/create', LINEN, '2026-11-10T09:00:00Z')).toMatchObject({
      status: 'processed',
      outcome: 'needs_attention',
      subject_label: 'fixture-linen-shirt',
    });
    const first = await mappingsOf(c);
    const product = first.find((row) => row.entity === 'product');
    expect(product).toMatchObject({ external_id: LINEN, removed: false });
    expect(product?.local_id).not.toBeNull();
    const variants = first.filter((row) => row.entity === 'variant');
    expect(variants.map((row) => [row.external_id, row.state['lastOutcome']])).toEqual([
      [variantGid(11), 'created'],
      [variantGid(12), 'created'],
      [variantGid(13), 'created'],
      [variantGid(14), 'needs_sku'],
    ]);
    expect(variants.map((row) => row.local_id === null)).toEqual([false, false, false, true]);
    // Each mapping keeps its inventory item id (the stock push of milestone 3 sets levels on it).
    expect(variants[0]?.state).toMatchObject({
      productId: LINEN,
      inventoryItemId: 'gid://shopify/InventoryItem/77700000810119',
      tracked: true,
    });
    const created = await variantRow(variants[1]?.local_id as string);
    expect(created).toMatchObject({ sku: 'PX-LIN-M', weight_grams: 300, price: '650.00' });
    expect(created?.product_id).toBe(product?.local_id);
    expect(attention).toEqual([
      expect.objectContaining({
        connectionId: c.id,
        externalProductId: LINEN,
        externalVariantId: variantGid(14),
        variantId: null,
        outcome: 'needs_sku',
      }),
    ]);

    // 03 and 04: newer, identical: the catalog answers unchanged, nothing is written or published.
    const entries = await catalogEntries();
    expect(await arrive(c, 'products/update', LINEN, '2026-11-10T10:00:00Z')).toMatchObject({
      status: 'processed',
      outcome: 'needs_attention',
    });
    expect(attention).toHaveLength(1);
    expect(await catalogEntries()).toBe(entries);
    expect((await variantRow(variants[1]?.local_id as string))?.updated_at).toEqual(
      created?.updated_at,
    );
    // The same version again is stale: no read is applied.
    expect(await arrive(c, 'products/update', LINEN, '2026-11-10T10:00:00Z')).toMatchObject({
      status: 'ignored',
      outcome: 'stale',
    });

    // 07: products/delete reads the product back, Shopify has none: every mapping is removed,
    // the catalog keeps its style, variants, and link.
    expect(await arrive(c, 'products/delete', LINEN, null)).toMatchObject({
      status: 'processed',
      outcome: 'product_removed',
    });
    const removed = await mappingsOf(c);
    expect(removed.every((row) => row.removed)).toBe(true);
    expect(removed.map((row) => row.local_id)).toEqual(first.map((row) => row.local_id));
    expect(await catalogEntries()).toBe(entries);
    expect(await styleLinked(product?.local_id as string)).toBe(true);
    expect((await variantRow(variants[0]?.local_id as string))?.linked).toBe(true);
    expect(remainingShopifyExchanges()).toEqual([]);
  });

  it('archiving a connection unlinks only the styles and variants no other active connection maps (AC-16)', async () => {
    useShopifyScenarios('product-three-variants');
    const c = await plant();
    await arrive(c, 'products/create', LINEN, '2026-11-10T09:00:00Z');
    const rows = await mappingsOf(c);
    const style = rows.find((row) => row.entity === 'product')?.local_id as string;
    const ids = rows.filter((row) => row.entity === 'variant').map((row) => row.local_id ?? '');
    const [small = '', medium = '', large = ''] = ids;
    // Another live connection maps the M variant; an archived one maps the L variant.
    const other = await plant();
    const archived = await plant();
    await api.owner.pool.query(`UPDATE connections SET status = 'archived' WHERE id = $1::uuid`, [
      archived.id,
    ]);
    await api.owner.pool.query(
      `INSERT INTO connection_external_ids (connection_id, entity, external_id, local_id)
       VALUES ($1::uuid, 'variant', 'gid://shopify/ProductVariant/1', $2::uuid),
              ($3::uuid, 'variant', 'gid://shopify/ProductVariant/2', $4::uuid)`,
      [other.id, medium, archived.id, large],
    );
    for (const id of [small, medium, large]) expect((await variantRow(id))?.linked).toBe(true);

    const db = worker.get<DatabaseConnection>(DATABASE).db;
    const counts = await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE connections SET status = 'archived' WHERE id = ${c.id}::uuid`);
      return worker.get(ProductUnlink).forConnection(tx, c.id, {
        kind: 'system_job',
        name: 'connectors.archive',
        jobId: randomUUID(),
      });
    });
    expect(counts).toEqual({ styles: 1, variants: 2 });
    expect(await styleLinked(style)).toBe(false);
    expect((await variantRow(small))?.linked).toBe(false);
    expect((await variantRow(medium))?.linked).toBe(true);
    expect((await variantRow(large))?.linked).toBe(false);
    // The mappings stay for history.
    expect(await mappingsOf(c)).toHaveLength(rows.length);
    expect(await auditActions(small)).toContain('sku.channel_unlinked');
  });

  it('marks a variant gone from its product removed and gives it back to the app, keeping the rest (spec 0012 Follow-up)', async () => {
    useShopifyScenarios('product-three-variants');
    const c = await plant();
    await arrive(c, 'products/create', LINEN, '2026-11-10T09:00:00Z');
    resetShopifyScenarios();
    useShopifyScenarios('product-variant-gone');
    const large = (await mappingsOf(c)).find((row) => row.external_id === variantGid(13));
    expect(await arrive(c, 'products/update', LINEN, '2026-11-10T11:00:00Z')).toMatchObject({
      status: 'processed',
    });
    const after = await mappingsOf(c);
    expect(after.filter((row) => row.removed).map((row) => row.external_id)).toEqual([
      variantGid(13),
    ]);
    expect((await variantRow(large?.local_id as string))?.linked).toBe(false);
    const small = after.find((row) => row.external_id === variantGid(11));
    expect((await variantRow(small?.local_id as string))?.linked).toBe(true);
    expect(remainingShopifyExchanges()).toEqual([]);
  });

  it('ignores a gift card as gift_card, making no style (spec 0012 Follow-up)', async () => {
    useShopifyScenarios('product-gift-card');
    const c = await plant();
    expect(
      await arrive(
        c,
        'products/create',
        'gid://shopify/Product/2220000081009',
        '2026-11-10T09:00:00Z',
      ),
    ).toMatchObject({ status: 'ignored', outcome: 'gift_card' });
    expect(await mappingsOf(c)).toEqual([]);
    expect(remainingShopifyExchanges()).toEqual([]);
  });

  it('reads and applies the product of an order line naming an unknown variant first, in the same job, so the order has mapped lines (AC-9, review M8)', async () => {
    useShopifyScenarios('order-product-first');
    const c = await plant({ productsSwept: true });
    const gid = 'gid://shopify/Order/5550000081001';
    expect(await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z')).toMatchObject({
      status: 'processed',
      outcome: null,
    });
    const order = await orderOf(c, gid);
    const mapped = (await mappingsOf(c)).filter((row) => row.entity === 'variant');
    expect(mapped.map((row) => row.external_id)).toEqual([
      'gid://shopify/ProductVariant/7770000081101',
      'gid://shopify/ProductVariant/7770000081102',
    ]);
    // One variant read named the product, one product read mapped both lines.
    expect(await lineVariants(order?.id as string)).toEqual(mapped.map((row) => row.local_id));
    const state = (
      await api.owner.pool.query<{ state: Record<string, unknown> }>(
        `SELECT state FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity = 'order' AND external_id = $2`,
        [c.id, gid],
      )
    ).rows[0]?.state;
    expect(state?.['unmappedLines']).toBeUndefined();
    expect(remainingShopifyExchanges()).toEqual([]);
  });

  it('links a still unmapped line with linkChannelLineVariant when its product maps later, with no edit recorded (AC-9)', async () => {
    useShopifyScenarios('product-late-link');
    // Before the first products backfill: no product read before the order.
    const c = await plant();
    const gid = 'gid://shopify/Order/5550000081002';
    await arrive(c, 'orders/create', gid, '2026-11-02T09:15:04Z');
    const order = await orderOf(c, gid);
    expect(await lineVariants(order?.id as string)).toEqual([null, null]);

    const intake = worker.get(OrderIntake);
    const link = vi.spyOn(intake, 'linkChannelLineVariant');
    const edit = vi.spyOn(intake, 'applyChannelEdit');
    try {
      expect(
        await arrive(
          c,
          'products/create',
          'gid://shopify/Product/2220000081003',
          '2026-11-10T08:30:00Z',
        ),
      ).toMatchObject({ status: 'processed', outcome: null });
      expect(link).toHaveBeenCalledTimes(2);
      expect(edit).not.toHaveBeenCalled();
    } finally {
      link.mockRestore();
      edit.mockRestore();
    }
    const variants = (await mappingsOf(c)).filter((row) => row.entity === 'variant');
    expect(await lineVariants(order?.id as string)).toEqual(variants.map((row) => row.local_id));
    expect(await auditActions(order?.id as string)).not.toContain('order.edited');
    expect((await orderOf(c, gid))?.updated_at).toEqual(order?.updated_at);
    const mapping = (
      await api.owner.pool.query<{ state: Record<string, unknown>; version: Date }>(
        `SELECT state, external_version AS version FROM connection_external_ids
         WHERE connection_id = $1::uuid AND entity = 'order' AND external_id = $2`,
        [c.id, gid],
      )
    ).rows[0];
    expect(mapping?.state['unmappedLines']).toBeUndefined();
    expect(mapping?.version.toISOString()).toBe('2026-11-02T09:15:04.000Z');
    expect(remainingShopifyExchanges()).toEqual([]);
  });

  it('keeps product events and log lines free of a product title, SKU, or secret, and publishes no failure', () => {
    expect(failedEvents).toEqual([]);
    const joined = logLines.join('\n');
    for (const value of ['Fixture Linen Shirt', 'PX-LIN-M', SECRET]) {
      expect(joined).not.toContain(value);
    }
    expect(manager).not.toBe('');
  });
});
