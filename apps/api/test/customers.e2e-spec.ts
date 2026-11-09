import { randomUUID } from 'node:crypto';
import {
  CustomerProfile,
  CustomerSearchResponse,
  CustomerSetFlagResponse,
} from '@ssdashboard/contracts';
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
// PostgreSQL as the application role, with the built api serving the routes; milestone 3 adds the
// flag (AC-11, AC-12) and its note to the log sentinel.
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

  describe('the flag (AC-11, AC-12)', () => {
    const send = async (method: 'PUT' | 'POST', path: string, body: unknown, cookie = support) => {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', origin: base, cookie },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, text, body: (text ? JSON.parse(text) : null) as unknown };
    };
    const setFlag = (id: string, body: unknown, cookie = support) =>
      send('PUT', `/customers/${id}/flag`, body, cookie);
    const clearFlag = (id: string, body: unknown, cookie = support) =>
      send('POST', `/customers/${id}/flag/clear`, body, cookie);
    const stampOf = async (id: string) => CustomerProfile.parse((await profile(id)).body).updatedAt;
    const importFlag = (id: string, kind: 'returner' | 'refuser' | 'fake' | 'abusive') =>
      app.db.transaction((tx) => customers.setFlagFromImport(tx, id, kind, randomUUID()));
    const row = async (id: string) =>
      (
        await owner.pool.query<{
          risk_flag: string | null;
          risk_flag_source: string | null;
          risk_flag_note: string | null;
          risk_flag_set_by: string | null;
          set: boolean;
        }>(
          `SELECT risk_flag, risk_flag_source, risk_flag_note, risk_flag_set_by,
                  risk_flag_set_at IS NOT NULL AS set
           FROM customers WHERE id = $1`,
          [id],
        )
      ).rows[0];

    it('sets refuser with a note as a manual flag by the person, shows it, then clears it with flag_mistaken', async () => {
      const id = (await link({ phone: newPhone() })).customerId as string;

      const set = await setFlag(id.toUpperCase(), {
        kind: 'refuser',
        note: '  Refused twice at the door  ',
        reasonCode: 'repeated_refusals',
        expectedUpdatedAt: await stampOf(id),
      });

      expect(set.status).toBe(200);
      const answer = CustomerSetFlagResponse.parse(set.body);
      expect(answer.flag).toMatchObject({
        kind: 'refuser',
        source: 'manual',
        note: 'Refused twice at the door',
      });
      expect(answer.flag.setByName).not.toBeNull();
      const shown = CustomerProfile.parse((await profile(id)).body);
      expect(shown.flag).toEqual(answer.flag);
      expect(shown.updatedAt).toBe(answer.updatedAt);
      expect(await row(id)).toMatchObject({ risk_flag_source: 'manual', set: true });
      expect((await row(id))?.risk_flag_set_by).not.toBeNull();
      const listed = await search({ phone: shown.phones[0]?.e164 });
      expect(CustomerSearchResponse.parse(listed.body).items[0]).toMatchObject({
        flagKind: 'refuser',
        flagSource: 'manual',
      });

      const cleared = await clearFlag(id, {
        reasonCode: 'flag_mistaken',
        expectedUpdatedAt: answer.updatedAt,
      });

      expect(cleared.status).toBe(204);
      expect(CustomerProfile.parse((await profile(id)).body).flag).toBeNull();
      expect(await row(id)).toEqual({
        risk_flag: null,
        risk_flag_source: null,
        risk_flag_note: null,
        risk_flag_set_by: null,
        set: false,
      });
    });

    it('answers 409 STALE_RECORD for an old stamp and 409 NOT_FLAGGED for a customer with no flag', async () => {
      const id = (await link({ phone: newPhone() })).customerId as string;
      const old = await stampOf(id);
      const first = await setFlag(id, { kind: 'returner', expectedUpdatedAt: old });
      expect(first.status).toBe(200);

      const again = await setFlag(id, { kind: 'fake', expectedUpdatedAt: old });
      const clearOld = await clearFlag(id, { reasonCode: 'policy_review', expectedUpdatedAt: old });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'STALE_RECORD' });
      expect(clearOld.status).toBe(409);
      expect(clearOld.body).toMatchObject({ code: 'STALE_RECORD' });

      const fresh = await stampOf(id);
      expect(
        (await clearFlag(id, { reasonCode: 'policy_review', expectedUpdatedAt: fresh })).status,
      ).toBe(204);
      const none = await clearFlag(id, {
        reasonCode: 'policy_review',
        expectedUpdatedAt: await stampOf(id),
      });
      expect(none.status).toBe(409);
      expect(none.body).toMatchObject({ code: 'NOT_FLAGGED' });
    });

    it('refuses a set on a merged id with 409 CUSTOMER_MERGED, an unknown id with 404, a long note with 422 NOTE_TOO_LONG, and a missing clear reason with 422 REASON_REQUIRED', async () => {
      const survivor = (await link({ phone: newPhone() })).customerId as string;
      const merged = (await link({ phone: newPhone() })).customerId as string;
      await owner.pool.query(`UPDATE customers SET merged_into_id = $2 WHERE id = $1`, [
        merged,
        survivor,
      ]);
      const stamp = await stampOf(survivor);

      const onMerged = await setFlag(merged, { kind: 'fake', expectedUpdatedAt: stamp });
      const unknown = await setFlag(randomUUID(), { kind: 'fake', expectedUpdatedAt: stamp });
      const long = await setFlag(survivor, {
        kind: 'fake',
        note: 'Zzlongnote'.repeat(51),
        expectedUpdatedAt: stamp,
      });
      const noReason = await clearFlag(survivor, { expectedUpdatedAt: stamp });

      expect(onMerged.status).toBe(409);
      expect(onMerged.body).toMatchObject({ code: 'CUSTOMER_MERGED' });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
      expect(long.status).toBe(422);
      expect(long.body).toMatchObject({ code: 'NOTE_TOO_LONG' });
      expect(long.text).not.toContain('Zzlongnote');
      expect(noReason.status).toBe(422);
      expect(noReason.body).toMatchObject({ code: 'REASON_REQUIRED' });
      expect((await row(survivor))?.risk_flag).toBeNull();
    });

    it('shows a flag on a merged id on the survivor until cleared, and the clear empties every flagged id', async () => {
      const survivor = (await link({ phone: newPhone() })).customerId as string;
      const merged = (await link({ phone: newPhone() })).customerId as string;
      const other = (await link({ phone: newPhone() })).customerId as string;
      await owner.pool.query(
        `UPDATE customers SET risk_flag = 'abusive', risk_flag_source = 'blacklist_import',
                risk_flag_set_at = now() WHERE id = ANY($1::uuid[])`,
        [[merged, other]],
      );
      await owner.pool.query(
        `UPDATE customers SET merged_into_id = $2 WHERE id = ANY($1::uuid[])`,
        [[merged, other], survivor],
      );
      expect(CustomerProfile.parse((await profile(survivor)).body).flag).toMatchObject({
        kind: 'abusive',
        source: 'blacklist_import',
      });

      // Asked through a merged id, the clear works on its survivor.
      const cleared = await clearFlag(merged, {
        reasonCode: 'customer_settled',
        expectedUpdatedAt: await stampOf(survivor),
      });

      expect(cleared.status).toBe(204);
      expect(CustomerProfile.parse((await profile(survivor)).body).flag).toBeNull();
      for (const id of [merged, other, survivor]) expect((await row(id))?.risk_flag).toBeNull();
    });

    it('setFlagFromImport never replaces a manual flag, on the customer or a merged id, and replaces an older import flag', async () => {
      const manual = (await link({ phone: newPhone() })).customerId as string;
      await setFlag(manual, {
        kind: 'returner',
        note: 'kept',
        expectedUpdatedAt: await stampOf(manual),
      });

      expect(await importFlag(manual, 'fake')).toBe('kept_manual');
      expect(await row(manual)).toMatchObject({
        risk_flag: 'returner',
        risk_flag_source: 'manual',
        risk_flag_note: 'kept',
      });

      const imported = (await link({ phone: newPhone() })).customerId as string;
      expect(await importFlag(imported, 'returner')).toBe('set');
      expect(await importFlag(imported, 'fake')).toBe('set');
      expect(await row(imported)).toEqual({
        risk_flag: 'fake',
        risk_flag_source: 'blacklist_import',
        risk_flag_note: null,
        risk_flag_set_by: null,
        set: true,
      });

      // A manual flag on a record merged into the customer also keeps the import out.
      const survivor = (await link({ phone: newPhone() })).customerId as string;
      await owner.pool.query(`UPDATE customers SET merged_into_id = $2 WHERE id = $1`, [
        manual,
        survivor,
      ]);
      expect(await importFlag(survivor, 'abusive')).toBe('kept_manual');
      expect((await row(survivor))?.risk_flag).toBeNull();
      await expect(importFlag(randomUUID(), 'fake')).rejects.toMatchObject({
        code: 'CUSTOMER_NOT_FOUND',
      });
    });

    it('answers 403 to the warehouse hat on both flag routes', async () => {
      const id = (await link({ phone: newPhone() })).customerId as string;
      const stamp = await stampOf(id);

      expect(
        (await setFlag(id, { kind: 'fake', expectedUpdatedAt: stamp }, warehouse)).status,
      ).toBe(403);
      expect(
        (await clearFlag(id, { reasonCode: 'flag_mistaken', expectedUpdatedAt: stamp }, warehouse))
          .status,
      ).toBe(403);
    });

    // Review m1: the stamp is the greatest `updated_at` over every id, so absorbing a record moves it.
    const merge = (survivorId: string, mergedId: string) =>
      send('POST', '/customers/merges', { survivorId, mergedId });
    const flagAs = async (id: string, kind: string, setAt = 'now()') =>
      owner.pool.query(
        `UPDATE customers SET risk_flag = $2, risk_flag_source = 'blacklist_import',
                risk_flag_set_at = ${setAt} WHERE id = $1`,
        [id, kind],
      );
    /** Waits until some session waits for an advisory lock, so a held lock is known to block it. */
    const waitForAdvisoryWaiter = async () => {
      for (let tries = 0; tries < 200; tries += 1) {
        const waiting = await count(
          `SELECT count(*) AS n FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted AND classid = $1
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          [CUSTOMER_LOCK],
        );
        if (waiting > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('No session waited for the customer lock');
    };
    /** Runs `during` while an owner transaction holds the customer lock of `id`, then commits it. */
    const holdingLockOf = async <T>(
      id: string,
      blocked: () => Promise<T>,
      during: (client: {
        query(text: string, params?: unknown[]): Promise<unknown>;
      }) => Promise<void>,
    ): Promise<T> => {
      const client = await owner.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))`, [
          CUSTOMER_LOCK,
          id,
        ]);
        const pending = blocked();
        // Keep a refusal from being reported as unhandled before it is awaited below.
        pending.catch(() => undefined);
        await waitForAdvisoryWaiter();
        await during(client);
        await client.query('COMMIT');
        return await pending;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    it('moves the stamp when a flagged record is merged in, so a clear with the old stamp is STALE_RECORD and keeps its flag', async () => {
      const a = (await link({ phone: newPhone() })).customerId as string;
      const b = (await link({ phone: newPhone() })).customerId as string;
      await setFlag(a, { kind: 'returner', expectedUpdatedAt: await stampOf(a) });
      await flagAs(b, 'fake');
      const old = await stampOf(a);

      expect((await merge(a, b)).status).toBe(201);
      const moved = await stampOf(a);
      expect(moved > old).toBe(true);

      const cleared = await clearFlag(a, { reasonCode: 'flag_mistaken', expectedUpdatedAt: old });
      const set = await setFlag(a, { kind: 'abusive', expectedUpdatedAt: old });

      expect(cleared.status).toBe(409);
      expect(cleared.body).toMatchObject({ code: 'STALE_RECORD' });
      expect(set.status).toBe(409);
      expect(set.body).toMatchObject({ code: 'STALE_RECORD' });
      expect(await row(b)).toMatchObject({
        risk_flag: 'fake',
        risk_flag_source: 'blacklist_import',
      });
      expect(await row(a)).toMatchObject({ risk_flag: 'returner', risk_flag_source: 'manual' });

      // With the stamp after the merge, both flags go, and the set answers the profile's stamp.
      const fresh = await setFlag(a, { kind: 'abusive', expectedUpdatedAt: moved });
      expect(fresh.status).toBe(200);
      const answer = CustomerSetFlagResponse.parse(fresh.body);
      expect(answer.updatedAt).toBe(await stampOf(a));
      expect(
        (await clearFlag(b, { reasonCode: 'flag_mistaken', expectedUpdatedAt: answer.updatedAt }))
          .status,
      ).toBe(204);
      for (const id of [a, b]) expect((await row(id))?.risk_flag).toBeNull();
    });

    it('lists a customer whose only flag sits on a merged record in the flagged list, once, by that flag time', async () => {
      const a = (await link({ phone: newPhone(), name: 'Mergedflag only' })).customerId as string;
      const severe = (await link({ phone: newPhone() })).customerId as string;
      const mild = (await link({ phone: newPhone() })).customerId as string;
      const twin = (await link({ phone: newPhone(), name: 'Mergedflag twin' }))
        .customerId as string;
      // The most severe merged flag is a's canonical flag; `twin` holds its own flag at the same time.
      await flagAs(severe, 'fake', `'2099-01-01T00:00:00Z'`);
      await flagAs(mild, 'returner', `'2099-06-01T00:00:00Z'`);
      await flagAs(twin, 'refuser', `'2099-01-01T00:00:00Z'`);
      await owner.pool.query(
        `UPDATE customers SET merged_into_id = $2 WHERE id = ANY($1::uuid[])`,
        [[severe, mild], a],
      );

      const ids: string[] = [];
      const kinds = new Map<string, string | null>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = CustomerSearchResponse.parse(
          (await search({ flagged: true, limit: 1, ...(cursor && { cursor }) })).body,
        );
        ids.push(...page.items.map((item) => item.id));
        for (const item of page.items) kinds.set(item.id, item.flagKind);
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 2);
      // The two customers flagged on 2099-01-01 come first, a and twin, in one order, no repeats.
      expect([...ids].sort()).toEqual([a, twin].sort());
      expect(kinds.get(a)).toBe('fake');

      const all: string[] = [];
      cursor = undefined;
      pages = 0;
      do {
        const page = CustomerSearchResponse.parse(
          (await search({ flagged: true, limit: 7, ...(cursor && { cursor }) })).body,
        );
        all.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 20);
      expect(new Set(all).size).toBe(all.length);
      expect(all.filter((id) => id === a)).toHaveLength(1);
      expect(all).not.toContain(severe);
      expect(all).not.toContain(mild);
      expect(all.slice(0, 2).sort()).toEqual([a, twin].sort());
    });

    it('answers one 200 and nine STALE_RECORD to ten parallel sets with one stamp, and the same to ten clears', async () => {
      const id = (await link({ phone: newPhone() })).customerId as string;
      const stamp = await stampOf(id);
      const sets = await Promise.all(
        Array.from({ length: 10 }, () =>
          setFlag(id, { kind: 'refuser', expectedUpdatedAt: stamp }),
        ),
      );
      expect(sets.filter((reply) => reply.status === 200)).toHaveLength(1);
      for (const reply of sets.filter((r) => r.status !== 200)) {
        expect([reply.status, (reply.body as { code: string }).code]).toEqual([
          409,
          'STALE_RECORD',
        ]);
      }

      const flagged = await stampOf(id);
      const clears = await Promise.all(
        Array.from({ length: 10 }, () =>
          clearFlag(id, { reasonCode: 'policy_review', expectedUpdatedAt: flagged }),
        ),
      );
      expect(clears.filter((reply) => reply.status === 204)).toHaveLength(1);
      for (const reply of clears.filter((r) => r.status !== 204)) {
        expect([reply.status, (reply.body as { code: string }).code]).toEqual([
          409,
          'STALE_RECORD',
        ]);
      }
      expect(
        await count(
          `SELECT count(*) AS n FROM audit_entries WHERE record_id = $1 AND action = 'customer.unflagged'`,
          [id],
        ),
      ).toBe(1);
    });

    it('refuses a clear that waited while a flagged record was merged in with STALE_RECORD, and keeps that flag', async () => {
      const a = (await link({ phone: newPhone() })).customerId as string;
      const b = (await link({ phone: newPhone() })).customerId as string;
      await setFlag(a, { kind: 'returner', expectedUpdatedAt: await stampOf(a) });
      await flagAs(b, 'fake');
      const old = await stampOf(a);

      const cleared = await holdingLockOf(
        a,
        () => clearFlag(a, { reasonCode: 'flag_mistaken', expectedUpdatedAt: old }),
        async (client) => {
          // The merge commits while the clear waits for the lock (as the owner, the pointer and stamp).
          await client.query(
            `UPDATE customers SET merged_into_id = $2, updated_at = now() WHERE id = $1`,
            [b, a],
          );
        },
      );

      expect(cleared.status).toBe(409);
      expect(cleared.body).toMatchObject({ code: 'STALE_RECORD' });
      expect(await row(b)).toMatchObject({ risk_flag: 'fake' });
      expect(await row(a)).toMatchObject({ risk_flag: 'returner' });
    });

    it('gives consistent outcomes to a clear racing a real merge, never a 500, and never clears the merged record unseen', async () => {
      for (let round = 0; round < 5; round += 1) {
        const a = (await link({ phone: newPhone() })).customerId as string;
        const b = (await link({ phone: newPhone() })).customerId as string;
        await setFlag(a, { kind: 'returner', expectedUpdatedAt: await stampOf(a) });
        await flagAs(b, 'fake');
        const old = await stampOf(a);

        const [merged, cleared] = await Promise.all([
          merge(a, b),
          clearFlag(a, { reasonCode: 'flag_mistaken', expectedUpdatedAt: old }),
        ]);

        expect(merged.status, merged.text).toBe(201);
        expect([204, 409]).toContain(cleared.status);
        if (cleared.status === 409) {
          expect(cleared.body).toMatchObject({ code: 'STALE_RECORD' });
          expect((await row(a))?.risk_flag).toBe('returner');
        } else {
          expect((await row(a))?.risk_flag).toBeNull();
        }
        // Either way b joined after the person's read, so its flag stays.
        expect((await row(b))?.risk_flag).toBe('fake');
      }
    });

    it('setFlagFromImport answers CUSTOMER_CHANGED when a merge moved the id set while it waited', async () => {
      const a = (await link({ phone: newPhone() })).customerId as string;
      const b = (await link({ phone: newPhone() })).customerId as string;

      await expect(
        holdingLockOf(
          a,
          () => importFlag(a, 'fake'),
          async (client) => {
            await client.query(
              `UPDATE customers SET merged_into_id = $2, updated_at = now() WHERE id = $1`,
              [b, a],
            );
          },
        ),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CHANGED' });
      expect((await row(a))?.risk_flag).toBeNull();
      expect(await importFlag(a, 'fake')).toBe('set');
    });

    it('lets a person replace an import flag, the audit entry carrying the import source before', async () => {
      const id = (await link({ phone: newPhone() })).customerId as string;
      expect(await importFlag(id, 'refuser')).toBe('set');

      const set = await setFlag(id, { kind: 'fake', expectedUpdatedAt: await stampOf(id) });

      expect(set.status).toBe(200);
      expect(await row(id)).toMatchObject({ risk_flag: 'fake', risk_flag_source: 'manual' });
      const entries = (
        await owner.pool.query<{ before: unknown; after: unknown }>(
          `SELECT before, after FROM audit_entries
           WHERE action = 'customer.flagged' AND record_id = $1`,
          [id],
        )
      ).rows;
      expect(entries).toEqual([
        {
          before: { riskFlag: 'refuser', riskFlagSource: 'blacklist_import' },
          after: { riskFlag: 'fake', riskFlagSource: 'manual' },
        },
      ]);
    });

    it('strips invisible format characters from the note and answers Cache-Control no-store', async () => {
      const id = (await link({ phone: newPhone() })).customerId as string;
      const response = await fetch(`${base}/api/customers/${id}/flag`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: base, cookie: support },
        body: JSON.stringify({
          kind: 'abusive',
          note: '‮ Shouted ​at the courier ⁦',
          expectedUpdatedAt: await stampOf(id),
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(CustomerSetFlagResponse.parse(await response.json()).flag.note).toBe(
        'Shouted at the courier',
      );
      expect((await row(id))?.risk_flag_note).toBe('Shouted at the courier');

      const early = await setFlag(id, { kind: 'fake', expectedUpdatedAt: '0000-01-01T00:00:00Z' });
      expect(early.status).toBe(422);
      expect(early.body).toMatchObject({ code: 'VALIDATION_FAILED' });
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
        // A flag note is personal data too (AC-17): set, refuse as too long, and clear it.
        const stamp = CustomerProfile.parse((await profile(created)).body).updatedAt;
        const flagged = await fetch(`${base}/api/customers/${created}/flag`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', origin: base, cookie: support },
          body: JSON.stringify({
            kind: 'abusive',
            note: 'Zzsentinel note',
            expectedUpdatedAt: stamp,
          }),
        });
        await fetch(`${base}/api/customers/${created}/flag`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', origin: base, cookie: support },
          body: JSON.stringify({
            kind: 'abusive',
            note: 'Zzsentinel'.repeat(60),
            expectedUpdatedAt: stamp,
          }),
        });
        const { updatedAt } = CustomerSetFlagResponse.parse(await flagged.json());
        await post(support, `/customers/${created}/flag/clear`, {
          reasonCode: 'flag_mistaken',
          expectedUpdatedAt: updatedAt,
        });
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
