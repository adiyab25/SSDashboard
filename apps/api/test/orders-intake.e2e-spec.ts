import { randomUUID } from 'node:crypto';
import {
  ChannelOrderInput,
  ChannelOrderSnapshot,
  CreatedOrder,
  InvalidTransition,
  OrderDetail,
  OrderListResponse,
  SkuDetail,
  replayStates,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OrderIntake,
  type ChannelActor,
  type ChannelCreateActor,
} from '../src/orders/intake/order-intake.service.js';
import { OrderTransactions, type OrderTransaction } from '../src/orders/order-transactions.js';
import {
  InvalidOrderInput,
  LineAlreadyMapped,
  OrderNumberTaken,
  PaymentMethodLocked,
  RelatedOrderState,
  VariantUnknown,
} from '../src/orders/orders.errors.js';
import { OrderAttentionRaised, OrderEdited, OrderPlaced } from '../src/orders/orders.events.js';
import { OrderTransitions } from '../src/orders/transitions/order-transitions.service.js';
import { DomainEvents } from '../src/platform/events/domain-events.js';
import {
  cancelReasonCodeOf,
  firstActiveFulfillmentOf,
  mapShopifyOrder,
  mapShopifyOrderSnapshot,
  replacementInput,
  type ShopifyOrderContext,
} from '../src/connectors/shopify/order-mapper.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { readShopifyOrder } from './shopify-order-reader.js';

const CREATED = 'order-created-cod/01-order-read.json';
const SWAP = 'order-edited-size-swap';
const UNMAPPED = 'order-unmapped-line/01-order-read.json';
const BAD_PHONE = 'order-bad-phone/01-order-read.json';
const PREPAID = 'order-prepaid-gateway/01-order-read.json';
const COD_UNPAID = 'order-prepaid-gateway/02-order-read.json';
const COD_MARKED_PAID = 'order-prepaid-gateway/03-order-read.json';
const CANCELLED_BEFORE = 'order-cancelled-customer/01-order-read.json';
const CANCELLED_AFTER = 'order-cancelled-customer/02-order-read.json';
const COLLISION = 'order-number-collision';
const EXCHANGE_BEFORE = 'order-exchange-added-lines/01-order-read.json';
const EXCHANGE_AFTER = 'order-exchange-added-lines/02-order-read.json';
const GO_LIVE_OPEN = 'order-go-live-import/01-order-read.json';
const GO_LIVE_FULFILLED = 'order-go-live-import/02-order-read.json';
const GO_LIVE_CANCELLED = 'order-go-live-import/03-order-read.json';
const SHOP_ONE = 'fixture-store.myshopify.com';
const SHOP_TWO = 'fixture-store-2.myshopify.com';
/** The go live instant the fixtures assume (fixtures README, `order-go-live-import`). */
const GO_LIVE_AT = '2026-11-01T00:00:00Z';
/** `config.gatewayMethods` of the fixture connection: the fixtures' gateway names. */
const GATEWAY_METHODS: ShopifyOrderContext['gatewayMethods'] = {
  'Cash on Delivery (COD)': 'cod',
  manual: 'cod',
  'Fixture Card Gateway': 'gateway',
};

/** Where an order of one fixture shop goes in the test database. */
interface ShopifyShopContext {
  readonly storeId: string;
  readonly channelId: string;
  readonly connectionId: string;
}

/** Options of a test mapping. */
interface MapOptions {
  /**
   * Appends a random suffix to the channel ref and the order number (a test side tweak of the
   * mapped input), so one fixture can create several orders in one store.
   */
  readonly unique?: boolean;
  /** The connection's go live instant; absent means live. */
  readonly goLiveAt?: string;
}

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

/** The mapped input with a random suffix on its channel ref and order number. */
const withSuffix = (input: ChannelOrderInput): ChannelOrderInput => {
  const suffix = randomSuffix();
  return ChannelOrderInput.parse({
    ...input,
    channelOrderRef: `${input.channelOrderRef}:${suffix}`,
    orderNumber: `${input.orderNumber}-${suffix}`,
  });
};

