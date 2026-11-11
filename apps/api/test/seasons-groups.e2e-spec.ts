import { randomUUID } from 'node:crypto';
import {
  ProductGroup,
  ProductGroupListResponse,
  Season,
  SeasonListResponse,
  SkuDetail,
  StyleDetail,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0012 milestone 2 (AC-6, AC-7, AC-17): seasons and product groups through the running api
// on its own scratch database. This file is the registry `proof` of season.created,
// season.edited, season.archived, season.unarchived, season.deleted, product_group.created,
// product_group.edited, product_group.archived, product_group.unarchived, and
// product_group.deleted. A refused or no change write records nothing.
describe('seasons and product groups (spec 0012, AC-6, AC-7)', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let manager: string;
  let managerId: string;
  let editor: string;
  let n = 0;
  const code = (prefix: string) => {
    n += 1;
    return `${prefix}${n}`;
  };

  beforeAll(async () => {
    api = await startInProcessApi();
    const person = await api.addPerson(['manager']);
    managerId = person.id;
    manager = await api.signIn(person.email);
    editor = await api.signIn((await api.addPerson(['operations'])).email);
  });

  afterAll(async () => {
    await api?.close();
  });

  /** The audit entries of one record, oldest first. */
  async function entriesOf(id: string) {
    const { rows } = await api.owner.pool.query<{
      action: string;
      record_type: string;
      record_label: string | null;
      actor_user_id: string | null;
      actor_hat: string | null;
      before: unknown;
      after: unknown;
    }>(
      `SELECT action, record_type, record_label, actor_user_id, actor_hat, before, after
       FROM audit_entries WHERE record_id = $1 ORDER BY recorded_at, id`,
      [id],
    );
    return rows;
  }

  async function newSeason(body: Record<string, unknown> = {}) {
    const reply = await api.call(manager, 'POST', '/api/seasons', {
      code: code('SS'),
      name: { en: 'Summer' },
      ...body,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return Season.parse(reply.body);
  }

  async function newGroup(body: Record<string, unknown> = {}) {
    const reply = await api.call(manager, 'POST', '/api/product-groups', {
      code: code('GR'),
      name: { en: 'Tops' },
      ...body,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return ProductGroup.parse(reply.body);
  }

  async function newStyle(body: Record<string, unknown> = {}) {
    const reply = await api.call(manager, 'POST', '/api/products', {
      name: { en: 'Tee' },
      variants: [{ sku: code('STY-') }],
      ...body,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return SkuDetail.parse(reply.body);
  }

  async function seeded(path: string, seededCode: string) {
    const reply = await api.call(manager, 'GET', `${path}?q=${seededCode}`);
    expect(reply.status).toBe(200);
    const found = (reply.body as { items: { code: string; id: string; updatedAt: string }[] })
      .items;
    const row = found.find((item) => item.code === seededCode);
    if (!row) throw new Error(`${seededCode} is not seeded`);
    return row;
  }

  describe('seasons (AC-6)', () => {
    it('creates a season with a shaped code, a name, and ordered dates, and records season.created', async () => {
      const reply = await api.call(manager, 'POST', '/api/seasons', {
        code: '  ss27 ',
        name: { en: 'Spring Summer 27', ar: 'ربيع صيف ٢٧' },
        startsOn: '2027-03-01',
        endsOn: '2027-08-31',
      });

      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      const season = Season.parse(reply.body);
      expect(season).toMatchObject({
        code: 'SS27',
        startsOn: '2027-03-01',
        endsOn: '2027-08-31',
        archived: false,
        protected: false,
      });
      expect(season.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      const [entry] = await entriesOf(season.id);
      expect(entry).toMatchObject({
        action: 'season.created',
        record_type: 'season',
        record_label: 'SS27',
        actor_user_id: managerId,
        actor_hat: 'manager',
        after: { code: 'SS27', startsOn: '2027-03-01', endsOn: '2027-08-31' },
      });
    });

    it('refuses a taken code (409), a bad code, a missing name, and dates out of order (422)', async () => {
      const season = await newSeason();

      const taken = await api.call(manager, 'POST', '/api/seasons', {
        code: season.code.toLowerCase(),
        name: { en: 'Again' },
      });
      const badCode = await api.call(manager, 'POST', '/api/seasons', {
        code: 'SPRING SUMMER',
        name: { en: 'x' },
      });
      const noName = await api.call(manager, 'POST', '/api/seasons', {
        code: code('NN'),
        name: { en: '' },
      });
      const outOfOrder = await api.call(manager, 'POST', '/api/seasons', {
        code: code('OO'),
        name: { en: 'x' },
        startsOn: '2027-09-01',
        endsOn: '2027-08-01',
      });

      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'SEASON_CODE_TAKEN' });
      for (const reply of [badCode, noName, outOfOrder]) {
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ code: 'INVALID_INPUT' });
      }
    });

    it('edits with the stale check, refuses dates out of order with the stored ones, and records the changed fields only', async () => {
      const season = await newSeason({ startsOn: '2027-01-01' });

      const stale = await api.call(manager, 'PATCH', `/api/seasons/${season.id}`, {
        updatedAt: '2000-01-01T00:00:00.000000Z',
        name: { en: 'Late' },
      });
      const outOfOrder = await api.call(manager, 'PATCH', `/api/seasons/${season.id}`, {
        updatedAt: season.updatedAt,
        endsOn: '2026-12-31',
      });
      const edited = await api.call(manager, 'PATCH', `/api/seasons/${season.id}`, {
        updatedAt: season.updatedAt,
        name: { en: 'Winter', ar: 'شتاء' },
        endsOn: '2027-02-28',
      });
      const again = Season.parse(edited.body);
      const unchanged = await api.call(manager, 'PATCH', `/api/seasons/${season.id}`, {
        updatedAt: again.updatedAt,
        name: { en: 'Winter', ar: 'شتاء' },
      });

      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'STALE_RECORD' });
      expect(outOfOrder.status).toBe(422);
      expect(outOfOrder.body).toMatchObject({ code: 'INVALID_INPUT' });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(again).toMatchObject({ name: { en: 'Winter', ar: 'شتاء' }, endsOn: '2027-02-28' });
      expect(unchanged.status).toBe(200);
      const entries = await entriesOf(season.id);
      expect(entries.map((entry) => entry.action)).toEqual(['season.created', 'season.edited']);
      expect(entries[1]).toMatchObject({
        before: { name: { en: 'Summer', ar: null }, endsOn: null },
        after: { name: { en: 'Winter', ar: 'شتاء' }, endsOn: '2027-02-28' },
      });
    });

    it('archives a season out of the default list and new assignments (422 ARCHIVED), keeps it on its styles, and unarchives it', async () => {
      const season = await newSeason();
      const holder = await newStyle({ seasonId: season.id });

      const archived = await api.call(manager, 'POST', `/api/seasons/${season.id}/archive`);
      const again = await api.call(manager, 'POST', `/api/seasons/${season.id}/archive`);
      const active = SeasonListResponse.parse(
        (await api.call(manager, 'GET', `/api/seasons?q=${season.code}`)).body,
      );
      const archivedList = SeasonListResponse.parse(
        (await api.call(manager, 'GET', `/api/seasons?status=archived&q=${season.code}`)).body,
      );
      const createWith = await api.call(manager, 'POST', '/api/products', {
        name: { en: 'New' },
        variants: [{ sku: code('NEW-') }],
        seasonId: season.id,
      });
      const other = await newStyle();
      const style = StyleDetail.parse(
        (await api.call(manager, 'GET', `/api/styles/${other.productId}`)).body,
      );
      const editWith = await api.call(manager, 'PATCH', `/api/styles/${other.productId}`, {
        updatedAt: style.updatedAt,
        seasonId: season.id,
      });
      const assignWith = await api.call(manager, 'POST', '/api/styles/assign', {
        styleIds: [other.productId],
        seasonId: season.id,
      });
      const kept = SkuDetail.parse((await api.call(manager, 'GET', `/api/skus/${holder.id}`)).body);
      const unarchived = await api.call(manager, 'POST', `/api/seasons/${season.id}/unarchive`);

      expect(archived.status).toBe(200);
      expect(Season.parse(archived.body).archived).toBe(true);
      expect(again.status).toBe(200);
      expect(active.items.map((item) => item.id)).not.toContain(season.id);
      expect(archivedList.items.map((item) => item.id)).toEqual([season.id]);
      for (const reply of [createWith, editWith, assignWith]) {
        expect(reply.status, JSON.stringify(reply.body)).toBe(422);
        expect(reply.body).toMatchObject({ code: 'ARCHIVED' });
      }
      expect(kept.season?.id).toBe(season.id);
      expect(Season.parse(unarchived.body).archived).toBe(false);
      expect((await entriesOf(season.id)).map((entry) => entry.action)).toEqual([
        'season.created',
        'season.archived',
        'season.unarchived',
      ]);
    });

    it('deletes a season only while nothing references it (409 IN_USE), recording season.deleted', async () => {
      const used = await newSeason();
      await newStyle({ seasonId: used.id });
      const unused = await newSeason();

      const refused = await api.call(manager, 'DELETE', `/api/seasons/${used.id}`);
      const deleted = await api.call(manager, 'DELETE', `/api/seasons/${unused.id}`);
      const gone = await api.call(manager, 'DELETE', `/api/seasons/${unused.id}`);

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'IN_USE' });
      expect(deleted.status).toBe(204);
      expect(gone.status).toBe(404);
      expect((await entriesOf(used.id)).map((entry) => entry.action)).toEqual(['season.created']);
      expect(await entriesOf(unused.id)).toMatchObject([
        { action: 'season.created' },
        { action: 'season.deleted', before: { code: unused.code } },
      ]);
    });

    // Review M2 minor 7: a cost record alone (its style in another season) keeps a season.
    // Product groups have no cost record reference, so only seasons have this case.
    it('refuses to delete a season only a cost record holds (409 IN_USE)', async () => {
      const held = await newSeason();
      const sku = await newStyle();
      await api.owner.pool.query(
        `INSERT INTO cost_records (product_id, season_id, cost_basis, unit_cost, effective_from)
         VALUES ($1, $2, 'factory_invoice', '10.0000', '2026-03-01')`,
        [sku.productId, held.id],
      );

      const refused = await api.call(manager, 'DELETE', `/api/seasons/${held.id}`);

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'IN_USE' });
      expect((await entriesOf(held.id)).map((entry) => entry.action)).toEqual(['season.created']);
    });

    it('lets CORE be renamed but never recoded, archived, or deleted (409 SEASON_PROTECTED)', async () => {
      const core = await seeded('/api/seasons', 'CORE');
      expect(Season.parse(core).protected).toBe(true);

      const renamed = await api.call(manager, 'PATCH', `/api/seasons/${core.id}`, {
        updatedAt: core.updatedAt,
        name: { en: 'Core basics', ar: 'الأساسيات' },
      });
      const fresh = Season.parse(renamed.body);
      const recoded = await api.call(manager, 'PATCH', `/api/seasons/${core.id}`, {
        updatedAt: fresh.updatedAt,
        code: 'BASICS',
      });
      const archived = await api.call(manager, 'POST', `/api/seasons/${core.id}/archive`);
      const deleted = await api.call(manager, 'DELETE', `/api/seasons/${core.id}`);

      expect(renamed.status).toBe(200);
      expect(fresh.code).toBe('CORE');
      for (const reply of [recoded, archived, deleted]) {
        expect(reply.status).toBe(409);
        expect(reply.body).toMatchObject({ code: 'SEASON_PROTECTED' });
      }
    });

    it('pages by code without skipping or repeating, and lets stock.view read but not write', async () => {
      const prefix = `PG${randomUUID().slice(0, 4).toUpperCase()}`;
      for (let i = 0; i < 5; i += 1) await newSeason({ code: `${prefix}${i}` });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query = `/api/seasons?q=${prefix}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const page = SeasonListResponse.parse((await api.call(editor, 'GET', query)).body);
        seen.push(...page.items.map((item) => item.code));
        cursor = page.nextCursor;
      } while (cursor);

      const write = await api.call(editor, 'POST', '/api/seasons', {
        code: code('NO'),
        name: { en: 'x' },
      });

      expect(seen).toEqual([0, 1, 2, 3, 4].map((i) => `${prefix}${i}`));
      expect(write.status).toBe(403);
    });
  });

  describe('product groups (AC-7)', () => {
    it('creates, edits with the stale check, archives, unarchives, and deletes an unused group, recording each', async () => {
      const group = await newGroup({ code: ' knit ' });
      expect(group.code).toBe('KNIT');

      const taken = await api.call(manager, 'POST', '/api/product-groups', {
        code: 'KNIT',
        name: { en: 'Again' },
      });
      const stale = await api.call(manager, 'PATCH', `/api/product-groups/${group.id}`, {
        updatedAt: '2000-01-01T00:00:00.000000Z',
        code: 'KNITS',
      });
      const edited = ProductGroup.parse(
        (
          await api.call(manager, 'PATCH', `/api/product-groups/${group.id}`, {
            updatedAt: group.updatedAt,
            code: 'KNITS',
          })
        ).body,
      );
      const archived = await api.call(manager, 'POST', `/api/product-groups/${group.id}/archive`);
      const unarchived = await api.call(
        manager,
        'POST',
        `/api/product-groups/${group.id}/unarchive`,
      );
      const deleted = await api.call(manager, 'DELETE', `/api/product-groups/${group.id}`);

      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'PRODUCT_GROUP_CODE_TAKEN' });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'STALE_RECORD' });
      expect(edited.code).toBe('KNITS');
      expect(ProductGroup.parse(archived.body).archived).toBe(true);
      expect(ProductGroup.parse(unarchived.body).archived).toBe(false);
      expect(deleted.status).toBe(204);
      expect(await entriesOf(group.id)).toMatchObject([
        { action: 'product_group.created', record_type: 'product_group', record_label: 'KNIT' },
        {
          action: 'product_group.edited',
          record_label: 'KNITS',
          before: { code: 'KNIT' },
          after: { code: 'KNITS' },
        },
        { action: 'product_group.archived' },
        { action: 'product_group.unarchived' },
        { action: 'product_group.deleted', before: { code: 'KNITS' } },
      ]);
    });

    it('refuses an archived group on a new style (422 ARCHIVED) and deleting a group in use (409 IN_USE)', async () => {
      const group = await newGroup();
      await newStyle({ productGroupId: group.id });
      await api.call(manager, 'POST', `/api/product-groups/${group.id}/archive`);

      const createWith = await api.call(manager, 'POST', '/api/products', {
        name: { en: 'New' },
        variants: [{ sku: code('NG-') }],
        productGroupId: group.id,
      });
      const refused = await api.call(manager, 'DELETE', `/api/product-groups/${group.id}`);
      const unknown = await api.call(manager, 'POST', '/api/products', {
        name: { en: 'New' },
        variants: [{ sku: code('NU-') }],
        productGroupId: randomUUID(),
      });

      expect(createWith.status).toBe(422);
      expect(createWith.body).toMatchObject({ code: 'ARCHIVED' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'IN_USE' });
      expect(unknown.status).toBe(404);
    });

    it('lets MAIN be renamed but never recoded, archived, or deleted (409 PRODUCT_GROUP_PROTECTED)', async () => {
      const main = await seeded('/api/product-groups', 'MAIN');
      const list = ProductGroupListResponse.parse(
        (await api.call(editor, 'GET', '/api/product-groups?q=MAIN')).body,
      );
      expect(list.items.find((item) => item.code === 'MAIN')?.protected).toBe(true);

      const renamed = await api.call(manager, 'PATCH', `/api/product-groups/${main.id}`, {
        updatedAt: main.updatedAt,
        name: { en: 'Main line' },
      });
      const fresh = ProductGroup.parse(renamed.body);
      const recoded = await api.call(manager, 'PATCH', `/api/product-groups/${main.id}`, {
        updatedAt: fresh.updatedAt,
        code: 'LINE',
      });
      const archived = await api.call(manager, 'POST', `/api/product-groups/${main.id}/archive`);
      const deleted = await api.call(manager, 'DELETE', `/api/product-groups/${main.id}`);

      expect(renamed.status).toBe(200);
      for (const reply of [recoded, archived, deleted]) {
        expect(reply.status).toBe(409);
        expect(reply.body).toMatchObject({ code: 'PRODUCT_GROUP_PROTECTED' });
      }
    });
  });
});
