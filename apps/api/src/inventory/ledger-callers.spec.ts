import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The modules whose code may only compare channel stock with the ledger, never post it (spec 0011 AC-8). */
const CHANNEL_SIDE_MODULES = ['connectors', 'channels'] as const;

/** The services that write or rebuild stock; a channel side file never names either. */
const LEDGER_WRITERS = ['LedgerService', 'ReconciliationService'] as const;

/** Source files of every kind a module can load: TypeScript and JavaScript, modules and scripts. */
const SOURCE_FILE = /\.(?:[mc]?[jt]s|tsx)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(name) ? [path] : [];
  });
}

/**
 * Every static module reference of a source text: `import ... from 'x'`, `import 'x'`,
 * `export ... from 'x'` (any number of lines, namespace forms included), with its clause.
 */
const STATIC_REFERENCE =
  /\b(?:import|export)\s+(?:type\s+)?([^;'"`]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

/** A dynamic `import(...)` or `require(...)`, with whatever expression is its argument. */
const DYNAMIC_REFERENCE = /\b(?:import|require)\s*\(([^)]*)\)/g;

const LEDGER_FOLDER = /^inventory\/ledger(?:\/|$)/;
const INVENTORY_BARREL = /^inventory\/inventory\.module(?:\.[mc]?[jt]sx?)?$/;

/**
 * The path of a specifier relative to `src/`, with `..` and `.` resolved against the importing
 * file (`fromFile`, relative to `src/`), so `../x/../inventory/ledger/y.js` is read for what it is.
 * A specifier that is not relative is returned as written (a package name, which never points at
 * the ledger).
 */
function resolvedSpecifier(specifier: string, fromFile: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
}

/**
 * The references of one source text that break the channel rule (spec 0011 AC-8), as the
 * specifiers written. A reference breaks it when it:
 * - resolves to a file under `inventory/ledger/` (static, re-export, or dynamic);
 * - reaches `inventory/inventory.module` as a namespace (`import * as`, `export * from`), which
 *   can hand out `LedgerService`, or by a clause naming `LedgerService` or `ReconciliationService`;
 * - is a dynamic `import()` or `require()` whose argument mentions `inventory/ledger` or
 *   `inventory.module` in any form (a template literal, a concatenation, a variable path is
 *   caught by the text it holds).
 * Importing `InventoryModule` or the read services by name stays allowed. Pure: it reads text only.
 * A re-export chain through a third module (a file elsewhere that re-exports the ledger, imported
 * from a channel file) is not followed; the module wall and review cover it.
 */
function forbiddenLedgerImports(source: string, fromFile: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(STATIC_REFERENCE)) {
    const clause = match[1] ?? '';
    const written = match[2] ?? match[3] ?? '';
    const target = resolvedSpecifier(written, fromFile);
    const namesWriter = LEDGER_WRITERS.some((name) => new RegExp(`\\b${name}\\b`).test(clause));
    const namespace =
      /(^|[\s,{])\*\s*(?:as\s+\w+)?\s*$/.test(clause) || /\*\s+as\s+\w+/.test(clause);
    if (LEDGER_FOLDER.test(target)) found.push(written);
    else if (INVENTORY_BARREL.test(target) && (namesWriter || namespace)) found.push(written);
  }
  for (const match of source.matchAll(DYNAMIC_REFERENCE)) {
    const argument = match[1] ?? '';
    if (/inventory\/ledger|inventory\.module/.test(argument.replace(/\.\.\//g, ''))) {
      found.push(argument.trim());
    } else if (/inventory/.test(argument) && /ledger|\.module/.test(argument)) {
      found.push(argument.trim());
    }
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

  const offendersIn = (list: { name: string; text: string }[]) =>
    list
      .map((file) => ({ file: file.name, imports: forbiddenLedgerImports(file.text, file.name) }))
      .filter((entry) => entry.imports.length > 0);

  it('finds the channel side source', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.name.startsWith('connectors/'))).toBe(true);
    expect(files.some((file) => file.name.startsWith('channels/'))).toBe(true);
  });

  it('has no import of LedgerService, ReconciliationService, or inventory/ledger/', () => {
    expect(offendersIn(files)).toEqual([]);
  });

  describe('would catch a planted reference (in memory, not a real file)', () => {
    const from = 'connectors/shopify/planted.ts';
    it.each([
      [
        'a direct import',
        "import { LedgerService } from '../../inventory/ledger/ledger.service.js';",
      ],
      [
        'a type import',
        "import type { PostingResult } from '../../inventory/ledger/ledger.service.js';",
      ],
      [
        'a barrel clause naming a writer',
        "import { ReconciliationService } from '../../inventory/inventory.module.js';",
      ],
      [
        'an aliased writer',
        "import { Module, LedgerService as Ledger } from '../../inventory/inventory.module.js';",
      ],
      [
        'a namespace import of the barrel',
        "import * as inventory from '../../inventory/inventory.module.js';",
      ],
      [
        'a namespace re-export of the barrel',
        "export * from '../../inventory/inventory.module.js';",
      ],
      [
        'a named re-export of the barrel',
        "export { LedgerService } from '../../inventory/inventory.module.js';",
      ],
      [
        'a re-export of a ledger file',
        "export { costOutbound } from '../../inventory/ledger/costing.js';",
      ],
      ['a side effect import', "import '../../inventory/ledger/ledger.service.js';"],
      [
        'a path that walks out and back in',
        "import { LedgerService } from '../../x/../inventory/ledger/ledger.service.js';",
      ],
      [
        'a multi line clause',
        "import {\n  OnlineStockService,\n  LedgerService,\n} from '../../inventory/inventory.module.js';",
      ],
      [
        'a dynamic import',
        "const ledger = await import('../../inventory/ledger/ledger.service.js');",
      ],
      [
        'a dynamic import of a template literal',
        'const ledger = await import(`../../inventory/${"ledger"}/ledger.service.js`);',
      ],
      [
        'a dynamic import of a concatenation',
        "const ledger = await import('../../inventory/' + 'ledger/ledger.service.js');",
      ],
      [
        'a dynamic import of the barrel',
        "const barrel = await import('../../inventory/inventory.module.js');",
      ],
      [
        'a require of a ledger file',
        "const ledger = require('../../inventory/ledger/ledger.service.js');",
      ],
    ])('flags %s', (_name, planted) => {
      expect(forbiddenLedgerImports(planted, from)).not.toEqual([]);
    });

    it('resolves the specifier against the importing file, not the text', () => {
      // The same text is harmless from a file that sits elsewhere.
      const text = "import { x } from './ledger/costing.js';";
      expect(forbiddenLedgerImports(text, 'inventory/planted.ts')).not.toEqual([]);
      expect(forbiddenLedgerImports(text, 'connectors/planted.ts')).toEqual([]);
    });

    it('lets the read services and the module itself through', () => {
      expect(
        forbiddenLedgerImports(
          "import { OnlineStockService, OnlineStockGate } from '../../inventory/inventory.module.js';",
          from,
        ),
      ).toEqual([]);
      expect(
        forbiddenLedgerImports(
          "import { InventoryModule } from '../inventory/inventory.module.js';",
          'connectors/x.ts',
        ),
      ).toEqual([]);
      expect(
        forbiddenLedgerImports(
          "import { LocationPolicyService } from '../../inventory/x.js';",
          from,
        ),
      ).toEqual([]);
    });

    it('scans every source extension', () => {
      for (const name of ['a.ts', 'a.mts', 'a.cts', 'a.js', 'a.mjs', 'a.tsx']) {
        expect(SOURCE_FILE.test(name)).toBe(true);
      }
      expect(SOURCE_FILE.test('README.md')).toBe(false);
    });

    it('fails the file check when a planted file is added to the real ones', () => {
      const planted = {
        name: 'connectors/planted.ts',
        text: "import { LedgerService } from '../inventory/ledger/ledger.service.js';",
      };

      expect(offendersIn([...files, planted]).map((entry) => entry.file)).toEqual([
        'connectors/planted.ts',
      ]);
    });
  });
});
