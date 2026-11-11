import { randomUUID } from 'node:crypto';
import {
  AuditEntryDetail,
  AuditEntryListResponse,
  CostRecordListResponse,
  RecordCostResponse,
  Season,
  SkuDetail,
  StyleDetail,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CostService } from '../src/catalog/cost.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';
import { fixtures, ledgerHarness, posting, type LedgerHarness } from './ledger.js';

// Spec 0002, A12 (AC-30): the cost lookup against PostgreSQL, with the spec's worked example.
describe('CostService.costFor', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let costs: CostService;
  let make: ReturnType<typeof fixtures>;

  beforeAll(async () => {
    h = await ledgerHarness();
    costs = new CostService(h.app);
    make = fixtures(h.owner);
  });

  afterAll(async () => {
    await h?.close();
  });

  async function record(
    variantId: string,
    row: { override?: boolean; cost: string; from: string; basis?: string },
  ): Promise<void> {
    await h.owner.pool.query(
      `INSERT INTO cost_records (product_id, variant_id, season_id, cost_basis, unit_cost, effective_from)
       SELECT product_id, CASE WHEN $2::boolean THEN id END,
              (SELECT id FROM seasons WHERE code = 'CORE'), $3::cost_basis, $4, $5
       FROM product_variants WHERE id = $1`,
      [variantId, row.override ?? false, row.basis ?? 'factory_invoice', row.cost, row.from],
    );
  }

  it('follows the worked example: style 120, variant override 130, next season 140', async () => {
    const variantId = await make.variant();
    await record(variantId, { cost: '120.0000', from: '2026-03-01' });
    await record(variantId, { override: true, cost: '130.0000', from: '2026-04-01' });
    await record(variantId, { cost: '140.0000', from: '2027-03-01', basis: 'production_run' });

    expect(await costs.costFor(variantId, '2026-03-15')).toEqual({
      status: 'set',
      unitCost: '120.0000',
      costBasis: 'factory_invoice',
    });
    expect(await costs.costFor(variantId, '2026-05-01')).toMatchObject({ unitCost: '130.0000' });
    expect(await costs.costFor(variantId, '2027-03-02')).toEqual({
      status: 'set',
      unitCost: '140.0000',
      costBasis: 'production_run',
    });
    expect(await costs.costFor(variantId, '2026-02-28')).toEqual({ status: 'not_set' });
  });

  it('lets a later record on the same day correct a mistyped one, and labels an estimate', async () => {
    const variantId = await make.variant();
    await record(variantId, { cost: '12.0000', from: '2026-03-01', basis: 'estimate' });
    await record(variantId, { cost: '120.0000', from: '2026-03-01', basis: 'estimate' });

    expect(await costs.costFor(variantId, '2026-03-01')).toEqual({
      status: 'set',
      unitCost: '120.0000',
      costBasis: 'estimate',
    });
  });

  it('is not set for a style with no record, and a new record never changes a posted movement', async () => {
    const variantId = await make.variant();
    const locationId = await make.location();
    expect(await costs.costFor(variantId, '2026-03-01')).toEqual({ status: 'not_set' });

    const posted = await h.ledger.post(
      posting([{ variantId, locationId, quantity: 2, unitCost: '50.0000' }], {
        sourceType: 'opening_balance',
      }),
    );
    await record(variantId, { cost: '75.0000', from: '2026-01-01' });

    const { rows } = await h.owner.pool.query<{ unit_cost: string }>(
      'SELECT unit_cost FROM stock_movements WHERE id = $1',
      [posted.movements[0]?.id],
    );
    expect(rows[0]?.unit_cost).toBe('50.0000');
  });

  it('is not set for a variant that does not exist', async () => {
    expect(await costs.costFor('00000000-0000-7000-8000-000000000000', '2026-03-01')).toEqual({
      status: 'not_set',
    });
  });

  // Spec 0012, AC-12: many in one query equals one at a time, for every id and day.
  it('answers costForMany exactly as costFor for every id, plus the date and inherited or override', async () => {
    const worked = await make.variant();
    await record(worked, { cost: '120.0000', from: '2026-03-01' });
    await record(worked, { override: true, cost: '130.0000', from: '2026-04-01' });
    await record(worked, { cost: '140.0000', from: '2027-03-01', basis: 'production_run' });
    const estimate = await make.variant();
    await record(estimate, { cost: '12.0000', from: '2026-03-01', basis: 'estimate' });
    await record(estimate, { cost: '15.0000', from: '2026-03-01', basis: 'estimate' });
    const bare = await make.variant();
    const unknown = '00000000-0000-7000-8000-000000000000';
    const ids = [worked, estimate, bare, unknown];

    for (const day of ['2026-02-28', '2026-03-15', '2026-05-01', '2027-03-02']) {
      const many = await costs.costForMany(ids, day);
      expect([...many.keys()]).toEqual(ids);
      for (const id of ids) {
        const one = await costs.costFor(id, day);
        const answer = many.get(id);
        if (one.status === 'not_set') expect(answer).toEqual(one);
        else expect(answer).toMatchObject(one);
      }
    }
    const may = await costs.costForMany(ids, '2026-05-01');
    expect(may.get(worked)).toEqual({
      status: 'set',
      unitCost: '130.0000',
      costBasis: 'factory_invoice',
      effectiveFrom: '2026-04-01',
      inheritedFrom: 'variant',
    });
    expect(may.get(estimate)).toEqual({
      status: 'set',
      unitCost: '15.0000',
      costBasis: 'estimate',
      effectiveFrom: '2026-03-01',
      inheritedFrom: 'style',
    });
    expect(may.get(bare)).toEqual({ status: 'not_set' });
    expect((await costs.costForMany(ids, '2027-03-02')).get(worked)).toMatchObject({
      unitCost: '140.0000',
      inheritedFrom: 'style',
    });
    expect((await costs.costForMany([], '2026-05-01')).size).toBe(0);
  });
});

