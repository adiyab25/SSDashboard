import { randomUUID } from 'node:crypto';
import { ModulesContainer } from '@nestjs/core';
import { PERSONAL_DATA_KEYS, PERSONAL_DATA_PATHS } from '@ssdashboard/config/redaction';
import {
  COST_FIELD_KEYS,
  CreateStaffResponse,
  MeResponse,
  permissionsFor,
  SkuDetail,
  StockReceiptDetail,
  type Hat,
  type Permission,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MODULE_ROWS } from '../src/platform/modules/module-registry.js';
import { FIXTURE_MODULE_ROWS } from './fixtures/fixture-operations.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { routeCatalog, routesOf, type ControllerClass, type RouteEntry } from './route-catalog.js';

// Spec 0008 milestone 3 item 5 (AC-5, AC-6, AC-8, AC-9): every route of the running app, read from
// its Nest module graph, called as each hat alone. A route answers 403 exactly where the
// permission matrix says (`FORBIDDEN` for a missing permission, `WRONG_AUDIENCE` for the other
// audience) and something else everywhere else (a validation error is fine, a 5xx never is); no
// answer holds a `COST_FIELD_KEYS` field for a person without `cost.view`; and no answer to the
// media buyer or a partner user holds a key of `PERSONAL_DATA_KEYS` or a path of
// `PERSONAL_DATA_PATHS`. A new route without an entry in `FIXTURES` fails the sweep.

/**
 * What a route needs, as spec 0008's route mapping (and the API surface table) names it: its
 * permissions (all required), any hat of the route's audience, or nothing (an open route).
 */
type Needs = readonly Permission[] | 'any_hat' | 'open';

/**
 * How the sweep calls one route: what the spec says it needs, and the concrete path, a body and
 * headers, made fresh per call.
 */
interface Fixture {
  needs: Needs;
  path?: () => string;
  body?: () => unknown;
  headers?: () => Record<string, string>;
}

/** One person of the sweep: exactly these hats (and the cost grant or not), signed in. */
interface Persona {
  name: string;
  hats: Hat[];
  costView: boolean;
  cookie: string;
  permissions: ReadonlySet<Permission>;
  /** The media buyer and the partner user: no answer to them may hold personal data. */
  external: boolean;
}

/**
 * The person's own profile on the who am I routes carries their own `phone` (spec 0005 AC-19:
 * they edit it there). It is not customer data, so these keys are allowed on these routes only.
 */
const OWN_PROFILE_KEYS: Readonly<Record<string, readonly string[]>> = {
  'GET /me': ['phone'],
  'PATCH /me': ['phone'],
  'GET /partner/me': ['phone'],
  'PATCH /partner/me': ['phone'],
};

const normalKey = (key: string): string => key.toLowerCase().replace(/[_\-\s]/g, '');
const PERSONAL_KEYS = new Set(PERSONAL_DATA_KEYS.map(normalKey));
const PERSONAL_PATHS = PERSONAL_DATA_PATHS.map((path) => path.split('.').map(normalKey));

/** Every key path of a JSON answer (array indexes left out), each segment normalized. */
function keyPaths(value: unknown, prefix: string[] = [], out: string[][] = []): string[][] {
  if (Array.isArray(value)) for (const item of value) keyPaths(item, prefix, out);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = [...prefix, normalKey(key)];
      out.push(path);
      keyPaths(child, path, out);
    }
  }
  return out;
}

const endsWith = (path: string[], pattern: string[]): boolean =>
  path.length >= pattern.length &&
  pattern.every(
    (segment, i) => segment === '*' || segment === path[path.length - pattern.length + i],
  );

/** The personal data keys and paths an answer holds, beyond the route's own profile keys. */
function personalDataIn(body: unknown, allowed: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of keyPaths(body)) {
    const last = path.at(-1) ?? '';
    if (PERSONAL_KEYS.has(last) && !allowed.includes(last)) found.add(path.join('.'));
    for (const pattern of PERSONAL_PATHS) {
      if (endsWith(path, pattern)) found.add(path.join('.'));
    }
  }
  return [...found];
}

/**
 * The `COST_FIELD_KEYS` an answer holds, at any depth. A text answer (the CSV export, whose
 * `before` and `after` cells are JSON text) counts a key named anywhere in it, in any spelling
 * `normalKey` treats as the same (security review AS34).
 */
