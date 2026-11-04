import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spec 0002 security model: only the inventory module's ledger service writes the ledger
// tables. Every other module and extension goes through its exported services.
const LEDGER_TABLES =
  /\b(stock_movements|movement_groups|movement_serials|stock_levels|reservations|serials|stockMovements|movementGroups|movementSerials|stockLevels)\b/;

// Spec 0006: inside inventory only the ledger reads catalog tables (its `loadMaster` and
// `lockForArchive`); every other inventory file gets SKU data through `CatalogService`.
const CATALOG_TABLES =
  /\b(products|product_variants|productVariants|product_options|barcodes|uoms)\b/;

const API_SRC = fileURLToPath(new URL('..', import.meta.url));
const EXTENSIONS = fileURLToPath(new URL('../../../../extensions', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe('inventory module boundary', () => {
  it('keeps every reference to the ledger tables inside src/inventory', () => {
    const outside = [...sourceFiles(API_SRC), ...sourceFiles(EXTENSIONS)].filter(
      (path) => !relative(API_SRC, path).startsWith(`inventory${sep}`),
    );

    const offenders = outside.filter((path) => LEDGER_TABLES.test(readFileSync(path, 'utf8')));

    expect(offenders).toEqual([]);
  });

  it('would catch a module that reaches into the ledger tables', () => {
    expect(LEDGER_TABLES.test('db.insert(schema.stockMovements)')).toBe(true);
    expect(LEDGER_TABLES.test('UPDATE stock_levels SET on_hand = 0')).toBe(true);
    expect(LEDGER_TABLES.test('this.ledger.post(input)')).toBe(false);
  });

  it('keeps catalog table reads inside the ledger within inventory', () => {
    const inventory = sourceFiles(join(API_SRC, 'inventory')).filter((path) => {
      const inside = relative(API_SRC, path);
      return !inside.startsWith(`inventory${sep}ledger${sep}`) && !inside.endsWith('.spec.ts');
    });

    const offenders = inventory.filter((path) => CATALOG_TABLES.test(readFileSync(path, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
