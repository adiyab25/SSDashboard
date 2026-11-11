import type { LocalizedText, StyleListQuery, StyleSummary } from '@ssdashboard/contracts';
import { sql, type SQL } from '@ssdashboard/db';
import { decodeKeyset } from '../../platform/keyset-cursor.js';
import { codePrefixOf, escapeLike, MIN_CONTAINS_WORD } from './sku-list-sql.js';

/** One style row as the list query selects it. */
export interface StyleRow extends Record<string, unknown> {
  id: string;
  style_code: string;
  name: LocalizedText;
  season_id: string | null;
  season_code: string | null;
  season_name: LocalizedText | null;
  group_id: string;
  group_code: string;
  group_name: LocalizedText;
  active_variants: number;
  archived: boolean;
}

/** The style columns of the list, over `p` (style), `g` (group), and `s` (season, or null). */
export const STYLE_ROW_COLUMNS = sql`
  p.id, p.style_code, p.name,
  s.id AS season_id, s.code AS season_code, s.name AS season_name,
  g.id AS group_id, g.code AS group_code, g.name AS group_name,
  (SELECT count(*)::int FROM product_variants av
    WHERE av.product_id = p.id AND av.archived_at IS NULL) AS active_variants,
  p.archived_at IS NOT NULL AS archived`;

/** A style with its product group (`g`) and season (`s`, null when none). */
export const STYLE_ROW_FROM = sql`
  products p
  JOIN product_groups g ON g.id = p.product_group_id
  LEFT JOIN seasons s ON s.id = p.season_id`;

const localized = (text: LocalizedText | null): LocalizedText => ({
  en: text?.en ?? undefined,
  ar: text?.ar ?? undefined,
});

/** A selected row as the contract's `StyleSummary`. */
export function toStyleSummary(row: StyleRow): StyleSummary {
  return {
    id: row.id,
    code: row.style_code,
    name: localized(row.name),
    season:
      row.season_id && row.season_code
        ? { id: row.season_id, code: row.season_code, name: localized(row.season_name) }
        : null,
    productGroup: { id: row.group_id, code: row.group_code, name: localized(row.group_name) },
    activeVariantCount: row.active_variants,
    archived: row.archived,
  };
}

/**
 * The SQL behind `GET /api/styles` (spec 0012, AC-8). `words` come from `searchWords(q)`, the
 * same normalized words the SKU search uses. Filters: status (the style's own archive), season
 * (`none` for no season), product group, and the keyset cursor on the style code
 * (`COLLATE "C"`). With `q`, a style matches when its code starts with q (Western digits,
 * uppercased, LIKE escaped), or when any of its variants (only its active ones, unless the list
 * is `status=archived`) matches the SKU search's code prefix branch or, when a word has
 * `MIN_CONTAINS_WORD` or more characters, its every word branch.
 * Fetches `limit + 1` rows so the caller knows whether another page follows.
 */
export function buildStyleListSql(query: StyleListQuery, words: readonly string[] = []): SQL {
  const filters: SQL[] = [
    query.status === 'archived' ? sql`p.archived_at IS NOT NULL` : sql`p.archived_at IS NULL`,
  ];
  if (query.seasonId === 'none') filters.push(sql`p.season_id IS NULL`);
  else if (query.seasonId) filters.push(sql`p.season_id = ${query.seasonId}`);
  if (query.productGroupId) filters.push(sql`p.product_group_id = ${query.productGroupId}`);
  if (query.cursor) {
    const [after] = decodeKeyset(query.cursor, 1);
    filters.push(sql`p.style_code COLLATE "C" > ${after} COLLATE "C"`);
  }
  if (query.q) {
    const prefix = codePrefixOf(query.q);
    const variantMatches: SQL[] = [sql`v.sku COLLATE "C" LIKE ${prefix}`];
    if (words.some((word) => word.length >= MIN_CONTAINS_WORD)) {
      variantMatches.push(
        sql`(${sql.join(
          words.map((word) => sql`v.search_text LIKE ${`%${escapeLike(word)}%`}`),
          sql` AND `,
        )})`,
      );
    }
    // An active style matches by its active variants only; an archived style has none, so the
    // archived list matches by any of its variants (review M2 nit 1, catalog README Decisions).
    const variantStatus = query.status === 'archived' ? sql`` : sql`AND v.archived_at IS NULL`;
    filters.push(sql`(p.style_code COLLATE "C" LIKE ${prefix}
      OR EXISTS (SELECT 1 FROM product_variants v
                 WHERE v.product_id = p.id ${variantStatus}
                   AND (${sql.join(variantMatches, sql` OR `)})))`);
  }
  return sql`
    SELECT ${STYLE_ROW_COLUMNS}
    FROM ${STYLE_ROW_FROM}
    WHERE ${sql.join(filters, sql` AND `)}
    ORDER BY p.style_code COLLATE "C"
    LIMIT ${query.limit + 1}`;
}
