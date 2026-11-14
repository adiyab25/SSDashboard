import { Inject, Injectable } from '@nestjs/common';
import {
  ChannelProductInput,
  ChannelUnlinkInput,
  type AuditActor,
  type ChannelProductResult,
  type ChannelVariantOutcome,
  type LocalizedText,
  type OptionRole,
} from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import type { AuditEntryInput, JsonObject, JsonValue } from '../../audit/audit.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { pgArray, pgConstraint, type Transaction } from '../../database/sql.js';
import { SettingsService } from '../../platform/settings/settings.service.js';
import { OPTIONS_UNIQUE } from '../catalog.service.js';
import { MAX_OPTIONS, optionRoleOf } from '../styles/styles.service.js';
import { ChannelSyncError } from './channel-sync-error.js';
import {
  CATALOG_CHANNEL_SKU_LOCK,
  CATALOG_CHANNEL_STYLE_LOCK,
  INVALID_BARCODE,
  channelBarcodeOf,
  channelSkuLockKey,
  channelSkuOf,
  channelStyleLockKey,
  isValidSku,
  moneyText,
  nameLanguageOf,
  optionValuesKey,
  styleCodeFromHandle,
} from './channel-rules.js';

type Product = z.output<typeof ChannelProductInput>;
type ChannelVariant = Product['variants'][number];
type Language = 'en' | 'ar';

/** The most `-2`, `-3` suffixes tried for a new style code before giving up. */
const MAX_STYLE_CODE_ATTEMPTS = 1000;

/** The variant columns the sync compares, over `product_variants`. */
const VARIANT_COLUMNS = sql`
  id, sku, product_id, option_values, price, compare_at_price, weight_grams, requires_shipping,
  archived_at IS NOT NULL AS archived, channel_linked_at IS NOT NULL AS linked`;

/** A variant row as the sync reads it, locked. */
interface VariantRow extends Record<string, unknown> {
  id: string;
  sku: string;
  product_id: string;
  option_values: Record<string, number>;
  price: string | null;
  compare_at_price: string | null;
  weight_grams: number | null;
  requires_shipping: boolean;
  archived: boolean;
  linked: boolean;
}

/** A style row the sync writes, locked. */
interface StyleRow extends Record<string, unknown> {
  id: string;
  style_code: string;
  name: LocalizedText;
  tags: string[];
  product_type: string | null;
  brand: string | null;
  archived: boolean;
  linked: boolean;
  channel_name_language: Language | null;
}

/** A barcode row the sync may compare or move. */
interface BarcodeRow extends Record<string, unknown> {
  id: string;
  variant_id: string;
  code: string;
  from_channel: boolean;
}

/** An option of the target style while the call works on it: stored, or new and still to insert. */
interface WorkingOption {
  id: string | null;
  position: number;
  name: LocalizedText;
  role: OptionRole;
  values: LocalizedText[];
  nameKeys: string[];
  valueKeys: string[][];
  valuesChanged: boolean;
}

/** How one input variant resolved before any write. `mapped`: found by the connector's `variantId`. */
type Plan =
  | { kind: 'refused'; outcome: ChannelVariantOutcome; variantId: string | null }
  | { kind: 'existing'; id: string; sku: string; mapped: boolean }
  | { kind: 'new'; sku: string };

/** The answer for one variant. */
type VariantAnswer = { outcome: ChannelVariantOutcome; variantId: string | null };

/** The state one `applyProduct` call carries between its steps. */
interface CallState {
  tx: Transaction;
  input: Product;
  actor: AuditActor;
  correlationId: string;
  /**
   * Whether this is the source store (`catalog.source_store_id` is null or names it): only then
   * does content apply and does the call set `channel_linked_at` and `channel_name_language`
   * (lead ruling 2026-11-11). Another store only resolves, and creates app owned records.
   */
  content: boolean;
  style: StyleRow | null;
  styleCreated: boolean;
  /** Styles of variants another writer created in parallel, locked, by id (review minor 6). */
  racedStyles: Map<string, StyleRow>;
  options: WorkingOption[];
  /** Input option position to the target style's option, null when it could not be placed. */
  optionMap: (WorkingOption | null)[];
  optionsFailed: boolean;
  /** Active variants of the target style by their `optionValuesKey`, kept as the call writes. */
  combos: Map<string, string>;
  /** The `optionValuesKey`s archived variants of the target style hold (an unarchive may clash). */
  archivedCombos: Set<string>;
  /** Every barcode the call may meet, by code, kept as the call writes. */
  barcodesByCode: Map<string, BarcodeRow>;
  /** The channel barcode of each variant the call touches, by variant id. */
  channelBarcodes: Map<string, BarcodeRow>;
  normalized: Map<string, string>;
  /** `catalog.store_product_groups` and `catalog.new_style_season`, read once in the call. */
  groupSetting: Record<string, string>;
  seasonSetting: string | null;
  entries: AuditEntryInput[];
  groupId: string | null;
  groupCode: string | null;
  seasonId: string | null;
  seasonCode: string | null;
}

/** A text in one language slot, as `jsonb` stores it. */
const inSlot = (language: Language, text: string): LocalizedText =>
  language === 'ar' ? { ar: text } : { en: text };

/** A stored name without empty languages. */
const cleanText = (text: LocalizedText): LocalizedText => ({
  ...(text.en ? { en: text.en } : {}),
  ...(text.ar ? { ar: text.ar } : {}),
});

/** The text a label shows of a stored name or value: English first, else Arabic. */
const labelOf = (text: LocalizedText | undefined): string => text?.en ?? text?.ar ?? '';

/** Whether two key lists share a non empty key (names and values match after normalizing). */
const overlaps = (a: readonly string[], b: readonly string[]) =>
  a.some((key) => key.length > 0 && b.includes(key));

/** Refuses an actor that is not a `system_job` (AC-17, security review L7). */
function assertSystemJob(actor: AuditActor): void {
  if (actor.kind !== 'system_job') {
    throw new ChannelSyncError('NotSystemJob', 'The channel sync records as a system job only');
  }
}

