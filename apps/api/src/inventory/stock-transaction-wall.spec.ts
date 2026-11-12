import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spec 0011 AC-5, security review L1: the mark that makes a transaction a stock unit can only be
// given inside `inventory/ledger/`. Any other file may import the `StockTransaction` type, never a
// value, so no module can mint the brand on its own transaction.

const SRC = fileURLToPath(new URL('..', import.meta.url));
const LEDGER_DIR = ['inventory', 'ledger'].join(sep) + sep;

const WALL = String.raw`[^'"]*stock-transaction(?:\.js)?`;
/** `import ... from` and `export ... from` clauses naming the file. */
const CLAUSE_FROM_WALL = new RegExp(
  String.raw`\b(import|export)\s+([^;]*?)\s+from\s+['"]${WALL}['"]`,
  'g',
);
const LITERAL_LOAD = new RegExp(String.raw`(?:require|import)\(\s*['"]${WALL}['"]\s*\)`);
/** A dynamic load whose argument is not a plain string literal, and any `createRequire`. */
const NON_LITERAL_LOAD = /\b(?:require|import)\(\s*(?!['"][^'"]*['"]\s*\))/;
const CREATE_REQUIRE = /\bcreateRequire\b/;

/** The reasons a source text breaks the wall: a value import or re-export, or a load it cannot read. */
function breaches(text: string, allowNonLiteralLoad = false): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(CLAUSE_FROM_WALL)) {
    const clause = match[2] ?? '';
    // `import type {...}` and `export type {...}` carry no value; `* as ns` and `*` do.
    if (!/^type\s/.test(clause)) found.push(match[0]);
  }
  if (LITERAL_LOAD.test(text)) found.push('a dynamic load of stock-transaction');
  if (!allowNonLiteralLoad && NON_LITERAL_LOAD.test(text))
    found.push('a dynamic load with a non literal argument');
  if (CREATE_REQUIRE.test(text)) found.push('createRequire');
  return found;
}

/**
 * The one file that loads code by a computed name: it imports the `extensions/<client>` packages
 * the environment lists, and never names this file.
 */
const EXTENSION_LOADER = ['extensions', 'load-extensions.ts'].join(sep);

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
      // Specs are never shipped; the ones that scan source text name these patterns on purpose.
      .filter((path) => !path.endsWith('.spec.ts'))
      .filter(
        (path) =>
          breaches(readFileSync(path, 'utf8'), relative(SRC, path) === EXTENSION_LOADER).length > 0,
      )
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
    expect(
      breaches(`export type { StockTransaction } from '../inventory/ledger/stock-transaction.js';`),
    ).toEqual([]);
  });

  it('catches value re-exports, namespace forms, non literal loads, and createRequire', () => {
    const path = `'../inventory/ledger/stock-transaction.js'`;
    expect(breaches(`export { markStockUnit } from ${path};`)).toHaveLength(1);
    expect(breaches(`export * from ${path};`)).toHaveLength(1);
    expect(breaches(`export * as unit from ${path};`)).toHaveLength(1);
    expect(breaches(`import * as unit from ${path};`)).toHaveLength(1);
    expect(breaches(`import { type StockTransaction, markStockUnit } from ${path};`)).toHaveLength(
      1,
    );
    expect(breaches(`const m = await import(name);`)).toHaveLength(1);
    expect(breaches(`const m = require(\`./stock-\${x}\`);`)).toHaveLength(1);
    expect(breaches(`const r = createRequire(import.meta.url);`)).toHaveLength(1);
    expect(breaches(`const m = await import('./other.js');`)).toEqual([]);
  });
});