// Spec 0013 milestone 3 (AC-11, AC-14, AC-15, AC-18, AC-23, AC-25, B1): the in process channel
// calls feature 13 makes, run inside `OrderTransactions.run` as the application role on a scratch
// database. Every input comes from a SYNTHETIC Shopify fixture (apps/api/src/connectors/shopify/
// fixtures, to be replaced by recordings) read by `shopify-order-reader.ts` and mapped by spec
// 0015's real order mapper (`order-mapper.ts`); a case overrides a field of the mapped input only where Shopify
// cannot say it (a prepayment by instapay, the first states of an `import` actor, the MAIN store's
// landing page channel `LP`, which stands in for an internal store's own channel).
// Reservations and the shipment posting are milestones 4 and 5: the closed order import proves
// only that no order holding path and no shipment job runs for it.
describe('orders, milestone 3: the channel intake contract', { timeout: 240_000 }, () => {
  let api: InProcessApi;
  let support = '';
  let mainStore = '';
  let manualChannel = '';
  let lpChannel = '';
  let essStore = '';
  let essChannel = '';
  let connection = '';
  let skuM = '';
  let skuL = '';
  let skuRetired = '';
  let n = 0;
  const edited: OrderEdited[] = [];
  const attentions: OrderAttentionRaised[] = [];
  const placed: OrderPlaced[] = [];

  const job = (): ChannelActor => ({
    type: 'system_job',
    job: 'shopify.intake',
    jobId: randomUUID(),
  });
  const importRun = () => ({ type: 'import' as const, runId: randomUUID() });
  const run = <T>(work: (tx: OrderTransaction) => Promise<T>) =>
    api.app.get(OrderTransactions).run(work);
  const intake = () => api.app.get(OrderIntake);
  /** The error a call rejects with (null when it resolves), caught at once so no rejection dangles. */
  const failureOf = (call: Promise<unknown>): Promise<unknown> =>
    call.then(
      () => null,
      (error: unknown) => error,
    );

  const phone = () => {
    n += 1;
    return `0102${String(1_000_000 + n)}`;
  };

  /**
   * What the mapper needs for one fixture shop: its store, channel, and connection, the variant
   * map, the alt phone attribute, the gateway methods, no gift tags, and the go live instant.
   */
  const contextOf = (
    shopDomain: string,
    shops: Record<string, ShopifyShopContext>,
    goLiveAt: string | null = null,
  ): ShopifyOrderContext => {
    const shop = shops[shopDomain];
    if (!shop) throw new Error(`No store in the test context for shop ${shopDomain}`);
    return {
      ...shop,
      variants: new Map([
        ['gid://shopify/ProductVariant/7770000000101', skuM],
        ['gid://shopify/ProductVariant/7770000000102', skuL],
      ]),
      altPhoneAttribute: 'alt_phone',
      gatewayMethods: GATEWAY_METHODS,
      giftTags: {},
      goLiveAt,
    };
  };
  /** Fixture shop one is ESS (Shopify), shop two is MAIN through its landing page channel. */
  const shopsOf = (): Record<string, ShopifyShopContext> => ({
    [SHOP_ONE]: { storeId: essStore, channelId: essChannel, connectionId: connection },
    [SHOP_TWO]: { storeId: mainStore, channelId: lpChannel, connectionId: connection },
  });
  /** A fixture order mapped to a new order input by the real mapper. */
  const shopifyOrderInput = (
    file: string,
    shops: Record<string, ShopifyShopContext>,
    options: MapOptions = {},
  ): ChannelOrderInput => {
    const { shopDomain, order } = readShopifyOrder(file);
    const { input } = mapShopifyOrder(order, contextOf(shopDomain, shops, options.goLiveAt));
    return options.unique ? withSuffix(input) : input;
  };
  /** A fixture order mapped to a snapshot by the real mapper. */
  const shopifyOrderSnapshot = (
    file: string,
    shops: Record<string, ShopifyShopContext>,
  ): ChannelOrderSnapshot => {
    const { shopDomain, order } = readShopifyOrder(file);
    return mapShopifyOrderSnapshot(order, contextOf(shopDomain, shops)).snapshot;
  };
  /** The go live first states the mapper gives an open order placed before go live. */
  const goLiveStates = () =>
    shopifyOrderInput(GO_LIVE_OPEN, shopsOf(), { goLiveAt: GO_LIVE_AT }).firstStates;
  /** The found first states the mapper gives a closed order placed before go live. */
  const foundStates = (file: string) =>
    shopifyOrderInput(file, shopsOf(), { goLiveAt: GO_LIVE_AT }).firstStates;
  /** The cancel reason code of a fixture order. */
  const cancelReasonOf = (file: string) => cancelReasonCodeOf(readShopifyOrder(file).order);
  /** The time of a fixture order's first active fulfillment, or null. */
  const firstFulfillmentAt = (file: string) =>
    firstActiveFulfillmentOf(readShopifyOrder(file).order)?.createdAt ?? null;
  /**
   * The replacement of an exchange by edit (AC-12): the lines `after` holds that `before` did
   * not, mapped by the real mapper, with a random suffix.
   */
  const replacement = (before: string, after: string, originalOrderId: string, nth: number) => {
    const knownLineIds = new Set(
      readShopifyOrder(before).order.lineItems.nodes.map((line) => line.id),
    );
    const { shopDomain, order } = readShopifyOrder(after);
    const mapped = replacementInput(
      order,
      { originalOrderId, n: nth, knownLineIds },
      contextOf(shopDomain, shopsOf()),
    );
    if (!mapped) throw new Error('The fixture adds no line');
    return withSuffix(mapped.input);
  };
  /** A fixture mapped to an input in ESS, each call a new ref and number, with fields overridden. */
  const fx = (file: string, over: Record<string, unknown> = {}) =>
    ChannelOrderInput.parse({
      ...shopifyOrderInput(file, shopsOf(), { unique: true }),
      ...over,
    });
  /**
   * The same, in the internal MAIN store through its landing page channel (security M2: a channel
   * order never arrives on a manual entry channel), where a person may edit without write back.
   */
  const fxMain = (file: string, over: Record<string, unknown> = {}) =>
    fx(file, { storeId: mainStore, channelId: lpChannel, ...over });
  /** A carrier delivery time for found states past a first cash state. */
  const DELIVERY_AT = '2026-11-01T09:00:00.000Z';
  /** The snapshot a fixture holds, with fields overridden. */
  const snap = (file: string, over: Record<string, unknown> = {}) =>
    ChannelOrderSnapshot.parse({ ...shopifyOrderSnapshot(file, shopsOf()), ...over });

  /** A store, channel, and connection of their own, for a test that needs a clean store. */
  const newShop = async (code: string): Promise<ShopifyShopContext> => {
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    const storeId = await one(
      `INSERT INTO stores (code, name, public_name, kind)
       VALUES ('${code}', '{"en":"${code}"}', '{"en":"${code}"}', 'shopify') RETURNING id`,
    );
    const channelId = await one(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ('${code}', '{"en":"${code}"}', 'shopify', '${storeId}') RETURNING id`,
    );
    const connectionId = await one(
      `INSERT INTO connections (provider, label, store_id, shop_domain)
       VALUES ('shopify', '${code}', '${storeId}', '${code.toLowerCase()}.myshopify.com') RETURNING id`,
    );
    return { storeId, channelId, connectionId };
  };

  const create = async (input: ChannelOrderInput, actor: ChannelCreateActor = job()) =>
    run((tx) => intake().createFromChannel(tx, input, actor));

  const detail = async (id: string) => {
    const reply = await api.call(support, 'GET', `/api/orders/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return OrderDetail.parse(reply.body);
  };

  const owner = <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => api.owner.pool.query<T>(text, params);

  const orderRow = async (id: string) =>
    (
      await owner<{
        customer_id: string | null;
        contact_phone_raw: string | null;
        ship_to_phone: string | null;
        ship_to_phone_alt: string | null;
        prepaid_amount: string;
        updated_at: string;
        confirmed_at: string | null;
        confirmed_by: string | null;
        placed_at: string;
        carrier_delivery_created_at: string | null;
      }>(
        `SELECT customer_id, contact_phone_raw, ship_to_phone, ship_to_phone_alt, prepaid_amount,
                updated_at::text, confirmed_at::text, confirmed_by, placed_at::text,
                carrier_delivery_created_at::text
         FROM orders WHERE id = $1::uuid`,
        [id],
      )
    ).rows[0];

  const eventsOf = async (id: string) =>
    (
      await owner<{
        machine: 'fulfillment' | 'cash';
        from_state: string | null;
        to_state: string;
        actor_type: string;
        reason_code: string | null;
      }>(
        `SELECT machine, from_state, to_state, actor_type, reason_code FROM order_events
         WHERE order_id = $1::uuid ORDER BY recorded_at, id`,
        [id],
      )
    ).rows;

  const auditOf = async (id: string) =>
    (
      await owner<{
        action: string;
        reason: string | null;
        actor_kind: string;
        record_label: string;
        after: Record<string, unknown> | null;
      }>(
        `SELECT action, reason, actor_kind, record_label, after FROM audit_entries
         WHERE record_id = $1::uuid ORDER BY recorded_at, id`,
        [id],
      )
    ).rows;

  const attentionsOf = (id: string) =>
    attentions.filter((a) => a.orderId === id).map((a) => [a.kind, a.sourceType]);

  /** Plants a waiting outbound command on the order, as feature 18's executor will queue one. */
  const openCommand = async (orderId: string) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO outbound_commands (connection_id, kind, linked_type, linked_id, payload, idempotency_key)
         VALUES ($1::uuid, 'shopify.order_edit', 'order', $2::uuid, '{}'::jsonb, $3) RETURNING id`,
        [connection, orderId, `fixture:${randomUUID()}`],
      )
    ).rows[0]?.id as string;

  const recordDelivery = (orderId: string, type: 'carrier_delivery' | 'shopify_fulfillment') =>
    run((tx) =>
      api.app
        .get(OrderTransitions)
        .recordCarrierDelivery(
          tx,
          orderId,
          { at: new Date(), source: { type, id: randomUUID() } },
          job(),
        ),
    );

  beforeAll(async () => {
    api = await startInProcessApi();
    const manager = await api.signIn((await api.addPerson(['manager'])).email);
    support = await api.signIn((await api.addPerson(['support'])).email);
    const one = async (text: string) => (await owner<{ id: string }>(text)).rows[0]?.id as string;
    mainStore = await one(`SELECT id FROM stores WHERE code = 'MAIN'`);
    manualChannel = await one(`SELECT id FROM channels WHERE code = 'manual'`);
    lpChannel = await one(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ('LP', '{"en":"Landing page"}', 'landing_page', '${mainStore}') RETURNING id`,
    );
    essStore = await one(
      `INSERT INTO stores (code, name, public_name, kind)
       VALUES ('ESS', '{"en":"Essentials"}', '{"en":"Essentials"}', 'shopify') RETURNING id`,
    );
    essChannel = await one(
      `INSERT INTO channels (code, name, kind, default_store_id)
       VALUES ('ESS', '{"en":"Essentials"}', 'shopify', '${essStore}') RETURNING id`,
    );
    connection = await one(
      `INSERT INTO connections (provider, label, store_id, shop_domain)
       VALUES ('shopify', 'Essentials', '${essStore}', 'ess.myshopify.com') RETURNING id`,
    );
    const sku = async (code: string) => {
      const reply = await api.call(manager, 'POST', '/api/products', {
        name: { en: `Tee ${code}` },
        variants: [{ sku: code, price: '570.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };
    skuM = await sku('IN-M');
    skuL = await sku('IN-L');
    skuRetired = await sku('IN-OLD');
    await owner(`UPDATE product_variants SET archived_at = now() WHERE id = $1::uuid`, [
      skuRetired,
    ]);
    const events = api.app.get(DomainEvents);
    events.on(OrderEdited, (_tx, event) => void edited.push(event), 'orders-intake-e2e');
    events.on(
      OrderAttentionRaised,
      (_tx, event) => void attentions.push(event),
      'orders-intake-e2e',
    );
    events.on(OrderPlaced, (_tx, event) => void placed.push(event), 'orders-intake-e2e');
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('channel intake (AC-14)', () => {
    it('creates once per channel ref: a repeat answers created false and writes nothing', async () => {
      const input = fx(CREATED);

      const first = await create(input);
      const again = await create(input);
      const page = await detail(first.orderId);
      const row = await orderRow(first.orderId);
      const count = await owner<{ count: string }>(
        `SELECT count(*)::text AS count FROM orders WHERE store_id = $1::uuid AND channel_order_ref = $2`,
        [essStore, input.channelOrderRef],
      );
      const external = await owner<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_external_ids WHERE external_id = $1`,
        [input.channelCustomer?.externalId],
      );

      expect(first.created).toBe(true);
      expect(again).toEqual({ orderId: first.orderId, created: false });
      expect(count.rows[0]?.count).toBe('1');
      expect(page).toMatchObject({
        storeCode: 'ESS',
        orderNumber: input.orderNumber,
        fulfillmentState: 'new',
        cashState: 'unpaid',
        customerNote: 'اتصلوا قبل التوصيل (fixture note)',
        source: {
          capturedFrom: 'shopify_journey',
          utmSource: 'fixture_social',
          utmCampaign: 'fixture_launch',
          discountCode: 'WELCOME10',
        },
      });
      expect(page.customer).not.toBeNull();
      expect(page.money).toMatchObject({
        shippingChargedAmount: '50.00',
        totalAmount: '860.00',
        codExpectedAmount: '860.00',
      });
      expect(page.lines.map((l) => [l.title, l.variantId])).toEqual([
        ['Fixture Basic Tee M', skuM],
        ['Fixture Basic Tee L', skuL],
      ]);
      expect(page.shipTo.name).toBe('مها تجريبية');
      expect(page.shipTo.address).toContain('شارع الاختبار');
      expect(row?.ship_to_phone_alt).toMatch(/1000000102$/);
      expect(external.rows[0]?.count).toBe('1');
      expect(placed.filter((p) => p.orderId === first.orderId)).toHaveLength(1);
      expect(await auditOf(first.orderId)).toEqual([]);
    });

    it('keeps unmapped lines (an unmapped variant, a deleted one) with the channel title', async () => {
      const { orderId } = await create(fx(UNMAPPED));
      const page = await detail(orderId);

      expect(page.lines.map((l) => [l.title, l.variantId])).toEqual([
        ['Fixture Basic Tee M', skuM],
        ['Fixture Basic Tee XL', null],
        ['Fixture Deleted Product', null],
      ]);
      expect(page.money).toMatchObject({ totalAmount: '1060.00' });
    });

    it('keeps an order whose main and second phone do not parse, unlinked, without refusing', async () => {
      const input = fx(BAD_PHONE);

      const { orderId } = await create(input);
      const row = await orderRow(orderId);

      expect(row).toMatchObject({
        customer_id: null,
        ship_to_phone: null,
        contact_phone_raw: '+201300000101',
        ship_to_phone_alt: null,
      });
      expect(attentionsOf(orderId)).toEqual([
        ['phone_unparseable', 'order'],
        ['phone_unparseable', 'ship_to_phone_alt'],
      ]);
    });

    it('applies a snapshot that drops a line and changes a quantity: one cancel, one cancel plus add', async () => {
      const input = fx(CREATED);
      const { orderId } = await create(input);
      const [m] = input.lines;
      const snapshot = snap(CREATED, { lines: [{ ...m, quantity: 2, discountAmount: '90.00' }] });

      const result = await run((tx) => intake().applyChannelEdit(tx, orderId, snapshot, job()));
      const page = await detail(orderId);

      expect(result).toEqual({ applied: true, changed: true });
      expect(
        page.lines.map((x) => [x.position, x.title, x.quantity, x.lineState, x.cancelReasonCode]),
      ).toEqual([
        [1, 'Fixture Basic Tee M', 1, 'cancelled', 'edit_removal'],
        [2, 'Fixture Basic Tee L', 1, 'cancelled', 'edit_removal'],
        [3, 'Fixture Basic Tee M', 2, 'open', null],
      ]);
      expect(page.money).toMatchObject({ totalAmount: '860.00', codExpectedAmount: '860.00' });
      const entries = await auditOf(orderId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'order.edited',
        reason: 'channel_edit',
        actor_kind: 'system_job',
        record_label: `ESS/${input.orderNumber}`,
        after: { origin: 'channel' },
      });
      expect(edited.find((e) => e.orderId === orderId)).toMatchObject({
        origin: 'channel',
        cancelledLineIds: [page.lines[0]?.id, page.lines[1]?.id],
        addedLineIds: [page.lines[2]?.id],
      });
    });

    it('applies a size swap and an address change from Shopify as an edit, and its echoes change nothing', async () => {
      const { orderId } = await create(fx(`${SWAP}/01-order-read.json`));
      const before = await detail(orderId);

      const swapped = await run((tx) =>
        intake().applyChannelEdit(tx, orderId, snap(`${SWAP}/02-order-read.json`), job()),
      );
      const page = await detail(orderId);
      const echoSame = await run((tx) =>
        intake().applyChannelEdit(tx, orderId, snap(`${SWAP}/03-order-read.json`), job()),
      );
      const echoNewer = await run((tx) =>
        intake().applyChannelEdit(tx, orderId, snap(`${SWAP}/04-order-read.json`), job()),
      );

      expect(before.lines.map((x) => x.title)).toEqual([
        'Fixture Basic Tee M',
        'Fixture Basic Tee L',
      ]);
      expect(swapped).toEqual({ applied: true, changed: true });
      expect(page.lines.map((x) => [x.position, x.title, x.lineState, x.cancelReasonCode])).toEqual(
        [
          [1, 'Fixture Basic Tee M', 'cancelled', 'edit_removal'],
          [2, 'Fixture Basic Tee L', 'open', null],
          [3, 'Fixture Basic Tee L', 'open', null],
        ],
      );
      expect(page.shipTo.address).toContain('شارع التعديل');
      expect(page.money).toMatchObject({ totalAmount: '860.00' });
      expect(edited.find((e) => e.orderId === orderId)).toMatchObject({
        addedLineIds: [page.lines[2]?.id],
      });
      expect(echoSame).toEqual({ applied: true, changed: false });
      expect(echoNewer).toEqual({ applied: true, changed: false });
      expect(await auditOf(orderId)).toHaveLength(1);
    });

    it('applies nothing while a write back command is open, raising no attention; applies once it syncs', async () => {
      const { orderId } = await create(fx(CREATED));
      const command = await openCommand(orderId);
      const before = await orderRow(orderId);
      const snapshot = snap(CREATED, { shippingChargedAmount: '70.00' });

      const held = await run((tx) => intake().applyChannelEdit(tx, orderId, snapshot, job()));
      const after = await orderRow(orderId);
      await owner(
        `UPDATE outbound_commands SET sync_state = 'synced', synced_at = now() WHERE id = $1::uuid`,
        [command],
      );
      const applied = await run((tx) => intake().applyChannelEdit(tx, orderId, snapshot, job()));

      expect(held).toEqual({ applied: false, why: 'write_back_open' });
      expect(after?.updated_at).toBe(before?.updated_at);
      expect(attentionsOf(orderId)).toEqual([]);
      expect(applied).toEqual({ applied: true, changed: true });
      expect((await detail(orderId)).money.shippingChargedAmount).toBe('70.00');
    });

    it('matches a line with no channel id by variant, quantity, and price; recordChannelLineIds makes the echo a no change', async () => {
      // A MAIN store channel order with the M line only, so a person may add the L line in the
      // app (no write back). The fixture's own L line stands for what Shopify later reports.
      const full = fxMain(CREATED);
      const [mLine, fixtureL] = full.lines;
      const input = fxMain(CREATED, { lines: [mLine] });
      const { orderId } = await create(input);
      const page = await detail(orderId);
      const add = await api.call(support, 'POST', `/api/orders/${orderId}/edits`, {
        expectedUpdatedAt: page.updatedAt,
        operations: [{ kind: 'add_line', variantId: skuL, quantity: 1, unitPrice: '450.00' }],
      });
      expect(add.status, JSON.stringify(add.body)).toBe(200);
      const added = OrderDetail.parse(add.body).lines.find((x) => x.variantId === skuL)
        ?.id as string;
      const lLine = { ...fixtureL, channelLineId: 'cl-l-matched', discountAmount: '0.00' };

      const matched = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snap(CREATED, { lines: [...input.lines, lLine] }),
          job(),
        ),
      );
      const lines = await owner<{ id: string; channel_line_id: string | null }>(
        `SELECT id, channel_line_id FROM order_lines WHERE order_id = $1::uuid ORDER BY position`,
        [orderId],
      );

      expect(matched).toEqual({ applied: true, changed: false });
      expect(lines.rows).toHaveLength(2);
      expect(lines.rows.find((r) => r.id === added)?.channel_line_id).toBe('cl-l-matched');

      // A second added line, then the executor records its id: the echo changes nothing.
      const page2 = await detail(orderId);
      const add2 = await api.call(support, 'POST', `/api/orders/${orderId}/edits`, {
        expectedUpdatedAt: page2.updatedAt,
        operations: [{ kind: 'add_line', variantId: skuL, quantity: 3, unitPrice: '450.00' }],
      });
      const second = OrderDetail.parse(add2.body).lines.find((x) => x.quantity === 3)?.id as string;
      const recorded = await run((tx) =>
        intake().recordChannelLineIds(
          tx,
          orderId,
          [{ lineId: second, channelLineId: 'cl-l-3' }],
          job(),
        ),
      );
      const echo = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snap(CREATED, {
            lines: [...input.lines, lLine, { ...lLine, channelLineId: 'cl-l-3', quantity: 3 }],
          }),
          job(),
        ),
      );
      const conflict = await failureOf(
        run((tx) =>
          intake().recordChannelLineIds(
            tx,
            orderId,
            [{ lineId: second, channelLineId: 'cl-other' }],
            job(),
          ),
        ),
      );

      expect(recorded).toEqual({ recorded: 1 });
      expect(echo).toEqual({ applied: true, changed: false });
      expect(conflict).toMatchObject({ code: 'ChannelLineIdConflict' });
      expect((await auditOf(orderId)).filter((e) => e.actor_kind === 'system_job')).toEqual([]);
    });

    it('applies nothing once the carrier delivery exists (Shopify fulfillment source), raising channel_edit_not_applied; an echo raises nothing', async () => {
      const input = fx(CREATED);
      const { orderId } = await create(input);

      const delivered = await recordDelivery(orderId, 'shopify_fulfillment');
      const echo = await run((tx) => intake().applyChannelEdit(tx, orderId, snap(CREATED), job()));
      const refused = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snap(CREATED, { lines: [{ ...input.lines[0], quantity: 3 }] }),
          job(),
        ),
      );
      const page = await detail(orderId);

      expect(delivered).toEqual({ applied: true });
      expect(page.carrierDeliveryCreatedAt).not.toBeNull();
      expect(echo).toEqual({ applied: true, changed: false });
      expect(refused).toEqual({ applied: false, why: 'carrier_delivery_exists' });
      expect(attentionsOf(orderId)).toEqual([['channel_edit_not_applied', 'order']]);
      expect(page.lines.every((x) => x.lineState === 'open')).toBe(true);
    });

    it('refuses an overpaying snapshot as an attention, and never changes the prepayment', async () => {
      const prepaid = fx(PREPAID);
      const { orderId } = await create(prepaid);
      // A deposit by instapay is not something the card fixture says: overridden on a cod order.
      const deposit = fx(CREATED, { prepaidAmount: '100.00', prepaidMethod: 'instapay' });
      const second = await create(deposit);

      const overpaid = await run((tx) =>
        intake().applyChannelEdit(tx, orderId, snap(PREPAID, { lines: [prepaid.lines[0]] }), job()),
      );
      const grown = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          second.orderId,
          snap(CREATED, {
            lines: [...deposit.lines, { ...deposit.lines[0], channelLineId: 'cl-extra' }],
          }),
          job(),
        ),
      );

      expect(prepaid).toMatchObject({
        paymentMethod: 'gateway',
        prepaidAmount: '860.00',
        prepaidMethod: 'gateway',
      });
      expect(overpaid).toEqual({ applied: false, why: 'overpaid' });
      expect(attentionsOf(orderId)).toEqual([['channel_edit_not_applied', 'order']]);
      expect(grown).toEqual({ applied: true, changed: true });
      expect((await orderRow(second.orderId))?.prepaid_amount).toBe('100.00');
      expect(
        ChannelOrderSnapshot.safeParse({ ...snap(CREATED), prepaidAmount: '0.00' }).success,
      ).toBe(false);
    });

    it('unlinks the customer when the main phone stops parsing and keeps a valid second phone against bad text (review N4, security L9)', async () => {
      const input = fx(CREATED);
      const { orderId } = await create(input);
      const before = await orderRow(orderId);
      expect(before?.customer_id).not.toBeNull();

      const result = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snap(CREATED, {
            shipTo: { ...input.shipTo, phone: '01x 9999', phoneAlt: 'not a phone' },
          }),
          job(),
        ),
      );
      const row = await orderRow(orderId);

      expect(result).toEqual({ applied: true, changed: true });
      expect(row).toMatchObject({
        customer_id: null,
        ship_to_phone: null,
        contact_phone_raw: '01x 9999',
        ship_to_phone_alt: before?.ship_to_phone_alt,
      });
      expect(row?.ship_to_phone_alt).not.toBeNull();
      expect(attentionsOf(orderId)).toEqual([
        ['phone_unparseable', 'order'],
        ['phone_unparseable', 'ship_to_phone_alt'],
      ]);
      const allText = (
        await owner<{ text: string }>(`SELECT row_to_json(a)::text AS text FROM audit_entries a`)
      ).rows
        .map((r) => r.text)
        .join('\n');
      expect(allText).not.toContain('01x 9999');
      expect(allText).not.toContain('fixture note');
    });

    it('sends a packed order back to confirmed with a system job event', async () => {
      const input = fxMain(CREATED);
      const { orderId } = await create(input);
      for (const what of ['confirm', 'pack']) {
        const { updatedAt } = await detail(orderId);
        const reply = await api.call(
          what === 'pack' ? await api.signIn((await api.addPerson(['warehouse'])).email) : support,
          'POST',
          `/api/orders/${orderId}/${what}`,
          { expectedUpdatedAt: updatedAt },
        );
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      }

      await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snap(CREATED, { shippingChargedAmount: '60.00' }),
          job(),
        ),
      );
      const events = await eventsOf(orderId);

      expect((await detail(orderId)).fulfillmentState).toBe('confirmed');
      expect(events.at(-1)).toMatchObject({
        machine: 'fulfillment',
        from_state: 'packed',
        to_state: 'confirmed',
        actor_type: 'system_job',
        reason_code: 'channel_edit',
      });
    });
  });

  describe('channel cancel (AC-14)', () => {
    it('cancels a confirmed order by system_job with the channel. reason Shopify gave', async () => {
      const { orderId } = await create(fxMain(CANCELLED_BEFORE));
      const { updatedAt } = await detail(orderId);
      await api.call(support, 'POST', `/api/orders/${orderId}/confirm`, {
        expectedUpdatedAt: updatedAt,
      });
      const reason = cancelReasonOf(CANCELLED_BEFORE) as string;

      const result = await run((tx) => intake().cancelFromChannel(tx, orderId, reason, job()));
      const page = await detail(orderId);
      const events = await eventsOf(orderId);

      expect(reason).toBe('channel.customer');
      expect(result).toEqual({ applied: true });
      expect(page).toMatchObject({
        fulfillmentState: 'cancelled',
        cashState: 'nothing_to_collect',
      });
      expect(events.find((e) => e.to_state === 'cancelled')).toMatchObject({
        actor_type: 'system_job',
        reason_code: 'channel.customer',
      });
      const other = await create(fx(CREATED));
      await expect(
        run((tx) => intake().cancelFromChannel(tx, other.orderId, 'customer', job())),
      ).rejects.toBeInstanceOf(InvalidTransition);
    });

    it('changes nothing on an order already returned, and raises channel_cancel_after_pickup on a delivered one', async () => {
      // Returned to origin is not a Shopify fact: the first states are overridden on the fixture.
      const returned = await create(
        fx(CANCELLED_BEFORE, {
          firstStates: { fulfillment: 'returned_to_origin', cash: 'nothing_to_collect' },
        }),
        importRun(),
      );
      // Shopify fulfilled it on 2026-11-03 and the customer cancelled on 2026-11-06; the carrier
      // delivery is the app's own fact, so the first states are overridden too.
      const delivered = await create(
        fx(CANCELLED_AFTER, {
          firstStates: {
            fulfillment: 'delivered',
            cash: 'collected_by_carrier',
            carrierDeliveryCreatedAt: DELIVERY_AT,
          },
        }),
        importRun(),
      );

      const echo = await run((tx) =>
        intake().cancelFromChannel(
          tx,
          returned.orderId,
          cancelReasonOf(CANCELLED_BEFORE) as string,
          job(),
        ),
      );
      const late = await run((tx) =>
        intake().cancelFromChannel(
          tx,
          delivered.orderId,
          cancelReasonOf(CANCELLED_AFTER) as string,
          job(),
        ),
      );

      expect(echo).toEqual({ applied: false, why: 'already_final' });
      expect(attentionsOf(returned.orderId)).toEqual([]);
      expect((await detail(returned.orderId)).fulfillmentState).toBe('returned_to_origin');
      expect(late).toEqual({ applied: false, why: 'after_pickup' });
      expect(attentionsOf(delivered.orderId)).toEqual([['channel_cancel_after_pickup', 'order']]);
      expect((await detail(delivered.orderId)).fulfillmentState).toBe('delivered');
    });
  });

  describe("feature 13's calls (AC-25, AC-23)", () => {
    it('starts a go live import confirmed with one go_live_import event, the first cash event, and no audit entry', async () => {
      const input = fx(GO_LIVE_OPEN, { firstStates: goLiveStates() });

      const { orderId } = await create(input);
      const events = await eventsOf(orderId);
      const row = await orderRow(orderId);

      expect(events).toEqual([
        {
          machine: 'fulfillment',
          from_state: null,
          to_state: 'confirmed',
          actor_type: 'system_job',
          reason_code: 'go_live_import',
        },
        {
          machine: 'cash',
          from_state: null,
          to_state: 'unpaid',
          actor_type: 'system_job',
          reason_code: null,
        },
      ]);
      expect(row?.confirmed_at).toBe(row?.placed_at);
      expect(row?.placed_at).toContain('2026-10-20');
      expect(row?.confirmed_by).toBeNull();
      expect(await auditOf(orderId)).toEqual([]);
      await expect(
        create(fx(GO_LIVE_OPEN, { firstStates: goLiveStates() }), importRun()),
      ).rejects.toBeInstanceOf(InvalidOrderInput);
      await expect(
        create(
          fx(GO_LIVE_OPEN, { firstStates: { fulfillment: 'delivered', cash: 'unpaid' } }),
          job(),
        ),
      ).rejects.toBeInstanceOf(InvalidOrderInput);
    });

    it('links an unmapped line: variant set, no edit, no audit; a mapped line refuses; a delivered order raises shipped_with_unmapped_lines', async () => {
      const unmappedId = 'gid://shopify/LineItem/6660000003002';
      const input = fx(UNMAPPED, { firstStates: goLiveStates() });
      const { orderId } = await create(input);
      const before = await orderRow(orderId);

      const linked = await run((tx) =>
        intake().linkChannelLineVariant(tx, orderId, unmappedId, skuM),
      );
      const again = await failureOf(
        run((tx) => intake().linkChannelLineVariant(tx, orderId, unmappedId, skuL)),
      );
      const shipped = await create(
        fx(UNMAPPED, {
          firstStates: {
            fulfillment: 'delivered',
            cash: 'collected_by_carrier',
            carrierDeliveryCreatedAt: DELIVERY_AT,
          },
        }),
        importRun(),
      );
      const late = await run((tx) =>
        intake().linkChannelLineVariant(tx, shipped.orderId, unmappedId, skuM),
      );

      expect(linked).toMatchObject({ reserved: true });
      expect((await detail(orderId)).lines.map((l) => l.variantId)).toEqual([skuM, skuM, null]);
      expect((await orderRow(orderId))?.updated_at).toBe(before?.updated_at);
      expect(edited.filter((e) => e.orderId === orderId)).toEqual([]);
      expect(await auditOf(orderId)).toEqual([]);
      expect(again).toBeInstanceOf(LineAlreadyMapped);
      expect(late).toMatchObject({ reserved: false });
      expect(attentionsOf(shipped.orderId)).toEqual([
        ['shipped_with_unmapped_lines', 'order_line'],
      ]);
    });

    it('rederives a prepaid gateway order to cod: prepaid to unpaid, COD expected the total, audited; locked after a collection or a delivery', async () => {
      const { orderId } = await create(fx(PREPAID));
      expect((await detail(orderId)).cashState).toBe('prepaid');

      const result = await run((tx) =>
        intake().rederivePaymentMethod(
          tx,
          orderId,
          { paymentMethod: 'cod', prepaidAmount: '0.00', prepaidMethod: null },
          job(),
        ),
      );
      const page = await detail(orderId);
      const events = await eventsOf(orderId);

      expect(result).toEqual({ changed: true });
      expect(page).toMatchObject({ cashState: 'unpaid' });
      expect(page.money).toMatchObject({
        paymentMethod: 'cod',
        prepaidAmount: '0.00',
        prepaidMethod: null,
        codExpectedAmount: '860.00',
        codDueAmount: '860.00',
      });
      expect(events.at(-1)).toMatchObject({
        machine: 'cash',
        from_state: 'prepaid',
        to_state: 'unpaid',
        actor_type: 'system_job',
        reason_code: 'payment_method_rederived',
      });
      expect((await auditOf(orderId)).map((e) => [e.action, e.reason, e.actor_kind])).toEqual([
        ['order.payment_method_rederived', 'gateway_mapping_changed', 'system_job'],
      ]);
      expect(
        replayStates(
          events.map((e) => ({ machine: e.machine, fromState: e.from_state, toState: e.to_state })),
        ),
      ).toEqual({
        fulfillment: 'new',
        cash: 'unpaid',
      });

      // A collection, planted as the owner until milestone 5's recordCollection.
      await owner(`UPDATE orders SET cod_collected_amount = 100 WHERE id = $1::uuid`, [orderId]);
      await expect(
        run((tx) =>
          intake().rederivePaymentMethod(
            tx,
            orderId,
            { paymentMethod: 'gateway', prepaidAmount: '860.00', prepaidMethod: 'gateway' },
            job(),
          ),
        ),
      ).rejects.toBeInstanceOf(PaymentMethodLocked);
      const frozen = await create(fx(CREATED));
      await recordDelivery(frozen.orderId, 'carrier_delivery');
      await expect(
        run((tx) =>
          intake().rederivePaymentMethod(
            tx,
            frozen.orderId,
            { paymentMethod: 'gateway', prepaidAmount: '860.00', prepaidMethod: 'gateway' },
            job(),
          ),
        ),
      ).rejects.toBeInstanceOf(PaymentMethodLocked);
    });

    it('keeps a cod order cod with nothing prepaid after staff marks it paid in Shopify', async () => {
      const unpaid = fx(COD_UNPAID);
      const marked = fx(COD_MARKED_PAID);

      const { orderId } = await create(marked);

      expect([unpaid.paymentMethod, unpaid.prepaidAmount]).toEqual(['cod', '0.00']);
      expect([marked.paymentMethod, marked.prepaidAmount, marked.prepaidMethod]).toEqual([
        'cod',
        '0.00',
        null,
      ]);
      expect(await detail(orderId)).toMatchObject({ cashState: 'unpaid' });
    });

    it('takes replacement_for from the channel for a delivered original, and refuses a confirmed one', async () => {
      // A delivered original is the app's fact (the carrier delivered it), not Shopify's.
      const original = await create(
        fx(EXCHANGE_BEFORE, {
          firstStates: {
            fulfillment: 'delivered',
            cash: 'collected_by_carrier',
            carrierDeliveryCreatedAt: DELIVERY_AT,
          },
        }),
        importRun(),
      );
      const open = await create(fx(EXCHANGE_BEFORE));

      const made = await create(replacement(EXCHANGE_BEFORE, EXCHANGE_AFTER, original.orderId, 1));
      const page = await detail(made.orderId);

      expect(page.type).toBe('exchange_replacement');
      expect(page.relatedOrder).toMatchObject({
        id: original.orderId,
        relation: 'replacement_for',
      });
      expect(page.lines.map((l) => [l.title, l.variantId])).toEqual([
        ['Fixture Basic Tee L', skuL],
      ]);
      expect(page.orderNumber).toContain('#1009-R1');
      await expect(
        create(replacement(EXCHANGE_BEFORE, EXCHANGE_AFTER, open.orderId, 2)),
      ).rejects.toBeInstanceOf(RelatedOrderState);
    });
  });

  describe('closed order import (AC-14; reservations are milestone 4, the shipment job milestone 5)', () => {
    it('creates a delivered and reconciled order in its found states: one event per machine, nothing held, no shipment job', async () => {
      // Delivered and reconciled are the app's facts: the fulfilled go live fixture is overridden.
      const { orderId } = await create(
        fx(GO_LIVE_FULFILLED, {
          firstStates: {
            fulfillment: 'delivered',
            cash: 'reconciled',
            carrierDeliveryCreatedAt: firstFulfillmentAt(GO_LIVE_FULFILLED),
          },
        }),
        importRun(),
      );
      const page = await detail(orderId);
      const events = await eventsOf(orderId);
      const jobs = await owner<{ count: string }>(
        `SELECT count(*)::text AS count FROM pgboss.job WHERE name = 'orders.post_shipment'`,
      );

      expect(events).toEqual([
        {
          machine: 'fulfillment',
          from_state: null,
          to_state: 'delivered',
          actor_type: 'import',
          reason_code: null,
        },
        {
          machine: 'cash',
          from_state: null,
          to_state: 'reconciled',
          actor_type: 'import',
          reason_code: null,
        },
      ]);
      expect(page.lines.map((x) => [x.lineState, x.shortQuantity])).toEqual([['delivered', 0]]);
      expect(page.carrierDeliveryCreatedAt).toBe('2026-10-23T09:00:00.000000Z');
      expect(page.money).toMatchObject({
        codCollectedAmount: '455.00',
        remittedAmount: '455.00',
      });
      expect(jobs.rows[0]?.count).toBe('0');
    });

    it('imports a fulfilled and a cancelled order in the states Shopify says: shipped with the fulfillment time, cancelled with channel.staff', async () => {
      const fulfilled = await create(
        fx(GO_LIVE_FULFILLED, { firstStates: foundStates(GO_LIVE_FULFILLED) }),
        importRun(),
      );
      const cancelled = await create(
        fx(GO_LIVE_CANCELLED, { firstStates: foundStates(GO_LIVE_CANCELLED) }),
        importRun(),
      );

      expect(await eventsOf(fulfilled.orderId)).toMatchObject([
        { machine: 'fulfillment', from_state: null, to_state: 'shipped', actor_type: 'import' },
        { machine: 'cash', from_state: null, to_state: 'unpaid', actor_type: 'import' },
      ]);
      expect((await detail(fulfilled.orderId)).carrierDeliveryCreatedAt).toBe(
        '2026-10-23T09:00:00.000000Z',
      );
      expect(await eventsOf(cancelled.orderId)).toMatchObject([
        {
          machine: 'fulfillment',
          from_state: null,
          to_state: 'cancelled',
          actor_type: 'import',
          reason_code: 'channel.staff',
        },
        { machine: 'cash', to_state: 'nothing_to_collect' },
      ]);
    });

    it('creates a found new order as usual', async () => {
      const { orderId } = await create(
        fx(GO_LIVE_OPEN, { firstStates: { fulfillment: 'new', cash: 'unpaid' } }),
        importRun(),
      );

      expect(await detail(orderId)).toMatchObject({ fulfillmentState: 'new', cashState: 'unpaid' });
      expect((await detail(orderId)).lines.every((x) => x.lineState === 'open')).toBe(true);
    });
  });

  describe('the milestone 3 review fixes', () => {
    it('records a replaced line id on its new line; refuses an id an open line holds and one line named twice (review R1)', async () => {
      // A MAIN store channel order, so a person may replace the M line in the app.
      const input = fxMain(CREATED);
      const { orderId } = await create(input);
      const before = await detail(orderId);
      const [mLine, lLine] = before.lines;
      const mChannelId = input.lines[0]?.channelLineId as string;
      const replace = await api.call(support, 'POST', `/api/orders/${orderId}/edits`, {
        expectedUpdatedAt: before.updatedAt,
        operations: [
          {
            kind: 'replace_line',
            lineId: mLine?.id,
            variantId: skuM,
            quantity: 2,
            unitPrice: '410.00',
          },
          { kind: 'add_line', variantId: skuL, quantity: 3, unitPrice: '450.00' },
        ],
      });
      expect(replace.status, JSON.stringify(replace.body)).toBe(200);
      const replaced = OrderDetail.parse(replace.body).lines;
      const fresh = replaced.find((x) => x.quantity === 2)?.id as string;
      const extra = replaced.find((x) => x.quantity === 3)?.id as string;

      const recorded = await run((tx) =>
        intake().recordChannelLineIds(
          tx,
          orderId,
          [{ lineId: fresh, channelLineId: mChannelId }],
          job(),
        ),
      );
      const heldByOpen = await failureOf(
        run((tx) =>
          intake().recordChannelLineIds(
            tx,
            orderId,
            [{ lineId: extra, channelLineId: mChannelId }],
            job(),
          ),
        ),
      );
      const alreadySet = await failureOf(
        run((tx) =>
          intake().recordChannelLineIds(
            tx,
            orderId,
            [{ lineId: lLine?.id as string, channelLineId: 'cl-new' }],
            job(),
          ),
        ),
      );
      const twice = await failureOf(
        run((tx) =>
          intake().recordChannelLineIds(
            tx,
            orderId,
            [
              { lineId: extra, channelLineId: 'cl-a' },
              { lineId: extra, channelLineId: 'cl-b' },
            ],
            job(),
          ),
        ),
      );
      const lines = await owner<{ id: string; channel_line_id: string | null }>(
        `SELECT id, channel_line_id FROM order_lines WHERE order_id = $1::uuid`,
        [orderId],
      );

      expect(recorded).toEqual({ recorded: 1 });
      expect(lines.rows.find((r) => r.id === fresh)?.channel_line_id).toBe(mChannelId);
      expect(heldByOpen).toMatchObject({ code: 'ChannelLineIdConflict' });
      expect(alreadySet).toMatchObject({ code: 'ChannelLineIdConflict' });
      expect(twice).toMatchObject({ code: 'ChannelLineIdConflict' });
    });

    it('imports found cancelled, refused, collected, and remitted orders through the real insert, with the run on the events (security M1)', async () => {
      const runActor = importRun();
      const cancelled = await create(
        fx(CANCELLED_BEFORE, { firstStates: foundStates(GO_LIVE_CANCELLED) }),
        runActor,
      );
      const refused = await create(
        fx(CREATED, {
          firstStates: {
            fulfillment: 'refused',
            cash: 'nothing_to_collect',
            refusedReasonCode: 'size',
            carrierDeliveryCreatedAt: DELIVERY_AT,
          },
        }),
        importRun(),
      );
      const collected = await create(
        fx(CREATED, {
          firstStates: {
            fulfillment: 'delivered',
            cash: 'collected_by_carrier',
            carrierDeliveryCreatedAt: DELIVERY_AT,
          },
        }),
        importRun(),
      );
      const remitted = await create(
        fx(CREATED, {
          firstStates: {
            fulfillment: 'delivered',
            cash: 'remitted',
            carrierDeliveryCreatedAt: DELIVERY_AT,
          },
        }),
        importRun(),
      );
      const rows = await owner<{
        id: string;
        fulfillment_state: string;
        cash_state: string;
        cancel_reason_code: string | null;
        refused_reason_code: string | null;
        cod_collected_amount: string;
        remitted_amount: string;
        cod_due_amount: string;
      }>(
        `SELECT id, fulfillment_state, cash_state, cancel_reason_code, refused_reason_code,
                cod_collected_amount, remitted_amount, cod_due_amount
         FROM orders WHERE id = ANY($1::uuid[])`,
        [[cancelled.orderId, refused.orderId, collected.orderId, remitted.orderId]],
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      const sources = await owner<{ source_type: string | null; source_id: string | null }>(
        `SELECT source_type, source_id::text FROM order_events WHERE order_id = $1::uuid`,
        [cancelled.orderId],
      );

      expect(byId.get(cancelled.orderId)).toMatchObject({
        fulfillment_state: 'cancelled',
        cash_state: 'nothing_to_collect',
        cancel_reason_code: 'channel.staff',
        cod_due_amount: '0.00',
      });
      expect(byId.get(refused.orderId)).toMatchObject({
        fulfillment_state: 'refused',
        refused_reason_code: 'size',
        cod_due_amount: '0.00',
      });
      expect(byId.get(collected.orderId)).toMatchObject({
        cash_state: 'collected_by_carrier',
        cod_collected_amount: '860.00',
        remitted_amount: '0.00',
      });
      expect(byId.get(remitted.orderId)).toMatchObject({
        cash_state: 'remitted',
        cod_collected_amount: '860.00',
        remitted_amount: '860.00',
      });
      expect(sources.rows).toEqual([
        { source_type: 'import_run', source_id: runActor.runId },
        { source_type: 'import_run', source_id: runActor.runId },
      ]);
    });

    it.each([
      ['a held order already remitted', { fulfillment: 'new', cash: 'remitted' }],
      [
        'a collection without its carrier delivery time',
        { fulfillment: 'delivered', cash: 'collected_by_carrier' },
      ],
      [
        'nothing to collect on a cod order still due',
        { fulfillment: 'new', cash: 'nothing_to_collect' },
      ],
      ['prepaid with no prepayment', { fulfillment: 'confirmed', cash: 'prepaid' }],
    ])('refuses found states that contradict each other: %s', async (_name, firstStates) => {
      const refused = await failureOf(create(fx(CREATED, { firstStates }), importRun()));

      expect(refused).toBeInstanceOf(InvalidOrderInput);
    });

    it('refuses an import run id that is not a uuid', async () => {
      const refused = await failureOf(
        create(fx(CREATED, { firstStates: { fulfillment: 'new', cash: 'unpaid' } }), {
          type: 'import',
          runId: 'run-1',
        }),
      );

      expect(refused).toBeInstanceOf(InvalidOrderInput);
    });

    it('refuses a manual entry channel, a channel of another store, and an SO number on an internal store (security M2)', async () => {
      const manual = await failureOf(create(fxMain(CREATED, { channelId: manualChannel })));
      const foreign = await failureOf(create(fx(CREATED, { storeId: mainStore })));
      const numbered = await failureOf(
        create(fxMain(CREATED, { orderNumber: `SO-${new Date().getFullYear()}-000777` })),
      );
      const shopifyStore = await create(fx(CREATED, { orderNumber: 'SO-2026-000778' }));

      expect(manual).toBeInstanceOf(InvalidOrderInput);
      expect(foreign).toBeInstanceOf(InvalidOrderInput);
      expect(numbered).toBeInstanceOf(InvalidOrderInput);
      expect(shopifyStore.created).toBe(true);
    });

    it('refuses the channel edit, the payment correction, the channel cancel, and the line id record on a manual order (security M2, R2)', async () => {
      const reply = await api.call(support, 'POST', '/api/orders', {
        clientRef: randomUUID(),
        storeId: mainStore,
        channelId: manualChannel,
        shipTo: { name: 'Sentinel Name', phone: phone(), address: 'x' },
        lines: [{ variantId: skuM, quantity: 1, unitPrice: '570.00' }],
        shippingChargedAmount: '50.00',
        paymentMethod: 'cod',
      });
      const orderId = CreatedOrder.parse(reply.body).id;

      const edit = await failureOf(
        run((tx) => intake().applyChannelEdit(tx, orderId, snap(CREATED), job())),
      );
      const payment = await failureOf(
        run((tx) =>
          intake().rederivePaymentMethod(
            tx,
            orderId,
            { paymentMethod: 'gateway', prepaidAmount: '620.00', prepaidMethod: 'gateway' },
            job(),
          ),
        ),
      );

      const cancel = await failureOf(
        run((tx) => intake().cancelFromChannel(tx, orderId, 'channel.customer', job())),
      );
      const lineId = (await detail(orderId)).lines[0]?.id as string;
      const lineIds = await failureOf(
        run((tx) =>
          intake().recordChannelLineIds(tx, orderId, [{ lineId, channelLineId: 'cl-x' }], job()),
        ),
      );

      expect(edit).toBeInstanceOf(InvalidOrderInput);
      expect(payment).toBeInstanceOf(InvalidOrderInput);
      // Security R2: the channel cancel and the line id record take the same guard.
      expect(cancel).toBeInstanceOf(InvalidOrderInput);
      expect(lineIds).toBeInstanceOf(InvalidOrderInput);
      expect((await detail(orderId)).fulfillmentState).toBe('new');
      expect(await auditOf(orderId)).toHaveLength(1);
    });

    it('accepts a retired SKU on a channel order but refuses it as a mapping (security L6)', async () => {
      const retiredLine = { ...fx(UNMAPPED).lines[0], variantId: skuRetired };
      const sold = await create(fx(CREATED, { lines: [retiredLine] }));
      const unmapped = fx(UNMAPPED);
      const { orderId } = await create(unmapped);
      const unmappedId = unmapped.lines.find((l) => l.variantId === null)?.channelLineId as string;

      const mapping = await failureOf(
        run((tx) => intake().linkChannelLineVariant(tx, orderId, unmappedId, skuRetired)),
      );

      expect((await detail(sold.orderId)).lines[0]?.variantId).toBe(skuRetired);
      expect(mapping).toBeInstanceOf(VariantUnknown);
    });

    it('drops a channel customer id whose connection belongs to another store, linking by phone only (security L7)', async () => {
      const other = await newShop('L7S');
      const input = fx(CREATED, {
        channelCustomer: {
          kind: 'shopify_customer',
          connectionId: other.connectionId,
          externalId: `l7-${randomUUID()}`,
        },
      });

      const { orderId } = await create(input);
      const external = await owner<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_external_ids WHERE external_id = $1`,
        [input.channelCustomer?.externalId],
      );

      expect((await orderRow(orderId))?.customer_id).not.toBeNull();
      expect(external.rows[0]?.count).toBe('0');
    });

    it('stores null for a media buyer id from a channel, and prices shipping at the channel rate (review minors 6, 7)', async () => {
      const input = fx(CREATED, {
        source: { capturedFrom: 'shopify_journey', mediaBuyerId: randomUUID() },
        shippingTaxRate: '0.00',
      });

      const { orderId } = await create(input);
      const buyer = await owner<{ source_media_buyer_id: string | null }>(
        `SELECT source_media_buyer_id FROM orders WHERE id = $1::uuid`,
        [orderId],
      );

      expect(buyer.rows[0]?.source_media_buyer_id).toBeNull();
      expect((await detail(orderId)).money.shippingTaxAmount).toBe('0.00');
    });

    it('answers changes_payment, not_editable, and gift_must_stay_free as attentions (review minor 8)', async () => {
      const prepaid = await create(fx(PREPAID));
      const cancelled = await create(fx(CREATED));
      await run((tx) =>
        intake().cancelFromChannel(tx, cancelled.orderId, 'channel.customer', job()),
      );
      const giftLines = fx(CREATED).lines.map((line) => ({
        ...line,
        discountAmount: (Number(line.unitPrice) * line.quantity).toFixed(2),
      }));
      const gift = fx(CREATED, {
        type: 'gifted',
        giftReasonCode: 'influencer',
        shippingChargedAmount: '0.00',
        lines: giftLines,
      });
      const gifted = await create(gift);

      const payment = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          prepaid.orderId,
          snap(PREPAID, {
            lines: [...fx(PREPAID).lines, { ...fx(CREATED).lines[0], channelLineId: 'cl-more' }],
          }),
          job(),
        ),
      );
      const late = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          cancelled.orderId,
          snap(CREATED, { shippingChargedAmount: '99.00' }),
          job(),
        ),
      );
      const free = await run((tx) =>
        intake().applyChannelEdit(
          tx,
          gifted.orderId,
          snap(CREATED, {
            type: 'gifted',
            giftReasonCode: 'influencer',
            shippingChargedAmount: '0.00',
            lines: [...gift.lines, { ...fx(CREATED).lines[0], channelLineId: 'cl-priced' }],
          }),
          job(),
        ),
      );

      expect(payment).toEqual({ applied: false, why: 'changes_payment' });
      expect(late).toEqual({ applied: false, why: 'not_editable' });
      expect(free).toEqual({ applied: false, why: 'gift_must_stay_free' });
      for (const id of [prepaid.orderId, cancelled.orderId, gifted.orderId]) {
        expect(attentionsOf(id)).toContainEqual(['channel_edit_not_applied', 'order']);
      }
    });

    it('keeps the ship to and note of a channel edit out of every audit column (review minor 8)', async () => {
      const input = fx(CREATED);
      const { orderId } = await create(input);
      const sentinel = {
        name: 'Sentinel Channel Name',
        address: '44 Sentinel Channel Road',
        courierNote: 'Sentinel channel courier note',
        note: 'Sentinel channel customer note',
      };

      await run((tx) =>
        intake().applyChannelEdit(
          tx,
          orderId,
          snap(CREATED, {
            customerNote: sentinel.note,
            shipTo: {
              ...input.shipTo,
              name: sentinel.name,
              address: sentinel.address,
              courierNote: sentinel.courierNote,
              phone: '01009997766',
            },
          }),
          job(),
        ),
      );
      const entry = await owner<{ personal_fields: string[]; after: Record<string, unknown> }>(
        `SELECT personal_fields, after FROM audit_entries
         WHERE record_id = $1::uuid AND action = 'order.edited'`,
        [orderId],
      );
      const allText = (
        await owner<{ text: string }>(`SELECT row_to_json(a)::text AS text FROM audit_entries a`)
      ).rows
        .map((r) => r.text)
        .join('\n');

      expect(entry.rows[0]?.after).toMatchObject({
        origin: 'channel',
        shipToName: '[REDACTED]',
        shipToAddress: '[REDACTED]',
        customerNote: '[REDACTED]',
      });
      expect([...(entry.rows[0]?.personal_fields ?? [])].sort()).toEqual(
        expect.arrayContaining([
          'courierNote',
          'customerNote',
          'shipToAddress',
          'shipToName',
          'shipToPhone',
        ]),
      );
      for (const text of Object.values(sentinel)) expect(allText).not.toContain(text);
      expect(allText).not.toContain('+201009997766');
    });

    it('links an unmapped line of a packed order with its reservation seam, and a cancelled line without one (review minor 8)', async () => {
      const unmapped = fxMain(UNMAPPED);
      const unmappedId = unmapped.lines.find((l) => l.variantId === null)?.channelLineId as string;
      const packed = await create(unmapped);
      for (const what of ['confirm', 'pack']) {
        const { updatedAt } = await detail(packed.orderId);
        const reply = await api.call(
          what === 'pack' ? await api.signIn((await api.addPerson(['warehouse'])).email) : support,
          'POST',
          `/api/orders/${packed.orderId}/${what}`,
          { expectedUpdatedAt: updatedAt },
        );
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      }
      const dropped = fx(UNMAPPED);
      const withDropped = await create(dropped);
      await run((tx) =>
        intake().applyChannelEdit(
          tx,
          withDropped.orderId,
          snap(UNMAPPED, {
            lines: dropped.lines.filter((l) => l.channelLineId !== unmappedId),
          }),
          job(),
        ),
      );

      const onPacked = await run((tx) =>
        intake().linkChannelLineVariant(tx, packed.orderId, unmappedId, skuL),
      );
      const onCancelled = await run((tx) =>
        intake().linkChannelLineVariant(tx, withDropped.orderId, unmappedId, skuL),
      );

      expect(onPacked).toMatchObject({ reserved: true });
      expect(onCancelled).toMatchObject({ reserved: false });
      expect(attentionsOf(withDropped.orderId)).toEqual([]);
    });
  });

  describe('B1: the store beside every number (AC-3, AC-14)', () => {
    it('holds #1001 in two stores, finds both, refuses a second #1001 in the first, and labels the audit COLA/#1001', async () => {
      // Two clean stores, one per fixture shop, so the number is the fixture's own `#1001`.
      const ctx = { [SHOP_ONE]: await newShop('COLA'), [SHOP_TWO]: await newShop('COLB') };
      const file = (nn: string) => `${COLLISION}/${nn}-order-read.json`;

      const inA = await create(shopifyOrderInput(file('01'), ctx));
      await create(shopifyOrderInput(file('02'), ctx));
      const list = await api.call(support, 'GET', '/api/orders?q=1001');
      const taken = await failureOf(create(shopifyOrderInput(file('03'), ctx)));
      await run((tx) =>
        intake().applyChannelEdit(
          tx,
          inA.orderId,
          ChannelOrderSnapshot.parse({
            ...shopifyOrderSnapshot(file('01'), ctx),
            shippingChargedAmount: '55.00',
          }),
          job(),
        ),
      );

      expect(list.status).toBe(200);
      expect(
        OrderListResponse.parse(list.body)
          .items.map((item) => `${item.storeCode}/${item.orderNumber}`)
          .filter((label) => label.startsWith('COL'))
          .sort(),
      ).toEqual(['COLA/#1001', 'COLB/#1001']);
      expect(taken).toBeInstanceOf(OrderNumberTaken);
      expect((await auditOf(inA.orderId)).map((e) => e.record_label)).toEqual(['COLA/#1001']);
    });
  });

  it('keeps the manual path unchanged beside the channel one (a smoke check)', async () => {
    const reply = await api.call(support, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: mainStore,
      channelId: manualChannel,
      shipTo: { name: 'Sentinel Name', phone: phone(), address: 'x' },
      lines: [{ variantId: skuM, quantity: 1, unitPrice: '570.00' }],
      shippingChargedAmount: '50.00',
      paymentMethod: 'cod',
    });

    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(CreatedOrder.parse(reply.body).storeCode).toBe('MAIN');
  });
});
