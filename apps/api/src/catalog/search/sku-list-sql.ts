import type {
  LocalizedText,
  SkuListQuery,
  SkuOptionValue,
  SkuSummary,
} from '@ssdashboard/contracts';
import { normalizeDigits } from '@ssdashboard/i18n';
import { sql, type SQL } from '@ssdashboard/db';
import type { Executor } from '../../database/sql.js';
import { decodeKeyset } from '../../platform/keyset-cursor.js';

/** `to_char` format of `updatedAt`: microseconds, UTC (spec 0006, Value sourcing). */
export const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** At most this many distinct normalized words of `q` are matched (spec 0012, AC-3). */
export const MAX_SEARCH_WORDS = 5;

/**
 * The shortest word that runs the contains branch: a shorter `LIKE '%w%'` pattern gives the
 * trigram index nothing to look up (spec 0012, Search).
 */
export const MIN_CONTAINS_WORD = 3;

/** `%`, `_`, and `\` match themselves in a LIKE pattern. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The words a search matches, from the output of `ssd_search_normalize(q)`: split on spaces,
 * duplicates dropped, the first `MAX_SEARCH_WORDS` kept in order. Never normalizes itself, so
 * the query and the stored column always agree on one SQL function.
 */
export function searchWordsOf(normalized: string): string[] {
  return [...new Set(normalized.split(' ').filter((word) => word.length > 0))].slice(
    0,
    MAX_SEARCH_WORDS,
  );
}

/**
 * Runs `ssd_search_normalize(q)` in the database (the same function the stored `search_text`
 * uses) and returns its words for `buildSkuListSql`. Never normalizes in TypeScript.
 */
export async function searchWords(executor: Executor, q: string): Promise<string[]> {
  const { rows } = await executor.execute<{ normalized: string | null }>(
    sql`SELECT ssd_search_normalize(${q}) AS normalized`,
  );
  return searchWordsOf(rows[0]?.normalized ?? '');
}

/** The barcode branch's value: q trimmed, Western digits, uppercased (spec 0012, Value sourcing). */
export function barcodeOf(q: string): string {
  return normalizeDigits(q.trim()).toUpperCase();
}

/** The prefix branch's pattern: q in Western digits, uppercased, LIKE escaped, then `%`. */
export function codePrefixOf(q: string): string {
  return `${escapeLike(normalizeDigits(q).toUpperCase())}%`;
}

/** One SKU row as the list and detail queries select it. */
export interface SkuRow extends Record<string, unknown> {
  id: string;
  product_id: string;
  sku: string;
  name: LocalizedText;
  style_code: string;
  season_id: string | null;
  season_code: string | null;
  season_name: LocalizedText | null;
  group_id: string;
  group_code: string;
  group_name: LocalizedText;
  options: SkuOptionValue[];
  price: string | null;
  archived: boolean;
  updated_at: string;
}

/**
 * The SKU columns of spec 0012 AC-4, over `SKU_ROW_FROM`. The option value lookup
 * (`o.values -> ((v.option_values ->> o.position::text)::int)`) repeats the one in the database
 * function `ssd_variant_search_text` (`packages/db/migrations/0014_catalog_search_rules.sql`);
 * change both together. Never write `search_text` from here: the database stamps it.
 */
export const SKU_ROW_COLUMNS = sql`
  v.id, v.product_id, v.sku, p.name, p.style_code,
  s.id AS season_id, s.code AS season_code, s.name AS season_name,
  g.id AS group_id, g.code AS group_code, g.name AS group_name,
  coalesce((
    SELECT jsonb_agg(jsonb_build_object('name', o.name, 'value', l.label) ORDER BY o.position)
    FROM product_options o,
         LATERAL (SELECT o.values -> ((v.option_values ->> o.position::text)::int)) AS l(label)
    WHERE o.product_id = v.product_id AND l.label IS NOT NULL), '[]'::jsonb) AS options,
  v.price, v.archived_at IS NOT NULL AS archived,
  to_char(v.updated_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS updated_at`;

/** A variant with its style (`p`), product group (`g`), and season (`s`, null when none). */
export const SKU_ROW_FROM = sql`
  product_variants v
  JOIN products p ON p.id = v.product_id
  JOIN product_groups g ON g.id = p.product_group_id
  LEFT JOIN seasons s ON s.id = p.season_id`;

const localized = (text: LocalizedText): LocalizedText => ({ en: text.en, ar: text.ar });

