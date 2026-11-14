import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ChannelProductResult,
  ProductGroup,
  Season,
  SkuDetail,
  StyleDetail,
  personActor,
  systemJobActor,
  type AuditActor,
  type ChannelProductInput,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogChannelSync } from '../src/catalog/channel-sync/catalog-channel-sync.js';
import { ChannelSyncError } from '../src/catalog/channel-sync/channel-sync-error.js';
import { DATABASE } from '../src/database/database.module.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0012 milestone 4 (AC-14, AC-15, AC-17): the channel upsert contract spec 0015's connector
// calls, run through the real `CatalogChannelSync` inside transactions the test owns (READ
// COMMITTED, as the connector's), on the api's own scratch database. The products come from
// `fixtures/channel-products/*.json`: synthetic, to be replaced by recordings (each file's
// `_fixture` banner), already mapped to `ChannelProductInput`. This file is the registry `proof`
// of style.channel_created, style.channel_updated, sku.channel_created, sku.channel_linked,
// sku.channel_updated, style.channel_unlinked, and sku.channel_unlinked.
describe(
  'the channel upsert contract (spec 0012, AC-14, AC-15, AC-17)',
  { timeout: 180_000 },
  () => {
    let api: InProcessApi;
    let db: DatabaseConnection['db'];
    let sync: CatalogChannelSync;
    let editor: string;
    let manager: string;
    let n = 0;

    beforeAll(async () => {
      api = await startInProcessApi();
      db = api.app.get<DatabaseConnection>(DATABASE).db;
      sync = api.app.get(CatalogChannelSync);
      editor = await api.signIn((await api.addPerson(['operations'])).email);
      manager = await api.signIn((await api.addPerson(['manager'])).email);
    });

    afterAll(async () => {
      await api?.close();
    });

    type Input = ChannelProductInput;

    /**
     * A fixture product with its handle, SKUs, and barcodes made unique for this test (suffix `-n`),
     * coming from `storeId`.
     */
    function fixture(name: string, storeId: string = randomUUID()): Input {
      n += 1;
      const file = JSON.parse(
        readFileSync(new URL(`./fixtures/channel-products/${name}.json`, import.meta.url), 'utf8'),
      ) as { _fixture: { synthetic: boolean }; input: Input };
      expect(file._fixture.synthetic).toBe(true);
      const input = file.input;
      return {
        ...input,
        storeId,
        handle: `${input.handle}-${n}`,
        variants: input.variants.map((variant) => ({
          ...variant,
          sku: variant.sku ? `${variant.sku}-${n}` : variant.sku,
          barcode: variant.barcode ? `${variant.barcode}${n}` : variant.barcode,
        })),
      };
    }

    const actorOf = (): AuditActor => systemJobActor('connector-shopify.products', randomUUID());

    async function apply(input: Input, actor: AuditActor = actorOf()) {
      const result = await db.transaction((tx) => sync.applyProduct(tx, input, actor), {
        isolationLevel: 'read committed',
      });
      return ChannelProductResult.parse(result);
    }

    async function owner<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
      return (await api.owner.pool.query<T>(text, values)).rows;
    }

    async function setSetting(key: string, value: unknown) {
      if (value === undefined) {
        await owner(`DELETE FROM settings WHERE key = $1`, [key]);
        return;
      }
      await owner(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
    }

    async function entriesOf(correlationId: string) {
      return owner<{
        action: string;
        record_type: string;
        record_id: string;
        record_label: string;
        actor_kind: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `SELECT action, record_type, record_id, record_label, actor_kind, before, after
       FROM audit_entries WHERE correlation_id = $1 ORDER BY recorded_at, id`,
        [correlationId],
      );
    }

    /** The row versions of a style and everything under it: a write of any row changes one. */
    async function versionsOf(styleId: string) {
      return owner(
        `SELECT 'p' AS t, xmin::text AS v FROM products WHERE id = $1
       UNION ALL SELECT 'o' || position, xmin::text FROM product_options WHERE product_id = $1
       UNION ALL SELECT 'v' || sku, xmin::text FROM product_variants WHERE product_id = $1
       UNION ALL SELECT 'b' || b.code, b.xmin::text FROM barcodes b
         JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1
       ORDER BY 1`,
        [styleId],
      );
    }

    async function style(id: string) {
      const reply = await api.call(editor, 'GET', `/api/styles/${id}`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return StyleDetail.parse(reply.body);
    }

    async function sku(id: string) {
      const reply = await api.call(editor, 'GET', `/api/skus/${id}`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return SkuDetail.parse(reply.body);
    }

    const idsOf = (result: ChannelProductResult) => result.variants.map((v) => v.variantId);
    const outcomesOf = (result: ChannelProductResult) => result.variants.map((v) => v.outcome);

    /** Waits until some backend waits on a lock of `type` (`advisory`, `transactionid`). */
    async function waitForLockWait(type: string) {
      for (let i = 0; i < 200; i += 1) {
        const rows = await owner(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = $1`,
          [type],
        );
        if (rows.length) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`No backend waited on a ${type} lock`);
    }

    describe('creating and applying again (AC-14, AC-17)', () => {
      it('creates one style with its options and variants, then a second identical apply writes nothing', async () => {
        const input = fixture('round-tee');
        const actor = actorOf();
        const first = await apply(input, actor);

        expect(first.styleOutcome).toBe('created');
        expect(outcomesOf(first)).toEqual(['created', 'created', 'created']);
        const created = await style(first.styleId ?? '');
        expect(created.code).toBe(input.handle.toUpperCase());
        expect(created.name).toEqual({ en: 'Round Tee' });
        expect(created.productGroup.code).toBe('MAIN');
        expect(created.season).toBeNull();
        expect(created.tags).toEqual(['summer', 'cotton']);
        expect(created.productType).toBe('Tops');
        expect(created.brand).toBe('Fixture Brand');
        expect(created.channelLinked).toBe(true);
        expect(created.channelNameLanguage).toBe('en');
        expect(created.options.map((o) => [o.name, o.role, o.values])).toEqual([
          [{ en: 'Size' }, 'size', [{ en: 'S' }, { en: 'M' }, { en: 'L' }]],
          [{ en: 'Color' }, 'color', [{ en: 'Black' }]],
        ]);
        const large = created.variants.find((v) => v.code === input.variants[2]?.sku);
        expect(large).toMatchObject({ price: '260.00', channelLinked: true });
        expect(large?.barcodes).toEqual([
          expect.objectContaining({ code: input.variants[2]?.barcode, fromChannel: true }),
        ]);
        const entries = await entriesOf(actor.kind === 'system_job' ? actor.jobId : '');
        expect(entries.map((e) => e.action)).toEqual([
          'style.channel_created',
          'sku.channel_created',
          'sku.channel_created',
          'sku.channel_created',
        ]);
        expect(entries.every((e) => e.actor_kind === 'system_job')).toBe(true);
        expect(entries[0]).toMatchObject({ record_type: 'style', record_label: created.code });
        expect(entries[1]?.after).toMatchObject({
          sku: input.variants[0]?.sku,
          price: '250.00',
          barcode: input.variants[0]?.barcode,
          channel: { storeId: input.storeId, externalProductId: input.externalProductId },
        });

        const versions = await versionsOf(created.id);
        // The style, its 2 options, 3 variants, and 3 barcodes.
        expect(versions).toHaveLength(9);
        const second = actorOf();
        const again = await apply(input, second);
        // As the connector sends it once mapped: the same answer.
        const mapped = await apply({
          ...input,
          styleId: first.styleId,
          variants: input.variants.map((v, i) => ({ ...v, variantId: idsOf(first)[i] ?? null })),
        });

        expect(again.styleId).toBe(first.styleId);
        expect(again.styleOutcome).toBe('unchanged');
        expect(outcomesOf(again)).toEqual(['unchanged', 'unchanged', 'unchanged']);
        expect(idsOf(again)).toEqual(idsOf(first));
        expect(mapped.styleOutcome).toBe('unchanged');
        expect(outcomesOf(mapped)).toEqual(['unchanged', 'unchanged', 'unchanged']);
        expect(await entriesOf(second.kind === 'system_job' ? second.jobId : '')).toEqual([]);
        expect(await versionsOf(created.id)).toEqual(versions);
      });

      it('applies a Default Title product as a style with no options', async () => {
        const input = fixture('default-title');
        const result = await apply(input);
        const created = await style(result.styleId ?? '');

        expect(outcomesOf(result)).toEqual(['created']);
        expect(created.options).toEqual([]);
        expect(created.variants[0]).toMatchObject({ options: [], price: '20.00' });
        const kind = await owner<{ kind: string; option_values: unknown }>(
          `SELECT kind, option_values FROM product_variants WHERE id = $1`,
          [result.variants[0]?.variantId],
        );
        // Not tracked in Shopify: a service variant.
        expect(kind).toEqual([{ kind: 'service', option_values: {} }]);
      });

      it('writes an Arabic title into the Arabic name, which the app then refuses to edit', async () => {
        const input = fixture('arabic-title');
        const result = await apply(input);
        const created = await style(result.styleId ?? '');

        expect(created.name).toEqual({ ar: 'قميص أسود' });
        expect(created.channelNameLanguage).toBe('ar');
        expect(created.options[0]).toMatchObject({ name: { ar: 'المقاس' }, role: 'size' });

        const refused = await api.call(editor, 'PATCH', `/api/styles/${created.id}`, {
          updatedAt: created.updatedAt,
          name: { ar: 'قميص', en: 'Black Shirt' },
        });
        const english = await api.call(editor, 'PATCH', `/api/styles/${created.id}`, {
          updatedAt: created.updatedAt,
          name: { ar: 'قميص أسود', en: 'Black Shirt' },
        });
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'FIELD_OWNED_BY_CHANNEL', field: 'name.ar' });
        expect(english.status, JSON.stringify(english.body)).toBe(200);

        const actor = actorOf();
        const renamed = await apply({ ...input, title: 'قميص أسود جديد' }, actor);
        const after = await style(created.id);
        expect(renamed.styleOutcome).toBe('updated');
        expect(after.name).toEqual({ ar: 'قميص أسود جديد', en: 'Black Shirt' });
        const [entry] = await entriesOf(actor.kind === 'system_job' ? actor.jobId : '');
        expect(entry).toMatchObject({
          action: 'style.channel_updated',
          before: { name: { ar: 'قميص أسود', en: 'Black Shirt' } },
          after: { name: { ar: 'قميص أسود جديد', en: 'Black Shirt' } },
        });
        expect(Object.keys(entry?.after ?? {}).sort()).toEqual(['channel', 'name']);
      });
    });

    describe('resolving variants (AC-14)', () => {
      it('refuses a variant without a SKU or with a bad one and creates the rest', async () => {
        const input = fixture('round-tee');
        const [s, m, l] = input.variants;
        if (!s || !m || !l) throw new Error('fixture');
        const result = await apply({
          ...input,
          variants: [
            { ...s, sku: null },
            { ...m, sku: 'BAD SKU!' },
            { ...l, sku: `  ${l.sku?.toLowerCase()} ` },
          ],
        });

        expect(result.variants).toEqual([
          { externalVariantId: s.externalVariantId, variantId: null, outcome: 'needs_sku' },
          { externalVariantId: m.externalVariantId, variantId: null, outcome: 'invalid_sku' },
          expect.objectContaining({ outcome: 'created' }),
        ]);
        expect((await style(result.styleId ?? '')).variants.map((v) => v.code)).toEqual([l.sku]);
      });

      it('answers styleId null and creates no style when every variant is refused', async () => {
        const input = fixture('default-title');
        const count = async () =>
          (await owner<{ n: string }>(`SELECT count(*)::text AS n FROM products`))[0]?.n;
        const before = await count();
        const result = await apply({
          ...input,
          variants: input.variants.map((v) => ({ ...v, sku: null })),
        });

        expect(result).toMatchObject({ styleId: null, styleOutcome: 'unchanged' });
        expect(await count()).toBe(before);
      });

      it('links a SKU made by hand, takes over its price, and refuses a person price edit after', async () => {
        const input = fixture('default-title');
        const variant = input.variants[0];
        if (!variant?.sku) throw new Error('fixture');
        const made = await api.call(editor, 'POST', '/api/products', {
          name: { en: 'Hand wrap', ar: 'تغليف' },
          variants: [{ sku: variant.sku, price: '15.00' }],
        });
        expect(made.status, JSON.stringify(made.body)).toBe(201);
        const hand = SkuDetail.parse(made.body);
        expect(hand.channelLinked).toBe(false);

        const actor = actorOf();
        const result = await apply(input, actor);
        const linked = await sku(hand.id);

        expect(result).toMatchObject({ styleId: hand.productId, styleOutcome: 'updated' });
        expect(result.variants[0]).toMatchObject({ variantId: hand.id, outcome: 'linked' });
        expect(linked).toMatchObject({
          price: '20.00',
          channelLinked: true,
          channelNameLanguage: 'en',
          name: { en: 'Gift Wrap', ar: 'تغليف' },
        });
        const entries = await entriesOf(actor.kind === 'system_job' ? actor.jobId : '');
        expect(entries.map((e) => e.action).sort()).toEqual([
          'sku.channel_linked',
          'style.channel_updated',
        ]);
        expect(entries.find((e) => e.action === 'sku.channel_linked')).toMatchObject({
          before: { price: '15.00', channelLinked: false },
          after: { price: '20.00', channelLinked: true },
        });

        const price = await api.call(editor, 'PATCH', `/api/skus/${hand.id}`, {
          updatedAt: linked.updatedAt,
          price: '18.00',
        });
        const samePrice = await api.call(editor, 'PATCH', `/api/skus/${hand.id}`, {
          updatedAt: linked.updatedAt,
          price: '20',
        });
        expect(price.status).toBe(409);
        expect(price.body).toMatchObject({ code: 'FIELD_OWNED_BY_CHANNEL', field: 'price' });
        expect(samePrice.status, JSON.stringify(samePrice.body)).toBe(200);
      });

      it('answers sku_mismatch for a mapped variant whose Shopify SKU changed, and changes nothing', async () => {
        const input = fixture('default-title');
        const first = await apply(input);
        const id = first.variants[0]?.variantId ?? null;
        const before = await versionsOf(first.styleId ?? '');
        const variant = input.variants[0];
        if (!variant) throw new Error('fixture');
        const actor = actorOf();
        const result = await apply(
          {
            ...input,
            variants: [{ ...variant, variantId: id, sku: 'OTHER-CODE', price: '99.00' }],
          },
          actor,
        );

        expect(result.variants[0]).toMatchObject({ variantId: id, outcome: 'sku_mismatch' });
        expect(result.styleId).toBeNull();
        expect(await versionsOf(first.styleId ?? '')).toEqual(before);
        expect(await entriesOf(actor.kind === 'system_job' ? actor.jobId : '')).toEqual([]);
      });
    });

    describe('two stores (AC-14, AC-15)', () => {
      it('makes one style and one set of variants when two stores apply the same product in parallel', async () => {
        const input = fixture('round-tee');
        const other = { ...input, storeId: randomUUID() };
        let releaseFirst: () => void = () => undefined;
        const hold = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let firstApplied: () => void = () => undefined;
        const applied = new Promise<void>((resolve) => {
          firstApplied = resolve;
        });
        const first = db.transaction(
          async (tx) => {
            const result = await sync.applyProduct(tx, input, actorOf());
            firstApplied();
            await hold;
            return result;
          },
          { isolationLevel: 'read committed' },
        );
        await applied;
        const second = apply(other);
        await waitForLockWait('advisory');
        releaseFirst();
        const [a, b] = await Promise.all([first, second]);

        expect(a.styleOutcome).toBe('created');
        expect(b.styleId).toBe(a.styleId);
        expect(b.styleOutcome).toBe('unchanged');
        expect(idsOf(b)).toEqual(idsOf(a));
        expect(outcomesOf(b)).toEqual(['unchanged', 'unchanged', 'unchanged']);
        const styles = await owner(`SELECT id FROM products WHERE style_code LIKE $1`, [
          `${input.handle.toUpperCase()}%`,
        ]);
        expect(styles).toHaveLength(1);
      });

      it('makes one style when the same product comes under two handles with new SKUs in parallel', async () => {
        const input = fixture('round-tee');
        // Another store names the product differently: another handle, so another handle lock;
        // the SKU locks (lead ruling 2026-11-11) make the second call wait and resolve them.
        const other = { ...input, storeId: randomUUID(), handle: `${input.handle}-other` };
        let releaseFirst: () => void = () => undefined;
        const hold = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let firstApplied: () => void = () => undefined;
        const applied = new Promise<void>((resolve) => {
          firstApplied = resolve;
        });
        const first = db.transaction(
          async (tx) => {
            const result = await sync.applyProduct(tx, input, actorOf());
            firstApplied();
            await hold;
            return result;
          },
          { isolationLevel: 'read committed' },
        );
        await applied;
        const second = apply(other);
        await waitForLockWait('advisory');
        releaseFirst();
        const [a, b] = await Promise.all([first, second]);

        expect(a.styleOutcome).toBe('created');
        expect(b.styleId).toBe(a.styleId);
        expect(idsOf(b)).toEqual(idsOf(a));
        expect(outcomesOf(b)).toEqual(['unchanged', 'unchanged', 'unchanged']);
        expect(
          await owner(`SELECT id FROM products WHERE style_code = $1`, [
            other.handle.toUpperCase(),
          ]),
        ).toEqual([]);
      });

      it('links a SKU another writer created in parallel, links its style, and removes the style it created for nothing', async () => {
        const input = fixture('default-title');
        const variant = input.variants[0];
        if (!variant?.sku) throw new Error('fixture');
        const code = `HAND-${n}`;
        // A person's create (no SKU lock) holds the same new SKU uncommitted.
        let releaseFirst: () => void = () => undefined;
        const hold = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let firstInserted: () => void = () => undefined;
        const inserted = new Promise<void>((resolve) => {
          firstInserted = resolve;
        });
        const first = db.transaction(
          async (tx) => {
            const { rows } = await tx.execute<{ id: string }>(sql`
              INSERT INTO products (style_code, product_group_id, name, status)
              VALUES (${code}, (SELECT id FROM product_groups WHERE code = 'MAIN'),
                      '{"en": "Hand wrap"}'::jsonb, 'active')
              RETURNING id`);
            const styleId = rows[0]?.id ?? '';
            const made = await tx.execute<{ id: string }>(sql`
              INSERT INTO product_variants (product_id, sku, kind, tracking, base_uom_id, price)
              VALUES (${styleId}, ${variant.sku}, 'stocked', 'none',
                      (SELECT id FROM uoms WHERE code = 'pc'), 15)
              RETURNING id`);
            firstInserted();
            await hold;
            return { styleId, variantId: made.rows[0]?.id ?? '' };
          },
          { isolationLevel: 'read committed' },
        );
        await inserted;
        const actor = actorOf();
        const second = apply(input, actor);
        await waitForLockWait('transactionid');
        releaseFirst();
        const [hand, b] = await Promise.all([first, second]);

        expect(b.variants[0]).toMatchObject({ variantId: hand.variantId, outcome: 'linked' });
        expect(b).toMatchObject({ styleId: hand.styleId, styleOutcome: 'updated' });
        expect(
          await owner(`SELECT id FROM products WHERE style_code = $1`, [
            input.handle.toUpperCase(),
          ]),
        ).toEqual([]);
        const linked = await style(hand.styleId);
        expect(linked).toMatchObject({
          channelLinked: true,
          channelNameLanguage: 'en',
          name: { en: 'Gift Wrap' },
        });
        expect(linked.variants[0]).toMatchObject({ price: '20.00', channelLinked: true });
        const entries = await entriesOf(actor.kind === 'system_job' ? actor.jobId : '');
        expect(entries.map((e) => e.action).sort()).toEqual([
          'sku.channel_linked',
          'style.channel_updated',
        ]);
      });

      it('applies content only from the source store', async () => {
        const source = randomUUID();
        const input = fixture('round-tee', source);
        await setSetting('catalog.source_store_id', source);
        try {
          const first = await apply(input);
          const versions = await versionsOf(first.styleId ?? '');
          const actor = actorOf();
          const other = await apply(
            {
              ...input,
              storeId: randomUUID(),
              title: 'Other Title',
              tags: ['other'],
              variants: input.variants.map((v) => ({ ...v, price: '999.00', barcode: null })),
            },
            actor,
          );

          // Another store resolves and maps, and writes nothing (lead ruling 2026-11-11).
          expect(other.styleOutcome).toBe('unchanged');
          expect(other.styleId).toBe(first.styleId);
          expect(outcomesOf(other)).toEqual(['linked', 'linked', 'linked']);
          expect(idsOf(other)).toEqual(idsOf(first));
          expect(await versionsOf(first.styleId ?? '')).toEqual(versions);
          expect(await entriesOf(actor.kind === 'system_job' ? actor.jobId : '')).toEqual([]);

          const changed = await apply({
            ...input,
            variants: input.variants.map((v) => ({ ...v, price: '199.00' })),
          });
          expect(outcomesOf(changed)).toEqual(['updated', 'updated', 'updated']);
        } finally {
          await setSetting('catalog.source_store_id', undefined);
        }
      });
    });

    describe('conflicts (AC-14, AC-15)', () => {
      it('answers barcode_conflict for a code another variant holds, and never touches app barcodes', async () => {
        const first = fixture('default-title');
        const firstResult = await apply({
          ...first,
          variants: first.variants.map((v) => ({ ...v, barcode: `BC-${n}` })),
        });
        const taken = `BC-${n}`;
        const second = fixture('default-title');
        const result = await apply({
          ...second,
          variants: second.variants.map((v) => ({ ...v, barcode: taken })),
        });
        const id = result.variants[0]?.variantId ?? '';

        expect(result.variants[0]?.outcome).toBe('barcode_conflict');
        expect(id).not.toBe('');
        expect((await sku(id)).barcodes).toEqual([]);
        expect((await sku(firstResult.variants[0]?.variantId ?? '')).barcodes).toEqual([
          expect.objectContaining({ code: taken, fromChannel: true }),
        ]);

        // An app barcode stays through a channel barcode added, replaced, and removed.
        const added = await api.call(editor, 'POST', `/api/skus/${id}/barcodes`, {
          code: `APP-${n}`,
        });
        expect(added.status, JSON.stringify(added.body)).toBe(201);
        const variant = second.variants[0];
        if (!variant) throw new Error('fixture');
        const codesOf = async () =>
          (await sku(id)).barcodes.map((b) => [b.code, b.fromChannel]).sort();
        await apply({ ...second, variants: [{ ...variant, barcode: `CH1-${n}` }] });
        expect(await codesOf()).toEqual([
          [`APP-${n}`, false],
          [`CH1-${n}`, true],
        ]);
        const actor = actorOf();
        const replaced = await apply(
          { ...second, variants: [{ ...variant, barcode: `CH2-${n}` }] },
          actor,
        );
        expect(replaced.variants[0]?.outcome).toBe('updated');
        expect(await codesOf()).toEqual([
          [`APP-${n}`, false],
          [`CH2-${n}`, true],
        ]);
        expect((await entriesOf(actor.kind === 'system_job' ? actor.jobId : ''))[0]).toMatchObject({
          action: 'sku.channel_updated',
          before: { barcode: `CH1-${n}` },
          after: { barcode: `CH2-${n}` },
        });
        await apply({ ...second, variants: [{ ...variant, barcode: null }] });
        expect(await codesOf()).toEqual([[`APP-${n}`, false]]);
      });

      it('answers option_conflict when a variant would take another active variant option values', async () => {
        const input = fixture('round-tee');
        const first = await apply(input);
        const [s, m, l] = input.variants;
        if (!s || !m || !l) throw new Error('fixture');
        const result = await apply({
          ...input,
          variants: [s, { ...m, optionValues: ['S', 'Black'], price: '255.00' }, l],
        });

        expect(outcomesOf(result)).toEqual(['unchanged', 'option_conflict', 'unchanged']);
        expect(result.variants[1]?.variantId).toBe(first.variants[1]?.variantId);
        const medium = await sku(first.variants[1]?.variantId ?? '');
        expect(medium.options.map((o) => o.value)).toEqual([{ en: 'M' }, { en: 'Black' }]);
        // The rest of the variant applied.
        expect(medium.price).toBe('255.00');

        // A new size is appended and the variant follows Shopify.
        const resized = await apply({
          ...input,
          options: [
            { name: 'Size', values: ['S', 'M', 'L', 'XL'] },
            { name: 'Color', values: ['Black'] },
          ],
          variants: [s, m, { ...l, optionValues: ['XL', 'Black'] }],
        });
        expect(outcomesOf(resized)).toEqual(['unchanged', 'updated', 'updated']);
        const detail = await style(first.styleId ?? '');
        expect(detail.options[0]?.values).toEqual([
          { en: 'S' },
          { en: 'M' },
          { en: 'L' },
          { en: 'XL' },
        ]);
        expect(detail.variants.find((v) => v.code === l.sku)?.options[0]?.value).toEqual({
          en: 'XL',
        });
      });
    });

    describe('a new style group and season from the settings (AC-14)', () => {
      async function newGroup() {
        const reply = await api.call(manager, 'POST', '/api/product-groups', {
          code: `CG${++n}`,
          name: { en: 'Channel group' },
        });
        expect(reply.status, JSON.stringify(reply.body)).toBe(201);
        return ProductGroup.parse(reply.body);
      }

      async function newSeason() {
        const reply = await api.call(manager, 'POST', '/api/seasons', {
          code: `CS${++n}`,
          name: { en: 'Channel season' },
        });
        expect(reply.status, JSON.stringify(reply.body)).toBe(201);
        return Season.parse(reply.body);
      }

      it('gives a new style the store group and the new style season, else MAIN and none', async () => {
        const store = randomUUID();
        const group = await newGroup();
        const season = await newSeason();
        await setSetting('catalog.store_product_groups', { [store]: group.code });
        await setSetting('catalog.new_style_season', season.code);
        try {
          const mapped = await style((await apply(fixture('default-title', store))).styleId ?? '');
          const otherStore = await style((await apply(fixture('default-title'))).styleId ?? '');
          expect(mapped.productGroup.code).toBe(group.code);
          expect(mapped.season?.code).toBe(season.code);
          expect(otherStore.productGroup.code).toBe('MAIN');
          expect(otherStore.season?.code).toBe(season.code);

          expect(
            (await api.call(manager, 'POST', `/api/product-groups/${group.id}/archive`)).status,
          ).toBe(200);
          expect(
            (await api.call(manager, 'POST', `/api/seasons/${season.id}/archive`)).status,
          ).toBe(200);
          const archived = await style(
            (await apply(fixture('default-title', store))).styleId ?? '',
          );
          expect(archived.productGroup.code).toBe('MAIN');
          expect(archived.season).toBeNull();

          await setSetting('catalog.store_product_groups', { [store]: 'NOSUCH' });
          await setSetting('catalog.new_style_season', 'NOSUCH');
          const unknown = await style((await apply(fixture('default-title', store))).styleId ?? '');
          expect(unknown.productGroup.code).toBe('MAIN');
          expect(unknown.season).toBeNull();
        } finally {
          await setSetting('catalog.store_product_groups', undefined);
          await setSetting('catalog.new_style_season', undefined);
        }
      });

      it('takes the next free code when the handle code is taken', async () => {
        const input = fixture('default-title');
        const taken = await api.call(editor, 'POST', '/api/products', {
          name: { en: 'Taken' },
          styleCode: input.handle.toUpperCase(),
          variants: [{ sku: `TAKEN-${n}` }],
        });
        expect(taken.status, JSON.stringify(taken.body)).toBe(201);
        const created = await style((await apply(input)).styleId ?? '');
        expect(created.code).toBe(`${input.handle.toUpperCase()}-2`);
      });
    });

    describe('unlink (AC-15, AC-17)', () => {
      it('gives every field back to the app, records each unlink, and links again on the next apply', async () => {
        const input = fixture('round-tee');
        const result = await apply(input);
        const styleId = result.styleId ?? '';
        const variantIds = idsOf(result).filter((id): id is string => id !== null);
        const linkedDetail = await style(styleId);
        const actor = actorOf();
        const answer = await db.transaction(
          (tx) => sync.unlink(tx, { styleIds: [styleId], variantIds }, actor),
          { isolationLevel: 'read committed' },
        );
        const detail = await style(styleId);
        const first = await sku(variantIds[0] ?? '');

        expect(answer).toEqual({ styles: 1, variants: 3 });
        expect(detail).toMatchObject({ channelLinked: false, channelNameLanguage: null });
        expect(detail.updatedAt).not.toBe(linkedDetail.updatedAt);
        expect(detail.variants.every((v) => !v.channelLinked)).toBe(true);
        expect(first.barcodes).toEqual([expect.objectContaining({ fromChannel: false })]);
        const entries = await entriesOf(actor.kind === 'system_job' ? actor.jobId : '');
        expect(entries.map((e) => e.action)).toEqual([
          'style.channel_unlinked',
          'sku.channel_unlinked',
          'sku.channel_unlinked',
          'sku.channel_unlinked',
        ]);
        expect(entries.every((e) => e.actor_kind === 'system_job')).toBe(true);
        expect(entries[0]).toMatchObject({
          record_label: detail.code,
          before: { channelLinked: true, channelNameLanguage: 'en' },
          after: { channelLinked: false, channelNameLanguage: null },
        });
        expect(entries.find((e) => e.record_id === first.id)).toMatchObject({
          record_label: first.code,
          before: { channelLinked: true, channelBarcode: first.barcodes[0]?.code },
          after: { channelLinked: false, channelBarcode: null },
        });

        const price = await api.call(editor, 'PATCH', `/api/skus/${first.id}`, {
          updatedAt: first.updatedAt,
          price: '1.00',
        });
        const name = await api.call(editor, 'PATCH', `/api/styles/${styleId}`, {
          updatedAt: detail.updatedAt,
          name: { en: 'Mine now' },
        });
        expect(price.status, JSON.stringify(price.body)).toBe(200);
        expect(name.status, JSON.stringify(name.body)).toBe(200);
        const again = await db.transaction(
          (tx) => sync.unlink(tx, { styleIds: [styleId], variantIds }, actorOf()),
          { isolationLevel: 'read committed' },
        );
        expect(again).toEqual({ styles: 0, variants: 0 });

        // Relinked by the next apply: the channel takes its fields back, the kept barcodes count.
        const relinked = await apply(input);
        expect(outcomesOf(relinked)).toEqual(['linked', 'linked', 'linked']);
        expect(relinked.styleOutcome).toBe('updated');
        const back = await style(styleId);
        expect(back).toMatchObject({ channelLinked: true, name: { en: 'Round Tee' } });
        const relinkedFirst = await sku(first.id);
        expect(relinkedFirst.price).toBe('250.00');
        expect(relinkedFirst.barcodes).toEqual([expect.objectContaining({ fromChannel: false })]);
      });

      it('refuses an actor that is not a system job', async () => {
        await expect(
          db.transaction(
            (tx) =>
              sync.unlink(
                tx,
                { styleIds: [], variantIds: [] },
                personActor(randomUUID(), 'manager'),
              ),
            { isolationLevel: 'read committed' },
          ),
        ).rejects.toMatchObject({ code: 'NotSystemJob' });
      });
    });

    describe('the source store alone links (lead ruling 2026-11-11, AC-15)', () => {
      it('keeps what another store creates app owned, then the source store links it with its Arabic title', async () => {
        const source = randomUUID();
        const input = fixture('round-tee', randomUUID());
        await setSetting('catalog.source_store_id', source);
        try {
          const actor = actorOf();
          const created = await apply(input, actor);
          expect(outcomesOf(created)).toEqual(['created', 'created', 'created']);
          const own = await style(created.styleId ?? '');
          expect(own).toMatchObject({
            channelLinked: false,
            channelNameLanguage: null,
            name: { en: 'Round Tee' },
          });
          expect(own.variants.every((v) => !v.channelLinked)).toBe(true);
          expect(own.variants.flatMap((v) => v.barcodes.map((b) => b.fromChannel))).toEqual([
            false,
            false,
            false,
          ]);
          const entries = await entriesOf(actor.kind === 'system_job' ? actor.jobId : '');
          expect(entries[0]).toMatchObject({
            action: 'style.channel_created',
            after: { channelLinked: false, channelNameLanguage: null },
          });
          // App owned: a person may change the price.
          const medium = own.variants.find((v) => v.code === input.variants[1]?.sku);
          const edit = await api.call(editor, 'PATCH', `/api/skus/${medium?.id}`, {
            updatedAt: (await sku(medium?.id ?? '')).updatedAt,
            price: '240.00',
          });
          expect(edit.status, JSON.stringify(edit.body)).toBe(200);

          const linked = await apply({ ...input, storeId: source, title: 'قميص مستدير' });
          expect(linked.styleOutcome).toBe('updated');
          expect(outcomesOf(linked)).toEqual(['linked', 'linked', 'linked']);
          const after = await style(own.id);
          expect(after).toMatchObject({
            channelLinked: true,
            channelNameLanguage: 'ar',
            name: { en: 'Round Tee', ar: 'قميص مستدير' },
          });
          expect(after.variants.every((v) => v.channelLinked)).toBe(true);
          expect(after.variants.find((v) => v.id === medium?.id)?.price).toBe('250.00');
        } finally {
          await setSetting('catalog.source_store_id', undefined);
        }
      });

      it('lets another store add a variant to a linked style with only the option value it needs', async () => {
        const source = randomUUID();
        const input = fixture('round-tee', source);
        await setSetting('catalog.source_store_id', source);
        try {
          const first = await apply(input);
          const [s, m, l] = input.variants;
          if (!s || !m || !l) throw new Error('fixture');
          const other = await apply({
            ...input,
            storeId: randomUUID(),
            options: [
              { name: 'Size', values: ['S', 'M', 'L', 'XL', 'XXL'] },
              { name: 'Color', values: ['Black', 'White'] },
            ],
            variants: [
              s,
              m,
              l,
              {
                ...l,
                externalVariantId: 'gid://shopify/ProductVariant/1',
                sku: `TEE-BLK-XL-${n}`,
                optionValues: ['XL', 'Black'],
                barcode: null,
              },
            ],
          });

          expect(outcomesOf(other)).toEqual(['linked', 'linked', 'linked', 'created']);
          expect(other.styleId).toBe(first.styleId);
          const detail = await style(first.styleId ?? '');
          expect(detail.options.map((o) => o.values)).toEqual([
            [{ en: 'S' }, { en: 'M' }, { en: 'L' }, { en: 'XL' }],
            [{ en: 'Black' }],
          ]);
          expect(detail.variants.find((v) => v.code === `TEE-BLK-XL-${n}`)).toMatchObject({
            channelLinked: false,
          });
        } finally {
          await setSetting('catalog.source_store_id', undefined);
        }
      });
    });

    describe('more resolution cases (review minor 9)', () => {
      it('answers needs_sku with the id of a mapped variant that lost its SKU', async () => {
        const input = fixture('default-title');
        const first = await apply(input);
        const variant = input.variants[0];
        if (!variant) throw new Error('fixture');
        const result = await apply({
          ...input,
          variants: [{ ...variant, variantId: first.variants[0]?.variantId ?? null, sku: null }],
        });
        expect(result.variants[0]).toMatchObject({
          variantId: first.variants[0]?.variantId,
          outcome: 'needs_sku',
        });
      });

      it('answers invalid_sku for a SKU repeated in one product and for a non ASCII SKU', async () => {
        const input = fixture('round-tee');
        const [s, m, l] = input.variants;
        if (!s || !m || !l) throw new Error('fixture');
        const result = await apply({
          ...input,
          variants: [s, { ...m, sku: s.sku }, { ...l, sku: `ſ${l.sku}` }],
        });
        expect(outcomesOf(result)).toEqual(['created', 'invalid_sku', 'invalid_sku']);
      });

      it('answers barcode_conflict for a barcode failing the pattern or holding non ASCII letters', async () => {
        const input = fixture('round-tee');
        const [s, m, l] = input.variants;
        if (!s || !m || !l) throw new Error('fixture');
        const result = await apply({
          ...input,
          variants: [s, { ...m, barcode: '62 22' }, { ...l, barcode: 'ſ1' }],
        });
        expect(outcomesOf(result)).toEqual(['created', 'barcode_conflict', 'barcode_conflict']);
        expect((await sku(result.variants[1]?.variantId ?? '')).barcodes).toEqual([]);
      });

      it('creates a new variant of an archived style archived', async () => {
        const input = fixture('round-tee');
        const first = await apply(input);
        await owner(`UPDATE product_variants SET archived_at = now() WHERE product_id = $1`, [
          first.styleId,
        ]);
        await owner(`UPDATE products SET archived_at = now() WHERE id = $1`, [first.styleId]);
        const [s, m, l] = input.variants;
        if (!s || !m || !l) throw new Error('fixture');
        const result = await apply({
          ...input,
          variants: [
            s,
            m,
            l,
            {
              ...l,
              externalVariantId: 'gid://shopify/ProductVariant/2',
              sku: `TEE-BLK-XL-${n}`,
              optionValues: ['XL', 'Black'],
              barcode: null,
            },
          ],
        });
        expect(outcomesOf(result)).toEqual(['unchanged', 'unchanged', 'unchanged', 'created']);
        expect((await sku(result.variants[3]?.variantId ?? '')).status).toBe('archived');
      });

      it('applies content but not option values to a variant resolving outside the target style', async () => {
        const wrap = fixture('default-title');
        const outside = await apply(wrap);
        const input = fixture('round-tee');
        const first = await apply(input);
        const [s, m, l] = input.variants;
        const lone = wrap.variants[0];
        if (!s || !m || !l || !lone) throw new Error('fixture');
        const result = await apply({
          ...input,
          variants: [s, m, l, { ...lone, optionValues: ['XL', 'Black'], price: '33.00' }],
        });

        expect(result.styleId).toBe(first.styleId);
        expect(outcomesOf(result)).toEqual(['unchanged', 'unchanged', 'unchanged', 'updated']);
        const moved = await sku(outside.variants[0]?.variantId ?? '');
        expect(moved).toMatchObject({ productId: outside.styleId, price: '33.00', options: [] });
      });

      it('answers option_conflict for every variant when the style cannot take another option', async () => {
        const input = fixture('round-tee');
        const three = {
          ...input,
          options: [...input.options, { name: 'Fabric', values: ['Cotton'] }],
          variants: input.variants.map((v) => ({
            ...v,
            optionValues: [...v.optionValues, 'Cotton'],
          })),
        };
        await apply(three);
        const result = await apply({
          ...input,
          options: [...input.options, { name: 'Fit', values: ['Slim'] }],
          variants: input.variants.map((v) => ({
            ...v,
            price: '270.00',
            optionValues: [...v.optionValues, 'Slim'],
          })),
        });
        expect(outcomesOf(result)).toEqual([
          'option_conflict',
          'option_conflict',
          'option_conflict',
        ]);
        // The rest of each variant applied.
        expect((await sku(result.variants[0]?.variantId ?? '')).price).toBe('270.00');
      });

      it('applies compare at price, weight, and requires shipping changes', async () => {
        const input = fixture('default-title');
        await apply(input);
        const variant = input.variants[0];
        if (!variant) throw new Error('fixture');
        const actor = actorOf();
        const result = await apply(
          {
            ...input,
            variants: [
              { ...variant, compareAtPrice: '30', weightGrams: 500, requiresShipping: false },
            ],
          },
          actor,
        );
        expect(outcomesOf(result)).toEqual(['updated']);
        const [entry] = await entriesOf(actor.kind === 'system_job' ? actor.jobId : '');
        expect(entry).toMatchObject({
          action: 'sku.channel_updated',
          before: { compareAtPrice: null, weightGrams: null, requiresShipping: true },
          after: { compareAtPrice: '30.00', weightGrams: 500, requiresShipping: false },
        });
      });

      it('codes a style from its first SKU when the handle keeps no Latin letter or digit', async () => {
        const input = fixture('default-title');
        const result = await apply({ ...input, handle: 'تغليف-هدية' });
        expect((await style(result.styleId ?? '')).code).toBe(input.variants[0]?.sku);
      });

      it('refuses a caller transaction that is not READ COMMITTED and an actor that is not a job', async () => {
        const input = fixture('default-title');
        const repeatable = db.transaction((tx) => sync.applyProduct(tx, input, actorOf()), {
          isolationLevel: 'repeatable read',
        });
        await expect(repeatable).rejects.toBeInstanceOf(ChannelSyncError);
        await expect(repeatable).rejects.toMatchObject({ code: 'NotReadCommitted' });
        await expect(
          db.transaction(
            (tx) => sync.applyProduct(tx, input, personActor(randomUUID(), 'manager')),
            { isolationLevel: 'read committed' },
          ),
        ).rejects.toMatchObject({ code: 'NotSystemJob' });
      });
    });

    describe('person edits of channel owned fields (AC-15, security review L1)', () => {
      it('refuses a channel barcode removal, a tags change, a new option value, and a name change; stale wins', async () => {
        const input = fixture('round-tee');
        const result = await apply(input);
        const detail = await style(result.styleId ?? '');
        const small = await sku(result.variants[0]?.variantId ?? '');
        const barcode = small.barcodes[0];

        const removal = await api.call(
          editor,
          'DELETE',
          `/api/skus/${small.id}/barcodes/${barcode?.id}`,
        );
        const tags = await api.call(editor, 'PATCH', `/api/styles/${detail.id}`, {
          updatedAt: detail.updatedAt,
          tags: ['mine'],
        });
        const sameTags = await api.call(editor, 'PATCH', `/api/styles/${detail.id}`, {
          updatedAt: detail.updatedAt,
          tags: detail.tags,
        });
        const variant = await api.call(editor, 'POST', `/api/styles/${detail.id}/variants`, {
          sku: `TEE-BLK-XL-${n}`,
          options: [
            { name: { en: 'Size' }, value: { en: 'XL' } },
            { name: { en: 'Color' }, value: { en: 'Black' } },
          ],
        });
        const name = await api.call(editor, 'PATCH', `/api/skus/${small.id}`, {
          updatedAt: small.updatedAt,
          name: { en: 'Mine' },
        });
        const stale = await api.call(editor, 'PATCH', `/api/skus/${small.id}`, {
          updatedAt: '2000-01-01T00:00:00.000000Z',
          price: '1.00',
        });

        expect(removal.status).toBe(409);
        expect(removal.body).toMatchObject({ code: 'FIELD_OWNED_BY_CHANNEL', field: 'barcode' });
        expect(tags.status).toBe(409);
        expect(tags.body).toMatchObject({ code: 'FIELD_OWNED_BY_CHANNEL', field: 'tags' });
        expect(sameTags.status, JSON.stringify(sameTags.body)).toBe(200);
        expect(variant.status).toBe(409);
        expect(variant.body).toMatchObject({ code: 'FIELD_OWNED_BY_CHANNEL', field: 'options' });
        expect(name.status).toBe(409);
        expect(name.body).toMatchObject({ code: 'FIELD_OWNED_BY_CHANNEL', field: 'name.en' });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ code: 'STALE_RECORD' });
        expect((await sku(small.id)).barcodes).toHaveLength(1);
      });
    });

    describe('a product at the Shopify variant limit (review minor 8)', () => {
      it('creates 2,048 variants in one call, then answers unchanged for all of them', async () => {
        n += 1;
        const sizes = Array.from({ length: 32 }, (_, i) => `S${i + 1}`);
        const colors = Array.from({ length: 64 }, (_, i) => `C${i + 1}`);
        const input: Input = {
          storeId: randomUUID(),
          externalProductId: `gid://shopify/Product/big-${n}`,
          styleId: null,
          handle: `big-tee-${n}`,
          title: 'Big Tee',
          productType: 'Tops',
          vendor: 'Fixture Brand',
          tags: ['big'],
          options: [
            { name: 'Size', values: sizes },
            { name: 'Color', values: colors },
          ],
          variants: sizes.flatMap((size, i) =>
            colors.map((color, j) => ({
              externalVariantId: `gid://shopify/ProductVariant/big-${n}-${i}-${j}`,
              variantId: null,
              sku: `BIG-${n}-${size}-${color}`,
              optionValues: [size, color],
              price: '199.00',
              compareAtPrice: null,
              barcode: `BIG${n}X${i}X${j}`,
              weightGrams: 300,
              requiresShipping: true,
              tracked: true,
            })),
          ),
        };
        expect(input.variants).toHaveLength(2048);

        const started = performance.now();
        const created = await apply(input);
        const createMs = Math.round(performance.now() - started);
        const again = performance.now();
        const unchanged = await apply(input);
        const unchangedMs = Math.round(performance.now() - again);
        // Measured once for the review (minor 8): batch the statements only if this passes 5 s.
        process.stdout.write(
          `channel sync, 2,048 variants: created in ${createMs} ms, unchanged in ${unchangedMs} ms\n`,
        );

        expect(created.styleOutcome).toBe('created');
        expect(new Set(outcomesOf(created))).toEqual(new Set(['created']));
        expect(new Set(outcomesOf(unchanged))).toEqual(new Set(['unchanged']));
        const counted = await owner<{ n: string }>(
          `SELECT count(*)::text AS n FROM product_variants WHERE product_id = $1`,
          [created.styleId],
        );
        expect(counted[0]?.n).toBe('2048');
      });
    });
  },
);
