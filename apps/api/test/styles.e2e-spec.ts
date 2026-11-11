import { randomUUID } from 'node:crypto';
import {
  AssignStylesResponse,
  Season,
  SkuDetail,
  SkuListResponse,
  StyleDetail,
  StyleListResponse,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0012 milestone 2 (AC-8, AC-9, AC-10, AC-17): styles, variants, and barcodes through the
// running api on its own scratch database. This file is the registry `proof` of style.edited,
// style.code_changed, style.variant_added, sku.barcode_added, and sku.barcode_removed. A refused
// or no change write records nothing.
describe('styles, variants, and barcodes (spec 0012, AC-8 to AC-10)', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let manager: string;
  let editor: string;
  let editorId: string;
  let n = 0;
  const code = (prefix: string) => {
    n += 1;
    return `${prefix}-${n}`;
  };

  beforeAll(async () => {
    api = await startInProcessApi();
    manager = await api.signIn((await api.addPerson(['manager'])).email);
    const person = await api.addPerson(['operations']);
    editorId = person.id;
    editor = await api.signIn(person.email);
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
      correlation_id: string;
      before: unknown;
      after: unknown;
    }>(
      `SELECT action, record_type, record_label, actor_user_id, actor_hat, correlation_id,
              before, after
       FROM audit_entries WHERE record_id = $1 ORDER BY recorded_at, id`,
      [id],
    );
    return rows;
  }

  async function newStyle(
    body: Record<string, unknown> = {},
    name: { en?: string; ar?: string } = { en: 'Round Tee' },
  ) {
    const reply = await api.call(editor, 'POST', '/api/products', {
      name,
      variants: [{ sku: code('TEE'), price: '250.00' }],
      ...body,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return SkuDetail.parse(reply.body);
  }

  async function style(id: string) {
    const reply = await api.call(editor, 'GET', `/api/styles/${id}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return StyleDetail.parse(reply.body);
  }

  async function newSeason() {
    const reply = await api.call(manager, 'POST', '/api/seasons', {
      code: `SN${++n}`,
      name: { en: 'Season' },
    });
    expect(reply.status).toBe(201);
    return Season.parse(reply.body);
  }

  function addVariant(styleId: string, body: Record<string, unknown>) {
    return api.call(editor, 'POST', `/api/styles/${styleId}/variants`, body);
  }

  const size = (value: string) => ({ name: { en: 'Size' }, value: { en: value } });
  const color = (value: string) => ({ name: { en: 'Color' }, value: { en: value } });

  describe('creating a product with style fields (AC-10)', () => {
    it('takes an optional style code, season, and group; defaults are the SKU code, none, and MAIN', async () => {
      const season = await newSeason();
      const plain = await newStyle();
      const styled = await newStyle({ styleCode: ' polo-27 ', seasonId: season.id });
      const taken = await api.call(editor, 'POST', '/api/products', {
        name: { en: 'Clash' },
        variants: [{ sku: code('CLASH') }],
        styleCode: 'POLO-27',
      });

      expect(plain.style.code).toBe(plain.code);
      expect(plain.season).toBeNull();
      expect(plain.productGroup.code).toBe('MAIN');
      expect(styled.style.code).toBe('POLO-27');
      expect(styled.season?.code).toBe(season.code);
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'STYLE_CODE_TAKEN' });
    });

    // Review M2 minor 4: a defaulted style code that only a style holds is STYLE_CODE_TAKEN; the
    // SKU code itself is free. SKU_TAKEN only when a SKU holds the code.
    it('answers STYLE_CODE_TAKEN for a free SKU whose code a recoded style holds, SKU_TAKEN for a held one', async () => {
      const first = await newStyle();
      const current = await style(first.productId);
      const freed = code('POLO');
      const recoded = await api.call(manager, 'PATCH', `/api/styles/${first.productId}/code`, {
        updatedAt: current.updatedAt,
        code: freed,
      });
      expect(recoded.status, JSON.stringify(recoded.body)).toBe(200);

      const styleHeld = await api.call(editor, 'POST', '/api/products', {
        name: { en: 'Polo' },
        variants: [{ sku: freed }],
      });
      const skuHeld = await api.call(editor, 'POST', '/api/products', {
        name: { en: 'Again' },
        variants: [{ sku: first.code }],
      });

      expect(styleHeld.status).toBe(409);
      expect(styleHeld.body).toMatchObject({ code: 'STYLE_CODE_TAKEN' });
      expect(skuHeld.status).toBe(409);
      expect(skuHeld.body).toMatchObject({ code: 'SKU_TAKEN' });
    });
  });

  describe('adding variants (AC-10)', () => {
    it('appends options with their roles and values, matching names and values after normalizing', async () => {
      const first = await newStyle();
      const styleId = first.productId;

      const medium = await addVariant(styleId, {
        sku: code('TEE-BLK-M'),
        options: [size('M'), color('Black')],
        price: '٢٦٠',
        barcode: ` ٦٢٢٠${n} `,
      });
      const large = await addVariant(styleId, {
        sku: code('TEE-BLK-L'),
        options: [
          { name: { en: '  SIZE ' }, value: { en: 'L' } },
          { name: { en: 'COLOR', ar: 'اللون' }, value: { en: 'black' } },
        ],
      });

      expect(medium.status, JSON.stringify(medium.body)).toBe(201);
      expect(large.status, JSON.stringify(large.body)).toBe(201);
      const sku = SkuDetail.parse(medium.body);
      expect(sku).toMatchObject({ price: '260.00', productId: styleId });
      expect(sku.barcodes.map((barcode) => barcode.code)).toEqual([`6220${n - 1}`]);
      const detail = await style(styleId);
      expect(detail.options).toMatchObject([
        { name: { en: 'Size' }, role: 'size', position: 0, values: [{ en: 'M' }, { en: 'L' }] },
        { name: { en: 'Color' }, role: 'color', position: 1, values: [{ en: 'Black' }] },
      ]);
      expect(detail.variants.map((variant) => variant.options.map((o) => o.value.en))).toEqual([
        [],
        ['L', 'Black'],
        ['M', 'Black'],
      ]);
      // The new option values are in the search document at once.
      const found = SkuListResponse.parse(
        (await api.call(editor, 'GET', `/api/skus?q=black round&styleId=${styleId}`)).body,
      );
      expect(found.items.map((item) => item.code)).toEqual([
        SkuDetail.parse(large.body).code,
        sku.code,
      ]);
      const entries = await entriesOf(styleId);
      expect(entries.map((entry) => entry.action)).toEqual([
        'style.variant_added',
        'style.variant_added',
      ]);
      expect(entries[0]).toMatchObject({
        record_type: 'style',
        record_label: first.style.code,
        actor_user_id: editorId,
        actor_hat: 'operations',
        after: { sku: sku.code, price: '260', barcode: `6220${n - 1}` },
      });
    });

    it('infers an Arabic size name and gives an unknown name the role other', async () => {
      const first = await newStyle({}, { ar: 'قميص' });

      const reply = await addVariant(first.productId, {
        sku: code('QMS'),
        options: [
          { name: { ar: 'المقاس' }, value: { ar: 'كبير' } },
          { name: { en: 'Fit' }, value: { en: 'Slim' } },
        ],
      });

      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      expect((await style(first.productId)).options.map((option) => option.role)).toEqual([
        'size',
        'other',
      ]);
    });

    it('refuses a duplicate combination, a fourth option, a taken SKU, a taken barcode, and an archived style, writing nothing', async () => {
      const first = await newStyle();
      const styleId = first.productId;
      await addVariant(styleId, { sku: code('V'), options: [size('S'), color('Red')] });
      const holder = await newStyle();
      const barcode = `HOLD${n}`;
      await api.call(editor, 'POST', `/api/skus/${holder.id}/barcodes`, { code: barcode });
      const before = await style(styleId);

      const duplicate = await addVariant(styleId, {
        sku: code('DUP'),
        options: [color('red'), size('s')],
      });
      const sameAsFirst = await addVariant(styleId, { sku: code('EMPTY'), options: [] });
      const fourth = await addVariant(styleId, {
        sku: code('FOUR'),
        options: [
          size('M'),
          color('Red'),
          { name: { en: 'Fit' }, value: { en: 'Slim' } },
          { name: { en: 'Sleeve' }, value: { en: 'Long' } },
        ],
      });
      const skuTaken = await addVariant(styleId, { sku: first.code, options: [size('XL')] });
      const barcodeTaken = await addVariant(styleId, {
        sku: code('BC'),
        options: [size('XS')],
        barcode: barcode.toLowerCase(),
      });
      const unknown = await addVariant(randomUUID(), { sku: code('NONE') });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({ code: 'OPTION_COMBINATION_TAKEN' });
      expect(sameAsFirst.status).toBe(409);
      expect(sameAsFirst.body).toMatchObject({ code: 'OPTION_COMBINATION_TAKEN' });
      expect(fourth.status).toBe(400);
      const threeNew = await addVariant(styleId, {
        sku: code('THREE'),
        options: [
          size('M'),
          { name: { en: 'Fit' }, value: { en: 'Slim' } },
          { name: { en: 'Sleeve' }, value: { en: 'Long' } },
        ],
      });
      expect(threeNew.status).toBe(422);
      expect(threeNew.body).toMatchObject({ code: 'TOO_MANY_OPTIONS' });
      expect(skuTaken.status).toBe(409);
      expect(skuTaken.body).toMatchObject({ code: 'SKU_TAKEN' });
      expect(barcodeTaken.status).toBe(409);
      expect(barcodeTaken.body).toMatchObject({ code: 'BARCODE_TAKEN', skuCode: holder.code });
      expect(unknown.status).toBe(404);
      // Nothing of the refused writes stuck: no new option, value, variant, or entry.
      expect(await style(styleId)).toEqual(before);
      expect((await entriesOf(styleId)).map((entry) => entry.action)).toEqual([
        'style.variant_added',
      ]);

      // A style whose last variant is archived takes no new variant.
      const lone = await newStyle();
      const archived = await api.call(manager, 'POST', `/api/skus/${lone.id}/archive`);
      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
      const toArchived = await addVariant(lone.productId, { sku: code('LATE') });
      expect(toArchived.status).toBe(422);
      expect(toArchived.body).toMatchObject({ code: 'ARCHIVED' });
    });
  });

  // Review M2 nits 2 and 4: one status per route. An option given twice, or a name or value that
  // normalizes to nothing (it would never match, so each add would append a duplicate), answers
  // 400 INVALID_INPUT like a bad body, and writes nothing.
  describe('refusing unusable option input (AC-10)', () => {
    it('answers 400 INVALID_INPUT for a repeated option and for a name or value with no letter or digit', async () => {
      const first = await newStyle();
      const before = await style(first.productId);

      const repeated = await addVariant(first.productId, {
        sku: code('REP'),
        options: [size('M'), { name: { en: 'SIZE' }, value: { en: 'L' } }],
      });
      const blankName = await addVariant(first.productId, {
        sku: code('BLANK'),
        options: [{ name: { en: '-' }, value: { en: 'M' } }],
      });
      const blankValue = await addVariant(first.productId, {
        sku: code('BLANK'),
        options: [{ name: { en: 'Size' }, value: { en: '--', ar: '.' } }],
      });
      const badBody = await addVariant(first.productId, { sku: 'has space' });

      for (const reply of [repeated, blankName, blankValue, badBody]) {
        expect(reply.status, JSON.stringify(reply.body)).toBe(400);
        expect(reply.body).toMatchObject({ code: 'INVALID_INPUT' });
      }
      expect(await style(first.productId)).toEqual(before);
      expect(await entriesOf(first.productId)).toEqual([]);
    });
  });

  describe('the style list and page (AC-8)', () => {
    it('filters by season, no season, group, status, and q (style code prefix or a variant match)', async () => {
      const season = await newSeason();
      const groupReply = await api.call(manager, 'POST', '/api/product-groups', {
        code: `GL${++n}`,
        name: { en: 'Group' },
      });
      const groupId = (groupReply.body as { id: string }).id;
      const tag = `ZQ${randomUUID().slice(0, 6).toUpperCase()}`;
      const a = await newStyle({ styleCode: `${tag}-A`, seasonId: season.id }, { en: 'Linen' });
      const b = await newStyle({ styleCode: `${tag}-B`, productGroupId: groupId }, { en: 'Wool' });
      const c = await newStyle({ styleCode: `${tag}-C` }, { en: 'Cotton' });
      await addVariant(c.productId, { sku: `${tag}-SHIRT-NAVY`, options: [color('Navy')] });

      const list = async (query: string) =>
        StyleListResponse.parse(
          (await api.call(editor, 'GET', `/api/styles?${query}`)).body,
        ).items.map((item) => item.code);

      expect(await list(`q=${tag.toLowerCase()}`)).toEqual([`${tag}-A`, `${tag}-B`, `${tag}-C`]);
      expect(await list(`q=${tag}&seasonId=${season.id}`)).toEqual([`${tag}-A`]);
      expect(await list(`q=${tag}&seasonId=none`)).toEqual([`${tag}-B`, `${tag}-C`]);
      expect(await list(`q=${tag}&productGroupId=${groupId}`)).toEqual([`${tag}-B`]);
      expect(await list(`q=navy cotton`)).toEqual([`${tag}-C`]);
      expect(await list(`q=${tag}-SHIRT`)).toEqual([`${tag}-C`]);

      const summary = StyleListResponse.parse(
        (await api.call(editor, 'GET', `/api/styles?q=${tag}`)).body,
      ).items.find((item) => item.code === `${tag}-C`);
      expect(summary).toMatchObject({ activeVariantCount: 2, archived: false, season: null });

      await api.call(manager, 'POST', `/api/skus/${a.id}/archive`);
      expect(await list(`q=${tag}`)).toEqual([`${tag}-B`, `${tag}-C`]);
      expect(await list(`q=${tag}&status=archived`)).toEqual([`${tag}-A`]);
      expect(b.style.code).toBe(`${tag}-B`);

      // Paging by code: one row a page, no row twice, none skipped.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = StyleListResponse.parse(
          (
            await api.call(
              editor,
              'GET',
              `/api/styles?q=${tag}&status=active&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
            )
          ).body,
        );
        seen.push(...page.items.map((item) => item.code));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([`${tag}-B`, `${tag}-C`]);
      expect((await api.call(editor, 'GET', '/api/styles?cursor=bad!')).status).toBe(400);

      // Review M2 nit 1: an active style is found by its active variants only; once its only
      // navy variant is archived, `navy` no longer lists it, while its code still does.
      const navy = SkuListResponse.parse(
        (await api.call(editor, 'GET', `/api/skus?q=${tag}-SHIRT-NAVY`)).body,
      ).items[0];
      if (!navy) throw new Error('the navy variant is missing');
      expect((await api.call(manager, 'POST', `/api/skus/${navy.id}/archive`)).status).toBe(200);
      expect(await list(`q=navy cotton`)).toEqual([]);
      expect(await list(`q=${tag}-SHIRT`)).toEqual([]);
      expect(await list(`q=${tag}-C`)).toContain(`${tag}-C`);
      expect((await api.call(editor, 'GET', `/api/styles/${randomUUID()}`)).status).toBe(404);
    });
  });

  describe('editing styles (AC-9)', () => {
    it('edits name, description, season, group, and tags with the stale check, recording the changed fields', async () => {
      const first = await newStyle();
      const season = await newSeason();
      const current = await style(first.productId);

      const edited = await api.call(editor, 'PATCH', `/api/styles/${first.productId}`, {
        updatedAt: current.updatedAt,
        name: { en: 'Boxy Tee', ar: 'تيشيرت واسع' },
        description: { en: 'Heavy cotton' },
        seasonId: season.id,
        tags: ['summer', ' summer ', 'basics'],
      });
      const stale = await api.call(editor, 'PATCH', `/api/styles/${first.productId}`, {
        updatedAt: current.updatedAt,
        tags: [],
      });
      const tooMany = await api.call(editor, 'PATCH', `/api/styles/${first.productId}`, {
        updatedAt: current.updatedAt,
        tags: Array.from({ length: 51 }, (_, i) => `t${i}`),
      });

      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const detail = StyleDetail.parse(edited.body);
      expect(detail).toMatchObject({
        name: { en: 'Boxy Tee', ar: 'تيشيرت واسع' },
        description: { en: 'Heavy cotton' },
        season: { id: season.id },
        tags: ['summer', 'basics'],
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'STALE_RECORD' });
      expect(tooMany.status).toBe(400);
      // The rename reached the variants' search text.
      const found = SkuListResponse.parse(
        (await api.call(editor, 'GET', `/api/skus?q=boxy&styleId=${first.productId}`)).body,
      );
      expect(found.items.map((item) => item.id)).toEqual([first.id]);
      const unchanged = await api.call(editor, 'PATCH', `/api/styles/${first.productId}`, {
        updatedAt: detail.updatedAt,
        tags: ['summer', 'basics'],
      });
      expect(unchanged.status).toBe(200);
      const entries = await entriesOf(first.productId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'style.edited',
        record_label: first.style.code,
        before: {
          name: { en: 'Round Tee', ar: null },
          description: null,
          seasonId: null,
          seasonCode: null,
          tags: [],
        },
        after: {
          name: { en: 'Boxy Tee', ar: 'تيشيرت واسع' },
          description: { en: 'Heavy cotton', ar: null },
          seasonId: season.id,
          seasonCode: season.code,
          tags: ['summer', 'basics'],
        },
      });
    });

    it('assigns a season to 3 styles all or nothing: an unknown id changes none, then 3 entries share one correlation id', async () => {
      const styles = [await newStyle(), await newStyle(), await newStyle()];
      const ids = styles.map((sku) => sku.productId);
      const season = await newSeason();
      const missing = randomUUID();

      const refused = await api.call(editor, 'POST', '/api/styles/assign', {
        styleIds: [...ids.slice(0, 2), missing],
        seasonId: season.id,
      });
      const noTarget = await api.call(editor, 'POST', '/api/styles/assign', { styleIds: ids });
      const twice = await api.call(editor, 'POST', '/api/styles/assign', {
        styleIds: [ids[0], ids[0]],
        seasonId: season.id,
      });
      for (const id of ids) expect((await style(id)).season).toBeNull();
      const assigned = await api.call(editor, 'POST', '/api/styles/assign', {
        styleIds: ids,
        seasonId: season.id,
      });
      const again = await api.call(editor, 'POST', '/api/styles/assign', {
        styleIds: ids,
        seasonId: season.id,
      });

      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ code: 'NOT_FOUND', missingIds: [missing] });
      expect(noTarget.status).toBe(422);
      expect(noTarget.body).toMatchObject({ code: 'INVALID_INPUT' });
      expect(twice.status).toBe(422);
      expect(AssignStylesResponse.parse(assigned.body)).toEqual({ updated: 3 });
      expect(AssignStylesResponse.parse(again.body)).toEqual({ updated: 0 });
      for (const id of ids) expect((await style(id)).season?.id).toBe(season.id);
      const entries = (await Promise.all(ids.map(entriesOf))).flat();
      expect(entries.map((entry) => entry.action)).toEqual([
        'style.edited',
        'style.edited',
        'style.edited',
      ]);
      expect(new Set(entries.map((entry) => entry.correlation_id)).size).toBe(1);
      expect(entries[0]).toMatchObject({
        before: { seasonId: null, seasonCode: null },
        after: { seasonId: season.id, seasonCode: season.code },
      });
    });

    // Review M2 minor 5: ids compare lowercased. Uppercase style ids are found, an id and its
    // uppercase twin are one style (422 like any repeated id), and an edit that names the season
    // the style holds in uppercase changes nothing and records nothing.
    it('takes uppercase style, season, and group ids as the same ids', async () => {
      const first = await newStyle();
      const season = await newSeason();
      const id = first.productId;

      const assigned = await api.call(editor, 'POST', '/api/styles/assign', {
        styleIds: [id.toUpperCase()],
        seasonId: season.id.toUpperCase(),
      });
      const twins = await api.call(editor, 'POST', '/api/styles/assign', {
        styleIds: [id, id.toUpperCase()],
        seasonId: season.id,
      });
      const current = await style(id);
      const sameAgain = await api.call(editor, 'PATCH', `/api/styles/${id}`, {
        updatedAt: current.updatedAt,
        seasonId: season.id.toUpperCase(),
        productGroupId: first.productGroup.id.toUpperCase(),
      });

      expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
      expect(AssignStylesResponse.parse(assigned.body)).toEqual({ updated: 1 });
      expect(twins.status).toBe(422);
      expect(sameAgain.status, JSON.stringify(sameAgain.body)).toBe(200);
      expect(StyleDetail.parse(sameAgain.body).updatedAt).toBe(current.updatedAt);
      expect(await entriesOf(id)).toMatchObject([
        {
          action: 'style.edited',
          before: { seasonId: null },
          after: { seasonId: season.id, seasonCode: season.code },
        },
      ]);
    });

    it('changes a style code with catalog.manage only (409 STYLE_CODE_TAKEN, stale check), recording style.code_changed', async () => {
      const first = await newStyle();
      const other = await newStyle();
      const current = await style(first.productId);
      const target = code('BOXY');

      const forbidden = await api.call(editor, 'PATCH', `/api/styles/${first.productId}/code`, {
        updatedAt: current.updatedAt,
        code: target,
      });
      const taken = await api.call(manager, 'PATCH', `/api/styles/${first.productId}/code`, {
        updatedAt: current.updatedAt,
        code: other.style.code.toLowerCase(),
      });
      const changed = await api.call(manager, 'PATCH', `/api/styles/${first.productId}/code`, {
        updatedAt: current.updatedAt,
        code: target.toLowerCase(),
      });
      const stale = await api.call(manager, 'PATCH', `/api/styles/${first.productId}/code`, {
        updatedAt: current.updatedAt,
        code: code('LATE'),
      });

      expect(forbidden.status).toBe(403);
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'STYLE_CODE_TAKEN' });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(StyleDetail.parse(changed.body).code).toBe(target);
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'STALE_RECORD' });
      // The SKU code is untouched; the style code is in the search text.
      const sku = SkuDetail.parse((await api.call(editor, 'GET', `/api/skus/${first.id}`)).body);
      expect(sku.code).toBe(first.code);
      expect(await entriesOf(first.productId)).toMatchObject([
        {
          action: 'style.code_changed',
          record_label: target,
          before: { code: first.style.code },
          after: { code: target },
        },
      ]);
    });
  });

  describe('barcodes (AC-10)', () => {
    it('adds a shaped barcode, refuses one any SKU holds, removes it, and records both', async () => {
      const first = await newStyle();
      const other = await newStyle();

      const added = await api.call(editor, 'POST', `/api/skus/${first.id}/barcodes`, {
        code: ' ab-٤٤٥ ',
      });
      const takenElsewhere = await api.call(editor, 'POST', `/api/skus/${other.id}/barcodes`, {
        code: 'AB-445',
      });
      const bad = await api.call(editor, 'POST', `/api/skus/${first.id}/barcodes`, {
        code: 'has space',
      });
      const unknownSku = await api.call(editor, 'POST', `/api/skus/${randomUUID()}/barcodes`, {
        code: `X${n}`,
      });
      const sku = SkuDetail.parse(added.body);
      const barcode = sku.barcodes[0];
      if (!barcode) throw new Error('no barcode');
      const wrongSku = await api.call(
        editor,
        'DELETE',
        `/api/skus/${other.id}/barcodes/${barcode.id}`,
      );
      const scanned = SkuListResponse.parse(
        (await api.call(editor, 'GET', '/api/skus?q=ab-445')).body,
      );
      const removed = await api.call(
        editor,
        'DELETE',
        `/api/skus/${first.id}/barcodes/${barcode.id}`,
      );
      const again = await api.call(
        editor,
        'DELETE',
        `/api/skus/${first.id}/barcodes/${barcode.id}`,
      );

      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect(sku.barcodes.map((item) => item.code)).toEqual(['AB-445']);
      expect(takenElsewhere.status).toBe(409);
      expect(takenElsewhere.body).toMatchObject({ code: 'BARCODE_TAKEN', skuCode: first.code });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ code: 'INVALID_INPUT' });
      expect(unknownSku.status).toBe(404);
      expect(wrongSku.status).toBe(404);
      expect(scanned.items.map((item) => item.id)).toEqual([first.id]);
      expect(removed.status).toBe(204);
      expect(again.status).toBe(404);
      expect(await entriesOf(first.id)).toMatchObject([
        {
          action: 'sku.barcode_added',
          record_type: 'sku',
          record_label: first.code,
          after: { barcode: 'AB-445' },
        },
        { action: 'sku.barcode_removed', before: { barcode: 'AB-445' } },
      ]);
      expect(await entriesOf(other.id)).toEqual([]);
    });
  });
});
