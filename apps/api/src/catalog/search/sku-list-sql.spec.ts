import { SkuListQuery } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import { encodeKeyset, InvalidCursorError } from '../../platform/keyset-cursor.js';
import {
  barcodeOf,
  buildSkuListSql,
  codePrefixOf,
  escapeLike,
  searchWordsOf,
  toSkuSummary,
  type SkuRow,
} from './sku-list-sql.js';

/**
 * The SQL text of a Drizzle SQL object, nested SQL included, each bound string written as
 * `'<value>'` and any other bound value as `?`, whitespace collapsed.
 */
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

const BACKSLASH = String.fromCharCode(92);
const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const query = (input: Record<string, unknown>) => SkuListQuery.parse(input);
const count = (text: string, part: string) => text.split(part).length - 1;

describe('searchWordsOf (spec 0012, AC-3)', () => {
  it('splits the normalized text on spaces and keeps the first 5 distinct words in order', () => {
    expect(searchWordsOf('black tee')).toEqual(['black', 'tee']);
    expect(searchWordsOf('a b a c d e f')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(searchWordsOf('')).toEqual([]);
  });
});

describe('the branch values (spec 0012, Value sourcing)', () => {
  it('matches a barcode trimmed, in Western digits, uppercased', () => {
    expect(barcodeOf(' ٦٢٢abc ')).toBe('622ABC');
  });

  it('matches a code prefix in Western digits, uppercased, LIKE escaped', () => {
    expect(codePrefixOf('٢٠٤٤-blk')).toBe('2044-BLK%');
    expect(codePrefixOf('es_')).toBe(`ES${BACKSLASH}_%`);
    expect(codePrefixOf('5%')).toBe(`5${BACKSLASH}%%`);
  });

  it('escapes %, _, and a backslash', () => {
    expect(escapeLike(`a%b_c${BACKSLASH}`)).toBe(
      `a${BACKSLASH}%b${BACKSLASH}_c${BACKSLASH}${BACKSLASH}`,
    );
  });

  it.each([
    ['100%', `100${BACKSLASH}%`],
    ['A_B', `A${BACKSLASH}_B`],
    [`back${BACKSLASH}slash`, `back${BACKSLASH}${BACKSLASH}slash`],
    ['plain', 'plain'],
  ])('makes %s match itself', (input, escaped) => {
    expect(escapeLike(input)).toBe(escaped);
  });
});

describe('buildSkuListSql (spec 0012, AC-3, AC-4)', () => {
  it('lists without q in code order, limit + 1, with no branch', () => {
    const text = sqlText(buildSkuListSql(query({ limit: '20' })));
    expect(text).toContain('WHERE v.archived_at IS NULL ORDER BY v.sku COLLATE "C" LIMIT ?');
    expect(text).not.toContain('UNION');
    expect(text).not.toContain('search_text');
  });

  it('runs only the barcode and prefix branches when no word has 3 characters (`m` alone)', () => {
    const text = sqlText(buildSkuListSql(query({ q: 'm' }), ['m']));
    expect(text).toContain("b.code = 'M'");
    expect(text).toContain(`v.sku COLLATE "C" LIKE 'M%'`);
    expect(count(text, ' UNION ')).toBe(1);
    expect(text).not.toContain('search_text');
  });

  it('adds the contains branch with every word, escaped, when one word has 3 or more characters', () => {
    const text = sqlText(buildSkuListSql(query({ q: 'Black M' }), ['black', 'm']));
    expect(count(text, ' UNION ')).toBe(2);
    expect(text).toContain(
      "v.search_text LIKE '%black%' AND v.search_text LIKE '%m%' ORDER BY v.sku COLLATE \"C\" LIMIT ?",
    );
    const escaped = sqlText(buildSkuListSql(query({ q: 'x' }), ['a_b%']));
    expect(escaped).toContain(`v.search_text LIKE '%a${BACKSLASH}_b${BACKSLASH}%%'`);
  });

  it('orders and limits each branch by code, then the union again', () => {
    const text = sqlText(buildSkuListSql(query({ q: 'black tee' }), ['black', 'tee']));
    expect(count(text, 'ORDER BY v.sku COLLATE "C" LIMIT ?')).toBe(4);
    expect(text).toContain('WHERE v.id IN ((SELECT v.id FROM barcodes b');
  });

  it('puts the status, season, group, style, and cursor filters into every branch', () => {
    const cursor = encodeKeyset(['TEE-M']);
    const text = sqlText(
      buildSkuListSql(
        query({
          q: 'tee',
          status: 'archived',
          seasonId: ID,
          productGroupId: ID,
          styleId: ID,
          cursor,
        }),
        ['tee'],
      ),
    );
    for (const filter of [
      'v.archived_at IS NOT NULL AND',
      `p.season_id = '${ID}'`,
      `p.product_group_id = '${ID}'`,
      `v.product_id = '${ID}'`,
      `v.sku COLLATE "C" > 'TEE-M' COLLATE "C"`,
    ]) {
      expect(count(text, filter), filter).toBe(3);
    }
    expect(text).not.toContain('v.archived_at IS NULL');
  });

  it('filters styles with no season for seasonId=none', () => {
    const text = sqlText(buildSkuListSql(query({ seasonId: 'none' })));
    expect(text).toContain('p.season_id IS NULL');
  });

  it('refuses a cursor it did not issue', () => {
    expect(() => buildSkuListSql(query({ cursor: 'nope' }))).toThrow(InvalidCursorError);
  });
});

describe('toSkuSummary (spec 0012, AC-4)', () => {
  const row: SkuRow = {
    id: ID,
    product_id: ID,
    sku: 'TEE-BLK-M',
    name: { en: 'Tee', ar: 'تيشيرت' },
    style_code: 'TEE',
    season_id: null,
    season_code: null,
    season_name: null,
    group_id: ID,
    group_code: 'MAIN',
    group_name: { en: 'Main' },
    options: [{ name: { en: 'Size' }, value: { en: 'M', ar: 'وسط' } }],
    price: '10.00',
    archived: false,
    updated_at: '2026-11-08T10:00:00.000000Z',
  };

  it('names the style, a null season, the group, and the option values', () => {
    expect(toSkuSummary(row)).toEqual({
      id: ID,
      productId: ID,
      code: 'TEE-BLK-M',
      name: { en: 'Tee', ar: 'تيشيرت' },
      style: { id: ID, code: 'TEE', name: { en: 'Tee', ar: 'تيشيرت' } },
      season: null,
      productGroup: { id: ID, code: 'MAIN', name: { en: 'Main', ar: undefined } },
      options: [{ name: { en: 'Size', ar: undefined }, value: { en: 'M', ar: 'وسط' } }],
      price: '10.00',
      archived: false,
    });
  });

  it('names the season when the style has one', () => {
    expect(
      toSkuSummary({ ...row, season_id: ID, season_code: 'SS26', season_name: { en: 'SS 26' } })
        .season,
    ).toEqual({ id: ID, code: 'SS26', name: { en: 'SS 26', ar: undefined } });
  });
});
