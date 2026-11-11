import { randomUUID } from 'node:crypto';
import { CustomerProfile, CustomerSearchResponse } from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { CUSTOMER_LOCK } from '../src/customers/customer-locks.js';
import { CustomersError } from '../src/customers/customers.errors.js';
import { CustomersService } from '../src/customers/customers.service.js';
import type {
  ChannelCustomerRef,
  FindOrCreateInput,
} from '../src/customers/find-or-create/find-or-create.js';
import {
  createScratchDatabase,
  dropScratchDatabase,
  freePort,
  signInAs,
  start,
  stop,
  waitForHttp,
  type RunningProcess,
} from './support.js';

// Spec 0014 milestone 1 (AC-1 to AC-5, AC-9, AC-16, AC-17): the customers module against
// PostgreSQL as the application role, with the built api serving the two routes.
describe('customers by phone', { timeout: 180_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let app: DatabaseConnection;
  let customers: CustomersService;
  let api: RunningProcess | undefined;
  let base: string;
  let support: string;
  /** Searchers the helper rotates through, so no one person meets the throttle in the other tests. */
  let searchers: string[] = [];
  let nextSearcher = 0;
  let warehouse: string;
  let counter = 0;
  const seen = new Date('2026-11-01T10:00:00.000Z');

  // Planted by the owner: two Shopify stores (one connection each) and a partner channel.
  const issuers = { shopifyA: '', shopifyB: '', partner: '' };

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 4 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    app = createDatabase(appUrl.toString(), { max: 40 });
    customers = new CustomersService(app, new AuditService());

    for (const key of ['shopifyA', 'shopifyB'] as const) {
      counter += 1;
      const store = await owner.pool.query<{ id: string }>(
        `INSERT INTO stores (code, name, public_name, kind)
         VALUES ($1, '{"en":"Store"}', '{"en":"Store"}', 'shopify') RETURNING id`,
        [`CX-${counter}`],
      );
      const connection = await owner.pool.query<{ id: string }>(
        `INSERT INTO connections (provider, label, shop_domain, store_id)
         VALUES ('shopify', 'Shop', $1, $2) RETURNING id`,
        [`cx-${counter}.myshopify.com`, store.rows[0]?.id],
      );
      issuers[key] = connection.rows[0]?.id as string;
    }
    const channel = await owner.pool.query<{ id: string }>(
      `INSERT INTO channels (code, name, kind)
       VALUES ('partner-1', '{"en":"Partner shop"}', 'consignment_partner') RETURNING id`,
    );
    issuers.partner = channel.rows[0]?.id as string;

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    api = start('main.js', {
      PORT: String(port),
      DATABASE_URL: appUrl.toString(),
      PUBLIC_URL: base,
    });
    await waitForHttp(`${base}/api/health`, api);
    support = await signInAs(base, owner.pool, {
      email: 'support@example.com',
      access: { hats: ['support'] },
    });
    searchers = [support];
    for (const index of [2, 3, 4]) {
      searchers.push(
        await signInAs(base, owner.pool, {
          email: `support${index}@example.com`,
          access: { hats: ['support'] },
        }),
      );
    }
    warehouse = await signInAs(base, owner.pool, {
      email: 'warehouse@example.com',
      access: { hats: ['warehouse'] },
    });
  });

  afterAll(async () => {
    await stop(api);
    await app?.pool.end();
    await owner?.pool.end();
    if (scratch) await dropScratchDatabase(scratch.name);
  });

  /** A fresh Egyptian mobile in E.164 form and its kind, never used before. */
  const newPhone = () => {
    counter += 1;
    return { e164: `+2010${String(counter).padStart(8, '0')}`, kind: 'mobile' as const };
  };
  const shopify = (connectionId: string, externalId: string): ChannelCustomerRef => ({
    kind: 'shopify_customer',
    connectionId,
    externalId,
  });
  const link = (input: Partial<FindOrCreateInput>) =>
    app.db.transaction((tx) =>
      customers.findOrCreate(tx, {
        phone: null,
        channelCustomer: null,
        name: null,
        seenAt: seen,
        ...input,
      }),
    );
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await owner.pool.query<{ n: string }>(sql, params)).rows[0]?.n);
  const post = async (cookie: string | undefined, path: string, body: unknown) => {
    const response = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, ...(cookie && { cookie }) },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  const search = async (body: unknown, cookie?: string) => {
    nextSearcher += 1;
    const reply = await post(
      cookie ?? searchers[nextSearcher % searchers.length],
      '/customers/search',
      body,
    );
    return { status: reply.status, body: JSON.parse(reply.text) as unknown, text: reply.text };
  };
  const profile = async (id: string, cookie = support) => {
    const response = await fetch(`${base}/api/customers/${id}`, { headers: { cookie } });
    return { status: response.status, body: (await response.json()) as unknown };
  };

  describe('findOrCreate (AC-1)', () => {
    it('rule e: a new phone and channel id create one customer with the phone as primary', async () => {
      const phone = newPhone();

      const result = await link({
        phone,
        channelCustomer: shopify(issuers.shopifyA, 'e-1'),
        name: 'Rule E',
      });

      expect(result.outcome).toBe('created');
      const id = result.customerId as string;
      const { rows } = await owner.pool.query(
        'SELECT phone_e164, kind, is_primary FROM customer_phones WHERE customer_id = $1',
        [id],
      );
      expect(rows).toEqual([{ phone_e164: phone.e164, kind: 'mobile', is_primary: true }]);
      expect(
        await count('SELECT count(*) n FROM customer_external_ids WHERE customer_id = $1', [id]),
      ).toBe(1);
      expect(
        (await owner.pool.query('SELECT name FROM customers WHERE id = $1', [id])).rows[0],
      ).toEqual({ name: 'Rule E' });
    });

    it('rule a: the phone and the channel id on one customer match, and a replay writes nothing new', async () => {
      const phone = newPhone();
      const channelCustomer = shopify(issuers.shopifyA, 'a-1');
      const first = await link({ phone, channelCustomer });
      const rowsBefore = await count(
        'SELECT (SELECT count(*) FROM customers) + (SELECT count(*) FROM customer_phones) + (SELECT count(*) FROM customer_external_ids) + (SELECT count(*) FROM customer_merge_suggestions) n',
      );

      const replay = await link({ phone, channelCustomer });

      expect(replay).toEqual({ customerId: first.customerId, outcome: 'matched' });
      expect(
        await count(
          'SELECT (SELECT count(*) FROM customers) + (SELECT count(*) FROM customer_phones) + (SELECT count(*) FROM customer_external_ids) + (SELECT count(*) FROM customer_merge_suggestions) n',
        ),
      ).toBe(rowsBefore);
    });

    it('rule b: a known phone with a new channel id keeps the customer and attaches the id (two stores, one customer)', async () => {
      const phone = newPhone();
      const first = await link({ phone, channelCustomer: shopify(issuers.shopifyA, 'b-1') });

      const second = await link({ phone, channelCustomer: shopify(issuers.shopifyB, 'b-2') });

      expect(second).toEqual({ customerId: first.customerId, outcome: 'matched' });
      expect(
        await count('SELECT count(*) n FROM customer_external_ids WHERE customer_id = $1', [
          first.customerId,
        ]),
      ).toBe(2);
    });

    it('rule c: a known channel id with a new phone attaches the phone as not primary', async () => {
      const first = await link({
        phone: newPhone(),
        channelCustomer: shopify(issuers.shopifyA, 'c-1'),
      });
      const another = newPhone();

      const result = await link({
        phone: another,
        channelCustomer: shopify(issuers.shopifyA, 'c-1'),
      });

      expect(result).toEqual({ customerId: first.customerId, outcome: 'matched_by_channel_id' });
      const { rows } = await owner.pool.query(
        'SELECT is_primary FROM customer_phones WHERE phone_e164 = $1 AND customer_id = $2',
        [another.e164, first.customerId],
      );
      expect(rows).toEqual([{ is_primary: false }]);
    });

    it('rule d: both known on two customers answers the phone customer, moves nothing, and opens one suggestion that stays closed once dismissed', async () => {
      const phoneA = newPhone();
      const phoneB = newPhone();
      const a = await link({ phone: phoneA, channelCustomer: shopify(issuers.shopifyA, 'd-1') });
      const b = await link({ phone: phoneB });

      const result = await link({
        phone: phoneB,
        channelCustomer: shopify(issuers.shopifyA, 'd-1'),
      });

      expect(result).toEqual({ customerId: b.customerId, outcome: 'matched_with_conflict' });
      const pair = [a.customerId as string, b.customerId as string].sort();
      const suggestions = () =>
        owner.pool.query(
          `SELECT status, reason, customer_low_id, customer_high_id FROM customer_merge_suggestions
           WHERE customer_low_id = $1 AND customer_high_id = $2`,
          pair,
        );
      expect((await suggestions()).rows).toEqual([
        {
          status: 'open',
          reason: 'channel_id_conflict',
          customer_low_id: pair[0],
          customer_high_id: pair[1],
        },
      ]);
      // Nothing moved: the channel id is still on A, the phone still on B.
      expect(
        await count(
          "SELECT count(*) n FROM customer_external_ids WHERE customer_id = $1 AND external_id = 'd-1'",
          [a.customerId],
        ),
      ).toBe(1);
      expect(
        await count('SELECT count(*) n FROM customer_phones WHERE customer_id = $1', [
          b.customerId,
        ]),
      ).toBe(1);

      // Repeating opens none, and a dismissed pair is never suggested again.
      await link({ phone: phoneB, channelCustomer: shopify(issuers.shopifyA, 'd-1') });
      await owner.pool.query(
        "UPDATE customer_merge_suggestions SET status = 'dismissed', decided_at = now() WHERE customer_low_id = $1 AND customer_high_id = $2",
        pair,
      );
      await link({ phone: phoneB, channelCustomer: shopify(issuers.shopifyA, 'd-1') });
      const after = (await suggestions()).rows;
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ status: 'dismissed' });
    });

    it('rule f: no phone and an unknown or absent channel id answers null and writes nothing', async () => {
      const before = await count('SELECT count(*) n FROM customers');

      const absent = await link({});
      const unknown = await link({ channelCustomer: shopify(issuers.shopifyA, 'f-unknown') });

      expect(absent).toEqual({ customerId: null, outcome: 'no_phone' });
      expect(unknown).toEqual({ customerId: null, outcome: 'no_phone' });
      expect(await count('SELECT count(*) n FROM customers')).toBe(before);
      expect(
        await count("SELECT count(*) n FROM customer_external_ids WHERE external_id = 'f-unknown'"),
      ).toBe(0);
    });

    it('finds a known channel id without a phone as matched_by_channel_id', async () => {
      const first = await link({
        phone: newPhone(),
        channelCustomer: {
          kind: 'partner_reference',
          channelId: issuers.partner,
          externalId: 'p-1',
        },
      });

      const result = await link({
        channelCustomer: {
          kind: 'partner_reference',
          channelId: issuers.partner,
          externalId: 'p-1',
        },
      });

      expect(result).toEqual({ customerId: first.customerId, outcome: 'matched_by_channel_id' });
    });

    it('writes a name only when the customer has none, and moves last seen forward only', async () => {
      const phone = newPhone();
      const first = await link({ phone, name: null, seenAt: new Date('2026-11-02T00:00:00Z') });
      await link({ phone, name: '  First Name ', seenAt: new Date('2026-11-03T00:00:00Z') });
      await link({ phone, name: 'Second Name', seenAt: new Date('2026-11-01T00:00:00Z') });

      const customer = await owner.pool.query('SELECT name FROM customers WHERE id = $1', [
        first.customerId,
      ]);
      const stored = await owner.pool.query<{ last_seen_at: Date; first_seen_at: Date }>(
        'SELECT first_seen_at, last_seen_at FROM customer_phones WHERE phone_e164 = $1',
        [phone.e164],
      );
      expect(customer.rows[0]).toEqual({ name: 'First Name' });
      expect(stored.rows[0]?.last_seen_at.toISOString()).toBe('2026-11-03T00:00:00.000Z');
      // An older order replayed later widens the range backward.
      expect(stored.rows[0]?.first_seen_at.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    });

    it('answers a typed error without the id for an empty channel customer id', async () => {
      const failure = await link({
        phone: newPhone(),
        channelCustomer: shopify(issuers.shopifyA, '   '),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CustomersError);
      expect((failure as CustomersError).code).toBe('INVALID_CHANNEL_CUSTOMER');
    });

    it('resolves a phone held by a merged customer to its survivor', async () => {
      const survivor = await link({ phone: newPhone() });
      const mergedPhone = newPhone();
      const merged = await link({ phone: mergedPhone });
      await owner.pool.query('UPDATE customers SET merged_into_id = $1 WHERE id = $2', [
        survivor.customerId,
        merged.customerId,
      ]);

      const result = await link({
        phone: mergedPhone,
        channelCustomer: shopify(issuers.shopifyB, 'merged-1'),
      });

      expect(result).toEqual({ customerId: survivor.customerId, outcome: 'matched' });
      expect(
        await count('SELECT count(*) n FROM customer_external_ids WHERE customer_id = $1', [
          survivor.customerId,
        ]),
      ).toBe(1);
    });
  });

  describe('concurrency (AC-2)', () => {
    it('twenty parallel calls with one new phone and channel id create one customer, one phone, one channel id', async () => {
      const phone = newPhone();
      const channelCustomer = shopify(issuers.shopifyB, 'parallel-1');

      const results = await Promise.all(
        Array.from({ length: 20 }, () => link({ phone, channelCustomer, name: 'Parallel' })),
      );

      const ids = new Set(results.map((result) => result.customerId));
      expect(ids.size).toBe(1);
      expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1);
      const id = [...ids][0] as string;
      expect(
        await count('SELECT count(*) n FROM customer_phones WHERE phone_e164 = $1', [phone.e164]),
      ).toBe(1);
      expect(
        await count(
          "SELECT count(*) n FROM customer_external_ids WHERE external_id = 'parallel-1'",
        ),
      ).toBe(1);
      expect(await count('SELECT count(*) n FROM customers WHERE id = $1', [id])).toBe(1);
    });

    it('parallel calls with one channel id and five different new phones land on one customer', async () => {
      const phones = Array.from({ length: 5 }, newPhone);
      const channelCustomer = shopify(issuers.shopifyB, 'parallel-2');

      const results = await Promise.all(
        phones.flatMap((phone) => [
          link({ phone, channelCustomer }),
          link({ phone, channelCustomer }),
        ]),
      );

      expect(new Set(results.map((result) => result.customerId)).size).toBe(1);
      expect(
        await count('SELECT count(*) n FROM customer_phones WHERE customer_id = $1', [
          results[0]?.customerId,
        ]),
      ).toBe(5);
    });

    it('lockCustomers takes the customer lock over the whole id set', async () => {
      const survivor = (await link({ phone: newPhone() })).customerId as string;
      const merged = (await link({ phone: newPhone() })).customerId as string;
      await owner.pool.query('UPDATE customers SET merged_into_id = $1 WHERE id = $2', [
        survivor,
        merged,
      ]);
      const prober = await app.pool.connect();
      try {
        await app.db.transaction(async (tx) => {
          await customers.lockCustomers(tx, [survivor]);
          const free = await prober.query<{ free: boolean }>(
            'SELECT pg_try_advisory_xact_lock($1::int, hashtext($2::text)) AS free',
            [CUSTOMER_LOCK, merged],
          );
          expect(free.rows[0]?.free).toBe(false);
        });
      } finally {
        prober.release();
      }
    });
  });

  describe('reads', () => {
    it('resolves a merged id to its survivor in canonicalOf, idsOf, findByPhone and briefs', async () => {
      const survivorPhone = newPhone();
      const mergedPhone = newPhone();
      const survivor = (await link({ phone: survivorPhone, name: 'Survivor' }))
        .customerId as string;
      const merged = (await link({ phone: mergedPhone })).customerId as string;
      await owner.pool.query('UPDATE customers SET merged_into_id = $1 WHERE id = $2', [
        survivor,
        merged,
      ]);

      expect(await customers.canonicalOf(merged)).toBe(survivor);
      expect(await customers.canonicalOf(survivor)).toBe(survivor);
      expect(await customers.canonicalOf(randomUUID())).toBeNull();
      expect(await customers.idsOf(survivor)).toEqual([survivor, merged].sort());
      expect(await customers.idsOf(merged)).toEqual([survivor, merged].sort());
      expect(await customers.findByPhone(mergedPhone)).toBe(survivor);
      expect(await customers.findByPhone(newPhone())).toBeNull();
      const [brief] = await customers.briefs([merged]);
      expect(brief).toMatchObject({
        askedId: merged,
        id: survivor,
        name: 'Survivor',
        primaryPhone: survivorPhone.e164,
        phoneCount: 2,
        flagKind: null,
      });
    });
  });

  describe('POST /api/customers/search (AC-3, AC-5)', () => {
    const forms = [
      '01001234567',
      '00201001234567',
      '+20 100 123 4567',
      '0010 0123 4567',
      '٠١٠٠١٢٣٤٥٦٧',
    ];

    it.each(forms)('finds the same customer for the phone typed as %s', async (typed) => {
      const e164 = '+201001234567';
      const found = await link({ phone: { e164, kind: 'mobile' }, name: 'Phone Forms' });

      const reply = await search({ phone: typed });

      expect(reply.status, reply.text).toBe(200);
      const parsed = CustomerSearchResponse.parse(reply.body);
      expect(parsed.items.map((item) => item.id)).toEqual([found.customerId]);
      expect(parsed.items[0]).toMatchObject({
        primaryPhone: e164,
        name: 'Phone Forms',
        phoneCount: 1,
      });
    });

    it('answers an empty page for a well formed phone nobody holds', async () => {
      const reply = await search({ phone: '01211112222' });

      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ items: [], nextCursor: null });
    });

    it('answers 400 INVALID_PHONE without the typed text', async () => {
      const typed = '0188 777 6655 hello';

      const reply = await search({ phone: typed });

      expect(reply.status).toBe(400);
      expect(reply.body).toMatchObject({ code: 'INVALID_PHONE' });
      expect(reply.text).not.toContain('8777');
      expect(reply.text).not.toContain('hello');
    });

    it('answers 400 INVALID_QUERY unless exactly one of the three is given, and for a bad cursor', async () => {
      for (const body of [
        {},
        { phone: '01001234567', nameContains: 'abcd' },
        { nameContains: 'ab' },
      ]) {
        const reply = await search(body);
        expect(reply.status, JSON.stringify(body)).toBe(400);
        expect(reply.body).toMatchObject({ code: 'INVALID_QUERY' });
      }
      const cursor = await search({ nameContains: 'abc', cursor: 'not-a-cursor!' });
      expect(cursor.status).toBe(400);
      expect(cursor.body).toMatchObject({ code: 'INVALID_CURSOR' });
    });

    it('finds by name fragment, ignoring case, in Arabic and English, matching % and _ literally', async () => {
      await link({ phone: newPhone(), name: 'Nadia Hamdy' });
      await link({ phone: newPhone(), name: 'منى عبد الرحمن' });
      await link({ phone: newPhone(), name: '100% Lamb_da' });

      const english = CustomerSearchResponse.parse(
        (await search({ nameContains: 'ADIA ham' })).body,
      );
      const arabic = CustomerSearchResponse.parse(
        (await search({ nameContains: 'عبد الرحمن' })).body,
      );
      const percent = CustomerSearchResponse.parse(
        (await search({ nameContains: '00% Lam' })).body,
      );
      const underscore = CustomerSearchResponse.parse(
        (await search({ nameContains: 'mb_da' })).body,
      );
      const wild = CustomerSearchResponse.parse((await search({ nameContains: 'N%a' })).body);

      expect(english.items.map((item) => item.name)).toEqual(['Nadia Hamdy']);
      expect(arabic.items.map((item) => item.name)).toEqual(['منى عبد الرحمن']);
      expect(percent.items.map((item) => item.name)).toEqual(['100% Lamb_da']);
      expect(underscore.items).toHaveLength(1);
      expect(wild.items).toEqual([]);
    });

    it('pages a name search by keyset with no row skipped or repeated, and lists canonical customers only', async () => {
      const made: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        made.push(
          (await link({ phone: newPhone(), name: `Pagetest ${String.fromCharCode(97 + index)}` }))
            .customerId as string,
        );
      }
      const absorbed = (await link({ phone: newPhone(), name: 'Pagetest merged' }))
        .customerId as string;
      await owner.pool.query('UPDATE customers SET merged_into_id = $1 WHERE id = $2', [
        made[0],
        absorbed,
      ]);

      const names: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const reply = await search({ nameContains: 'pagetest', limit: 2, cursor });
        const parsed = CustomerSearchResponse.parse(reply.body);
        names.push(...parsed.items.map((item) => item.name as string));
        cursor = parsed.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(names).toEqual(['Pagetest a', 'Pagetest b', 'Pagetest c', 'Pagetest d', 'Pagetest e']);
    });

    it('lists the flagged customers most recently flagged first, by keyset', async () => {
      const flagged: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const id = (await link({ phone: newPhone(), name: `Flagged ${index}` }))
          .customerId as string;
        await owner.pool.query(
          `UPDATE customers SET risk_flag = 'refuser', risk_flag_source = 'blacklist_import',
                  risk_flag_set_at = '2026-10-0${index + 1}T00:00:00Z' WHERE id = $1`,
          [id],
        );
        flagged.push(id);
      }

      const first = CustomerSearchResponse.parse((await search({ flagged: true, limit: 2 })).body);
      const second = CustomerSearchResponse.parse(
        (await search({ flagged: true, limit: 2, cursor: first.nextCursor })).body,
      );

      expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
        [...flagged].reverse(),
      );
      expect(first.items[0]).toMatchObject({ flagKind: 'refuser', flagSource: 'blacklist_import' });
      expect(second.nextCursor).toBeNull();
    });

    it('answers 400 INVALID_CURSOR for a name cursor that names no customer', async () => {
      const unknown = Buffer.from(JSON.stringify([randomUUID()])).toString('base64url');
      const withName = Buffer.from(JSON.stringify(['Pagetest a'])).toString('base64url');

      for (const cursor of [unknown, withName]) {
        const reply = await search({ nameContains: 'pagetest', cursor });
        expect(reply.status).toBe(400);
        expect(reply.body).toMatchObject({ code: 'INVALID_CURSOR' });
      }
    });

    it('refuses the 31st search of one person in a minute with 429 SEARCH_RATE_LIMITED and Retry-After', async () => {
      const heavy = await signInAs(base, owner.pool, {
        email: 'heavy@example.com',
        access: { hats: ['support'] },
      });

      const statuses: number[] = [];
      let last: Response | undefined;
      let lastText = '';
      for (let call = 0; call < 31; call += 1) {
        last = await fetch(`${base}/api/customers/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: base, cookie: heavy },
          body: JSON.stringify({ phone: '01211112222' }),
        });
        statuses.push(last.status);
        lastText = await last.text();
      }

      expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
      expect(statuses[30]).toBe(429);
      expect(JSON.parse(lastText)).toMatchObject({ code: 'SEARCH_RATE_LIMITED' });
      expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
      // Another person is not held back by it.
      expect((await search({ phone: '01211112222' })).status).toBe(200);
    });

    it('answers 403 to a person without customers.view and 401 without a session', async () => {
      const denied = await post(warehouse, '/customers/search', { phone: '01001234567' });
      const anonymous = await post(undefined, '/customers/search', { phone: '01001234567' });

      expect(denied.status).toBe(403);
      expect(JSON.parse(denied.text)).toMatchObject({ code: 'FORBIDDEN' });
      expect(anonymous.status).toBe(401);
    });
  });

  describe('GET /api/customers/:id (AC-4)', () => {
    it('answers the union of phones over all ids, the channel ids with their source, and resolvedFrom for a merged id', async () => {
      const survivorPhone = newPhone();
      const survivor = (
        await link({
          phone: survivorPhone,
          name: 'Profile Person',
          channelCustomer: shopify(issuers.shopifyA, 'profile-1'),
        })
      ).customerId as string;
      const mergedPhone = newPhone();
      const merged = (
        await link({
          phone: mergedPhone,
          channelCustomer: {
            kind: 'partner_reference',
            channelId: issuers.partner,
            externalId: 'pr-1',
          },
        })
      ).customerId as string;
      await owner.pool.query('UPDATE customers SET merged_into_id = $1 WHERE id = $2', [
        survivor,
        merged,
      ]);

      const direct = await profile(survivor);
      const resolved = await profile(merged);

      expect(direct.status).toBe(200);
      const parsed = CustomerProfile.parse(direct.body);
      expect(parsed).toMatchObject({ id: survivor, resolvedFrom: null, name: 'Profile Person' });
      expect(parsed.phones.map((phone) => [phone.e164, phone.isPrimary])).toEqual([
        [survivorPhone.e164, true],
        [mergedPhone.e164, true],
      ]);
      expect(parsed.channelIds.map((id) => id.externalId).sort()).toEqual(['pr-1', 'profile-1']);
      const partner = parsed.channelIds.find((id) => id.externalId === 'pr-1');
      expect(partner).toMatchObject({ channelCode: 'partner-1', kind: 'partner_reference' });
      expect(partner?.channelName).toEqual({ en: 'Partner shop' });
      expect(parsed.flag).toBeNull();
      expect(CustomerProfile.parse(resolved.body)).toMatchObject({
        id: survivor,
        resolvedFrom: merged,
      });
    });

    it('shows the flag of a merged record on the survivor, the most severe first', async () => {
      const survivor = (await link({ phone: newPhone() })).customerId as string;
      for (const kind of ['returner', 'fake']) {
        const id = (await link({ phone: newPhone() })).customerId as string;
        await owner.pool.query(
          `UPDATE customers SET risk_flag = $2, risk_flag_source = 'blacklist_import',
                  risk_flag_set_at = now(), merged_into_id = $3 WHERE id = $1`,
          [id, kind, survivor],
        );
      }

      const parsed = CustomerProfile.parse((await profile(survivor)).body);

      expect(parsed.flag).toMatchObject({
        kind: 'fake',
        source: 'blacklist_import',
        setByName: null,
      });
    });

    it('answers 404 CUSTOMER_NOT_FOUND for an unknown or malformed id and 403 without customers.view', async () => {
      const unknown = await profile(randomUUID());
      const malformed = await profile('not-an-id');
      const known = (await link({ phone: newPhone() })).customerId as string;
      const denied = await profile(known, warehouse);

      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
      expect(malformed.status).toBe(404);
      expect(denied.status).toBe(403);
    });
  });

  describe('caching', () => {
    it('marks the search answer and the profile answer, found or not, Cache-Control no-store', async () => {
      const id = (await link({ phone: newPhone() })).customerId as string;
      const cached = new Set<string | null>();

      const searched = await fetch(`${base}/api/customers/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie: support },
        body: JSON.stringify({ phone: '01211112222' }),
      });
      cached.add(searched.headers.get('cache-control'));
      const profiled = await fetch(`${base}/api/customers/${id}`, { headers: { cookie: support } });
      cached.add(profiled.headers.get('cache-control'));
      const missing = await fetch(`${base}/api/customers/${randomUUID()}`, {
        headers: { cookie: support },
      });
      cached.add(missing.headers.get('cache-control'));

      expect(searched.status).toBe(200);
      expect(profiled.status).toBe(200);
      expect([...cached]).toEqual(['no-store']);
    });
  });

  describe('personal data and logs (AC-17)', () => {
    it('leaves a sentinel phone and name out of the log, the errors, and the answers it should not echo', async () => {
      const phone = { e164: '+201099887766', kind: 'mobile' as const };
      const name = 'Zzsentinel Nameperson';
      const captured: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      const writeErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = (chunk: string | Uint8Array) => (captured.push(String(chunk)), true);
      process.stderr.write = (chunk: string | Uint8Array) => (captured.push(String(chunk)), true);
      let errorText = '';
      try {
        await link({ phone, name, channelCustomer: shopify(issuers.shopifyA, 'sentinel-1') });
        await link({ phone, name });
        await search({ phone: '01099887766' });
        await search({ nameContains: 'Zzsentinel' });
        await search({ phone: '01099887766x' });
        const created = (await customers.findByPhone(phone)) as string;
        await profile(created);
        errorText = await link({
          phone,
          channelCustomer: shopify(issuers.shopifyA, ' '),
        }).then(
          () => '',
          (error: unknown) => String((error as Error).message),
        );
      } finally {
        process.stdout.write = write;
        process.stderr.write = writeErr;
      }

      // The api writes something (its start up lines), so an empty log would not prove anything.
      const apiLog = api?.output() ?? '';
      expect(apiLog.length).toBeGreaterThan(0);
      for (const text of [apiLog, captured.join(''), errorText]) {
        expect(text).not.toContain('1099887766');
        expect(text).not.toContain('Zzsentinel');
      }
    });
  });
});