// Spec 0012 milestone 3 (AC-12, AC-13, AC-16, AC-17): the style page's cost and the cost record
// routes through the running api. This file is the registry `proof` of cost_record.recorded.
describe(
  'style cost, visible and recordable (spec 0012, AC-12, AC-13)',
  { timeout: 120_000 },
  () => {
    let api: InProcessApi;
    let owner: string;
    let ownerId: string;
    let warehouse: string;
    let editorWithoutCost: string;
    let managerWithoutCost: string;
    let today: string;
    let n = 0;
    const code = (prefix: string) => `${prefix}-${(n += 1)}-${randomUUID().slice(0, 4)}`;

    beforeAll(async () => {
      api = await startInProcessApi();
      const boss = await api.addPerson(['manager'], { costView: true });
      ownerId = boss.id;
      owner = await api.signIn(boss.email);
      warehouse = await api.signIn((await api.addPerson(['warehouse'])).email);
      editorWithoutCost = await api.signIn((await api.addPerson(['operations'])).email);
      managerWithoutCost = await api.signIn((await api.addPerson(['manager'])).email);
      const { rows } = await api.owner.pool.query<{ day: string }>(
        `SELECT to_char(ssd_operating_day(now()), 'YYYY-MM-DD') AS day`,
      );
      today = rows[0]?.day as string;
    });

    afterAll(async () => {
      await api?.close();
    });

    async function newStyle(): Promise<SkuDetail> {
      const reply = await api.call(owner, 'POST', '/api/products', {
        name: { en: 'Cost Tee' },
        variants: [{ sku: code('CT'), price: '250.00' }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body);
    }

    async function addVariant(styleId: string): Promise<SkuDetail> {
      const reply = await api.call(owner, 'POST', `/api/styles/${styleId}/variants`, {
        sku: code('CTV'),
        options: [{ name: { en: 'Size' }, value: { en: code('S') } }],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return SkuDetail.parse(reply.body);
    }

    async function newSeason(): Promise<Season> {
      const reply = await api.call(owner, 'POST', '/api/seasons', {
        code: `SS${(n += 1)}`,
        name: { en: 'Spring summer' },
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return Season.parse(reply.body);
    }

    async function style(id: string, cookie = owner) {
      const reply = await api.call(cookie, 'GET', `/api/styles/${id}`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return { parsed: StyleDetail.parse(reply.body), raw: reply.body as StyleDetail };
    }

    const recordCost = (styleId: string, body: Record<string, unknown>, cookie = owner) =>
      api.call(cookie, 'POST', `/api/styles/${styleId}/cost-records`, body);

    /** The cost record entries of one style, oldest first. */
    async function costEntriesOf(styleId: string) {
      const { rows } = await api.owner.pool.query<{
        action: string;
        record_type: string;
        record_label: string;
        actor_user_id: string;
        reason: string | null;
        after: Record<string, unknown>;
      }>(
        `SELECT action, record_type, record_label, actor_user_id, reason, after
       FROM audit_entries WHERE record_id = $1 AND action = 'cost_record.recorded'
       ORDER BY recorded_at, id`,
        [styleId],
      );
      return rows;
    }

    it('shows Not set, never 0, on a new style, and no cost key without cost.view', async () => {
      const sku = await newStyle();

      const held = await style(sku.productId);
      const plain = await style(sku.productId, warehouse);

      expect(held.parsed.variants.map((variant) => variant.cost)).toEqual([{ status: 'not_set' }]);
      expect(plain.raw.variants.every((variant) => !('cost' in variant))).toBe(true);
      expect(JSON.stringify(plain.raw)).not.toContain('unitCost');
    });

    it('records a style cost (SS26) every variant inherits, and an override for one variant', async () => {
      const first = await newStyle();
      const second = await addVariant(first.productId);
      const season = await newSeason();

      const styleRecord = await recordCost(first.productId, {
        seasonId: season.id,
        costBasis: 'factory_invoice',
        unitCost: '١٢٠',
        effectiveFrom: today,
        source: 'INV-26-001',
      });
      expect(styleRecord.status, JSON.stringify(styleRecord.body)).toBe(201);
      const added = RecordCostResponse.parse(styleRecord.body);
      expect(added.record).toMatchObject({
        variant: null,
        season: { id: season.id, code: season.code },
        costBasis: 'factory_invoice',
        unitCost: '120.0000',
        effectiveFrom: today,
        source: 'INV-26-001',
        recordedBy: { id: ownerId },
      });
      const inherited = {
        status: 'set',
        unitCost: '120.0000',
        costBasis: 'factory_invoice',
        effectiveFrom: today,
        inheritedFrom: 'style',
      };
      expect(added.variants.map((variant) => variant.cost)).toEqual([inherited, inherited]);

      const override = await recordCost(first.productId, {
        variantId: second.id,
        seasonId: season.id,
        costBasis: 'estimate',
        unitCost: '130.5',
        effectiveFrom: today,
      });
      expect(override.status, JSON.stringify(override.body)).toBe(201);
      expect(RecordCostResponse.parse(override.body).record.variant).toEqual({
        id: second.id,
        code: second.code,
      });

      const page = await style(first.productId);
      const byId = new Map(page.parsed.variants.map((variant) => [variant.id, variant.cost]));
      expect(byId.get(first.id)).toEqual(inherited);
      expect(byId.get(second.id)).toEqual({
        status: 'set',
        unitCost: '130.5000',
        costBasis: 'estimate',
        effectiveFrom: today,
        inheritedFrom: 'variant',
      });

      // The style page reads costForMany, which equals costFor for every id.
      const costs = api.app.get(CostService);
      const many = await costs.costForMany([first.id, second.id], today);
      for (const id of [first.id, second.id]) {
        expect(many.get(id)).toMatchObject(await costs.costFor(id, today));
      }

      const entries = await costEntriesOf(first.productId);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        action: 'cost_record.recorded',
        record_type: 'style',
        record_label: first.style.code,
        actor_user_id: ownerId,
        reason: null,
        after: {
          costRecordId: added.record.id,
          variantId: null,
          seasonCode: season.code,
          unitCost: '120.0000',
          effectiveFrom: today,
          source: 'INV-26-001',
        },
      });
      expect(entries[1]?.after).toMatchObject({ variantId: second.id, variantCode: second.code });
    });

    it('needs a reason for a backdated record (422 REASON_REQUIRED) and saves one given', async () => {
      const sku = await newStyle();
      const season = await newSeason();
      const body = {
        seasonId: season.id,
        costBasis: 'purchase_landed',
        unitCost: '90',
        effectiveFrom: '2000-01-01',
      };

      const refused = await recordCost(sku.productId, body);
      const blank = await recordCost(sku.productId, { ...body, reason: '   ' });
      const saved = await recordCost(sku.productId, { ...body, reason: 'Invoice found late' });

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'REASON_REQUIRED' });
      expect(blank.status).toBe(422);
      expect(blank.body).toMatchObject({ code: 'REASON_REQUIRED' });
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      const entries = await costEntriesOf(sku.productId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ reason: 'Invoice found late' });
      const { rows } = await api.owner.pool.query<{ count: string }>(
        'SELECT count(*) FROM cost_records WHERE product_id = $1',
        [sku.productId],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('takes an archived season, refuses a variant of another style, an unknown season, and a bad body', async () => {
      const sku = await newStyle();
      const other = await newStyle();
      const season = await newSeason();
      const archived = await api.call(owner, 'POST', `/api/seasons/${season.id}/archive`);
      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
      const body = {
        seasonId: season.id,
        costBasis: 'estimate',
        unitCost: '1',
        effectiveFrom: today,
      };

      const onArchived = await recordCost(sku.productId, body);
      const foreignVariant = await recordCost(sku.productId, { ...body, variantId: other.id });
      const unknownSeason = await recordCost(sku.productId, { ...body, seasonId: randomUUID() });
      const unknownStyle = await recordCost(randomUUID(), body);
      const fiveDecimals = await recordCost(sku.productId, { ...body, unitCost: '1.00001' });
      const tooBig = await recordCost(sku.productId, { ...body, unitCost: '10000000000' });
      const longSource = await recordCost(sku.productId, { ...body, source: 'x'.repeat(201) });
      const longReason = await recordCost(sku.productId, { ...body, reason: 'x'.repeat(501) });
      const noSeason = await recordCost(sku.productId, { ...body, seasonId: undefined });

      expect(onArchived.status, JSON.stringify(onArchived.body)).toBe(201);
      for (const reply of [foreignVariant, unknownSeason, unknownStyle]) {
        expect(reply.status).toBe(404);
        expect(reply.body).toMatchObject({ code: 'NOT_FOUND' });
      }
      for (const reply of [fiveDecimals, tooBig, longSource, longReason, noSeason]) {
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ code: 'INVALID_INPUT' });
      }
      const max = await recordCost(sku.productId, { ...body, unitCost: '9999999999.9999' });
      expect(max.status, JSON.stringify(max.body)).toBe(201);
    });

    it('lists the records newest recorded first, page by page', async () => {
      const sku = await newStyle();
      const season = await newSeason();
      for (const unitCost of ['10', '20', '30']) {
        const reply = await recordCost(sku.productId, {
          seasonId: season.id,
          costBasis: 'estimate',
          unitCost,
          effectiveFrom: today,
        });
        expect(reply.status).toBe(201);
      }

      const first = await api.call(
        owner,
        'GET',
        `/api/styles/${sku.productId}/cost-records?limit=2`,
      );
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const one = CostRecordListResponse.parse(first.body);
      const second = await api.call(
        owner,
        'GET',
        `/api/styles/${sku.productId}/cost-records?limit=2&cursor=${one.nextCursor}`,
      );
      const two = CostRecordListResponse.parse(second.body);
      const missing = await api.call(owner, 'GET', `/api/styles/${randomUUID()}/cost-records`);
      const badCursor = await api.call(
        owner,
        'GET',
        `/api/styles/${sku.productId}/cost-records?cursor=nope`,
      );

      expect([...one.items, ...two.items].map((row) => row.unitCost)).toEqual([
        '30.0000',
        '20.0000',
        '10.0000',
      ]);
      expect(two.nextCursor).toBeNull();
      expect(one.items[0]?.recordedBy?.name).toEqual(expect.any(String));
      expect(missing.status).toBe(404);
      expect(badCursor.status).toBe(400);
    });

    /** A style whose one variant carries a cost record dated today, so a leak would show. */
    async function costedStyle(reason?: string): Promise<SkuDetail> {
      const sku = await newStyle();
      const season = await newSeason();
      const reply = await recordCost(sku.productId, {
        seasonId: season.id,
        costBasis: 'factory_invoice',
        unitCost: '77.7',
        effectiveFrom: today,
        ...(reason ? { reason } : {}),
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      return sku;
    }

    it('records a cost dated exactly today without a reason', async () => {
      const sku = await costedStyle();
      expect(await costEntriesOf(sku.productId)).toHaveLength(1);
    });

    it('drops cost from a PATCH style answer for an editor without cost.view', async () => {
      const sku = await costedStyle();
      const { parsed } = await style(sku.productId);

      const reply = await api.call(editorWithoutCost, 'PATCH', `/api/styles/${sku.productId}`, {
        updatedAt: parsed.updatedAt,
        tags: ['edited'],
      });

      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const raw = reply.body as StyleDetail;
      expect(raw.tags).toEqual(['edited']);
      expect(raw.variants.length).toBeGreaterThan(0);
      expect(raw.variants.every((variant) => !('cost' in variant))).toBe(true);
      expect(JSON.stringify(raw)).not.toMatch(/unitCost|77\.7/);
    });

    it('drops cost from a PATCH style code answer for catalog.manage without cost.view', async () => {
      const sku = await costedStyle();
      const { parsed } = await style(sku.productId);

      const reply = await api.call(
        managerWithoutCost,
        'PATCH',
        `/api/styles/${sku.productId}/code`,
        { updatedAt: parsed.updatedAt, code: code('NEWSTYLE').toUpperCase() },
      );

      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const raw = reply.body as StyleDetail;
      expect(raw.variants.length).toBeGreaterThan(0);
      expect(raw.variants.every((variant) => !('cost' in variant))).toBe(true);
      expect(JSON.stringify(raw)).not.toMatch(/unitCost|77\.7/);
    });

    it('hides unitCost and the reason of cost_record.recorded from an audit reader without cost.view', async () => {
      const reason = 'was 120.00 and now 95.50';
      const sku = await costedStyle(reason);
      const listPath = `/api/audit/records/style/${sku.productId}/entries`;
      const exportPath = `/api/audit/entries/export?action=cost_record.recorded&recordType=style&recordId=${sku.productId}&dayFrom=${today}&dayTo=${today}`;
      const exportOf = async (cookie: string) =>
        (
          await fetch(`${api.base}${exportPath}`, {
            method: 'POST',
            headers: { cookie, origin: api.base },
          })
        ).text();

      const seen = await api.call(owner, 'GET', listPath);
      const hidden = await api.call(managerWithoutCost, 'GET', listPath);
      expect(seen.status, JSON.stringify(seen.body)).toBe(200);
      expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
      const seenItem = AuditEntryListResponse.parse(seen.body).items[0];
      const hiddenItem = AuditEntryListResponse.parse(hidden.body).items[0];
      expect(seenItem?.reason).toBe(reason);
      expect(JSON.stringify(seenItem?.after)).toContain('unitCost');
      expect(hiddenItem?.action).toBe('cost_record.recorded');
      expect(hiddenItem?.reason).toBeNull();
      expect(JSON.stringify(hidden.body)).not.toMatch(/unitCost|77\.7|95\.50/);

      const detailPath = `/api/audit/entries/${hiddenItem?.id}`;
      const detailSeen = await api.call(owner, 'GET', detailPath);
      const detailHidden = await api.call(managerWithoutCost, 'GET', detailPath);
      expect(AuditEntryDetail.parse(detailSeen.body).reason).toBe(reason);
      expect(AuditEntryDetail.parse(detailHidden.body).reason).toBeNull();
      expect(JSON.stringify(detailHidden.body)).not.toMatch(/unitCost|77\.7|95\.50/);

      const fileSeen = await exportOf(owner);
      const fileHidden = await exportOf(managerWithoutCost);
      expect(fileSeen).toContain(reason);
      expect(fileSeen).toContain('unitCost');
      expect(fileHidden).toContain('cost_record.recorded');
      expect(fileHidden).not.toMatch(/unitCost|77\.7|95\.50|was 120/);
    });

    it('answers 403 on the cost records without cost.view, and records nothing', async () => {
      const sku = await newStyle();
      const season = await newSeason();
      const body = {
        seasonId: season.id,
        costBasis: 'estimate',
        unitCost: '5',
        effectiveFrom: today,
      };

      const read = await api.call(warehouse, 'GET', `/api/styles/${sku.productId}/cost-records`);
      const add = await recordCost(sku.productId, body, warehouse);
      const addByEditor = await recordCost(sku.productId, body, editorWithoutCost);

      for (const reply of [read, add, addByEditor]) {
        expect(reply.status).toBe(403);
        expect(reply.body).toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await costEntriesOf(sku.productId)).toEqual([]);
    });
  },
);