/** A selected row as the contract's `SkuSummary`. */
export function toSkuSummary(row: SkuRow): SkuSummary {
  const name = localized(row.name);
  return {
    id: row.id,
    productId: row.product_id,
    code: row.sku,
    name,
    style: { id: row.product_id, code: row.style_code, name },
    season:
      row.season_id && row.season_code
        ? { id: row.season_id, code: row.season_code, name: localized(row.season_name ?? {}) }
        : null,
    productGroup: { id: row.group_id, code: row.group_code, name: localized(row.group_name) },
    options: row.options.map((option) => ({
      name: localized(option.name),
      value: localized(option.value),
    })),
    price: row.price,
    archived: row.archived,
  };
}

/**
 * The conditions every branch carries: status, season (`none` for no season), product group,
 * style, and the keyset cursor on the code (`COLLATE "C"`). Over `v` (variant) and `p` (style).
 */
function filtersOf(query: SkuListQuery): SQL {
  const filters: SQL[] = [
    query.status === 'archived' ? sql`v.archived_at IS NOT NULL` : sql`v.archived_at IS NULL`,
  ];
  if (query.seasonId === 'none') filters.push(sql`p.season_id IS NULL`);
  else if (query.seasonId) filters.push(sql`p.season_id = ${query.seasonId}`);
  if (query.productGroupId) filters.push(sql`p.product_group_id = ${query.productGroupId}`);
  if (query.styleId) filters.push(sql`v.product_id = ${query.styleId}`);
  if (query.cursor) {
    const [after] = decodeKeyset(query.cursor, 1);
    filters.push(sql`v.sku COLLATE "C" > ${after} COLLATE "C"`);
  }
  return sql.join(filters, sql` AND `);
}

/**
 * The SQL behind `GET /api/skus` (spec 0012, AC-3 and AC-4). `words` come from
 * `searchWords(q)`. Without `q`, one filtered page in code order. With `q`, the union of
 * branches, each filtered, ordered by code (`COLLATE "C"`), and limited, then ordered and paged
 * by code again:
 * (a) the variant whose barcode equals q trimmed, in Western digits, uppercased
 *     (`barcodes_code_unique`);
 * (b) variants whose code starts with q in Western digits, uppercased, LIKE escaped
 *     (`product_variants_sku_c_idx`);
 * (c) only when a word has `MIN_CONTAINS_WORD` or more characters: variants whose
 *     `search_text` contains every word, each as `LIKE '%word%'` escaped
 *     (`product_variants_search_trgm_idx`).
 * UNION (not ALL) lists a SKU matching several branches once. Never an OR across branches,
 * which would force a scan of every row.
 */
export function buildSkuListSql(query: SkuListQuery, words: readonly string[] = []): SQL {
  const where = filtersOf(query);
  const limit = query.limit + 1;
  if (!query.q) {
    return sql`
      SELECT ${SKU_ROW_COLUMNS}
      FROM ${SKU_ROW_FROM}
      WHERE ${where}
      ORDER BY v.sku COLLATE "C"
      LIMIT ${limit}`;
  }
  const branches: SQL[] = [
    sql`SELECT v.id FROM barcodes b
          JOIN product_variants v ON v.id = b.variant_id
          JOIN products p ON p.id = v.product_id
        WHERE b.tenant_id = current_setting('ssd.tenant_id')::uuid
          AND b.code = ${barcodeOf(query.q)} AND ${where}
        ORDER BY v.sku COLLATE "C" LIMIT ${limit}`,
    sql`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE ${where} AND v.sku COLLATE "C" LIKE ${codePrefixOf(query.q)}
        ORDER BY v.sku COLLATE "C" LIMIT ${limit}`,
  ];
  if (words.some((word) => word.length >= MIN_CONTAINS_WORD)) {
    const contains = words.map((word) => sql`v.search_text LIKE ${`%${escapeLike(word)}%`}`);
    branches.push(
      sql`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE ${where} AND ${sql.join(contains, sql` AND `)}
          ORDER BY v.sku COLLATE "C" LIMIT ${limit}`,
    );
  }
  return sql`
    SELECT ${SKU_ROW_COLUMNS}
    FROM ${SKU_ROW_FROM}
    WHERE v.id IN (${sql.join(
      branches.map((branch) => sql`(${branch})`),
      sql` UNION `,
    )})
    ORDER BY v.sku COLLATE "C"
    LIMIT ${limit}`;
}
