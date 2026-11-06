import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaTables, TABLE_OWNERSHIP } from '@ssdashboard/db';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Spec 0002, A5 (AC-34): a module reads and writes only its own tables. A file under
// apps/api/src/<module>/ that names another module's table, by its Drizzle export or its SQL name,
// fails this test, and so does an extension (extensions/<client>) that names any core table.
// Foreign keys between modules' tables are constraints, not reads, and live in packages/db.
// Cross module data goes through an exported service or a past tense domain event.

const API_SRC = fileURLToPath(new URL('.', import.meta.url));
const EXTENSIONS = fileURLToPath(new URL('../../../extensions', import.meta.url));

// `auth` and `staff` are the identity module until feature 7 moves them into src/identity/.
const FOLDER_MODULE: Record<string, string> = { auth: 'identity', staff: 'identity' };

/** One table named where its module may not name it. */
interface Breach {
  /** The file, relative to the repo root, with forward slashes. */
  file: string;
  line: number;
  table: string;
  owner: string;
}

/** A source file to check: its path relative to the repo root and its text. */
interface SourceFile {
  path: string;
  text: string;
}

const ownerOf = new Map<string, string>(Object.entries(TABLE_OWNERSHIP));
const sqlNameOfExport = new Map(schemaTables().map((t) => [t.exportName, t.sqlName]));

// A snake case name (`stock_movements`) is unmistakable anywhere in a string. A one word name
// (`orders`, `settings`) counts only where SQL names a table (after FROM, JOIN, INTO, UPDATE,
// TABLE, TRUNCATE, USING, or a comma), so prose in a message does not.
const SQL_TABLE_CONTEXT = String.raw`(?:\b(?:from|join|into|update|table|truncate|using)\s+|,\s*)(?:only\s+)?(?:"?public"?\.)?"?`;
const sqlPatterns = [...ownerOf.keys()].map((table) => ({
  table,
  pattern: table.includes('_')
    ? new RegExp(String.raw`\b${table}\b`)
    : new RegExp(`${SQL_TABLE_CONTEXT}${table}\\b`, 'i'),
}));

/**
 * The module a file belongs to: `apps/api/src/<module>/...`; `app` for the entry points directly
 * under `apps/api/src` (they own no tables); `extension` for any `extensions/...` file.
 */
function moduleOf(path: string): string | undefined {
  const api = /^apps\/api\/src\/([^/]+)\/.+/.exec(path);
  if (api?.[1]) return FOLDER_MODULE[api[1]] ?? api[1];
  if (/^apps\/api\/src\/[^/]+$/.test(path)) return 'app';
  return path.startsWith('extensions/') ? 'extension' : undefined;
}

const isDbModule = (node: ts.Expression): boolean =>
  ts.isStringLiteral(node) && node.text.startsWith('@ssdashboard/db');

