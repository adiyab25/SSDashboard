import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spec 0011 AC-5, security review L1: the mark that makes a transaction a stock unit can only be
// given inside `inventory/ledger/`. Any other file may import the `StockTransaction` type, never a
// value, so no module can mint the brand on its own transaction.

const SRC = fileURLToPath(new URL('..', import.meta.url));
const LEDGER_DIR = ['inventory', 'ledger'].join(sep) + sep;

const IMPORT_FROM_WALL = /import\s+([^;]*?)\s+from\s+['"][^'"]*stock-transaction(?:\.js)?['"]/g;
const REQUIRES_WALL = /(?:require|import)\(\s*['"][^'"]*stock-transaction(?:\.js)?['"]\s*\)/;

/** The reasons a source text breaks the wall: a value import of the stock transaction file. */
function breaches(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IMPORT_FROM_WALL)) {
    const clause = match[1] ?? '';
    if (!/^type\s/.test(clause)) found.push(match[0]);
  }
  if (REQUIRES_WALL.test(text)) found.push('a dynamic load of stock-transaction');
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('the stock unit mark stays inside inventory/ledger', () => {
  it('lets no file outside inventory/ledger import a value from stock-transaction', () => {
    const offenders = sources(SRC)
      .filter((path) => !(relative(SRC, path) + '').startsWith(LEDGER_DIR))
      .filter((path) => !path.endsWith('stock-transaction-wall.spec.ts'))
      .filter((path) => breaches(readFileSync(path, 'utf8')).length > 0)
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it('catches a planted value import and a dynamic load, and allows a type import', () => {
    expect(
      breaches(`import { markStockUnit } from '../inventory/ledger/stock-transaction.js';`),
    ).toHaveLength(1);
    expect(breaches(`const m = await import('./ledger/stock-transaction.js');`)).toHaveLength(1);
    expect(
      breaches(`import type { StockTransaction } from '../inventory/ledger/stock-transaction.js';`),
    ).toEqual([]);
  });
});
