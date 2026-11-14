import type { DatabaseConnection } from '@ssdashboard/db';
import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../database/sql.js';
import { CatalogLocks } from './catalog-locks.service.js';

const A = '0190c0de-0000-7000-8000-00000000000a';
const B = '0190c0de-0000-7000-8000-00000000000b';

/** A transaction stub that records each statement's SQL text and bound values. */
function recordingTx() {
  const execute = vi.fn((_query: unknown) => Promise.resolve({ rows: [] }));
  return { tx: { execute } as unknown as Transaction, execute };
}

/** The text chunks and the bound values of one recorded Drizzle `sql` statement. */
function partsOf(query: unknown): { text: string; values: unknown[] } {
  const chunks = (query as { queryChunks: unknown[] }).queryChunks;
  const text: string[] = [];
  const values: unknown[] = [];
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object' && 'value' in chunk) {
      text.push(([] as unknown[]).concat(chunk.value).join(''));
    } else {
      values.push(chunk);
    }
  }
  return { text: text.join(''), values };
}

// Lead rule (catalog lane, CatalogChannelSync): variant rows are locked in ascending id order,
// duplicates dropped, and no style or product row is locked by these statements.
describe('CatalogLocks lock order', () => {
  const connection = { db: { execute: vi.fn() } } as unknown as DatabaseConnection;

  for (const method of ['lockForShare', 'lockForUpdate'] as const) {
    it(`${method} locks variant rows only, ordered by id, with each id once`, async () => {
      const { tx, execute } = recordingTx();
      await new CatalogLocks(connection)[method](tx, [B, A, B]);

      expect(execute).toHaveBeenCalledTimes(1);
      const { text, values } = partsOf(execute.mock.calls[0]?.[0]);
      expect(text).toMatch(/FROM product_variants/);
      expect(text).toMatch(/ORDER BY id\s+FOR (SHARE|UPDATE)/);
      expect(text).toContain(method === 'lockForShare' ? 'FOR SHARE' : 'FOR UPDATE');
      expect(text).not.toMatch(/\b(styles|products)\b/);
      expect(values).toEqual([`{"${B}","${A}"}`]);
    });
  }
});
