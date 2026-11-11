import { OPTION_ROLE_NAMES, StyleListQuery } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { encodeKeyset, InvalidCursorError } from '../../platform/keyset-cursor.js';
import { optionRoleOf } from '../styles/styles.service.js';
import { buildStyleListSql, toStyleSummary, type StyleRow } from './style-list-sql.js';

/** The SQL text of a Drizzle SQL object, bound strings as `'<value>'`, others as `?`. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk): string => {
      if (typeof chunk === 'object' && chunk !== null) {
        const value = (chunk as { value?: unknown }).value;
        if (Array.isArray(value)) return value.join('');
        if (Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) return sqlText(chunk);
      }
      return typeof chunk === 'string' ? `'${chunk}'` : '?';
    })
    .join('')
    .replace(/\s+/g, ' ');
}

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const query = (input: Record<string, unknown>) => StyleListQuery.parse(input);

describe('buildStyleListSql (spec 0012, AC-8)', () => {
  it('lists active styles by code, 50 a page plus one to know a next page follows', () => {
    const text = sqlText(buildStyleListSql(query({})));

    expect(text).toContain('p.archived_at IS NULL');
    expect(text).toContain('ORDER BY p.style_code COLLATE "C"');
    expect(text).toMatch(/LIMIT \?$/);
    expect(text).not.toContain('EXISTS (SELECT 1 FROM product_variants v');
  });

  it('filters by archived status, no season, a season, a group, and the cursor', () => {
    const none = sqlText(buildStyleListSql(query({ status: 'archived', seasonId: 'none' })));
    const some = sqlText(
      buildStyleListSql(query({ seasonId: ID, productGroupId: ID, cursor: encodeKeyset(['TEE']) })),
    );

    expect(none).toContain('p.archived_at IS NOT NULL');
    expect(none).toContain('p.season_id IS NULL');
    expect(some).toContain(`p.season_id = '${ID}'`);
    expect(some).toContain(`p.product_group_id = '${ID}'`);
    expect(some).toContain(`p.style_code COLLATE "C" > 'TEE' COLLATE "C"`);
    expect(() => buildStyleListSql(query({ cursor: 'not-a-cursor' }))).toThrow(InvalidCursorError);
  });

  it('matches q on the style code prefix or a variant code prefix, and on every word only with a long word', () => {
    const short = sqlText(buildStyleListSql(query({ q: 'm' }), ['m']));
    const long = sqlText(buildStyleListSql(query({ q: 'black tee' }), ['black', 'tee']));

    expect(short).toContain(`p.style_code COLLATE "C" LIKE 'M%'`);
    expect(short).toContain(`v.sku COLLATE "C" LIKE 'M%'`);
    expect(short).not.toContain('search_text');
    expect(long).toContain(`v.search_text LIKE '%black%' AND v.search_text LIKE '%tee%'`);
  });

  it('matches an active style by its active variants only, an archived one by any variant', () => {
    const active = sqlText(buildStyleListSql(query({ q: 'navy' }), ['navy']));
    const archived = sqlText(buildStyleListSql(query({ q: 'navy', status: 'archived' }), ['navy']));

    expect(active).toContain('v.product_id = p.id AND v.archived_at IS NULL');
    expect(archived).not.toContain(' v.archived_at IS NULL');
    expect(archived).toContain('v.product_id = p.id AND (v.sku');
  });
});

describe('toStyleSummary', () => {
  it('maps a row with no season, dropping null languages', () => {
    const row: StyleRow = {
      id: ID,
      style_code: 'TEE',
      name: { en: 'Tee' },
      season_id: null,
      season_code: null,
      season_name: null,
      group_id: ID,
      group_code: 'MAIN',
      group_name: { en: 'Main', ar: 'الرئيسية' },
      active_variants: 3,
      archived: false,
    };

    expect(toStyleSummary(row)).toEqual({
      id: ID,
      code: 'TEE',
      name: { en: 'Tee', ar: undefined },
      season: null,
      productGroup: { id: ID, code: 'MAIN', name: { en: 'Main', ar: 'الرئيسية' } },
      activeVariantCount: 3,
      archived: false,
    });
  });
});

describe('optionRoleOf (spec 0012, AC-10)', () => {
  it('gives size and color from OPTION_ROLE_NAMES in either language slot, else other', () => {
    for (const name of OPTION_ROLE_NAMES.size) expect(optionRoleOf([name, ''])).toBe('size');
    for (const name of OPTION_ROLE_NAMES.color) expect(optionRoleOf(['', name])).toBe('color');
    expect(optionRoleOf(['fit', 'المقاس'])).toBe('size');
    expect(optionRoleOf(['fit', ''])).toBe('other');
    expect(optionRoleOf(['', ''])).toBe('other');
  });
});
