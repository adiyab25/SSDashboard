import { randomUUID } from 'node:crypto';
import {
  CustomerMergeResponse,
  CustomerProfile,
  CustomerUndoMergeResponse,
  MergeSuggestionPage,
  personActor,
  SkuDetail,
  type NormalizedPhone,
} from '@ssdashboard/contracts';
import { APP_ROLE, createDatabase, runMigrations, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { CustomersService } from '../src/customers/customers.service.js';
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

// Spec 0014 milestone 2 (AC-6, AC-8, AC-9, AC-10, AC-16, AC-17): merge and undo by pointer, the
// merge suggestions, and `addPhone`, against PostgreSQL as the application role, with the built
// api serving the routes (its log is read by the sentinel test).
describe('customers merge and undo', { timeout: 240_000 }, () => {
  let scratch: { name: string; url: string };
  let owner: DatabaseConnection;
  let app: DatabaseConnection;
  let customers: CustomersService;
  let api: RunningProcess | undefined;
  let base: string;
  let support: string;
  let supportId: string;
  let manager: string;
  let warehouse: string;
  let counter = 0;
  const seen = new Date('2026-11-01T10:00:00.000Z');

  beforeAll(async () => {
    scratch = await createScratchDatabase();
    await runMigrations(scratch.url);
    owner = createDatabase(scratch.url, { max: 4 });
    const appUrl = new URL(scratch.url);
    appUrl.searchParams.set('options', `-c role=${APP_ROLE}`);
    app = createDatabase(appUrl.toString(), { max: 10 });
    customers = new CustomersService(app, new AuditService());

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
    supportId = (
      await owner.pool.query<{ id: string }>(
        `SELECT id FROM users WHERE email = 'support@example.com'`,
      )
    ).rows[0]?.id as string;
    manager = await signInAs(base, owner.pool, {
      email: 'manager@example.com',
      access: { hats: ['manager'] },
    });
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

  /** A fresh Egyptian mobile in E.164 form, never used before. */
  const newPhone = (): NormalizedPhone => {
    counter += 1;
    return { e164: `+2011${String(counter).padStart(8, '0')}`, kind: 'mobile' };
  };
  /** A new customer with its own phone (and a name when given). */
  const customer = async (name: string | null = null): Promise<string> => {
    const phone = newPhone();
    const result = await app.db.transaction((tx) =>
      customers.findOrCreate(tx, { phone, channelCustomer: null, name, seenAt: seen }),
    );
    return result.customerId as string;
  };
  const phoneOf = async (id: string): Promise<NormalizedPhone> => ({
    e164: (
      await owner.pool.query<{ e164: string }>(
        'SELECT phone_e164 AS e164 FROM customer_phones WHERE customer_id = $1 AND is_primary',
        [id],
      )
    ).rows[0]?.e164 as string,
    kind: 'mobile',
  });
  const supportActor = () => personActor(supportId, 'support');
  const addPhone = (customerId: string, phone: NormalizedPhone) =>
    app.db.transaction((tx) => customers.addPhone(tx, customerId, phone, supportActor()));
  const call = async (cookie: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        origin: base,
        cookie,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as unknown, text };
  };
  const merge = (survivorId: string, mergedId: string, extra: object = {}, cookie = support) =>
    call(cookie, 'POST', '/customers/merges', { survivorId, mergedId, ...extra });
  const undo = (mergeId: string, reasonCode: unknown = 'wrong_merge', cookie = support) =>
    call(cookie, 'POST', `/customers/merges/${mergeId}/undo`, { reasonCode });
  const pointerOf = async (id: string) =>
    (
      await owner.pool.query<{ merged_into_id: string | null }>(
        'SELECT merged_into_id FROM customers WHERE id = $1',
        [id],
      )
    ).rows[0]?.merged_into_id;
  const mergedEntryOf = async (mergedId: string) =>
    (
      await owner.pool.query<{ id: string }>(
        `SELECT id FROM audit_entries
         WHERE action = 'customer.merged' AND record_id = $1 AND undo_action IS NOT NULL
         ORDER BY recorded_at DESC LIMIT 1`,
        [mergedId],
      )
    ).rows[0]?.id as string;
  const suggestionOf = async (a: string, b: string) =>
    (
      await owner.pool.query<{ id: string; status: string; merge_id: string | null }>(
        `SELECT id, status, merge_id FROM customer_merge_suggestions
         WHERE customer_low_id = LEAST($1::uuid, $2::uuid) AND customer_high_id = GREATEST($1::uuid, $2::uuid)`,
        [a, b],
      )
    ).rows;
  /** A fingerprint of every row of a table another module owns. */
  const fingerprint = async (table: 'orders' | 'credit_entries') =>
    (
      await owner.pool.query<{ f: string | null; n: string }>(
        `SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY t.id)) AS f, count(*) AS n FROM ${table} t`,
      )
    ).rows[0];

  describe('merge (AC-6)', () => {
    it('points the merged customer at the survivor, records one merge row, and answers the survivor', async () => {
      const survivor = await customer('Survivor One');
      const merged = await customer('Merged One');

      const reply = await merge(survivor, merged, { reasonCode: 'same_person' });

      expect(reply.status, reply.text).toBe(201);
      const body = CustomerMergeResponse.parse(reply.body);
      expect(body.survivor).toMatchObject({ id: survivor, phoneCount: 2 });
      expect(await pointerOf(merged)).toBe(survivor);
      const { rows } = await owner.pool.query(
        'SELECT action, survivor_id, merged_id, reason, actor_id FROM customer_merges WHERE id = $1',
        [body.mergeId],
      );
      expect(rows).toEqual([
        {
          action: 'merge',
          survivor_id: survivor,
          merged_id: merged,
          reason: 'same_person',
          actor_id: supportId,
        },
      ]);
      expect(await customers.findByPhone(await phoneOf(merged))).toBe(survivor);
    });

    it('answers 409 SAME_CUSTOMER, CUSTOMER_MERGED, 404 CUSTOMER_NOT_FOUND, and 422 REASON_INVALID', async () => {
      const a = await customer();
      const b = await customer();
      const c = await customer();
      expect((await merge(a, b)).status).toBe(201);

      const same = await merge(a, b);
      const self = await merge(a, a);
      const stale = await merge(c, b);
      const unknown = await merge(a, randomUUID());
      const reason = await merge(a, c, { reasonCode: 'call_01012345678' });
      const invalid = await merge('not-a-uuid', c);

      expect([same.status, (same.body as { code: string }).code]).toEqual([409, 'SAME_CUSTOMER']);
      expect([self.status, (self.body as { code: string }).code]).toEqual([409, 'SAME_CUSTOMER']);
      expect([stale.status, (stale.body as { code: string }).code]).toEqual([
        409,
        'CUSTOMER_MERGED',
      ]);
      expect([unknown.status, (unknown.body as { code: string }).code]).toEqual([
        404,
        'CUSTOMER_NOT_FOUND',
      ]);
      expect([reason.status, (reason.body as { code: string }).code]).toEqual([
        422,
        'REASON_INVALID',
      ]);
      expect(reason.text).not.toContain('01012345678');
      expect(invalid.status).toBe(422);
      expect(await pointerOf(c)).toBeNull();
    });

    // Five rounds, because the race it guards (a merge that read the pair before another one
    // committed) shows only under load.
    it('twenty parallel merges of one pair give one merge and nineteen 409s, five rounds', async () => {
      for (let round = 0; round < 5; round += 1) {
        const survivor = await customer();
        const merged = await customer();

        const replies = await Promise.all(
          Array.from({ length: 20 }, () => merge(survivor, merged)),
        );

        const statuses = replies.map((reply) => reply.status);
        expect(statuses.filter((status) => status === 201)).toHaveLength(1);
        expect(statuses.filter((status) => status === 409)).toHaveLength(19);
        for (const reply of replies.filter((r) => r.status === 409)) {
          expect(['SAME_CUSTOMER', 'CUSTOMER_CHANGED']).toContain(
            (reply.body as { code: string }).code,
          );
        }
        const rows = await owner.pool.query<{ n: string }>(
          'SELECT count(*) n FROM customer_merges WHERE merged_id = $1',
          [merged],
        );
        expect(Number(rows.rows[0]?.n)).toBe(1);
      }
    });
  });

  describe('chains (spec 0002 AC-28, AC-6, AC-8)', () => {
    it('keeps chains one hop, undoes in reverse order only, and never touches another module’s rows', async () => {
      // B is a real order's customer, so the order row proves a merge never rewrites it.
      const sku = await call(manager, 'POST', '/products', {
        name: { en: 'Chain tee' },
        variants: [{ sku: 'CHAIN-M', price: '100.00' }],
      });
      expect(sku.status, sku.text).toBe(201);
      const ids = await owner.pool.query<{ store: string; channel: string }>(
        `SELECT (SELECT id FROM stores WHERE code = 'MAIN') AS store,
                (SELECT id FROM channels WHERE code = 'manual') AS channel`,
      );
      const order = await call(support, 'POST', '/orders', {
        clientRef: randomUUID(),
        storeId: ids.rows[0]?.store,
        channelId: ids.rows[0]?.channel,
        shipTo: { name: 'Chain Buyer', phone: '01155554444', address: '1 Chain Street' },
        lines: [{ variantId: SkuDetail.parse(sku.body).id, quantity: 1, unitPrice: '100.00' }],
        shippingChargedAmount: '20.00',
        paymentMethod: 'cod',
      });
      expect(order.status, order.text).toBe(201);
      const b = (
        await owner.pool.query<{ customer_id: string }>(
          'SELECT customer_id FROM orders WHERE id = $1',
          [(order.body as { id: string }).id],
        )
      ).rows[0]?.customer_id as string;
      expect(b).toBeTruthy();
      const a = await customer();
      const c = await customer();
      const ordersBefore = await fingerprint('orders');
      const creditBefore = await fingerprint('credit_entries');

      const first = CustomerMergeResponse.parse((await merge(c, b)).body);
      const second = CustomerMergeResponse.parse((await merge(a, c)).body);

      expect(await pointerOf(b)).toBe(a);
      expect(await pointerOf(c)).toBe(a);
      expect(await customers.findByPhone(await phoneOf(b))).toBe(a);
      expect(await customers.findByPhone(await phoneOf(c))).toBe(a);
      expect(await customers.idsOf(a)).toEqual([a, b, c].sort());
      const repointed = await owner.pool.query<{ repointed_ids: string[] }>(
        'SELECT repointed_ids::text[] AS repointed_ids FROM customer_merges WHERE id = $1',
        [second.mergeId],
      );
      expect(repointed.rows[0]?.repointed_ids).toEqual([b]);
      const profile = CustomerProfile.parse((await call(support, 'GET', `/customers/${a}`)).body);
      expect(profile.merges.map((m) => [m.mergeId, m.undoable])).toEqual([
        [second.mergeId, true],
        [first.mergeId, false],
      ]);

      const notLatest = await undo(first.mergeId);
      expect([notLatest.status, (notLatest.body as { code: string }).code]).toEqual([
        409,
        'MERGE_NOT_LATEST',
      ]);
      const viaAudit = await call(
        manager,
        'POST',
        `/audit/entries/${await mergedEntryOf(b)}/undo`,
        { reason: 'wrong_merge' },
      );
      expect(viaAudit.status, viaAudit.text).toBe(409);
      expect(viaAudit.body).toMatchObject({
        code: 'UNDO_NOT_POSSIBLE',
        undoCode: 'MERGE_NOT_LATEST',
      });

      const undone = await undo(second.mergeId);
      expect(undone.status, undone.text).toBe(200);
      expect(CustomerUndoMergeResponse.parse(undone.body)).toEqual({
        restoredId: c,
        survivorId: a,
      });
      expect(await pointerOf(c)).toBeNull();
      expect(await pointerOf(b)).toBe(c);
      expect(await customers.idsOf(a)).toEqual([a]);
      expect(await customers.idsOf(c)).toEqual([b, c].sort());

      // Now the first merge is the latest again.
      expect((await undo(first.mergeId)).status).toBe(200);
      expect(await pointerOf(b)).toBeNull();
      expect(await fingerprint('orders')).toEqual(ordersBefore);
      expect(await fingerprint('credit_entries')).toEqual(creditBefore);
    });
  });

  describe('undo (AC-8)', () => {
    it('undoes once from the customer route, then refuses from both routes with MERGE_ALREADY_UNDONE', async () => {
      const survivor = await customer();
      const merged = await customer();
      const made = CustomerMergeResponse.parse((await merge(survivor, merged)).body);

      const missing = await call(support, 'POST', `/customers/merges/${made.mergeId}/undo`, {});
      const invalid = await undo(made.mergeId, 'oops');
      const first = await undo(made.mergeId, 'different_people');
      const second = await undo(made.mergeId);
      const viaAudit = await call(
        manager,
        'POST',
        `/audit/entries/${await mergedEntryOf(merged)}/undo`,
        { reason: 'wrong_merge' },
      );
      const unknown = await undo(randomUUID());
      const malformed = await undo('nope');

      expect([missing.status, (missing.body as { code: string }).code]).toEqual([
        422,
        'REASON_REQUIRED',
      ]);
      expect([invalid.status, (invalid.body as { code: string }).code]).toEqual([
        422,
        'REASON_INVALID',
      ]);
      expect(first.status, first.text).toBe(200);
      expect([second.status, (second.body as { code: string }).code]).toEqual([
        409,
        'MERGE_ALREADY_UNDONE',
      ]);
      expect(viaAudit.status, viaAudit.text).toBe(409);
      expect(viaAudit.body).toMatchObject({
        code: 'UNDO_NOT_POSSIBLE',
        undoCode: 'MERGE_ALREADY_UNDONE',
      });
      expect([unknown.status, (unknown.body as { code: string }).code]).toEqual([
        404,
        'MERGE_NOT_FOUND',
      ]);
      expect(malformed.status).toBe(404);
      const rows = await owner.pool.query(
        `SELECT action, reason FROM customer_merges WHERE undoes_merge_id = $1`,
        [made.mergeId],
      );
      expect(rows.rows).toEqual([{ action: 'undo', reason: 'different_people' }]);
    });

    it('undoes a fresh merge from the audit screen and records customer.merged_undone on the merged record', async () => {
      const survivor = await customer();
      const merged = await customer();
      const made = CustomerMergeResponse.parse((await merge(survivor, merged)).body);

      const reply = await call(
        manager,
        'POST',
        `/audit/entries/${await mergedEntryOf(merged)}/undo`,
        { reason: 'wrong_merge' },
      );

      expect(reply.status, reply.text).toBe(200);
      expect(reply.body).toMatchObject({ action: 'customer.merged_undone' });
      expect(await pointerOf(merged)).toBeNull();
      const undoRow = await owner.pool.query(
        `SELECT reason FROM customer_merges WHERE undoes_merge_id = $1`,
        [made.mergeId],
      );
      expect(undoRow.rows).toEqual([{ reason: 'wrong_merge' }]);
      const again = await undo(made.mergeId);
      expect((again.body as { code: string }).code).toBe('MERGE_ALREADY_UNDONE');
    });

    it('lets a support agent undo from the customer route but not from the audit screen', async () => {
      const survivor = await customer();
      const merged = await customer();
      await merge(survivor, merged);

      const reply = await call(
        support,
        'POST',
        `/audit/entries/${await mergedEntryOf(merged)}/undo`,
        { reason: 'wrong_merge' },
      );

      expect(reply.status).toBe(403);
      expect(await pointerOf(merged)).toBe(survivor);
    });
  });

  describe('addPhone (AC-10) and suggestions (AC-9)', () => {
    it('adds a new phone, holds a known one, and never moves another customer’s phone', async () => {
      const a = await customer();
      const b = await customer();
      const fresh = newPhone();

      const added = await addPhone(a, fresh);
      const again = await addPhone(a, fresh);
      const primary = await addPhone(a, await phoneOf(a));
      const other = await addPhone(a, await phoneOf(b));

      expect(added).toEqual({ outcome: 'added' });
      expect(again).toEqual({ outcome: 'already_held' });
      expect(primary).toEqual({ outcome: 'already_held' });
      expect(other).toEqual({ outcome: 'held_by_other', otherCustomerId: b });
      const phones = await owner.pool.query(
        'SELECT phone_e164, is_primary FROM customer_phones WHERE customer_id = $1 ORDER BY is_primary DESC',
        [a],
      );
      expect(phones.rows).toEqual([
        { phone_e164: (await phoneOf(a)).e164, is_primary: true },
        { phone_e164: fresh.e164, is_primary: false },
      ]);
      expect(await customers.findByPhone(await phoneOf(b))).toBe(b);
      expect(await suggestionOf(a, b)).toMatchObject([{ status: 'open', merge_id: null }]);
      const reason = await owner.pool.query<{ reason: string }>(
        `SELECT reason FROM customer_merge_suggestions WHERE id = $1`,
        [(await suggestionOf(a, b))[0]?.id],
      );
      expect(reason.rows[0]?.reason).toBe('second_phone_conflict');
      // A system caller writes no entry; a person's `added` does.
      const entries = await owner.pool.query(
        `SELECT count(*)::int n FROM audit_entries WHERE action = 'customer.phone_added' AND record_id = $1`,
        [a],
      );
      expect(entries.rows[0]).toEqual({ n: 1 });
    });

    it('adds a phone given a merged id to the survivor', async () => {
      const survivor = await customer();
      const merged = await customer();
      await merge(survivor, merged);
      const fresh = newPhone();

      expect(await addPhone(merged, fresh)).toEqual({ outcome: 'added' });
      expect(await customers.findByPhone(fresh)).toBe(survivor);
      const owners = await owner.pool.query(
        'SELECT customer_id FROM customer_phones WHERE phone_e164 = $1',
        [fresh.e164],
      );
      expect(owners.rows).toEqual([{ customer_id: survivor }]);
    });

    it('lists open suggestions oldest first with both customers, and a dismissed pair is never suggested again', async () => {
      const a = await customer('Listed A');
      const b = await customer('Listed B');
      await addPhone(a, await phoneOf(b));
      const [suggestion] = await suggestionOf(a, b);

      const page = MergeSuggestionPage.parse(
        (await call(support, 'GET', '/customers/merge-suggestions?limit=100')).body,
      );
      const item = page.items.find((i) => i.id === suggestion?.id);
      expect(item?.reason).toBe('second_phone_conflict');
      expect(item?.customers.map((c) => c.id)).toEqual([a, b]);
      expect(page.openCount).toBeGreaterThanOrEqual(page.items.length);
      const times = page.items.map((i) => i.createdAt);
      expect(times).toEqual([...times].sort());

      const dismissed = await call(
        support,
        'POST',
        `/customers/merge-suggestions/${suggestion?.id}/dismiss`,
        { reasonCode: 'shared_phone' },
      );
      const twice = await call(
        support,
        'POST',
        `/customers/merge-suggestions/${suggestion?.id}/dismiss`,
        {},
      );
      const unknown = await call(
        support,
        'POST',
        `/customers/merge-suggestions/${randomUUID()}/dismiss`,
        {},
      );
      const badReason = await call(
        support,
        'POST',
        `/customers/merge-suggestions/${suggestion?.id}/dismiss`,
        { reasonCode: 'nope' },
      );
      expect(dismissed.status, dismissed.text).toBe(204);
      expect([twice.status, (twice.body as { code: string }).code]).toEqual([
        409,
        'SUGGESTION_CLOSED',
      ]);
      expect([unknown.status, (unknown.body as { code: string }).code]).toEqual([
        404,
        'SUGGESTION_NOT_FOUND',
      ]);
      expect(badReason.status).toBe(422);

      // The same pair again, by addPhone and by findOrCreate rule (d): no new row, still dismissed.
      expect(await addPhone(a, await phoneOf(b))).toMatchObject({ outcome: 'held_by_other' });
      expect(await suggestionOf(a, b)).toMatchObject([{ id: suggestion?.id, status: 'dismissed' }]);
      const after = MergeSuggestionPage.parse(
        (await call(support, 'GET', '/customers/merge-suggestions?limit=100')).body,
      );
      expect(after.items.map((i) => i.id)).not.toContain(suggestion?.id);
    });

    it('pages the suggestions by keyset with no row skipped or repeated, and refuses a forged cursor', async () => {
      for (let i = 0; i < 3; i += 1) {
        const a = await customer();
        const b = await customer();
        await addPhone(a, await phoneOf(b));
      }
      const all = MergeSuggestionPage.parse(
        (await call(support, 'GET', '/customers/merge-suggestions?limit=100')).body,
      );
      const seenIds: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor === null ? '' : `&cursor=${cursor}`;
        const page = MergeSuggestionPage.parse(
          (await call(support, 'GET', `/customers/merge-suggestions?limit=2${query}`)).body,
        );
        seenIds.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor !== null);

      expect(seenIds).toEqual(all.items.map((i) => i.id));
      const forged = await call(support, 'GET', '/customers/merge-suggestions?cursor=WyJ4Il0');
      expect([forged.status, (forged.body as { code: string }).code]).toEqual([
        400,
        'INVALID_CURSOR',
      ]);
    });

    it('marks the suggestion applied by a merge that names it, closes the pair’s suggestion on any merge, and hides a pair already one', async () => {
      const a = await customer();
      const b = await customer();
      await addPhone(a, await phoneOf(b));
      const [named] = await suggestionOf(a, b);
      const c = await customer();
      const d = await customer();
      await addPhone(c, await phoneOf(d));
      const e = await customer();

      const mismatch = await merge(c, d, { suggestionId: named?.id });
      const unknown = await merge(c, d, { suggestionId: randomUUID() });
      const applied = CustomerMergeResponse.parse(
        (await merge(a, b, { suggestionId: named?.id, reasonCode: 'suggestion' })).body,
      );
      const closed = await merge(a, e, { suggestionId: named?.id });
      // A merge without the suggestion id still closes the pair's open suggestion.
      const plain = CustomerMergeResponse.parse((await merge(d, c)).body);

      expect([mismatch.status, (mismatch.body as { code: string }).code]).toEqual([
        409,
        'SUGGESTION_MISMATCH',
      ]);
      expect([unknown.status, (unknown.body as { code: string }).code]).toEqual([
        404,
        'SUGGESTION_NOT_FOUND',
      ]);
      expect([closed.status, (closed.body as { code: string }).code]).toEqual([
        409,
        'SUGGESTION_CLOSED',
      ]);
      expect(await suggestionOf(a, b)).toMatchObject([
        { status: 'applied', merge_id: applied.mergeId },
      ]);
      expect(await suggestionOf(c, d)).toMatchObject([
        { status: 'applied', merge_id: plain.mergeId },
      ]);

      // A pair that resolves to one but is still open (planted) is hidden from the list.
      const f = await customer();
      const g = await customer();
      await addPhone(f, await phoneOf(g));
      const [hidden] = await suggestionOf(f, g);
      await owner.pool.query('UPDATE customers SET merged_into_id = $1 WHERE id = $2', [f, g]);
      const page = MergeSuggestionPage.parse(
        (await call(support, 'GET', '/customers/merge-suggestions?limit=100')).body,
      );
      expect(page.items.map((i) => i.id)).not.toContain(hidden?.id);
    });
  });

  describe('who may call (AC-16)', () => {
    it('answers 403 to the warehouse hat on every merge route and 401 without a session', async () => {
      const a = await customer();
      const b = await customer();
      const id = randomUUID();
      const routes: [string, string, unknown][] = [
        ['POST', '/customers/merges', { survivorId: a, mergedId: b }],
        ['POST', `/customers/merges/${id}/undo`, { reasonCode: 'wrong_merge' }],
        ['GET', '/customers/merge-suggestions', undefined],
        ['POST', `/customers/merge-suggestions/${id}/dismiss`, {}],
      ];

      for (const [method, path, body] of routes) {
        expect((await call(warehouse, method, path, body)).status, path).toBe(403);
        expect((await call('', method, path, body)).status, path).toBe(401);
      }
      expect(await pointerOf(b)).toBeNull();
    });
  });

  describe('personal data and logs (AC-17)', () => {
    it('leaves a sentinel phone and name out of the log and the answers through merge, undo, addPhone, and dismiss', async () => {
      const name = 'Zzmergesentinel Person';
      const sentinel: NormalizedPhone = { e164: '+201188776655', kind: 'mobile' };
      const second: NormalizedPhone = { e164: '+201188776644', kind: 'mobile' };
      const captured: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      const writeErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = (chunk: string | Uint8Array) => (captured.push(String(chunk)), true);
      process.stderr.write = (chunk: string | Uint8Array) => (captured.push(String(chunk)), true);
      const answers: string[] = [];
      try {
        const a = (
          await app.db.transaction((tx) =>
            customers.findOrCreate(tx, {
              phone: sentinel,
              channelCustomer: null,
              name,
              seenAt: seen,
            }),
          )
        ).customerId as string;
        const b = await customer(name);
        await addPhone(a, second);
        await addPhone(b, second);
        const [suggestion] = await suggestionOf(a, b);
        answers.push(
          (
            await call(
              support,
              'POST',
              `/customers/merge-suggestions/${suggestion?.id}/dismiss`,
              {},
            )
          ).text,
        );
        const made = await merge(a, b, { reasonCode: 'same_person' });
        answers.push((await merge(a, b)).text);
        answers.push((await undo(CustomerMergeResponse.parse(made.body).mergeId)).text);
        answers.push((await undo(CustomerMergeResponse.parse(made.body).mergeId)).text);
      } finally {
        process.stdout.write = write;
        process.stderr.write = writeErr;
      }

      const apiLog = api?.output() ?? '';
      expect(apiLog.length).toBeGreaterThan(0);
      for (const text of [apiLog, captured.join(''), ...answers]) {
        expect(text).not.toContain('1188776655');
        expect(text).not.toContain('1188776644');
        expect(text).not.toContain('Zzmergesentinel');
      }
    });
  });
});