/**
 * The catalog's one channel write path (spec 0012, AC-14, AC-15, AC-17; the channel upsert
 * contract): the Shopify connector (spec 0015) creates and updates styles and variants only
 * through `applyProduct`, and gives a channel's fields back to the app through `unlink`. It runs
 * inside the caller's transaction (it never opens, commits, or retries one; the caller runs READ
 * COMMITTED, checked at entry, and reruns the whole call on a deadlock, 40P01), never reads
 * connector or channel tables, never archives, unarchives, or deletes (except a style it created
 * that ends the call with no variant), never writes a field the app owns, never writes
 * `search_text` (the database does), and builds every statement with bound parameters only.
 * Constraint clashes are pre-checked under the held locks and absorbed with
 * `ON CONFLICT DO NOTHING` (then identified) or, only where a parallel writer can still clash, a
 * savepoint, so a refused variant never aborts the caller's transaction.
 */
@Injectable()
export class CatalogChannelSync {
  /** Takes the audit writer (the AC-17 entries) and the settings reader (the three catalog keys). */
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * Applies one channel product (the rules of spec 0012's channel upsert contract):
   * 1. refuses a caller transaction that is not READ COMMITTED (`NotReadCommitted`) and an actor
   *    that is not a `system_job` (`NotSystemJob`); takes one advisory lock on the normalized
   *    handle (`channelStyleLockKey`), so two stores' calls for one product queue;
   * 2. resolves each variant: the given `variantId` (its SKU must equal the channel's, else
   *    `sku_mismatch`; none is `needs_sku`), else an existing SKU equal to the trimmed and
   *    uppercased channel SKU, else a new variant (`needs_sku` and `invalid_sku` are never
   *    created; a SKU or variant a previous input variant took is `invalid_sku`); then takes one
   *    advisory lock per SKU code it may create, in sorted order (`CATALOG_CHANNEL_SKU_LOCK`,
   *    lead ruling 2026-11-11), and resolves again, so the same product under two handles makes
   *    one style; after locking the variants it checks each SKU again (review minor 1);
   * 3. the target style is the first resolved variant's, else the given `styleId`, else a new one
   *    made only when the first variant must be created (code from the handle, or the first SKU
   *    code when the handle keeps no letter or digit; group from `catalog.store_product_groups`,
   *    season from `catalog.new_style_season`), removed again if it ends with no variant;
   * 4. compares before every write (a second identical call writes no row and no audit entry and
   *    answers `unchanged` everywhere); only the source store applies content (name in the
   *    channel's language, tags, product type, vendor, price, compare at price, weight, requires
   *    shipping, the channel barcode, and a variant's option values) and sets `channel_linked_at`
   *    and `channel_name_language` (lead ruling 2026-11-11). Another store writes nothing on an
   *    existing variant (it answers `linked`, the variant id for the connector's map); a variant
   *    or style it creates is seeded from its data but stays app owned (no link, no channel
   *    language, its barcode an app barcode, only the option values it needs written);
   * 5. records the AC-17 entries as `actor` under one correlation id.
   * Throws `ZodError` on a malformed input, `ChannelSyncError` (above, plus `StyleCodeExhausted`,
   * `UnknownConflict`, `Invariant`), or a database failure.
   */
  async applyProduct(
    tx: Transaction,
    raw: ChannelProductInput,
    actor: AuditActor,
  ): Promise<ChannelProductResult> {
    const input = ChannelProductInput.parse(raw);
    assertSystemJob(actor);
    await this.assertReadCommitted(tx);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(${CATALOG_CHANNEL_STYLE_LOCK}::int,
                                   hashtext(${channelStyleLockKey(input.handle)}))`);
    const settings = await this.settings.read(
      ['catalog.source_store_id', 'catalog.store_product_groups', 'catalog.new_style_season'],
      tx,
    );
    const source = settings['catalog.source_store_id'];
    const state: CallState = {
      tx,
      input,
      actor,
      correlationId: this.audit.newCorrelationId(actor),
      content: source === null || source.toLowerCase() === input.storeId,
      style: null,
      styleCreated: false,
      racedStyles: new Map(),
      options: [],
      optionMap: [],
      optionsFailed: false,
      combos: new Map(),
      archivedCombos: new Set(),
      barcodesByCode: new Map(),
      channelBarcodes: new Map(),
      normalized: new Map(),
      groupSetting: settings['catalog.store_product_groups'],
      seasonSetting: settings['catalog.new_style_season'],
      entries: [],
      groupId: null,
      groupCode: null,
      seasonId: null,
      seasonCode: null,
    };

    let plans = await this.resolve(state);
    if (await this.lockNewCodes(tx, plans)) plans = await this.resolve(state);
    const firstExisting = plans.find((plan) => plan.kind === 'existing');
    let styleId =
      firstExisting?.kind === 'existing' ? await this.styleOf(tx, firstExisting.id) : null;
    if (!styleId && input.styleId) styleId = input.styleId;
    if (styleId) state.style = await this.lockStyle(tx, styleId);

    const existingIds = plans.flatMap((plan) => (plan.kind === 'existing' ? [plan.id] : []));
    const rows = await this.lockVariants(tx, existingIds);
    for (const [i, plan] of plans.entries()) {
      if (plan.kind !== 'existing') continue;
      const row = rows.get(plan.id);
      // A variant deleted between the read and the lock is created again if its SKU allows.
      if (!row) plans[i] = { kind: 'new', sku: plan.sku };
      // Its code changed meanwhile (review minor 1): a mapped variant is a mismatch, a variant
      // found by its SKU no longer holds it, so the SKU is planned as new.
      else if (row.sku !== plan.sku) {
        plans[i] = plan.mapped
          ? { kind: 'refused', outcome: 'sku_mismatch', variantId: plan.id }
          : { kind: 'new', sku: plan.sku };
      }
    }

    await this.loadOptions(state, plans);
    await this.loadCombos(state);
    await this.loadBarcodes(state, [...rows.keys()]);

    const results: ChannelProductResult['variants'] = [];
    for (const [i, plan] of plans.entries()) {
      const variant = input.variants[i];
      if (!variant) continue;
      let outcome: VariantAnswer;
      if (plan.kind === 'refused') outcome = { outcome: plan.outcome, variantId: plan.variantId };
      else if (plan.kind === 'existing') {
        const row = rows.get(plan.id);
        if (!row) throw new ChannelSyncError('Invariant', 'A locked variant went missing');
        outcome = await this.applyExisting(state, variant, row, false);
      } else outcome = await this.applyNew(state, variant, plan.sku);
      results.push({ externalVariantId: variant.externalVariantId, ...outcome });
    }

    const applied = results.filter(
      (result) =>
        result.variantId !== null &&
        !['needs_sku', 'invalid_sku', 'sku_mismatch'].includes(result.outcome),
    );
    let styleOutcome: ChannelProductResult['styleOutcome'] = 'unchanged';
    let resultStyleId: string | null = null;
    if (state.style && state.styleCreated) {
      if (await this.removeIfEmpty(tx, state.style.id)) {
        state.entries = state.entries.filter((entry) => entry.action !== 'style.channel_created');
      } else {
        styleOutcome = 'created';
        resultStyleId = state.style.id;
      }
    } else if (state.style && applied.length) {
      if (await this.updateStyle(state, state.style)) styleOutcome = 'updated';
      resultStyleId = state.style.id;
    }
    if (!resultStyleId && applied[0]?.variantId) {
      resultStyleId = await this.styleOf(tx, applied[0].variantId);
      // The product maps to the style of a variant another writer created in parallel: link it
      // as the target style would be (review minor 6).
      const raced = resultStyleId ? state.racedStyles.get(resultStyleId) : undefined;
      if (raced && (await this.updateStyle(state, raced))) styleOutcome = 'updated';
    }
    await this.audit.recordMany(tx, state.entries);
    return { styleId: resultStyleId, styleOutcome, variants: results };
  }

  /**
   * Gives a channel's fields back to the app (AC-15): clears `channel_linked_at` and
   * `channel_name_language` on the given styles and `channel_linked_at` on the given variants,
   * and turns their channel barcodes into app barcodes (`from_channel` false; the codes stay, so
   * scanning keeps working; on a later link a channel code the variant already holds counts as
   * applied, and any other channel code is added as a new channel barcode). Locks the styles,
   * then the variants, in id order. Writes only rows that hold a link (bumping their
   * `updated_at`, so an edit read before the unlink is stale) and records `style.channel_unlinked`
   * and `sku.channel_unlinked` for each as `actor`, a `system_job` (lead ruling 2026-11-11), under
   * one correlation id. Never touches any other field. Runs in the caller's transaction. Returns
   * how many styles and variants it unlinked.
   */
  async unlink(
    tx: Transaction,
    raw: ChannelUnlinkInput,
    actor: AuditActor,
  ): Promise<{ styles: number; variants: number }> {
    const input = ChannelUnlinkInput.parse(raw);
    assertSystemJob(actor);
    const correlationId = this.audit.newCorrelationId(actor);
    const entries: AuditEntryInput[] = [];
    if (input.styleIds.length) {
      const { rows } = await tx.execute<{
        id: string;
        style_code: string;
        linked: boolean;
        language: Language | null;
      }>(sql`
        SELECT id, style_code, channel_linked_at IS NOT NULL AS linked,
               channel_name_language AS language
        FROM products WHERE id = ANY(${pgArray(input.styleIds)}::uuid[])
        ORDER BY id FOR NO KEY UPDATE`);
      const linked = rows.filter((row) => row.linked || row.language !== null);
      if (linked.length) {
        await tx.execute(sql`
          UPDATE products
          SET channel_linked_at = NULL, channel_name_language = NULL, updated_at = now()
          WHERE id = ANY(${pgArray(linked.map((row) => row.id))}::uuid[])`);
      }
      for (const row of linked) {
        entries.push({
          actor,
          action: 'style.channel_unlinked',
          record: { type: 'style', id: row.id, label: row.style_code },
          before: { channelLinked: row.linked, channelNameLanguage: row.language },
          after: { channelLinked: false, channelNameLanguage: null },
          correlationId,
        });
      }
    }
    if (input.variantIds.length) {
      const { rows } = await tx.execute<{
        id: string;
        sku: string;
        linked: boolean;
        codes: string[] | null;
      }>(sql`
        SELECT v.id, v.sku, v.channel_linked_at IS NOT NULL AS linked,
               (SELECT array_agg(b.code ORDER BY b.code) FROM barcodes b
                WHERE b.variant_id = v.id AND b.from_channel) AS codes
        FROM product_variants v WHERE v.id = ANY(${pgArray(input.variantIds)}::uuid[])
        ORDER BY v.id FOR NO KEY UPDATE OF v`);
      const touched = rows.filter((row) => row.linked || row.codes?.length);
      if (touched.length) {
        const ids = pgArray(touched.map((row) => row.id));
        await tx.execute(sql`
          UPDATE product_variants SET channel_linked_at = NULL, updated_at = now()
          WHERE id = ANY(${ids}::uuid[])`);
        await tx.execute(sql`
          UPDATE barcodes SET from_channel = false
          WHERE variant_id = ANY(${ids}::uuid[]) AND from_channel`);
      }
      for (const row of touched) {
        const before: JsonObject = {};
        const after: JsonObject = {};
        if (row.linked) {
          before.channelLinked = true;
          after.channelLinked = false;
        }
        if (row.codes?.length) {
          // The code stays on the variant as an app barcode.
          before.channelBarcode = row.codes[0] ?? null;
          after.channelBarcode = null;
        }
        entries.push({
          actor,
          action: 'sku.channel_unlinked',
          record: { type: 'sku', id: row.id, label: row.sku },
          before,
          after,
          correlationId,
        });
      }
    }
    await this.audit.recordMany(tx, entries);
    return {
      styles: entries.filter((entry) => entry.action === 'style.channel_unlinked').length,
      variants: entries.filter((entry) => entry.action === 'sku.channel_unlinked').length,
    };
  }

  /**
   * Refuses a caller transaction that is not READ COMMITTED (security review L3): each statement
   * must see what a call it waited for committed.
   */
  private async assertReadCommitted(tx: Transaction): Promise<void> {
    const { rows } = await tx.execute<{ level: string }>(sql`
      SELECT current_setting('transaction_isolation') AS level`);
    if (rows[0]?.level !== 'read committed') {
      throw new ChannelSyncError(
        'NotReadCommitted',
        'The channel sync runs only in a READ COMMITTED transaction',
      );
    }
  }

  /**
   * Takes one advisory lock per distinct SKU code planned as new, in sorted order (lead ruling
   * 2026-11-11), in one statement (`unnest` scans the sorted array in order). Returns whether it
   * took any, so the caller resolves again after the wait.
   */
  private async lockNewCodes(tx: Transaction, plans: readonly Plan[]): Promise<boolean> {
    const codes = [
      ...new Set(plans.flatMap((plan) => (plan.kind === 'new' ? [plan.sku] : []))),
    ].sort();
    if (!codes.length) return false;
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(${CATALOG_CHANNEL_SKU_LOCK}::int, hashtext(k.key))
      FROM unnest(${pgArray(codes.map(channelSkuLockKey))}::text[]) AS k(key)`);
    return true;
  }

  /** Step 2: how each input variant resolves, from one unlocked read of ids and codes. */
  private async resolve(state: CallState): Promise<Plan[]> {
    const { input } = state;
    const ids = input.variants.flatMap((variant) => (variant.variantId ? [variant.variantId] : []));
    const codes = input.variants.flatMap((variant) => {
      const code = channelSkuOf(variant.sku);
      return code && isValidSku(code) ? [code] : [];
    });
    const { rows } = await state.tx.execute<{ id: string; sku: string }>(sql`
      SELECT id, sku FROM product_variants
      WHERE id = ANY(${pgArray(ids)}::uuid[]) OR sku = ANY(${pgArray(codes)}::text[])`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const bySku = new Map(rows.map((row) => [row.sku, row]));
    const takenIds = new Set<string>();
    const takenSkus = new Set<string>();
    return input.variants.map((variant): Plan => {
      const code = channelSkuOf(variant.sku);
      const mapped = variant.variantId ? byId.get(variant.variantId) : undefined;
      if (mapped) {
        if (takenIds.has(mapped.id))
          return { kind: 'refused', outcome: 'invalid_sku', variantId: null };
        takenIds.add(mapped.id);
        takenSkus.add(mapped.sku);
        if (!code) return { kind: 'refused', outcome: 'needs_sku', variantId: mapped.id };
        if (code !== mapped.sku) {
          return { kind: 'refused', outcome: 'sku_mismatch', variantId: mapped.id };
        }
        return { kind: 'existing', id: mapped.id, sku: mapped.sku, mapped: true };
      }
      if (!code) return { kind: 'refused', outcome: 'needs_sku', variantId: null };
      if (!isValidSku(code) || takenSkus.has(code)) {
        return { kind: 'refused', outcome: 'invalid_sku', variantId: null };
      }
      takenSkus.add(code);
      const found = bySku.get(code);
      if (!found) return { kind: 'new', sku: code };
      if (takenIds.has(found.id))
        return { kind: 'refused', outcome: 'invalid_sku', variantId: null };
      takenIds.add(found.id);
      return { kind: 'existing', id: found.id, sku: found.sku, mapped: false };
    });
  }

  private async styleOf(tx: Transaction, variantId: string): Promise<string | null> {
    const { rows } = await tx.execute<{ product_id: string }>(sql`
      SELECT product_id FROM product_variants WHERE id = ${variantId}`);
    return rows[0]?.product_id ?? null;
  }

  /** Locks a style row (`FOR NO KEY UPDATE`, before its variants, the search triggers' order). */
  private async lockStyle(tx: Transaction, id: string): Promise<StyleRow | null> {
    const { rows } = await tx.execute<StyleRow>(sql`
      SELECT id, style_code, name, tags, product_type, brand,
             archived_at IS NOT NULL AS archived, channel_linked_at IS NOT NULL AS linked,
             channel_name_language
      FROM products WHERE id = ${id} FOR NO KEY UPDATE`);
    return rows[0] ?? null;
  }

  /** Locks the resolved variants in id order (after their style) and reads what the sync compares. */
  private async lockVariants(tx: Transaction, ids: string[]): Promise<Map<string, VariantRow>> {
    if (!ids.length) return new Map();
    const { rows } = await tx.execute<VariantRow>(sql`
      SELECT ${VARIANT_COLUMNS} FROM product_variants
      WHERE id = ANY(${pgArray(ids)}::uuid[])
      ORDER BY id FOR NO KEY UPDATE`);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Reads the target style's options and places each channel option on one (matching names after
   * `ssd_search_normalize`, either language), appending a new option while the style has fewer
   * than `MAX_OPTIONS`. The source store appends every channel value an option lacks; another
   * store only the values of the variants it will create (review minor 2). A channel option that
   * cannot be placed marks `optionsFailed`: then no option is written and every variant of the
   * style answers `option_conflict` (another store's existing variants are not affected, it
   * writes none). Nothing is written here.
   */
  private async loadOptions(state: CallState, plans: readonly Plan[]): Promise<void> {
    const { input } = state;
    if (state.style) {
      const { rows } = await state.tx.execute<{
        id: string;
        position: number;
        name: LocalizedText;
        role: OptionRole;
        values: LocalizedText[];
      }>(sql`
        SELECT id, position, name, role, values FROM product_options
        WHERE product_id = ${state.style.id} ORDER BY position`);
      state.options = rows.map((row) => ({
        id: row.id,
        position: row.position,
        name: row.name,
        role: row.role,
        values: [...row.values],
        nameKeys: [],
        valueKeys: [],
        valuesChanged: false,
      }));
    }
    const texts = [
      ...state.options.flatMap((option) => [
        option.name.en ?? '',
        option.name.ar ?? '',
        ...option.values.flatMap((value) => [value.en ?? '', value.ar ?? '']),
      ]),
      ...input.options.flatMap((option) => [option.name, ...option.values]),
      ...input.variants.flatMap((variant) => variant.optionValues),
    ];
    state.normalized = await this.normalize(state.tx, texts);
    const key = (text: string | undefined) => this.keyOf(state, text);
    for (const option of state.options) {
      option.nameKeys = [key(option.name.en), key(option.name.ar)];
      option.valueKeys = option.values.map((value) => [key(value.en), key(value.ar)]);
    }
    const used = new Set<WorkingOption>();
    state.optionMap = input.options.map((channelOption) => {
      const nameKeys = [key(channelOption.name)];
      let option = state.options.find((candidate) => overlaps(candidate.nameKeys, nameKeys));
      if (!option) {
        if (state.options.length >= MAX_OPTIONS) return null;
        option = {
          id: null,
          position: Math.max(-1, ...state.options.map((candidate) => candidate.position)) + 1,
          name: inSlot(nameLanguageOf(channelOption.name), channelOption.name),
          role: optionRoleOf(nameKeys),
          values: [],
          nameKeys,
          valueKeys: [],
          valuesChanged: false,
        };
        state.options.push(option);
      }
      if (used.has(option)) return null;
      used.add(option);
      return option;
    });
    state.optionsFailed = state.optionMap.some((option) => option === null);
    if (state.optionsFailed) return;
    if (state.content) {
      input.options.forEach((channelOption, position) => {
        for (const value of channelOption.values) this.valueIndex(state, position, value);
      });
    }
    input.variants.forEach((variant, i) => {
      if (!state.content && plans[i]?.kind !== 'new') return;
      variant.optionValues.forEach((value, position) => this.valueIndex(state, position, value));
    });
  }

  /** The index of a channel value on the option placed for input `position`, appending it if new. */
  private valueIndex(state: CallState, position: number, text: string): number {
    const option = state.optionMap[position];
    if (!option) throw new ChannelSyncError('Invariant', 'An unplaced option has no values');
    const keys = [this.keyOf(state, text)];
    const index = option.valueKeys.findIndex((candidate) => overlaps(candidate, keys));
    if (index >= 0) return index;
    option.values.push(inSlot(nameLanguageOf(text), text));
    option.valueKeys.push(keys);
    option.valuesChanged = true;
    return option.values.length - 1;
  }

  /**
   * The match key of a name or value: its `ssd_search_normalize` form, or, for a text that
   * normalizes to nothing (`-`), the trimmed text itself, so it still matches only itself and is
   * never appended twice. Blank is ''.
   */
  private keyOf(state: CallState, text: string | undefined): string {
    const trimmed = text?.trim() ?? '';
    if (!trimmed) return '';
    return state.normalized.get(text ?? '') || `\u0000${trimmed}`;
  }

  /** Every text through `ssd_search_normalize`, in one query. */
  private async normalize(tx: Transaction, texts: string[]): Promise<Map<string, string>> {
    const distinct = [...new Set(texts.filter((text) => text.length > 0))];
    if (!distinct.length) return new Map();
    const { rows } = await tx.execute<{ text: string; key: string }>(sql`
      SELECT t.text, ssd_search_normalize(t.text) AS key
      FROM unnest(${pgArray(distinct)}::text[]) AS t(text)`);
    return new Map(rows.map((row) => [row.text, row.key]));
  }

  /**
   * The target style's variants by option values, read under its row lock: the active ones (the
   * `product_variants_options_unique` set) and the keys archived ones hold, since only an
   * unarchive (inventory's `setArchived`, which takes the variant row before the style row) can
   * make a combination active without the style lock.
   */
  private async loadCombos(state: CallState): Promise<void> {
    if (!state.style) return;
    const { rows } = await state.tx.execute<{
      id: string;
      option_values: Record<string, number>;
      archived: boolean;
    }>(sql`
      SELECT id, option_values, archived_at IS NOT NULL AS archived FROM product_variants
      WHERE product_id = ${state.style.id}`);
    for (const row of rows) {
      const key = optionValuesKey(row.option_values);
      if (row.archived) state.archivedCombos.add(key);
      else state.combos.set(key, row.id);
    }
  }

  /** The channel barcodes of the resolved variants and every barcode holding a channel code. */
  private async loadBarcodes(state: CallState, variantIds: string[]): Promise<void> {
    const codes = state.input.variants.flatMap((variant) => {
      const code = channelBarcodeOf(variant.barcode);
      return typeof code === 'string' ? [code] : [];
    });
    const { rows } = await state.tx.execute<BarcodeRow>(sql`
      SELECT id, variant_id, code, from_channel FROM barcodes
      WHERE code = ANY(${pgArray(codes)}::text[])
         OR (from_channel AND variant_id = ANY(${pgArray(variantIds)}::uuid[]))`);
    for (const row of rows) {
      state.barcodesByCode.set(row.code, row);
      if (row.from_channel) state.channelBarcodes.set(row.variant_id, row);
    }
  }

  /**
   * Inserts the new options and writes appended values before a variant write uses them; a no op
   * once written. `loadOptions` already placed every value the call needs, so nothing is appended
   * later.
   */
  private async writeOptions(state: CallState): Promise<void> {
    if (!state.style) return;
    for (const option of state.options) {
      const values = JSON.stringify(option.values.map(cleanText));
      if (option.id === null) {
        const { rows } = await state.tx.execute<{ id: string }>(sql`
          INSERT INTO product_options (product_id, name, position, role, values)
          VALUES (${state.style.id}, ${JSON.stringify(cleanText(option.name))}::jsonb,
                  ${option.position}, ${option.role}, ${values}::jsonb)
          RETURNING id`);
        option.id = rows[0]?.id ?? null;
        option.valuesChanged = false;
      } else if (option.valuesChanged) {
        await state.tx.execute(sql`
          UPDATE product_options SET values = ${values}::jsonb
          WHERE id = ${option.id} AND values IS DISTINCT FROM ${values}::jsonb`);
        option.valuesChanged = false;
      }
    }
  }

  /** The option values the channel gives a variant of the target style, over its current ones. */
  private desiredOptions(
    state: CallState,
    variant: ChannelVariant,
    current: Readonly<Record<string, number>>,
  ): Record<string, number> {
    const desired: Record<string, number> = { ...current };
    variant.optionValues.forEach((value, position) => {
      const option = state.optionMap[position];
      if (option) desired[String(option.position)] = this.valueIndex(state, position, value);
    });
    return desired;
  }

  /**
   * A variant's option values as `[{ name, value }]` labels for an audit diff: a list, never an
   * object keyed by option name, since a channel's option name could look like a personal key
   * and make `AuditService` refuse the entry (security review L4).
   */
  private optionLabels(state: CallState, values: Readonly<Record<string, number>>): JsonValue[] {
    const labels: JsonValue[] = [];
    for (const option of state.options) {
      const index = values[String(option.position)];
      if (index !== undefined) {
        labels.push({ name: labelOf(option.name), value: labelOf(option.values[index]) });
      }
    }
    return labels;
  }

  /** The channel ids every AC-17 entry carries beside the changed fields. */
  private channelOf(state: CallState, variant?: ChannelVariant): JsonObject {
    return {
      storeId: state.input.storeId,
      externalProductId: state.input.externalProductId,
      ...(variant ? { externalVariantId: variant.externalVariantId } : {}),
    };
  }

  /**
   * One resolved catalog variant (`linked`, `updated`, `unchanged`, or a conflict). Another store
   * than the source writes nothing and answers `linked` (lead ruling 2026-11-11). From the source
   * store: content fields; option values only for a variant of the target style;
   * `channel_linked_at` on first link. `raced` forces `linked` (another writer created it while
   * this call inserted the same SKU).
   */
  private async applyExisting(
    state: CallState,
    variant: ChannelVariant,
    row: VariantRow,
    raced: boolean,
  ): Promise<{ outcome: ChannelVariantOutcome; variantId: string }> {
    if (!state.content) return { outcome: 'linked', variantId: row.id };
    const before: JsonObject = {};
    const after: JsonObject = {};
    const sets: SQL[] = [];
    const guards: SQL[] = [];
    const change = (column: string, key: string, from: JsonValue, to: JsonValue, value: SQL) => {
      before[key] = from;
      after[key] = to;
      sets.push(sql`${sql.identifier(column)} = ${value}`);
      guards.push(sql`${sql.identifier(column)} IS DISTINCT FROM ${value}`);
    };
    const price = moneyText(variant.price);
    if (price !== row.price) change('price', 'price', row.price, price, sql`${price}::numeric`);
    const compareAt = moneyText(variant.compareAtPrice);
    if (compareAt !== row.compare_at_price) {
      change(
        'compare_at_price',
        'compareAtPrice',
        row.compare_at_price,
        compareAt,
        sql`${compareAt}::numeric`,
      );
    }
    if (variant.weightGrams !== row.weight_grams) {
      change(
        'weight_grams',
        'weightGrams',
        row.weight_grams,
        variant.weightGrams,
        sql`${variant.weightGrams}::int`,
      );
    }
    if (variant.requiresShipping !== row.requires_shipping) {
      change(
        'requires_shipping',
        'requiresShipping',
        row.requires_shipping,
        variant.requiresShipping,
        sql`${variant.requiresShipping}::boolean`,
      );
    }
    if (!row.linked) {
      before.channelLinked = false;
      after.channelLinked = true;
      sets.push(sql`channel_linked_at = now()`);
      guards.push(sql`channel_linked_at IS NULL`);
    }
    let optionConflict = false;
    let optionSet: { desired: Record<string, number>; key: string } | null = null;
    if (state.style && row.product_id === state.style.id) {
      if (state.optionsFailed) optionConflict = true;
      else {
        const desired = this.desiredOptions(state, variant, row.option_values);
        const key = optionValuesKey(desired);
        if (key !== optionValuesKey(row.option_values)) {
          const holder = state.combos.get(key);
          if (!row.archived && holder && holder !== row.id) optionConflict = true;
          else optionSet = { desired, key };
        }
      }
    }
    const write = async (executor: Transaction, options: Record<string, number> | null) => {
      const allSets = [...sets];
      const allGuards = [...guards];
      if (options) {
        const json = JSON.stringify(options);
        allSets.push(sql`option_values = ${json}::jsonb`);
        allGuards.push(sql`option_values IS DISTINCT FROM ${json}::jsonb`);
      }
      if (!allSets.length) return;
      await executor.execute(sql`
        UPDATE product_variants SET ${sql.join(allSets, sql`, `)}, updated_at = now()
        WHERE id = ${row.id} AND (${sql.join(allGuards, sql` OR `)})`);
    };
    if (optionSet) {
      const target = optionSet;
      await this.writeOptions(state);
      let written = true;
      // The pre-check (`combos`, read under the style lock) is exact unless an archived variant
      // holds the values and is unarchived in parallel: only then a savepoint (security review L6).
      if (!row.archived && state.archivedCombos.has(target.key)) {
        try {
          await state.tx.transaction((savepoint) => write(savepoint, target.desired));
        } catch (error) {
          if (pgConstraint(error) !== OPTIONS_UNIQUE) throw error;
          written = false;
          optionConflict = true;
          await write(state.tx, null);
        }
      } else await write(state.tx, target.desired);
      if (written) {
        if (!row.archived) {
          state.combos.delete(optionValuesKey(row.option_values));
          state.combos.set(target.key, row.id);
        }
        before.options = this.optionLabels(state, row.option_values);
        after.options = this.optionLabels(state, target.desired);
      }
    } else await write(state.tx, null);
    const barcodeConflict = await this.syncBarcode(state, variant, row.id, before, after);
    const changed = Object.keys(after).length > 0;
    if (changed) {
      state.entries.push({
        actor: state.actor,
        action: !row.linked ? 'sku.channel_linked' : 'sku.channel_updated',
        record: { type: 'sku', id: row.id, label: row.sku },
        before,
        after: { ...after, channel: this.channelOf(state, variant) },
        correlationId: state.correlationId,
      });
    }
    let outcome: ChannelVariantOutcome =
      raced || !row.linked ? 'linked' : changed ? 'updated' : 'unchanged';
    if (barcodeConflict) outcome = 'barcode_conflict';
    if (optionConflict) outcome = 'option_conflict';
    return { outcome, variantId: row.id };
  }

  /**
   * Makes the variant's one channel barcode follow the channel's: added, replaced, or removed; a
   * code another variant holds, or one failing the barcode pattern, is not applied (`true`, the
   * caller answers `barcode_conflict`). A code the variant already holds as an app barcode counts
   * as applied. App barcodes are never touched. The source store writes a channel barcode;
   * another store only seeds a variant it creates, with an app barcode (`from_channel` false).
   * The holder is pre-checked from the codes read under the variant locks; an insert absorbs a
   * parallel add with `ON CONFLICT (tenant_id, code) DO NOTHING`, and only a replacement takes a
   * savepoint (security review L6). Writes the diff into `before` and `after`.
   */
  private async syncBarcode(
    state: CallState,
    variant: ChannelVariant,
    variantId: string,
    before: JsonObject,
    after: JsonObject,
  ): Promise<boolean> {
    const wanted = channelBarcodeOf(variant.barcode);
    if (wanted === INVALID_BARCODE) return true;
    const current = state.channelBarcodes.get(variantId) ?? null;
    if (current?.code === wanted || (current === null && wanted === null)) return false;
    const holder = wanted ? state.barcodesByCode.get(wanted) : undefined;
    if (holder && holder.variant_id !== variantId) return true;
    const record = (to: string | null) => {
      before.barcode = current?.code ?? null;
      after.barcode = to;
    };
    const forget = () => {
      if (!current) return;
      state.barcodesByCode.delete(current.code);
      state.channelBarcodes.delete(variantId);
    };
    if (wanted === null || holder) {
      // No channel barcode now, or the code is already this variant's own app barcode.
      if (!current) return false;
      await state.tx.execute(sql`DELETE FROM barcodes WHERE id = ${current.id}`);
      forget();
      record(wanted);
      return false;
    }
    let row: BarcodeRow | undefined;
    if (current) {
      try {
        row = await state.tx.transaction(async (savepoint) => {
          const { rows } = await savepoint.execute<BarcodeRow>(sql`
            UPDATE barcodes SET code = ${wanted} WHERE id = ${current.id}
            RETURNING id, variant_id, code, from_channel`);
          return rows[0];
        });
      } catch (error) {
        if (pgConstraint(error) !== 'barcodes_code_unique') throw error;
        return true;
      }
    } else {
      const { rows } = await state.tx.execute<BarcodeRow>(sql`
        INSERT INTO barcodes (variant_id, uom_id, code, from_channel)
        VALUES (${variantId}, (SELECT id FROM uoms WHERE code = 'pc'), ${wanted},
                ${state.content}::boolean)
        ON CONFLICT (tenant_id, code) DO NOTHING
        RETURNING id, variant_id, code, from_channel`);
      row = rows[0];
    }
    if (!row) return true;
    forget();
    state.barcodesByCode.set(row.code, row);
    if (row.from_channel) state.channelBarcodes.set(variantId, row);
    record(wanted);
    return false;
  }

  /**
   * One variant the catalog does not hold yet (`created`, or a conflict). Joins the target style,
   * created here when it is the first variant that must be created. Seeds every channel field,
   * kind `stocked` when the channel tracks inventory, else `service`, untracked, in `pc`;
   * archived when its style is archived (the sync never unarchives, and a style is never archived
   * with an active variant); linked only from the source store. The insert takes
   * `ON CONFLICT DO NOTHING` (no target: it absorbs both the SKU and the option values index); no
   * row back is
   * then identified (security review L9): the SKU now exists (another writer created it: locked,
   * its style locked first, and applied as `linked`), or another active variant holds the option
   * values (`option_conflict`), else `UnknownConflict`.
   */
  private async applyNew(
    state: CallState,
    variant: ChannelVariant,
    sku: string,
    retry = true,
  ): Promise<VariantAnswer> {
    if (state.optionsFailed) return { outcome: 'option_conflict', variantId: null };
    const desired = this.desiredOptions(state, variant, {});
    const key = optionValuesKey(desired);
    if (state.style && !state.style.archived && state.combos.has(key)) {
      return { outcome: 'option_conflict', variantId: null };
    }
    const style = state.style ?? (await this.createStyle(state, sku));
    await this.writeOptions(state);
    const kind = variant.tracked ? 'stocked' : 'service';
    const { rows } = await state.tx.execute<{ id: string }>(sql`
      INSERT INTO product_variants
        (product_id, sku, option_values, kind, tracking, base_uom_id, price, compare_at_price,
         weight_grams, requires_shipping, channel_linked_at, archived_at)
      VALUES (${style.id}, ${sku}, ${JSON.stringify(desired)}::jsonb, ${kind}, 'none',
              (SELECT id FROM uoms WHERE code = 'pc'),
              ${moneyText(variant.price)}::numeric, ${moneyText(variant.compareAtPrice)}::numeric,
              ${variant.weightGrams}::int, ${variant.requiresShipping}::boolean,
              ${state.content ? sql`now()` : sql`NULL`},
              ${style.archived ? sql`now()` : sql`NULL`})
      ON CONFLICT DO NOTHING
      RETURNING id`);
    const created = rows[0];
    if (!created) return this.identifyConflict(state, variant, sku, style, desired, retry);
    if (!style.archived) state.combos.set(key, created.id);
    const after: JsonObject = {
      sku,
      styleId: style.id,
      styleCode: style.style_code,
      options: this.optionLabels(state, desired),
      price: moneyText(variant.price),
      compareAtPrice: moneyText(variant.compareAtPrice),
      weightGrams: variant.weightGrams,
      requiresShipping: variant.requiresShipping,
      kind,
      archived: style.archived,
      channelLinked: state.content,
    };
    const barcodeConflict = await this.syncBarcode(state, variant, created.id, {}, after);
    if (!('barcode' in after)) after.barcode = null;
    state.entries.push({
      actor: state.actor,
      action: 'sku.channel_created',
      record: { type: 'sku', id: created.id, label: sku },
      after: { ...after, channel: this.channelOf(state, variant) },
      correlationId: state.correlationId,
    });
    return { outcome: barcodeConflict ? 'barcode_conflict' : 'created', variantId: created.id };
  }

  /**
   * Names the constraint a variant insert that returned no row hit (`applyNew`). The SKU holder,
   * committed by now (the insert waited for it), is read, its style locked (unless it is the
   * target style, already held) and then the variant, and applied as `linked`; one whose SKU
   * changed or that was deleted in between is inserted again, once.
   */
  private async identifyConflict(
    state: CallState,
    variant: ChannelVariant,
    sku: string,
    style: StyleRow,
    desired: Record<string, number>,
    retry: boolean,
  ): Promise<VariantAnswer> {
    const holder = (
      await state.tx.execute<{ id: string; product_id: string }>(sql`
        SELECT id, product_id FROM product_variants WHERE sku = ${sku}`)
    ).rows[0];
    if (holder) {
      if (holder.product_id !== style.id && !state.racedStyles.has(holder.product_id)) {
        const racedStyle = await this.lockStyle(state.tx, holder.product_id);
        if (racedStyle) state.racedStyles.set(racedStyle.id, racedStyle);
      }
      const row = (
        await state.tx.execute<VariantRow>(sql`
          SELECT ${VARIANT_COLUMNS} FROM product_variants WHERE id = ${holder.id}
          FOR NO KEY UPDATE`)
      ).rows[0];
      if (row?.sku === sku) {
        if (row.product_id === style.id && !row.archived) {
          state.combos.set(optionValuesKey(row.option_values), row.id);
        }
        await this.loadBarcodes(state, [row.id]);
        return this.applyExisting(state, variant, row, true);
      }
      if (retry) return this.applyNew(state, variant, sku, false);
    }
    const options = await state.tx.execute(sql`
      SELECT 1 FROM product_variants
      WHERE product_id = ${style.id} AND archived_at IS NULL
        AND option_values = ${JSON.stringify(desired)}::jsonb`);
    if (options.rows.length) return { outcome: 'option_conflict', variantId: null };
    throw new ChannelSyncError('UnknownConflict', 'A variant insert hit an unexpected constraint');
  }

  /**
   * The new style of a channel product (channel rule 3): code from the handle (the first SKU code
   * `sku` when the handle keeps no letter or digit, Q-12.1), `-2`, `-3` on a clash
   * (`ON CONFLICT (tenant_id, style_code) DO NOTHING`, then the next suffix); name in the slot of
   * the title's
   * script; tags, product type, and vendor from the channel; group from
   * `catalog.store_product_groups[storeId]` (missing, unknown, or archived: `MAIN`); season from
   * `catalog.new_style_season` (missing, unknown, or archived: none); active. Linked now with its
   * channel name language only from the source store; another store's style stays app owned
   * (`channel_name_language` null, lead ruling 2026-11-11).
   */
  private async createStyle(state: CallState, sku: string): Promise<StyleRow> {
    const { input, tx } = state;
    await this.lockGrouping(state);
    const slot = nameLanguageOf(input.title);
    const language = state.content ? slot : null;
    const name = JSON.stringify(inSlot(slot, input.title));
    for (let attempt = 1; attempt <= MAX_STYLE_CODE_ATTEMPTS; attempt += 1) {
      const code = styleCodeFromHandle(input.handle, attempt, sku);
      const { rows } = await tx.execute<StyleRow>(sql`
        INSERT INTO products
          (style_code, season_id, product_group_id, name, status, brand, product_type, tags,
           channel_linked_at, channel_name_language)
        VALUES (${code}, ${state.seasonId}, ${state.groupId}, ${name}::jsonb, 'active',
                ${input.vendor}, ${input.productType}, ${pgArray(input.tags)}::text[],
                ${state.content ? sql`now()` : sql`NULL`}, ${language})
        ON CONFLICT (tenant_id, style_code) DO NOTHING
        RETURNING id, style_code, name, tags, product_type, brand, false AS archived,
                  channel_linked_at IS NOT NULL AS linked, channel_name_language`);
      const style = rows[0];
      if (!style) continue;
      state.style = style;
      state.styleCreated = true;
      state.entries.push({
        actor: state.actor,
        action: 'style.channel_created',
        record: { type: 'style', id: style.id, label: style.style_code },
        after: {
          code: style.style_code,
          name: { en: style.name.en ?? null, ar: style.name.ar ?? null },
          channelLinked: state.content,
          channelNameLanguage: language,
          productGroupCode: state.groupCode,
          seasonCode: state.seasonCode,
          tags: input.tags,
          productType: input.productType,
          brand: input.vendor,
          channel: this.channelOf(state),
        },
        correlationId: state.correlationId,
      });
      return style;
    }
    throw new ChannelSyncError(
      'StyleCodeExhausted',
      `No free style code after ${MAX_STYLE_CODE_ATTEMPTS} attempts`,
    );
  }

  /**
   * The group and season of a new style from the two settings: the group the store maps to when
   * it exists and is not archived, else `MAIN`; the season when it exists and is not archived,
   * else none. Each row read `FOR SHARE`, so an archive in flight waits for this commit.
   */
  private async lockGrouping(state: CallState): Promise<void> {
    const groupCode =
      Object.entries(state.groupSetting).find(
        ([storeId]) => storeId.toLowerCase() === state.input.storeId,
      )?.[1] ?? null;
    const group = (
      await state.tx.execute<{ id: string; code: string }>(sql`
        SELECT id, code FROM product_groups
        WHERE code = coalesce(
          (SELECT code FROM product_groups WHERE code = ${groupCode} AND archived_at IS NULL),
          'MAIN')
        FOR SHARE`)
    ).rows[0];
    if (!group) throw new ChannelSyncError('Invariant', 'The seeded MAIN product group is missing');
    state.groupId = group.id;
    state.groupCode = group.code;
    const seasonCode = state.seasonSetting;
    const season = seasonCode
      ? (
          await state.tx.execute<{ id: string; code: string }>(sql`
            SELECT id, code FROM seasons WHERE code = ${seasonCode} AND archived_at IS NULL
            FOR SHARE`)
        ).rows[0]
      : undefined;
    state.seasonId = season?.id ?? null;
    state.seasonCode = season?.code ?? null;
  }

  /**
   * An existing style's channel fields, source store only (another store writes nothing): the
   * first link with its name language from the title's script, then the name in that language,
   * tags, product type, and vendor as `brand`. Compares first; writes and records
   * `style.channel_updated` only when something differs. Returns whether it wrote.
   */
  private async updateStyle(state: CallState, style: StyleRow): Promise<boolean> {
    if (!state.content) return false;
    const { input } = state;
    const language =
      (style.linked ? style.channel_name_language : null) ?? nameLanguageOf(input.title);
    const before: JsonObject = {};
    const after: JsonObject = {};
    const sets: SQL[] = [];
    if (!style.linked || style.channel_name_language === null) {
      before.channelLinked = style.linked;
      before.channelNameLanguage = style.channel_name_language;
      after.channelLinked = true;
      after.channelNameLanguage = language;
      sets.push(sql`channel_linked_at = coalesce(channel_linked_at, now())`);
      sets.push(sql`channel_name_language = ${language}`);
    }
    if ((style.name[language] ?? null) !== input.title) {
      const name = { ...cleanText(style.name), [language]: input.title };
      before.name = { en: style.name.en ?? null, ar: style.name.ar ?? null };
      after.name = { en: name.en ?? null, ar: name.ar ?? null };
      sets.push(sql`name = ${JSON.stringify(name)}::jsonb`);
    }
    if (JSON.stringify(style.tags) !== JSON.stringify(input.tags)) {
      before.tags = style.tags;
      after.tags = input.tags;
      sets.push(sql`tags = ${pgArray(input.tags)}::text[]`);
    }
    if (style.product_type !== input.productType) {
      before.productType = style.product_type;
      after.productType = input.productType;
      sets.push(sql`product_type = ${input.productType}`);
    }
    if (style.brand !== input.vendor) {
      before.brand = style.brand;
      after.brand = input.vendor;
      sets.push(sql`brand = ${input.vendor}`);
    }
    if (!sets.length) return false;
    await state.tx.execute(sql`
      UPDATE products SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE id = ${style.id}`);
    state.entries.push({
      actor: state.actor,
      action: 'style.channel_updated',
      record: { type: 'style', id: style.id, label: style.style_code },
      before,
      after: { ...after, channel: this.channelOf(state) },
      correlationId: state.correlationId,
    });
    return true;
  }

  /** Deletes a style this call created that holds no variant, with its options. */
  private async removeIfEmpty(tx: Transaction, styleId: string): Promise<boolean> {
    const { rows } = await tx.execute(sql`
      SELECT 1 FROM product_variants WHERE product_id = ${styleId} LIMIT 1`);
    if (rows.length) return false;
    await tx.execute(sql`DELETE FROM product_options WHERE product_id = ${styleId}`);
    await tx.execute(sql`DELETE FROM products WHERE id = ${styleId}`);
    return true;
  }
}
