import { Inject, Injectable } from '@nestjs/common';
import {
  OPTION_ROLE_NAMES,
  type AddVariantRequest,
  type AssignStylesRequest,
  type AssignStylesResponse,
  type ChangeStyleCodeRequest,
  type LocalizedText,
  type OptionRole,
  type SkuBarcode,
  type SkuDetail,
  type StyleDetail,
  type StyleListQuery,
  type StyleListResponse,
  type UpdateStyleRequest,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import type { z } from 'zod';
import type { AuditEntryInput, JsonObject } from '../../audit/audit.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import type { Access } from '../../platform/access/access.js';
import { pgArray, pgConstraint, type Executor } from '../../database/sql.js';
import { encodeKeyset } from '../../platform/keyset-cursor.js';
import { BARCODES_CODE_UNIQUE, barcodeTaken } from '../barcodes/barcodes.service.js';
import { catalogActor, type CatalogCaller } from '../catalog-caller.js';
import { catalogTransaction } from '../catalog-transaction.js';
import {
  CatalogError,
  CatalogService,
  OPTIONS_UNIQUE,
  optionCombinationTaken,
} from '../catalog.service.js';
import { CostService } from '../cost.service.js';
import {
  ISO_UTC,
  SKU_ROW_COLUMNS,
  SKU_ROW_FROM,
  searchWords,
  toSkuSummary,
  type SkuRow,
} from '../search/sku-list-sql.js';
import { buildStyleListSql, toStyleSummary, type StyleRow } from '../search/style-list-sql.js';

/** A style has at most this many option axes (spec 0012, AC-10; Shopify's limit too). */
export const MAX_OPTIONS = 3;

/** One style row as the detail and every write read it, locked or not. */
interface StyleRecord extends StyleRow {
  description: LocalizedText | null;
  tags: string[];
  product_type: string | null;
  brand: string | null;
  updated_at: string;
}

/** A style option as stored, with the normalized keys of its name and of each value. */
interface StoredOption extends Record<string, unknown> {
  id: string;
  position: number;
  name: LocalizedText;
  role: OptionRole;
  values: LocalizedText[];
  name_keys: string[];
  value_keys: string[][];
}

/** An option while a variant is being added: stored, or new and still to insert. */
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

const STYLE_RECORD_COLUMNS = sql`
  p.description, p.tags, p.product_type, p.brand,
  to_char(p.updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS updated_at`;

/** Text in both languages without empty ones, as stored in `jsonb` and shown in a diff. */
const cleanText = (text: LocalizedText): { en?: string; ar?: string } => ({
  ...(text.en ? { en: text.en } : {}),
  ...(text.ar ? { ar: text.ar } : {}),
});

/** A name or description in a diff: both languages, absent ones as null. */
const diffText = (text: LocalizedText | null): JsonObject | null =>
  text ? { en: text.en ?? null, ar: text.ar ?? null } : null;

const sameText = (a: LocalizedText | null, b: LocalizedText | null) =>
  JSON.stringify(diffText(a && Object.keys(cleanText(a)).length ? a : null)) ===
  JSON.stringify(diffText(b && Object.keys(cleanText(b)).length ? b : null));

/** Whether two sets of normalized keys share a non empty key (names match after normalizing). */
const overlaps = (a: readonly string[], b: readonly string[]) =>
  a.some((key) => key.length > 0 && b.includes(key));

/** The AC-10 role of a new option from its normalized names (`OPTION_ROLE_NAMES`). */
export function optionRoleOf(nameKeys: readonly string[]): OptionRole {
  const has = (names: readonly string[]) => nameKeys.some((key) => names.includes(key));
  if (has(OPTION_ROLE_NAMES.size)) return 'size';
  if (has(OPTION_ROLE_NAMES.color)) return 'color';
  return 'other';
}

/**
 * The `StyleDetail` serializer on `Access` (spec 0012, AC-12, AC-16): a caller holding
 * `cost.view` gets the detail as is; any other caller gets it without the `cost` key on every
 * variant (`cost` is in `COST_FIELD_KEYS`). Every style detail answer passes through it. Pure.
 */
export function serializeStyleDetail(
  detail: StyleDetail,
  access: Pick<Access, 'has'>,
): StyleDetail {
  if (access.has('cost.view')) return detail;
  return { ...detail, variants: detail.variants.map(({ cost: _cost, ...variant }) => variant) };
}

/**
 * Styles (spec 0012, AC-8 to AC-10, AC-17): the list and the detail, edits with the stale check,
 * the bulk season and group assign, the code change, and adding a variant with option matching.
 * Every write runs in one READ COMMITTED transaction (`catalogTransaction`, run again once on a
 * deadlock) that locks the style row first (then its options and variants, the order the search
 * triggers use), and records its audit entry there.
 * Never archives or deletes a style (inventory's SKU lifecycle does, through `CatalogService`),
 * and never writes `search_text` (the database does).
 */
@Injectable()
export class StylesService {
  /**
   * Takes the app connection, the catalog (SKU answers and grouping checks), the audit writer,
   * and the cost reader (each variant's cost in force on the detail).
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CostService) private readonly costs: CostService,
  ) {}

  /** One page of styles by code (`buildStyleListSql`). */
  async list(query: StyleListQuery): Promise<StyleListResponse> {
    const db = this.connection.db;
    const words = query.q ? await searchWords(db, query.q) : [];
    const { rows } = await db.execute<StyleRow>(buildStyleListSql(query, words));
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toStyleSummary),
      nextCursor: rows.length > query.limit && last ? encodeKeyset([last.style_code]) : null,
    };
  }

  /**
   * One style with its options and variants, each with its cost in force today, or `NotFound`.
   * The controller passes `withCost` false for a caller without `cost.view`, so the cost reads
   * are skipped; `serializeStyleDetail` stays the safety net.
   */
  async get(id: string, withCost = true): Promise<StyleDetail> {
    return this.detail(this.connection.db, id, withCost);
  }

  /**
   * Edits name, description, season, group, and tags (AC-9) with the stale check on the style's
   * `updated_at`. A season or group the style does not hold yet must exist (`NotFound`) and not
   * be archived (`Archived`). Records `style.edited` with the changed fields; a no change edit
   * writes nothing.
   */
  async update(
    id: string,
    input: z.output<typeof UpdateStyleRequest>,
    caller: CatalogCaller,
    withCost = true,
  ): Promise<StyleDetail> {
    const correlationId = this.audit.newCorrelationId();
    return catalogTransaction(this.connection.db, async (tx) => {
      const current = await this.lockStyle(tx, id, input.updatedAt);
      const before: JsonObject = {};
      const after: JsonObject = {};
      const sets: SQL[] = [];
      if (input.name !== undefined && !sameText(input.name, current.name)) {
        before.name = diffText(current.name);
        after.name = diffText(input.name);
        sets.push(sql`name = ${JSON.stringify(cleanText(input.name))}::jsonb`);
      }
      if (input.description !== undefined && !sameText(input.description, current.description)) {
        const description =
          input.description && Object.keys(cleanText(input.description)).length
            ? cleanText(input.description)
            : null;
        before.description = diffText(current.description);
        after.description = diffText(description);
        sets.push(sql`description = ${description ? JSON.stringify(description) : null}::jsonb`);
      }
      if (input.seasonId !== undefined && input.seasonId !== current.season_id) {
        const season = input.seasonId
          ? await this.catalog.assignableGrouping(tx, 'seasons', input.seasonId)
          : null;
        before.seasonId = current.season_id;
        before.seasonCode = current.season_code;
        after.seasonId = input.seasonId;
        after.seasonCode = season?.code ?? null;
        sets.push(sql`season_id = ${input.seasonId}`);
      }
      if (input.productGroupId !== undefined && input.productGroupId !== current.group_id) {
        const group = await this.catalog.assignableGrouping(
          tx,
          'product_groups',
          input.productGroupId,
        );
        before.productGroupId = current.group_id;
        before.productGroupCode = current.group_code;
        after.productGroupId = input.productGroupId;
        after.productGroupCode = group.code;
        sets.push(sql`product_group_id = ${input.productGroupId}`);
      }
      if (input.tags !== undefined && JSON.stringify(input.tags) !== JSON.stringify(current.tags)) {
        before.tags = current.tags;
        after.tags = input.tags;
        sets.push(sql`tags = ${pgArray(input.tags)}::text[]`);
      }
      if (sets.length) {
        await tx.execute(sql`
          UPDATE products SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE id = ${id}`);
        await this.audit.record(tx, {
          actor: catalogActor(caller, 'catalog.edit'),
          action: 'style.edited',
          record: { type: 'style', id, label: current.style_code },
          before,
          after,
          correlationId,
        });
      }
      return this.detail(tx, id, withCost);
    });
  }

  /**
   * Gives 1 to 200 styles a season (null clears it), a group, or both, in one transaction, all
   * or nothing (AC-9). Unknown style ids are `NotFound` with `missingIds`; an unknown season or
   * group `NotFound`, an archived one `Archived`. Locks the styles in id order. Records one
   * `style.edited` per changed style under one correlation id; returns how many changed.
   */
  async assign(
    input: z.output<typeof AssignStylesRequest>,
    caller: CatalogCaller,
  ): Promise<AssignStylesResponse> {
    const correlationId = this.audit.newCorrelationId();
    return catalogTransaction(this.connection.db, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        style_code: string;
        season_id: string | null;
        season_code: string | null;
        product_group_id: string;
        group_code: string;
      }>(sql`
        SELECT p.id, p.style_code, p.season_id, s.code AS season_code, p.product_group_id,
               g.code AS group_code
        FROM products p
        JOIN product_groups g ON g.id = p.product_group_id
        LEFT JOIN seasons s ON s.id = p.season_id
        WHERE p.id = ANY(${pgArray(input.styleIds)}::uuid[])
        ORDER BY p.id
        FOR NO KEY UPDATE OF p`);
      // Ids compare lowercased: the contract lowercases them, Postgres answers lowercase.
      const found = new Set(rows.map((row) => row.id.toLowerCase()));
      const missingIds = input.styleIds.filter((id) => !found.has(id.toLowerCase()));
      if (missingIds.length) {
        throw new CatalogError('NotFound', 'Some styles were not found', { missingIds });
      }
      const season = input.seasonId
        ? await this.catalog.assignableGrouping(tx, 'seasons', input.seasonId)
        : null;
      const group = input.productGroupId
        ? await this.catalog.assignableGrouping(tx, 'product_groups', input.productGroupId)
        : null;
      const entries: AuditEntryInput[] = [];
      const changed: string[] = [];
      for (const row of rows) {
        const before: JsonObject = {};
        const after: JsonObject = {};
        if (input.seasonId !== undefined && input.seasonId !== row.season_id) {
          before.seasonId = row.season_id;
          before.seasonCode = row.season_code;
          after.seasonId = input.seasonId;
          after.seasonCode = season?.code ?? null;
        }
        if (input.productGroupId !== undefined && input.productGroupId !== row.product_group_id) {
          before.productGroupId = row.product_group_id;
          before.productGroupCode = row.group_code;
          after.productGroupId = input.productGroupId;
          after.productGroupCode = group?.code ?? null;
        }
        if (!Object.keys(after).length) continue;
        changed.push(row.id);
        entries.push({
          actor: catalogActor(caller, 'catalog.edit'),
          action: 'style.edited',
          record: { type: 'style', id: row.id, label: row.style_code },
          before,
          after,
          correlationId,
        });
      }
      if (changed.length) {
        const sets: SQL[] = [];
        if (input.seasonId !== undefined) sets.push(sql`season_id = ${input.seasonId}`);
        if (input.productGroupId !== undefined) {
          sets.push(sql`product_group_id = ${input.productGroupId}`);
        }
        await tx.execute(sql`
          UPDATE products SET ${sql.join(sets, sql`, `)}, updated_at = now()
          WHERE id = ANY(${pgArray(changed)}::uuid[])`);
        await this.audit.recordMany(tx, entries);
      }
      return { updated: changed.length };
    });
  }

  /**
   * A new style code (AC-9, `catalog.manage`), with the stale check. A code another style holds
   * is `StyleCodeTaken`. Records `style.code_changed`; the same code changes nothing. Never
   * changes a SKU code (those change only through inventory's code change route).
   */
  async changeCode(
    id: string,
    input: z.output<typeof ChangeStyleCodeRequest>,
    caller: CatalogCaller,
    withCost = true,
  ): Promise<StyleDetail> {
    const correlationId = this.audit.newCorrelationId();
    try {
      return await catalogTransaction(this.connection.db, async (tx) => {
        const current = await this.lockStyle(tx, id, input.updatedAt);
        if (current.style_code !== input.code) {
          await tx.execute(sql`
            UPDATE products SET style_code = ${input.code}, updated_at = now() WHERE id = ${id}`);
          await this.audit.record(tx, {
            actor: catalogActor(caller, 'catalog.manage'),
            action: 'style.code_changed',
            record: { type: 'style', id, label: input.code },
            before: { code: current.style_code },
            after: { code: input.code },
            correlationId,
          });
        }
        return this.detail(tx, id, withCost);
      });
    } catch (error) {
      if (pgConstraint(error) === 'products_style_code_unique') {
        throw new CatalogError('StyleCodeTaken', `Style code ${input.code} is already in use`);
      }
      throw error;
    }
  }

  /**
   * Adds a variant to an active style (AC-10): option names and values match the style's after
   * `ssd_search_normalize` (either language against either language); a new name appends an
   * option (`TooManyOptions` past `MAX_OPTIONS`) with its role from `OPTION_ROLE_NAMES`, a new
   * value is appended to its option. The variant is stocked, untracked, in the `pc` unit. A taken
   * code is `SkuTaken`; the option values of another active variant `OptionCombinationTaken`; a
   * barcode any SKU holds `BarcodeTaken`; an archived style `Archived`; an option given twice,
   * or a name or value that normalizes to nothing in both languages (`-`), `InvalidInput`.
   * Locks the style row first (`FOR NO KEY UPDATE`, the lock `CatalogService.setArchived` takes
   * too), so a variant add and an archive of the style's last variant queue (AC-11). Records
   * `style.variant_added`, and returns the new SKU.
   */
  async addVariant(
    styleId: string,
    input: z.output<typeof AddVariantRequest>,
    caller: CatalogCaller,
  ): Promise<SkuDetail> {
    const correlationId = this.audit.newCorrelationId();
    let variantId: string;
    try {
      variantId = await catalogTransaction(this.connection.db, async (tx) => {
        const style = (
          await tx.execute<{ style_code: string; archived: boolean }>(sql`
            SELECT style_code, archived_at IS NOT NULL AS archived FROM products
            WHERE id = ${styleId} FOR NO KEY UPDATE`)
        ).rows[0];
        if (!style) throw new CatalogError('NotFound', 'Style not found');
        if (style.archived) {
          throw new CatalogError(
            'Archived',
            'This style is archived; unarchive one of its SKUs first',
          );
        }
        const options = await this.workingOptions(tx, styleId);
        const optionValues = await this.placeOptions(tx, options, input.options);
        for (const option of options) {
          if (option.id === null) {
            await tx.execute(sql`
              INSERT INTO product_options (product_id, name, position, role, values)
              VALUES (${styleId}, ${JSON.stringify(cleanText(option.name))}::jsonb,
                      ${option.position}, ${option.role},
                      ${JSON.stringify(option.values.map(cleanText))}::jsonb)`);
          } else if (option.valuesChanged) {
            await tx.execute(sql`
              UPDATE product_options
              SET values = ${JSON.stringify(option.values.map(cleanText))}::jsonb
              WHERE id = ${option.id}`);
          }
        }
        const created = (
          await tx.execute<{ id: string }>(sql`
            INSERT INTO product_variants
              (product_id, sku, option_values, price, kind, tracking, base_uom_id)
            VALUES (${styleId}, ${input.sku}, ${JSON.stringify(optionValues)}::jsonb,
                    ${input.price ?? null}, 'stocked', 'none',
                    (SELECT id FROM uoms WHERE code = 'pc'))
            RETURNING id`)
        ).rows[0];
        if (!created) throw new Error('The variant insert returned no row');
        if (input.barcode) {
          await tx.execute(sql`
            INSERT INTO barcodes (variant_id, uom_id, code)
            VALUES (${created.id}, (SELECT id FROM uoms WHERE code = 'pc'), ${input.barcode})`);
        }
        await this.audit.record(tx, {
          actor: catalogActor(caller, 'catalog.edit'),
          action: 'style.variant_added',
          record: { type: 'style', id: styleId, label: style.style_code },
          after: {
            variantId: created.id,
            sku: input.sku,
            options: input.options.map((pair) => ({
              name: diffText(pair.name),
              value: diffText(pair.value),
            })),
            price: input.price ?? null,
            barcode: input.barcode ?? null,
          },
          correlationId,
        });
        return created.id;
      });
    } catch (error) {
      const constraint = pgConstraint(error);
      if (constraint === 'product_variants_sku_unique') {
        throw new CatalogError('SkuTaken', `SKU ${input.sku} is already in use`);
      }
      if (constraint === OPTIONS_UNIQUE) throw optionCombinationTaken();
      if (constraint === BARCODES_CODE_UNIQUE && input.barcode) {
        throw await barcodeTaken(this.connection.db, input.barcode);
      }
      throw error;
    }
    return this.catalog.getSku(variantId);
  }

  /** The style's options with the normalized keys of their names and values, by position. */
  private async workingOptions(tx: Executor, styleId: string): Promise<WorkingOption[]> {
    const { rows } = await tx.execute<StoredOption>(sql`
      SELECT o.id, o.position, o.name, o.role, o.values,
             ARRAY[ssd_search_normalize(coalesce(o.name ->> 'en', '')),
                   ssd_search_normalize(coalesce(o.name ->> 'ar', ''))] AS name_keys,
             coalesce((
               SELECT jsonb_agg(jsonb_build_array(
                        ssd_search_normalize(coalesce(e.value ->> 'en', '')),
                        ssd_search_normalize(coalesce(e.value ->> 'ar', ''))) ORDER BY e.ordinality)
               FROM jsonb_array_elements(o.values) WITH ORDINALITY AS e(value, ordinality)),
               '[]'::jsonb) AS value_keys
      FROM product_options o
      WHERE o.product_id = ${styleId}
      ORDER BY o.position`);
    return rows.map((row) => ({
      id: row.id,
      position: row.position,
      name: row.name,
      role: row.role,
      values: [...row.values],
      nameKeys: row.name_keys,
      valueKeys: [...row.value_keys],
      valuesChanged: false,
    }));
  }

  /**
   * Places each name and value pair on the style's options (appending options and values as
   * needed, in `options`) and returns the variant's `option_values` (position to value index).
   * Every text is normalized by `ssd_search_normalize` in one query.
   */
  private async placeOptions(
    tx: Executor,
    options: WorkingOption[],
    pairs: z.output<typeof AddVariantRequest>['options'],
  ): Promise<Record<string, number>> {
    const texts = pairs.flatMap((pair) => [
      pair.name.en ?? '',
      pair.name.ar ?? '',
      pair.value.en ?? '',
      pair.value.ar ?? '',
    ]);
    const normalized = texts.length
      ? (
          await tx.execute<{ key: string }>(sql`
            SELECT ssd_search_normalize(t.text) AS key
            FROM unnest(${pgArray(texts)}::text[]) WITH ORDINALITY AS t(text, ordinality)
            ORDER BY t.ordinality`)
        ).rows.map((row) => row.key)
      : [];
    const optionValues: Record<string, number> = {};
    const used = new Set<WorkingOption>();
    pairs.forEach((pair, i) => {
      const nameKeys = [normalized[i * 4] ?? '', normalized[i * 4 + 1] ?? ''];
      const valueKeys = [normalized[i * 4 + 2] ?? '', normalized[i * 4 + 3] ?? ''];
      // A text that normalizes to nothing never matches, so it would append a duplicate each
      // time and slip past OPTION_COMBINATION_TAKEN (review M2 nit 4).
      if (nameKeys.every((key) => !key) || valueKeys.every((key) => !key)) {
        throw new CatalogError(
          'InvalidInput',
          'An option name and value need at least one letter or digit',
        );
      }
      let option = options.find((candidate) => overlaps(candidate.nameKeys, nameKeys));
      if (!option) {
        if (options.length >= MAX_OPTIONS) {
          throw new CatalogError('TooManyOptions', `A style has at most ${MAX_OPTIONS} options`);
        }
        option = {
          id: null,
          position: Math.max(-1, ...options.map((candidate) => candidate.position)) + 1,
          name: pair.name,
          role: optionRoleOf(nameKeys),
          values: [],
          nameKeys,
          valueKeys: [],
          valuesChanged: false,
        };
        options.push(option);
      }
      if (used.has(option)) {
        throw new CatalogError('InvalidInput', 'Each option may be given only once');
      }
      used.add(option);
      let index = option.valueKeys.findIndex((keys) => overlaps(keys, valueKeys));
      if (index < 0) {
        option.values.push(pair.value);
        option.valueKeys.push(valueKeys);
        option.valuesChanged = true;
        index = option.values.length - 1;
      }
      optionValues[String(option.position)] = index;
    });
    return optionValues;
  }

  /**
   * Locks the style row (`FOR NO KEY UPDATE`, first, before its options and variants) and
   * checks the stale value: 0 rows is `NotFound`, another `updated_at` is `Stale`.
   */
  private async lockStyle(tx: Executor, id: string, updatedAt: string): Promise<StyleRecord> {
    const { rows } = await tx.execute<StyleRecord>(sql`
      SELECT ${this.recordColumns()}
      FROM ${this.recordFrom()}
      WHERE p.id = ${id}
      FOR NO KEY UPDATE OF p`);
    const row = rows[0];
    if (!row) throw new CatalogError('NotFound', 'Style not found');
    if (row.updated_at !== updatedAt) {
      throw new CatalogError('Stale', 'Someone else changed this style. Reload and try again.');
    }
    return row;
  }

  private recordColumns(): SQL {
    return sql`${this.listColumns()}, ${STYLE_RECORD_COLUMNS}`;
  }

  private listColumns(): SQL {
    return sql`
      p.id, p.style_code, p.name,
      s.id AS season_id, s.code AS season_code, s.name AS season_name,
      g.id AS group_id, g.code AS group_code, g.name AS group_name,
      0 AS active_variants, p.archived_at IS NOT NULL AS archived`;
  }

  private recordFrom(): SQL {
    return sql`products p
      JOIN product_groups g ON g.id = p.product_group_id
      LEFT JOIN seasons s ON s.id = p.season_id`;
  }

  /**
   * The style page's answer: the style, its options by position, its variants by code, each
   * with its `cost` in force on today's operating day (`CostService.costForMany`, one query).
   * Carries cost only when `withCost`; the controller serializes it on `Access` as well.
   */
  private async detail(executor: Executor, id: string, withCost: boolean): Promise<StyleDetail> {
    const { rows } = await executor.execute<StyleRecord>(sql`
      SELECT ${this.recordColumns()} FROM ${this.recordFrom()} WHERE p.id = ${id}`);
    const row = rows[0];
    if (!row) throw new CatalogError('NotFound', 'Style not found');
    const options = await executor.execute<StoredOption>(sql`
      SELECT id, position, name, role, values FROM product_options
      WHERE product_id = ${id} ORDER BY position`);
    const variants = await executor.execute<SkuRow>(sql`
      SELECT ${SKU_ROW_COLUMNS} FROM ${SKU_ROW_FROM}
      WHERE v.product_id = ${id}
      ORDER BY v.sku COLLATE "C"`);
    const ids = variants.rows.map((variant) => variant.id);
    const barcodes = ids.length
      ? (
          await executor.execute<SkuBarcode & { variant_id: string }>(sql`
            SELECT id, code, variant_id FROM barcodes
            WHERE variant_id = ANY(${pgArray(ids)}::uuid[])
            ORDER BY code COLLATE "C"`)
        ).rows
      : [];
    const costs = withCost
      ? await this.costs.costForMany(ids, await this.costs.today(executor), executor)
      : null;
    const summary = toStyleSummary(row);
    return {
      id: summary.id,
      code: summary.code,
      name: summary.name,
      description: row.description ? cleanText(row.description) : null,
      season: summary.season,
      productGroup: summary.productGroup,
      tags: row.tags,
      productType: row.product_type,
      brand: row.brand,
      archived: row.archived,
      updatedAt: row.updated_at,
      options: options.rows.map((option) => ({
        id: option.id,
        name: cleanText(option.name),
        role: option.role,
        position: option.position,
        values: option.values.map(cleanText),
      })),
      variants: variants.rows.map((variant) => {
        const sku = toSkuSummary(variant);
        return {
          id: sku.id,
          code: sku.code,
          options: sku.options,
          price: sku.price,
          archived: sku.archived,
          barcodes: barcodes
            .filter((barcode) => barcode.variant_id === sku.id)
            .map((barcode) => ({ id: barcode.id, code: barcode.code })),
          ...(costs && { cost: costs.get(sku.id) ?? { status: 'not_set' as const } }),
        };
      }),
    };
  }
}
