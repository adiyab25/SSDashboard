import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The modules whose code may only compare channel stock with the ledger, never post it (spec 0011 AC-8). */
const CHANNEL_SIDE_MODULES = ['connectors', 'channels'] as const;

/** The services that write or rebuild stock; a channel side file never names either. */
const LEDGER_WRITERS = ['LedgerService', 'ReconciliationService'] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') || name.endsWith('.tsx') ? [path] : [];
  });
}

/** `import ... from 'x'`, `export ... from 'x'` (any number of lines), and `import('x')`. */
const MODULE_REFERENCE =
  /\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * The imports of one source text that break the channel rule: a specifier under
 * `inventory/ledger/`, or a clause naming `LedgerService` or `ReconciliationService` (which would
 * reach them through a barrel such as `inventory.module.js`). Pure: it only reads the text.
 */
function forbiddenLedgerImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(MODULE_REFERENCE)) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? match[3] ?? match[4] ?? '';
    const underLedger = /(^|\/)inventory\/ledger\//.test(specifier);
    const namesWriter = LEDGER_WRITERS.some((name) => new RegExp(`\\b${name}\\b`).test(clause));
    if (underLedger || namesWriter) found.push(specifier);
  }
  return found;
}

// Spec 0011 AC-8 (domain review m2): no file under connectors/ or channels/ imports the ledger, so
// inbound channel stock figures can only ever be compared with the ledger, never posted.
describe('channels never write stock (spec 0011 AC-8)', () => {
  const files = CHANNEL_SIDE_MODULES.flatMap((module) =>
    sourceFiles(join(SRC_DIR, module)).map((path) => ({
      name: relative(SRC_DIR, path).split(sep).join('/'),
      text: readFileSync(path, 'utf8'),
    })),
  );

  it('finds the channel side source', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.name.startsWith('connectors/'))).toBe(true);
    expect(files.some((file) => file.name.startsWith('channels/'))).toBe(true);
  });

  it('has no import of LedgerService, ReconciliationService, or inventory/ledger/', () => {
    const offenders = files
      .map((file) => ({ file: file.name, imports: forbiddenLedgerImports(file.text) }))
      .filter((entry) => entry.imports.length > 0);

    expect(offenders).toEqual([]);
  });

  describe('would catch a planted import (in memory, not a real file)', () => {
    it.each([
      ["import { LedgerService } from '../inventory/ledger/ledger.service.js';"],
      ["import type { PostingResult } from '../inventory/ledger/ledger.service.js';"],
      ["import { ReconciliationService } from '../inventory/inventory.module.js';"],
      ["import { Module, LedgerService as Ledger } from '../inventory/inventory.module.js';"],
      ["export { costOutbound } from '../inventory/ledger/costing.js';"],
      ["const ledger = await import('../../inventory/ledger/ledger.service.js');"],
      [
        "import {\n  OnlineStockService,\n  LedgerService,\n} from '../inventory/inventory.module.js';",
      ],
    ])('flags %s', (planted) => {
      expect(forbiddenLedgerImports(planted)).not.toEqual([]);
    });

    it('lets the read services through', () => {
      expect(
        forbiddenLedgerImports(
          "import { OnlineStockService, OnlineStockGate } from '../inventory/inventory.module.js';",
        ),
      ).toEqual([]);
      expect(
        forbiddenLedgerImports("import { LocationPolicyService } from '../inventory/x.js';"),
      ).toEqual([]);
    });

    it('fails the file check when a planted file is added to the real ones', () => {
      const planted = {
        name: 'connectors/planted.ts',
        text: "import { LedgerService } from '../inventory/ledger/ledger.service.js';",
      };
      const offenders = [...files, planted]
        .map((file) => ({ file: file.name, imports: forbiddenLedgerImports(file.text) }))
        .filter((entry) => entry.imports.length > 0);

      expect(offenders.map((entry) => entry.file)).toEqual(['connectors/planted.ts']);
    });
  });
});