/** Every table a file names, with the line it is named on. */
function tablesNamed(file: SourceFile): { table: string; line: number }[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const found: { table: string; line: number }[] = [];
  const add = (table: string | undefined, node: ts.Node) => {
    if (!table) return;
    found.push({ table, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };

  // The local names bound to the package (`import * as db`) and to its `schema` namespace
  // (`import { schema }`, `import { schema as s }`).
  const packageNames = new Set<string>();
  const schemaNames = new Set<string>(['schema']);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !isDbModule(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) packageNames.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'schema') {
          schemaNames.add(element.name.text);
        }
      }
    }
  }
  // Whether an expression holds tables as members: a schema or package binding, `db.schema`,
  // or a relational query root (`db.query`).
  const holdsTables = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return schemaNames.has(node.text) || packageNames.has(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === 'schema' || node.name.text === 'query';
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    // import { orders } from '@ssdashboard/db', export { orders } from '@ssdashboard/db'
    if (ts.isImportDeclaration(node) && isDbModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          add(sqlNameOfExport.get((element.propertyName ?? element.name).text), element);
        }
      }
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isDbModule(node.moduleSpecifier) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        add(sqlNameOfExport.get((element.propertyName ?? element.name).text), element);
      }
      return;
    }
    // schema.orders, s.orders, db.schema.orders, db.query.orders
    if (ts.isPropertyAccessExpression(node) && holdsTables(node.expression)) {
      add(sqlNameOfExport.get(node.name.text), node.name);
    }
    // schema['orders']
    if (
      ts.isElementAccessExpression(node) &&
      holdsTables(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      add(sqlNameOfExport.get(node.argumentExpression.text), node.argumentExpression);
    }
    // const { orders } = schema
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      holdsTables(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const name = element.propertyName ?? element.name;
        if (ts.isIdentifier(name)) add(sqlNameOfExport.get(name.text), element);
      }
    }
    // sql.identifier('orders')
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'identifier'
    ) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first) && ownerOf.has(first.text)) add(first.text, first);
    }
    // 'SELECT ... FROM orders' and sql`... FROM orders`
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const { table, pattern } of sqlPatterns) {
        if (pattern.test(node.text)) add(table, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every table a file names that its module does not own (an extension owns none). */
function breachesIn(files: readonly SourceFile[]): Breach[] {
  return files.flatMap((file) => {
    const module = moduleOf(file.path);
    if (!module) return [];
    return tablesNamed(file)
      .map(({ table, line }) => ({ file: file.path, line, table, owner: ownerOf.get(table) ?? '' }))
      .filter((breach) => breach.owner !== module);
  });
}

function sourceFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const toRepoPath = (path: string) => relative(REPO_ROOT, path).split(sep).join('/');

/**
 * Walls today's code breaks, each a module reading another module's table directly. They are
 * listed here instead of being fixed quietly; each entry names the follow up that removes it and
 * pins the exact number of places the file names the table, so a further read in a listed file
 * fails the test, and so does an entry that no longer occurs: the list only shrinks.
 */
const KNOWN_BREACHES: readonly { file: string; table: string; count: number; why: string }[] = [
  {
    file: 'apps/api/src/inventory/ledger/ledger.service.ts',
    table: 'product_variants',
    count: 2,
    why: 'loadMaster and lockForArchive lock SKU rows FOR SHARE / FOR UPDATE inside the posting transaction (spec 0006 allowed it); needs a catalog locking service',
  },
  {
    file: 'apps/api/src/inventory/ledger/reconciliation.service.ts',
    table: 'product_variants',
    count: 2,
    why: 'the serial check JOINs product_variants to find serial tracked SKUs, and the rebuild locks the SKU row FOR SHARE like loadMaster; needs catalog services for both',
  },
  {
    file: 'apps/api/src/inventory/locations/location-policy.service.ts',
    table: 'parties',
    count: 1,
    why: 'the party role check reads parties directly; needs a partners module service',
  },
  {
    file: 'apps/api/src/mail/mail.worker.ts',
    table: 'users',
    count: 1,
    why: 'the mail job reads the recipient; needs an identity service',
  },
  {
    file: 'apps/api/src/mail/mail.worker.ts',
    table: 'verifications',
    count: 1,
    why: 'the mail job reads the token row; needs an identity service',
  },
  {
    file: 'apps/api/src/database/pg-error.spec.ts',
    table: 'users',
    count: 1,
    why: 'a made up query text in an error redaction fixture; nothing is read',
  },
  {
    file: 'apps/api/src/platform/query-error.filter.spec.ts',
    table: 'users',
    count: 1,
    why: 'a made up query text in an error redaction fixture; nothing is read',
  },
];

const keyOf = (file: string, table: string) => `${file} ${table}`;

describe('module boundary (spec 0002, A5)', () => {
  // This file is skipped: its planted cases and its list name tables on purpose.
  const files = [...sourceFiles(API_SRC), ...sourceFiles(EXTENSIONS)]
    .map((path) => ({ path: toRepoPath(path), text: readFileSync(path, 'utf8') }))
    .filter((file) => file.path !== 'apps/api/src/module-boundary.spec.ts');
  const knownKeys = new Set(KNOWN_BREACHES.map((entry) => keyOf(entry.file, entry.table)));

  it('finds the api source, its entry points, and the extensions folder', () => {
    const paths = files.map((file) => file.path);

    expect(paths).toContain('apps/api/src/inventory/inventory.module.ts');
    expect(paths).toContain('apps/api/src/migrate.ts');
  });

  it('keeps every module to its own tables, and extensions to none', () => {
    const breaches = breachesIn(files).filter((b) => !knownKeys.has(keyOf(b.file, b.table)));

    expect(breaches.map((b) => `${b.file}:${b.line} names ${b.table} (${b.owner})`)).toEqual([]);
  });

  it('finds each known breach exactly as often as it is listed', () => {
    const counts = new Map<string, number>();
    for (const b of breachesIn(files)) {
      const key = keyOf(b.file, b.table);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const mismatched = KNOWN_BREACHES.filter(
      (entry) => counts.get(keyOf(entry.file, entry.table)) !== entry.count,
    ).map(
      (entry) =>
        `${keyOf(entry.file, entry.table)}: listed ${entry.count}, found ${counts.get(keyOf(entry.file, entry.table)) ?? 0}`,
    );

    expect(mismatched).toEqual([]);
  });

  it('reports a planted import of another module’s Drizzle table', () => {
    const planted = {
      path: 'apps/api/src/customers/x.ts',
      text: "import { orders } from '@ssdashboard/db';\nexport const read = orders;\n",
    };

    expect(breachesIn([planted])).toEqual([
      { file: 'apps/api/src/customers/x.ts', line: 1, table: 'orders', owner: 'orders' },
    ]);
  });

  it('reports schema access, SQL names, and extensions, and allows a module its own tables', () => {
    const planted: SourceFile[] = [
      { path: 'apps/api/src/catalog/a.ts', text: 'db.insert(schema.stockMovements);' },
      { path: 'apps/api/src/staff/b.ts', text: "q('UPDATE stock_levels SET on_hand = 0');" },
      { path: 'apps/api/src/credit/c.ts', text: 'sql`SELECT id FROM orders WHERE id = ${id}`;' },
      { path: 'extensions/acme/d.ts', text: "q('SELECT * FROM public.settings');" },
      {
        path: 'apps/api/src/auth/e.ts',
        text: "import { users, sessions } from '@ssdashboard/db';",
      },
      { path: 'apps/api/src/orders/f.ts', text: "throw new Error('two orders share a number');" },
      { path: 'apps/api/src/orders/g.ts', text: 'this.customers.canonicalOf(id);' },
    ];

    expect(breachesIn(planted).map((b) => `${b.file} ${b.table}`)).toEqual([
      'apps/api/src/catalog/a.ts stock_movements',
      'apps/api/src/staff/b.ts stock_levels',
      'apps/api/src/credit/c.ts orders',
      'extensions/acme/d.ts settings',
    ]);
  });

  // Security review n6 and verify defects D1, D2: one planted file per form the wall must see.
  it.each([
    [
      'a namespace import',
      "import * as db from '@ssdashboard/db';\ndb.schema.creditEntries;",
      'credit_entries',
    ],
    [
      'a member of a namespace import',
      "import * as data from '@ssdashboard/db';\ndata.orders;",
      'orders',
    ],
    [
      'an aliased schema import',
      "import { schema as s } from '@ssdashboard/db';\ns.orders;",
      'orders',
    ],
    [
      'an element access on the schema',
      "import { schema } from '@ssdashboard/db';\nschema['orders'];",
      'orders',
    ],
    [
      'a destructured schema',
      "import { schema } from '@ssdashboard/db';\nconst { orders } = schema;",
      'orders',
    ],
    [
      'a destructured alias',
      "import { schema as s } from '@ssdashboard/db';\nconst { orders: o } = s;",
      'orders',
    ],
    ['a re export', "export { orders } from '@ssdashboard/db';", 'orders'],
    ['an aliased re export', "export { orders as allOrders } from '@ssdashboard/db';", 'orders'],
    ['sql.identifier', "sql`SELECT * FROM ${sql.identifier('orders')}`;", 'orders'],
    [
      'a comma joined SQL list',
      "q('SELECT c.id FROM customers c, orders o WHERE false');",
      'orders',
    ],
    [
      'DELETE ... USING',
      "q('DELETE FROM customer_phones p USING orders o WHERE false');",
      'orders',
    ],
  ])('reports %s', (_form, text, table) => {
    const breaches = breachesIn([{ path: 'apps/api/src/customers/planted.ts', text }]);

    expect(breaches.map((b) => b.table)).toEqual([table]);
  });

  it('treats a file directly under apps/api/src as the app, which owns no tables', () => {
    const breaches = breachesIn([
      { path: 'apps/api/src/main.ts', text: "q('SELECT id FROM users');" },
    ]);

    expect(breaches).toEqual([
      { file: 'apps/api/src/main.ts', line: 1, table: 'users', owner: 'identity' },
    ]);
  });
});