function costKeysIn(body: unknown): string[] {
  if (typeof body === 'string') {
    const text = normalKey(body);
    return COST_FIELD_KEYS.filter((key) => text.includes(normalKey(key)));
  }
  const keys = new Set(keyPaths(body).map((path) => path.at(-1)));
  return COST_FIELD_KEYS.filter((key) => keys.has(normalKey(key)));
}

describe('the route sweep (spec 0008, AC-5, AC-6, AC-8)', { timeout: 300_000 }, () => {
  let api: InProcessApi;
  let routes: RouteEntry[];
  const personas: Persona[] = [];
  let n = 0;
  const unique = (prefix: string) => {
    n += 1;
    return `${prefix}-${n}-${randomUUID().slice(0, 8)}`;
  };

  /** Ids the fixtures name, planted in `beforeAll`. */
  const ids = {
    sku: '',
    skuToDelete: '',
    skuToArchive: '',
    location: '',
    locationToChange: '',
    receipt: '',
    receiptToVoid: '',
    staffTarget: '',
    partnerTarget: '',
    accountA: '',
    accountB: '',
    auditEntry: '',
    auditDay: '',
    customer: '',
    order: '',
    connection: '',
  };
  const STALE = '2000-01-01T00:00:00.000Z';
  const PEOPLE_MANAGE: Needs = ['people.manage'];

  /**
   * One entry per route, keyed `METHOD /path` as the route declares it. A route of the app that is
   * missing here fails the sweep; so does an entry that no route matches.
   */
  const FIXTURES: Readonly<Record<string, Fixture>> = {
    'GET /health': { needs: 'open' },
    'GET /config': { needs: 'open' },
    'GET /me': { needs: 'any_hat' },
    'PATCH /me': { needs: 'any_hat', body: () => ({}) },
    'GET /partner/me': { needs: 'any_hat' },
    'PATCH /partner/me': { needs: 'any_hat', body: () => ({}) },
    'POST /products': {
      needs: ['catalog.edit'],
      body: () => ({
        name: { en: 'Sweep tee' },
        variants: [{ sku: unique('SWEEP'), price: '5.00' }],
      }),
    },
    'GET /skus': { needs: ['stock.view'] },
    'GET /skus/:id': { needs: ['stock.view'], path: () => `/skus/${ids.sku}` },
    'PATCH /skus/:id': {
      needs: ['catalog.edit'],
      path: () => `/skus/${ids.sku}`,
      body: () => ({}),
    },
    'DELETE /skus/:id': { needs: ['catalog.manage'], path: () => `/skus/${ids.skuToDelete}` },
    'GET /skus/:id/usage': { needs: ['stock.view'], path: () => `/skus/${ids.sku}/usage` },
    'PATCH /skus/:id/code': {
      needs: ['catalog.manage'],
      path: () => `/skus/${ids.skuToArchive}/code`,
      body: () => ({}),
    },
    'POST /skus/:id/archive': {
      needs: ['catalog.manage'],
      path: () => `/skus/${ids.skuToArchive}/archive`,
    },
    'POST /skus/:id/unarchive': {
      needs: ['catalog.manage'],
      path: () => `/skus/${ids.skuToArchive}/unarchive`,
    },
    'GET /stock': { needs: ['stock.view'] },
    'GET /skus/:id/stock': { needs: ['stock.view'], path: () => `/skus/${ids.sku}/stock` },
    'GET /skus/:id/movements': { needs: ['stock.view'], path: () => `/skus/${ids.sku}/movements` },
    'POST /customers/search': {
      needs: ['customers.view'],
      body: () => ({ phone: '01001234567' }),
    },
    'GET /customers/:id': { needs: ['customers.view'], path: () => `/customers/${ids.customer}` },
    // Spec 0014 milestone 2: bodies naming unknown ids, so a permitted call answers 404 or 422.
    'POST /customers/merges': {
      needs: ['customers.merge'],
      body: () => ({ survivorId: ids.customer, mergedId: randomUUID() }),
    },
    'POST /customers/merges/:id/undo': {
      needs: ['customers.merge'],
      path: () => `/customers/merges/${randomUUID()}/undo`,
      body: () => ({ reasonCode: 'wrong_merge' }),
    },
    'GET /customers/merge-suggestions': { needs: ['customers.view'] },
    'POST /customers/merge-suggestions/:id/dismiss': {
      needs: ['customers.merge'],
      path: () => `/customers/merge-suggestions/${randomUUID()}/dismiss`,
      body: () => ({}),
    },
    'GET /orders': { needs: ['orders.view'] },
    'POST /orders/search': { needs: ['orders.view'], body: () => ({}) },
    'GET /orders/options': { needs: ['orders.confirm'] },
    'GET /orders/filter-options': { needs: ['orders.view'] },
    'GET /orders/:id': { needs: ['orders.view'], path: () => `/orders/${ids.order}` },
    'POST /orders': { needs: ['orders.confirm'], body: () => ({}) },
    'POST /orders/gifted': { needs: ['orders.gift'], body: () => ({}) },
    // Spec 0013 milestone 2: an empty body is refused with 422 once the permission passes.
    'POST /orders/:id/edits': {
      needs: ['orders.confirm'],
      path: () => `/orders/${ids.order}/edits`,
      body: () => ({}),
    },
    'POST /orders/:id/confirm': {
      needs: ['orders.confirm'],
      path: () => `/orders/${ids.order}/confirm`,
      body: () => ({}),
    },
    'POST /orders/:id/cancel': {
      needs: ['orders.confirm'],
      path: () => `/orders/${ids.order}/cancel`,
      body: () => ({}),
    },
    'POST /orders/:id/pack': {
      needs: ['fulfillment.work'],
      path: () => `/orders/${ids.order}/pack`,
      body: () => ({}),
    },
    'POST /orders/:id/unpack': {
      needs: ['fulfillment.work'],
      path: () => `/orders/${ids.order}/unpack`,
      body: () => ({}),
    },
    'GET /locations': { needs: ['stock.view'] },
    'POST /locations': {
      needs: ['catalog.manage'],
      body: () => ({
        code: unique('sweep').toLowerCase(),
        name: { en: 'Sweep' },
        kind: 'warehouse',
      }),
    },
    'PATCH /locations/:id': {
      needs: ['catalog.manage'],
      path: () => `/locations/${ids.locationToChange}`,
      body: () => ({ name: { en: 'Sweep renamed' } }),
    },
    'POST /locations/:id/archive': {
      needs: ['catalog.manage'],
      path: () => `/locations/${ids.locationToChange}/archive`,
    },
    'POST /locations/:id/unarchive': {
      needs: ['catalog.manage'],
      path: () => `/locations/${ids.locationToChange}/unarchive`,
    },
    'DELETE /locations/:id': {
      needs: ['catalog.manage'],
      path: () => `/locations/${ids.locationToChange}`,
    },
    'POST /stock-receipts': {
      needs: ['stock.receive'],
      body: () => ({
        locationId: ids.location,
        reference: unique('DN'),
        lines: [{ skuId: ids.sku, quantity: 1, unitCost: '3' }],
      }),
      headers: () => ({ 'idempotency-key': randomUUID() }),
    },
    'GET /stock-receipts': { needs: ['stock.view'] },
    'GET /stock-receipts/:id': {
      needs: ['stock.view'],
      path: () => `/stock-receipts/${ids.receipt}`,
    },
    'POST /stock-receipts/:id/void': {
      needs: ['stock.correct'],
      path: () => `/stock-receipts/${ids.receiptToVoid}/void`,
      body: () => ({ reason: 'sweep' }),
    },
    // Spec 0010: the audit trail, `audit.read` and `audit.export` on the manager hat only. The
    // detail and the history read a planted entry whose diff carries cost fields.
    'GET /audit/entries': { needs: ['audit.read'] },
    'GET /audit/entries/:id': {
      needs: ['audit.read'],
      path: () => `/audit/entries/${ids.auditEntry}`,
    },
    'GET /audit/records/:type/:id/entries': {
      needs: ['audit.read'],
      path: () => `/audit/records/stock_receipt/${ids.receipt}/entries`,
    },
    // A POST since security review AS28 (it writes `audit.exported`): the filter stays in the
    // query string, and there is no body. Its CSV answer is text, so the cost check reads it as
    // text (`costKeysIn`, security review AS34).
    'POST /audit/entries/export': {
      needs: ['audit.export'],
      path: () => `/audit/entries/export?dayFrom=${ids.auditDay}&dayTo=${ids.auditDay}`,
    },
    // Spec 0010 AC-14: `audit.undo`. The planted entry is not undoable, so an allowed caller gets
    // 409 NOT_UNDOABLE and nothing changes, however often the sweep calls it.
    'POST /audit/entries/:id/undo': {
      needs: ['audit.undo'],
      path: () => `/audit/entries/${ids.auditEntry}/undo`,
      body: () => ({ reason: 'sweep' }),
    },
    // Spec 0009: the brand's settings, `settings.manage` on the manager hat only. The write is
    // stale on purpose (409 for a manager), so the sweep never changes a setting.
    'GET /settings': { needs: ['settings.manage'] },
    'PUT /settings/:key': {
      needs: ['settings.manage'],
      // A core key (security finding S6): on this unlicensed install an Operations key would answer
      // 409 NOT_LICENSED before the stale check, so the stale write is made on a core one.
      path: () => '/settings/operating_day_cutoff_hour',
      body: () => ({ value: 5, reason: 'sweep', expectedUpdatedAt: STALE }),
    },
    // Spec 0009 milestone 2: the license, `settings.manage`. The upload is not a license, so a
    // manager gets 422 LICENSE_INVALID (`bad_format`): one refused check row, no license, no phase
    // change, however often the sweep calls it.
    // Spec 0009 milestone 3: what runs on this install (any staff hat; the license notices inside
    // only for settings.manage), and the off dialog's impact of the fixture module's toggle (read
    // only: it changes nothing).
    'GET /platform/modules': { needs: 'any_hat' },
    'GET /settings/:key/off-impact': {
      needs: ['settings.manage'],
      path: () => '/settings/module.fixtureops.enabled/off-impact',
    },
    'GET /platform/license': { needs: ['settings.manage'] },
    // Spec 0009 milestone 5: the cost rules (read with cost.view; add with settings.manage and
    // cost.view, both required). The add has no value for a set rule, so a person allowed gets 422
    // SETTING_INVALID and no rule is ever recorded.
    'GET /platform/cost-rules': { needs: ['cost.view'] },
    'POST /platform/cost-rules': {
      needs: ['settings.manage', 'cost.view'],
      body: () => ({
        kind: 'cod_fee_percent',
        status: 'set',
        effectiveFrom: '2026-01-01',
        reason: 'sweep',
      }),
    },
    // The owner type policies, settings.manage. The edit's reason is blank, so a manager gets 422
    // REASON_REQUIRED from the service before any row is read, and no policy ever changes.
    'GET /inventory/owner-policies': { needs: ['settings.manage'] },
    'PUT /inventory/owner-policies/:ownerType': {
      needs: ['settings.manage'],
      path: () => '/inventory/owner-policies/own',
      body: () => ({
        stockOwnedByBrand: true,
        handoverIsSale: false,
        saleRecordedAt: 'at_shipment',
        endCustomerRefundBy: 'brand',
        defectivePieceRefundBy: 'brand',
        taxDocument: 'b2c_electronic_receipt',
        settlementOwnerType: null,
        canSellOnline: true,
        reason: '  ',
        expectedUpdatedAt: STALE,
      }),
    },
    'POST /platform/license': {
      needs: ['settings.manage'],
      body: () => ({ envelope: 'not a license' }),
    },
    // Spec 0015 task 6: the connections, settings.manage. The connect body has a bad shop domain,
    // so a manager gets 422 INVALID_SHOP_DOMAIN and nothing is created; the read names a planted
    // connection (200), and the check an unknown one, so a manager gets 404 and no job is sent.
    'GET /connections': { needs: ['settings.manage'] },
    'POST /connections/shopify': {
      needs: ['settings.manage'],
      body: () => ({
        label: 'Sweep store',
        storeCode: unique('SWC').toUpperCase().slice(0, 32),
        shopDomain: 'not-a-shop.example.com',
        clientId: 'sweep-client',
        clientSecret: 'sweep-secret',
        appOwner: 'organization',
      }),
    },
    'GET /connections/:id': {
      needs: ['settings.manage'],
      path: () => `/connections/${ids.connection}`,
    },
    'POST /connections/:id/check': {
      needs: ['settings.manage'],
      path: () => `/connections/${randomUUID()}/check`,
    },
    // Spec 0015 task 7: the Shopify hook, audience `hook` with no permission (spec 0008 route
    // mapping: "none, proves itself by signature"). A signed in hat without a Shopify signature
    // gets the hook's own empty 401 (AC-4) before any guard, so nobody "reaches" it.
    'POST /hooks/shopify/:connectionId': {
      needs: 'open',
      path: () => `/hooks/shopify/${randomUUID()}`,
      body: () => ({ id: 1 }),
    },
    'GET /staff': { needs: PEOPLE_MANAGE },
    'POST /staff': {
      needs: PEOPLE_MANAGE,
      body: () => ({
        name: 'Sweep Staff',
        email: `${unique('staff')}@example.com`,
        hats: ['support'],
        costView: false,
      }),
    },
    'GET /staff/:id': { needs: PEOPLE_MANAGE, path: () => `/staff/${ids.staffTarget}` },
    'PATCH /staff/:id': {
      needs: PEOPLE_MANAGE,
      path: () => `/staff/${ids.staffTarget}`,
      body: () => ({ name: 'Sweep' }),
    },
    'PUT /staff/:id/access': {
      needs: PEOPLE_MANAGE,
      path: () => `/staff/${ids.staffTarget}/access`,
      body: () => ({ hats: ['support'], costView: false, updatedAt: STALE }),
    },
    'POST /staff/:id/disable': {
      needs: PEOPLE_MANAGE,
      path: () => `/staff/${ids.staffTarget}/disable`,
      body: () => ({}),
    },
    'POST /staff/:id/enable': {
      needs: PEOPLE_MANAGE,
      path: () => `/staff/${ids.staffTarget}/enable`,
    },
    'POST /staff/:id/reset-password': {
      needs: PEOPLE_MANAGE,
      path: () => `/staff/${ids.staffTarget}/reset-password`,
    },
    'POST /staff/:id/resend-invite': {
      needs: PEOPLE_MANAGE,
      path: () => `/staff/${ids.staffTarget}/resend-invite`,
    },
    'POST /staff/:id/reset-two-factor': {
      needs: PEOPLE_MANAGE,
      path: () => `/staff/${ids.staffTarget}/reset-two-factor`,
    },
    'POST /staff/:id/revoke-sessions': {
      needs: PEOPLE_MANAGE,
      path: () => `/staff/${ids.staffTarget}/revoke-sessions`,
    },
    'GET /partner-users': { needs: PEOPLE_MANAGE },
    'GET /partner-users/partner-accounts': { needs: PEOPLE_MANAGE },
    'POST /partner-users': {
      needs: PEOPLE_MANAGE,
      body: () => ({
        name: 'Sweep Partner',
        email: `${unique('partner')}@example.com`,
        partnerAccountId: ids.accountA,
      }),
    },
    'GET /partner-users/:id': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}`,
    },
    'PATCH /partner-users/:id': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}`,
      body: () => ({ name: 'Sweep' }),
    },
    'PUT /partner-users/:id/access': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}/access`,
      body: () => ({ partnerAccountId: ids.accountB, updatedAt: STALE }),
    },
    'POST /partner-users/:id/disable': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}/disable`,
      body: () => ({}),
    },
    'POST /partner-users/:id/enable': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}/enable`,
    },
    'POST /partner-users/:id/reset-password': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}/reset-password`,
    },
    'POST /partner-users/:id/resend-invite': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}/resend-invite`,
    },
    'POST /partner-users/:id/reset-two-factor': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}/reset-two-factor`,
    },
    'POST /partner-users/:id/revoke-sessions': {
      needs: PEOPLE_MANAGE,
      path: () => `/partner-users/${ids.partnerTarget}/revoke-sessions`,
    },
  };

  const keyOf = (route: RouteEntry) => `${route.method} ${route.path}`;

  beforeAll(async () => {
    // The fixture module rows give the off impact route a module toggle to read (no module of
    // today has one); their controllers are not loaded, so the route list is the app's own.
    api = await startInProcessApi((builder) =>
      builder.overrideProvider(MODULE_ROWS).useValue(FIXTURE_MODULE_ROWS),
    );
    // Every route the running app serves, from its own module graph.
    const controllers = [...api.app.get(ModulesContainer).values()].flatMap((module) =>
      [...module.controllers.values()]
        .map((wrapper) => wrapper.metatype)
        .filter((metatype): metatype is ControllerClass => typeof metatype === 'function'),
    );
    routes = controllers.flatMap(routesOf);

    ids.accountA = await api.addParty('SWA');
    ids.accountB = await api.addParty('SWB');
    const add = async (name: string, hats: Hat[], costView = false) => {
      const person = await api.addPerson(hats, { costView });
      personas.push({
        name,
        hats,
        costView,
        cookie: await api.signIn(person.email),
        permissions: new Set(permissionsFor(hats, costView ? ['cost.view'] : [])),
        external: false,
      });
    };
    await add('support', ['support']);
    await add('operations', ['operations']);
    await add('warehouse', ['warehouse']);
    await add('manager without cost', ['manager']);
    await add('manager with cost', ['manager'], true);
    const boss = personas.at(-1) as Persona;

    // The media buyer comes through POST /api/staff, as a manager would make one (item 4).
    const created = await api.call(boss.cookie, 'POST', '/api/staff', {
      name: 'Media Buyer',
      email: 'media.buyer@example.com',
      hats: ['media_buyer'],
      costView: false,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const buyer = CreateStaffResponse.parse(created.body);
    expect(buyer.staff).toMatchObject({ hats: ['media_buyer'], costView: false });
    if (buyer.setup.mode !== 'temporary_password') throw new Error('mail is off here');
    // The sweep is about access, not the first password change: clear it as the person would.
    await api.owner.pool.query('UPDATE users SET must_change_password = false WHERE id = $1', [
      buyer.staff.id,
    ]);
    personas.push({
      name: 'media_buyer',
      hats: ['media_buyer'],
      costView: false,
      cookie: await api.signIn('media.buyer@example.com', buyer.setup.temporaryPassword),
      permissions: new Set(permissionsFor(['media_buyer'], [])),
      external: true,
    });

    const partner = await api.addPerson(['partner'], { partnerAccountId: ids.accountA });
    personas.push({
      name: 'partner',
      hats: ['partner'],
      costView: false,
      cookie: await api.signIn(partner.email),
      permissions: new Set(permissionsFor(['partner'], [])),
      external: true,
    });

    // What the fixtures name, made by the manager with cost so receipts carry costs.
    const location = async () => {
      const reply = await api.call(boss.cookie, 'POST', '/api/locations', {
        code: unique('swl').toLowerCase(),
        name: { en: 'Sweep warehouse' },
        kind: 'warehouse',
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return (reply.body as { id: string }).id;
    };
    const sku = async () => {
      const reply = await api.call(boss.cookie, 'POST', '/api/products', {
        name: { en: 'Sweep product' },
        variants: [{ sku: unique('SWS'), price: '9.99' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body).id;
    };
    const receipt = async () => {
      const reply = await api.call(
        boss.cookie,
        'POST',
        '/api/stock-receipts',
        { locationId: ids.location, lines: [{ skuId: ids.sku, quantity: 4, unitCost: '7' }] },
        { 'idempotency-key': randomUUID() },
      );
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return StockReceiptDetail.parse(reply.body).id;
    };
    ids.location = await location();
    ids.locationToChange = await location();
    ids.sku = await sku();
    ids.skuToDelete = await sku();
    ids.skuToArchive = await sku();
    ids.receipt = await receipt();
    ids.receiptToVoid = await receipt();
    // A customer with a phone, so the customer read answers 200 to everyone the matrix allows.
    const customer = await api.owner.pool.query<{ id: string }>(
      `WITH made AS (INSERT INTO customers (name) VALUES ('Sweep Customer') RETURNING id),
            phone AS (INSERT INTO customer_phones (customer_id, phone_e164, kind, is_primary)
                      SELECT id, '+201001234567', 'mobile', true FROM made)
       SELECT id FROM made`,
    );
    ids.customer = customer.rows[0]?.id ?? '';
    // An order of the planted SKU, so the order read answers 200 to everyone the matrix allows.
    const ownerRows = await api.owner.pool.query<{ store: string; channel: string }>(
      `SELECT (SELECT id FROM stores WHERE code = 'MAIN') AS store,
              (SELECT id FROM channels WHERE code = 'manual') AS channel`,
    );
    const order = await api.call(boss.cookie, 'POST', '/api/orders', {
      clientRef: randomUUID(),
      storeId: ownerRows.rows[0]?.store,
      channelId: ownerRows.rows[0]?.channel,
      shipTo: { name: 'Sweep Buyer', phone: '01001234599', address: '1 Sweep Street' },
      lines: [{ variantId: ids.sku, quantity: 1, unitPrice: '9.99' }],
      shippingChargedAmount: '5.00',
      paymentMethod: 'cod',
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    ids.order = (order.body as { id: string }).id;
    // A Shopify connection with its store, planted as the owner (no credentials, no job), so the
    // connection read answers 200 to a manager.
    const connection = await api.owner.pool.query<{ id: string }>(
      `WITH store AS (INSERT INTO stores (code, name, public_name, kind)
                      VALUES ('SWEEPSHOP', '{"en":"Sweep shop"}', '{"en":"Sweep shop"}', 'shopify')
                      RETURNING id)
       INSERT INTO connections (provider, label, store_id, shop_domain)
       SELECT 'shopify', 'Sweep shop', id, 'sweep-shop.myshopify.com' FROM store RETURNING id`,
    );
    ids.connection = connection.rows[0]?.id ?? '';
    ids.staffTarget = (await api.addPerson(['support'])).id;
    ids.partnerTarget = (await api.addPerson(['partner'], { partnerAccountId: ids.accountA })).id;
    // An entry of the planted receipt whose diff carries cost fields, written as the owner (the
    // registry is not the point here), so the audit reads show whether cost leaves them.
    const planted = await api.owner.pool.query<{ id: string; day: string }>(
      `INSERT INTO audit_entries (correlation_id, actor_kind, actor_ref, action, record_type,
                                  record_id, record_label, before, after)
       VALUES (gen_random_uuid(), 'carrier', 'bosta', 'planted.costed', 'stock_receipt', $1,
               NULL, '{"status":"posted","referenceValue":"28.00"}'::jsonb,
               '{"status":"voided","lines":[{"unitCost":"7.00","quantity":4}]}'::jsonb)
       RETURNING id, to_char(operating_day, 'YYYY-MM-DD') AS day`,
      [ids.receipt],
    );
    ids.auditEntry = planted.rows[0]?.id ?? '';
    ids.auditDay = planted.rows[0]?.day ?? '';
  }, 180_000);

  afterAll(async () => {
    await api?.close();
  });

  it('reads the routes from the running module graph, the same as the declared one, each with a fixture', () => {
    const running = routes.map(keyOf).sort();
    const declared = routeCatalog(AppModule).map(keyOf).sort();

    expect(running).toEqual(declared);
    expect(
      running.filter((key) => !(key in FIXTURES)),
      'routes with no fixture',
    ).toEqual([]);
    expect(
      Object.keys(FIXTURES).filter((key) => !running.includes(key)),
      'fixtures of no route',
    ).toEqual([]);
    expect(running).toEqual(expect.arrayContaining(['GET /partner/me', 'GET /partner-users']));
  });

  it('finds every route declared exactly as the spec maps it', () => {
    const drift = routes.flatMap((route) => {
      const needs = FIXTURES[keyOf(route)]?.needs;
      const declared = route.declarations.map((declaration) =>
        declaration.kind === 'any_hat' ? 'any_hat' : [...declaration.permissions].sort().join('+'),
      );
      const expected =
        needs === undefined || needs === 'open'
          ? []
          : [needs === 'any_hat' ? 'any_hat' : [...needs].sort().join('+')];
      return JSON.stringify(declared) === JSON.stringify(expected)
        ? []
        : [
            `${keyOf(route)}: declares ${JSON.stringify(declared)}, the spec maps ${JSON.stringify(expected)}`,
          ];
    });

    expect(drift, drift.join('\n')).toEqual([]);
  });

  it('calls every route as each hat alone: 403 exactly where the matrix says, no cost without cost.view, no personal data to an external hat', async () => {
    const problems: string[] = [];
    /** The routes each persona reached (anything but 403). */
    const reached = new Map<string, string[]>();
    const costSeenBy = new Map<string, Set<string>>();

    for (const route of routes) {
      const key = keyOf(route);
      const fixture: Fixture = FIXTURES[key] ?? { needs: 'open' };
      for (const persona of personas) {
        const reply = await api.call(
          persona.cookie,
          route.method,
          `/api${fixture.path?.() ?? route.path}`,
          fixture.body?.(),
          fixture.headers?.(),
        );
        const where = `${persona.name} ${key} -> ${reply.status} ${JSON.stringify(reply.body).slice(0, 200)}`;
        const code = (reply.body as { code?: unknown } | null)?.code;
        const personaAudience = persona.hats.includes('partner') ? 'partner' : 'staff';

        // What the spec says, never what the code declares: a route whose declaration drifted
        // from the mapping fails here too, not only in `permission.spec.ts`.
        let denied: string | undefined;
        if (route.audience === 'hook') {
          // A hook proves itself by signature only (spec 0015 AC-4): without one, the same empty
          // 401 for every caller, a session cookie or not.
          if (reply.status !== 401 || reply.body !== null) {
            problems.push(`expected an empty 401 from a hook: ${where}`);
          }
          continue;
        }
        if (route.audience === 'portal') denied = 'WRONG_AUDIENCE';
        else if (route.audience === 'staff' || route.audience === 'partner') {
          if (route.audience !== personaAudience) denied = 'WRONG_AUDIENCE';
          else if (
            typeof fixture.needs !== 'string' &&
            !fixture.needs.every((permission) => persona.permissions.has(permission))
          ) {
            denied = 'FORBIDDEN';
          }
        }

        if (reply.status >= 500) problems.push(`server error: ${where}`);
        if (denied !== undefined && (reply.status !== 403 || code !== denied)) {
          problems.push(`expected 403 ${denied}: ${where}`);
        }
        if (denied === undefined && reply.status === 403) problems.push(`unexpected 403: ${where}`);
        // A persona the matrix allows must get a real answer on a read, so the cost and personal
        // data checks below look at a body and never at an error (a fixture that 404s is wrong).
        if (
          denied === undefined &&
          route.method === 'GET' &&
          (reply.status < 200 || reply.status >= 300)
        ) {
          problems.push(`an allowed GET did not answer 2xx: ${where}`);
        }
        if (reply.status !== 403)
          reached.set(persona.name, [...(reached.get(persona.name) ?? []), key]);

        const cost = costKeysIn(reply.body);
        if (cost.length > 0) {
          if (!persona.permissions.has('cost.view')) {
            problems.push(`cost field ${cost.join(', ')} without cost.view: ${where}`);
          }
          costSeenBy.set(persona.name, new Set([...(costSeenBy.get(persona.name) ?? []), key]));
        }
        if (persona.external) {
          const personal = personalDataIn(reply.body, OWN_PROFILE_KEYS[key] ?? []);
          if (personal.length > 0) {
            problems.push(`personal data ${personal.join(', ')} to an external hat: ${where}`);
          }
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
    // The media buyer reaches only the who am I routes, what runs on the install (any staff hat,
    // spec 0009 AC-26, no license notice), and the open ones today (no campaigns.view route exists
    // yet), and the partner user only the partner who am I routes and the open ones.
    expect(reached.get('media_buyer')?.sort()).toEqual(
      ['GET /config', 'GET /health', 'GET /me', 'PATCH /me', 'GET /platform/modules'].sort(),
    );
    expect(reached.get('partner')?.sort()).toEqual(
      ['GET /config', 'GET /health', 'GET /partner/me', 'PATCH /partner/me'].sort(),
    );
    // The cost check bites: the manager with the grant does see cost where it exists.
    expect([...(costSeenBy.get('manager with cost') ?? [])]).toEqual(
      expect.arrayContaining([
        'GET /stock-receipts/:id',
        'GET /stock',
        'GET /skus/:id/stock',
        'GET /skus/:id/movements',
        'GET /audit/entries/:id',
        'GET /audit/records/:type/:id/entries',
        'POST /audit/entries/export',
      ]),
    );
  });

  it('can fail: the personal data check finds a customer name and a phone, and lets only the own profile phone through', async () => {
    expect(personalDataIn({ customer: { name: 'x' }, phone: '1' }, []).sort()).toEqual([
      'customer.name',
      'phone',
    ]);
    expect(personalDataIn({ phone: '1' }, OWN_PROFILE_KEYS['GET /me'] ?? [])).toEqual([]);
    const buyer = personas.find((persona) => persona.name === 'media_buyer') as Persona;

    const me = (await api.call(buyer.cookie, 'GET', '/api/me')).body;

    // The media buyer's own answer does hold a `phone` key, and only the allow list lets it by.
    expect(personalDataIn(me, [])).toContain('phone');
    expect(personalDataIn(me, OWN_PROFILE_KEYS['GET /me'] ?? [])).toEqual([]);
  });

  it('answers the media buyer’s who am I with campaigns.view alone and no partner account (AC-8)', async () => {
    const buyer = personas.find((persona) => persona.name === 'media_buyer') as Persona;

    const me = MeResponse.parse((await api.call(buyer.cookie, 'GET', '/api/me')).body);

    expect(me).toMatchObject({
      hats: ['media_buyer'],
      permissions: ['campaigns.view'],
      partnerAccountId: null,
      home: 'backoffice',
    });
  });
});
