import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
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

// A folder under apps/api/src whose name is not its module's name. Empty since feature 7 moved
// `auth` and `staff` into src/identity/ (spec 0005, AC-27); add an entry only for such a folder.
const FOLDER_MODULE: Record<string, string> = {};

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

// Spec 0005, AC-27: the import path wall around identity. A file under apps/api/src whose module
// is not identity, and that is not an app entry point, may import from apps/api/src/identity/
// only the files on IDENTITY_PUBLIC_FILES; anything else (the Better Auth instance, the lockout,
// the audit service, the guards) stays inside. apps/api/test is outside the wall.

/**
 * The files under `apps/api/src/identity/` another module may import, each with why it is
 * public. This list, not `IdentityModule`'s Nest `exports` (it has none), is identity's public
 * surface. Add an entry only for a file that holds no Better Auth, lockout or audit dependency
 * and never writes an auth table; a new entry is a decision for identity's README.
 */
const IDENTITY_PUBLIC_FILES: Readonly<Record<string, string>> = {
  'apps/api/src/identity/identity.module.ts':
    'the module itself, imported by the app root to load sign in, staff and the global guards',
  'apps/api/src/identity/sign-in/current-staff.ts':
    'the AuthenticatedRequest type: handlers read the signed in person, ledger routes postedBy',
  'apps/api/src/identity/sign-in/public.decorator.ts':
    '@Public(): open routes (health, config) mark themselves for the global session guard',
  'apps/api/src/identity/staff/staff-directory.ts':
    'StaffDirectoryModule: read only display names for "posted by", no auth dependency',
  'apps/api/src/identity/hats/hat-directory.ts':
    'HatDirectoryModule: read only active holders of an internal hat, no auth dependency',
  'apps/api/src/identity/sign-in/mail-recipients.ts':
    'MailRecipientsModule: the read only recipient and token row the mail worker sends with',
};

/**
 * The app entry points directly under apps/api/src: they wire identity's internals (mounting
 * Better Auth, the create-admin command, the cleanup job) and sit outside the wall.
 */
const APP_ENTRY_POINTS: ReadonlySet<string> = new Set(
  [
    'app.module.ts',
    'app.setup.ts',
    'create-admin.ts',
    'worker.module.ts',
    'main.ts',
    'worker.ts',
    'migrate.ts',
  ].map((name) => `apps/api/src/${name}`),
);

/** One import of an identity file that is not on the public list. */
interface ImportBreach {
  file: string;
  line: number;
  target: string;
}

/** Every relative module specifier a file imports, re exports, or loads with `import()`. */
function relativeImports(file: SourceFile): { specifier: string; line: number }[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const found: { specifier: string; line: number }[] = [];
  const add = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteralLike(node) || !node.text.startsWith('.')) return;
    found.push({
      specifier: node.text,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The repo path a relative specifier resolves to, as its `.ts` source file. */
const resolveSource = (from: string, specifier: string): string =>
  `${posix.join(posix.dirname(from), specifier).replace(/\.(?:js|mjs|cjs|ts)$/, '')}.ts`;

/** Every import across the identity wall that does not land on a public file. */
function identityImportBreaches(files: readonly SourceFile[]): ImportBreach[] {
  return files.flatMap((file) => {
    if (!file.path.startsWith('apps/api/src/')) return [];
    if (moduleOf(file.path) === 'identity' || APP_ENTRY_POINTS.has(file.path)) return [];
    return relativeImports(file)
      .map(({ specifier, line }) => ({
        file: file.path,
        line,
        target: resolveSource(file.path, specifier),
      }))
      .filter(
        ({ target }) =>
          target.startsWith('apps/api/src/identity/') &&
          !Object.hasOwn(IDENTITY_PUBLIC_FILES, target),
      );
  });
}

describe('module boundary (spec 0002, A5)', () => {
  // This file is skipped: its planted cases and its list name tables on purpose.
  const files = [...sourceFiles(API_SRC), ...sourceFiles(EXTENSIONS)]
    .map((path) => ({ path: toRepoPath(path), text: readFileSync(path, 'utf8') }))
    .filter((file) => file.path !== 'apps/api/src/module-boundary.spec.ts');
  const knownKeys = new Set(KNOWN_BREACHES.map((entry) => keyOf(entry.file, entry.table)));

  it('finds the api source, its entry points, and the extensions folder', () => {
    const paths = files.map((file) => file.path);

    expect(paths).toContain('apps/api/src/inventory/inventory.module.ts');
    expect(paths).toContain('apps/api/src/identity/sign-in/mail-recipients.ts');
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

  // Spec 0010, AC-9 (milestone 2 task 11): only the audit module names audit_entries; every other
  // module records through AuditService. A planted import or SQL read elsewhere fails the wall.
  it('reports a planted import or read of the audit table outside the audit module', () => {
    const planted: SourceFile[] = [
      {
        path: 'apps/api/src/inventory/audit-shortcut.ts',
        text: "import { auditEntries } from '@ssdashboard/db';\nexport const read = auditEntries;\n",
      },
      {
        path: 'apps/api/src/catalog/history.ts',
        text: "q('SELECT action FROM audit_entries WHERE record_id = $1');",
      },
      { path: 'apps/api/src/audit/own.ts', text: "q('SELECT id FROM audit_entries');" },
    ];

    expect(breachesIn(planted)).toEqual([
      {
        file: 'apps/api/src/inventory/audit-shortcut.ts',
        line: 1,
        table: 'audit_entries',
        owner: 'audit',
      },
      { file: 'apps/api/src/catalog/history.ts', line: 1, table: 'audit_entries', owner: 'audit' },
    ]);
  });

  it('reports schema access, SQL names, and extensions, and allows a module its own tables', () => {
    const planted: SourceFile[] = [
      { path: 'apps/api/src/catalog/a.ts', text: 'db.insert(schema.stockMovements);' },
      {
        path: 'apps/api/src/identity/staff/b.ts',
        text: "q('UPDATE stock_levels SET on_hand = 0');",
      },
      { path: 'apps/api/src/credit/c.ts', text: 'sql`SELECT id FROM orders WHERE id = ${id}`;' },
      { path: 'extensions/acme/d.ts', text: "q('SELECT * FROM public.settings');" },
      {
        path: 'apps/api/src/identity/sign-in/e.ts',
        text: "import { users, sessions } from '@ssdashboard/db';",
      },
      { path: 'apps/api/src/orders/f.ts', text: "throw new Error('two orders share a number');" },
      { path: 'apps/api/src/orders/g.ts', text: 'this.customers.canonicalOf(id);' },
    ];

    expect(breachesIn(planted).map((b) => `${b.file} ${b.table}`)).toEqual([
      'apps/api/src/catalog/a.ts stock_movements',
      'apps/api/src/identity/staff/b.ts stock_levels',
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

  it('keeps the auth tables to identity: mail reads them through MailRecipients (AC-27)', () => {
    const breaches = breachesIn([
      {
        path: 'apps/api/src/mail/mail.worker.ts',
        text: 'sql`SELECT identifier FROM verifications WHERE id = ${id}`;',
      },
      {
        path: 'apps/api/src/identity/sign-in/mail-recipients.ts',
        text: 'sql`SELECT name FROM users WHERE id = ${id}`;',
      },
    ]);

    expect(breaches.map((b) => `${b.file} ${b.table} (${b.owner})`)).toEqual([
      'apps/api/src/mail/mail.worker.ts verifications (identity)',
    ]);
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

describe('identity import wall (spec 0005, AC-27)', () => {
  const files = sourceFiles(API_SRC).map((path) => ({
    path: toRepoPath(path),
    text: readFileSync(path, 'utf8'),
  }));

  it('lists only identity files that exist', () => {
    const paths = new Set(files.map((file) => file.path));

    expect(Object.keys(IDENTITY_PUBLIC_FILES).filter((path) => !paths.has(path))).toEqual([]);
  });

  it('lets other modules import only the public identity files', () => {
    expect(
      identityImportBreaches(files).map((b) => `${b.file}:${b.line} imports ${b.target}`),
    ).toEqual([]);
  });

  it('reports a planted import of an identity internal, and allows a public one', () => {
    const planted: SourceFile[] = [
      {
        path: 'apps/api/src/orders/a.ts',
        text: "import { AUTH } from '../identity/sign-in/auth.tokens.js';",
      },
      {
        path: 'apps/api/src/orders/b.ts',
        text: "import { StaffDirectory } from '../identity/staff/staff-directory.js';",
      },
    ];

    expect(identityImportBreaches(planted)).toEqual([
      {
        file: 'apps/api/src/orders/a.ts',
        line: 1,
        target: 'apps/api/src/identity/sign-in/auth.tokens.ts',
      },
    ]);
  });

  it.each([
    ['a type import', "import type { Auth } from '../../identity/sign-in/auth.tokens.js';"],
    ['a re export', "export { SignInLockout } from '../../identity/sign-in/sign-in-lockout.js';"],
    ['a dynamic import', "await import('../../identity/sign-in/auth-audit.service.js');"],
    ['an import type node', "let a: import('../../identity/sign-in/auth.tokens.js').Auth;"],
  ])('reports %s of an identity internal', (_form, text) => {
    const breaches = identityImportBreaches([{ path: 'apps/api/src/orders/deep/c.ts', text }]);

    expect(breaches).toHaveLength(1);
  });

  it('leaves identity itself, the app entry points, and apps/api/test outside the wall', () => {
    expect(
      identityImportBreaches([
        {
          path: 'apps/api/src/identity/staff/d.ts',
          text: "import { AUTH } from '../sign-in/auth.tokens.js';",
        },
        {
          path: 'apps/api/src/app.setup.ts',
          text: "import { AUTH } from './identity/sign-in/auth.tokens.js';",
        },
        {
          path: 'apps/api/test/e.e2e-spec.ts',
          text: "import { AUTH } from '../src/identity/sign-in/auth.tokens.js';",
        },
      ]),
    ).toEqual([]);
  });
});

// Spec 0010, AC-9 and AC-14 (milestone 4 task 17): the audit module reaches an owner's undo only
// through the handler the owner registered in `AuditUndoRegistry`, so no file under
// apps/api/src/audit/ imports a business module. It may import its own files, the shared
// plumbing (database, config, platform: access, audience, keyset paging, the time zone the export
// passes on), and identity's public staff directory for person names.

/** The folders under apps/api/src an audit file may import from: plumbing, never an owner. */
const AUDIT_MAY_IMPORT_FOLDERS: ReadonlySet<string> = new Set([
  'audit',
  'database',
  'config',
  'platform',
]);

/** Single files of another module an audit file may import, each with why. */
const AUDIT_MAY_IMPORT_FILES: Readonly<Record<string, string>> = {
  'apps/api/src/identity/staff/staff-directory.ts':
    'person names by id for the actor column (spec 0010 AC-9: names from the identity service)',
};

/** Every import from an audit file into a business module it may not reach. */
function auditImportBreaches(files: readonly SourceFile[]): ImportBreach[] {
  return files.flatMap((file) => {
    if (!file.path.startsWith('apps/api/src/audit/')) return [];
    return relativeImports(file)
      .map(({ specifier, line }) => ({
        file: file.path,
        line,
        target: resolveSource(file.path, specifier),
      }))
      .filter(({ target }) => {
        const folder = /^apps\/api\/src\/([^/]+)\/.+/.exec(target)?.[1];
        return (
          folder !== undefined &&
          !AUDIT_MAY_IMPORT_FOLDERS.has(folder) &&
          !Object.hasOwn(AUDIT_MAY_IMPORT_FILES, target)
        );
      });
  });
}

describe('audit imports no owning module (spec 0010, AC-9, AC-14)', () => {
  const files = sourceFiles(join(API_SRC, 'audit')).map((path) => ({
    path: toRepoPath(path),
    text: readFileSync(path, 'utf8'),
  }));

  it('finds the audit source, the undo registry and service included', () => {
    const paths = files.map((file) => file.path);

    expect(paths).toContain('apps/api/src/audit/audit-undo.registry.ts');
    expect(paths).toContain('apps/api/src/audit/audit-undo.service.ts');
  });

  it('keeps every audit file to its own folder, the plumbing, and the staff directory', () => {
    expect(
      auditImportBreaches(files).map((b) => `${b.file}:${b.line} imports ${b.target}`),
    ).toEqual([]);
  });

  it('reports a planted import of an owning module, its service, or another identity file', () => {
    const planted: SourceFile[] = [
      {
        path: 'apps/api/src/audit/undo-shortcut.ts',
        text: [
          "import { InventoryModule } from '../inventory/inventory.module.js';",
          "import type { ReceiptsService } from '../inventory/receipts/receipts.service.js';",
          "import { CatalogService } from '../catalog/catalog.service.js';",
          "import { HatService } from '../identity/hats/hat.service.js';",
          "import { StaffDirectory } from '../identity/staff/staff-directory.js';",
          "import { Permission } from '../platform/access/permission.decorator.js';",
          "import { AuditUndoRegistry } from './audit-undo.registry.js';",
        ].join('\n'),
      },
    ];

    expect(auditImportBreaches(planted).map((b) => `${b.line} ${b.target}`)).toEqual([
      '1 apps/api/src/inventory/inventory.module.ts',
      '2 apps/api/src/inventory/receipts/receipts.service.ts',
      '3 apps/api/src/catalog/catalog.service.ts',
      '4 apps/api/src/identity/hats/hat.service.ts',
    ]);
  });
});

// Spec 0010 AC-14, review M4R4 and security review AS33: an undone entry claims its target for
// good (the unique index then blocks the real undo), so only the undo writes one. The writer is a
// provider `AuditUndoModule` does not export, and no file but the undo service, its module, and
// the audit module's own tests may name it. Security review AS36: the insert pieces it shares with
// `AuditService` (`entryValues`, `INSERT_ENTRIES`, in `audit-entry-sql.ts`) would build the same
// row around it, so they are walled too: only the service and the writer may name them.
// Extensions are held to both walls.

/** The files that may name the undone entry writer, each with why. */
const UNDONE_WRITER_USERS: Readonly<Record<string, string>> = {
  'apps/api/src/audit/audit-undone.writer.ts': 'the writer itself',
  'apps/api/src/audit/audit-undo.service.ts': 'the undo, its only caller',
  'apps/api/src/audit/audit-undo.module.ts': 'provides it, exports nothing',
};

/** What names the writer: its class, its file, or the method the exported service once had. */
const UNDONE_WRITER_NAMES = /\bAuditUndoneWriter\b|audit-undone\.writer|\brecordUndone\b/;

/** The files that may name the shared entry insert pieces, each with why (AS36). */
const ENTRY_SQL_USERS: Readonly<Record<string, string>> = {
  'apps/api/src/audit/audit-entry-sql.ts': 'the insert pieces themselves',
  'apps/api/src/audit/audit.service.ts': 'record and recordMany: entries of listed codes',
  'apps/api/src/audit/audit-undone.writer.ts': 'the undone entry writer',
};

/** What names the insert pieces: the values builder, the column list, or their file. */
const ENTRY_SQL_NAMES = /\bentryValues\b|\bINSERT_ENTRIES\b|audit-entry-sql/;

/** Every file outside `users` (and the audit module's own specs) whose text matches `names`. */
function namedOutside(
  files: readonly SourceFile[],
  users: Readonly<Record<string, string>>,
  names: RegExp,
): string[] {
  return files
    .filter(
      (file) =>
        !Object.hasOwn(users, file.path) &&
        !/^apps\/api\/src\/audit\/[^/]+\.spec\.ts$/.test(file.path) &&
        names.test(file.text),
    )
    .map((file) => file.path);
}

/** Every file outside the allowed list (and the audit module's own specs) that names the writer. */
function undoneWriterBreaches(files: readonly SourceFile[]): string[] {
  return namedOutside(files, UNDONE_WRITER_USERS, UNDONE_WRITER_NAMES);
}

/** Every file outside the allowed list (and the audit specs) that names the insert pieces. */
function entrySqlBreaches(files: readonly SourceFile[]): string[] {
  return namedOutside(files, ENTRY_SQL_USERS, ENTRY_SQL_NAMES);
}

describe('only the undo writes an undone entry (spec 0010 AC-14, AS33)', () => {
  const files = [...sourceFiles(API_SRC), ...sourceFiles(EXTENSIONS)]
    .map((path) => ({ path: toRepoPath(path), text: readFileSync(path, 'utf8') }))
    .filter((file) => file.path !== 'apps/api/src/module-boundary.spec.ts');

  it('lists only files that exist', () => {
    const paths = new Set(files.map((file) => file.path));

    expect(Object.keys(UNDONE_WRITER_USERS).filter((path) => !paths.has(path))).toEqual([]);
    expect(Object.keys(ENTRY_SQL_USERS).filter((path) => !paths.has(path))).toEqual([]);
  });

  it('finds the writer named nowhere but the undo service, its module, and the audit specs', () => {
    expect(undoneWriterBreaches(files)).toEqual([]);
  });

  it('finds the insert pieces named nowhere but the service, the writer, and the audit specs (AS36)', () => {
    expect(entrySqlBreaches(files)).toEqual([]);
  });

  it('reports a planted module, extension, or other audit file that builds an entry row itself (AS36)', () => {
    const planted: SourceFile[] = [
      {
        path: 'apps/api/src/inventory/claim.ts',
        text: [
          "import { entryValues, INSERT_ENTRIES } from '../audit/audit-entry-sql.js';",
          'await tx.execute(sql`${INSERT_ENTRIES} VALUES ${entryValues(entry, targetId)}`);',
        ].join('\n'),
      },
      {
        path: 'extensions/acme/claim.ts',
        text: "const pieces = await import('x/audit-entry-sql');",
      },
      {
        path: 'apps/api/src/audit/audit-undo.service.ts',
        text: 'const row = entryValues(entry, id);',
      },
      {
        path: 'apps/api/src/audit/audit-undone.writer.ts',
        text: "import { entryValues, INSERT_ENTRIES } from './audit-entry-sql.js';",
      },
      { path: 'apps/api/src/audit/audit.service.spec.ts', text: 'INSERT_ENTRIES' },
    ];

    expect(entrySqlBreaches(planted)).toEqual([
      'apps/api/src/inventory/claim.ts',
      'extensions/acme/claim.ts',
      'apps/api/src/audit/audit-undo.service.ts',
    ]);
  });

  it('reports a planted owner, extension, or other audit file that names it', () => {
    const planted: SourceFile[] = [
      {
        path: 'apps/api/src/inventory/shortcut.ts',
        text: "import { AuditUndoneWriter } from '../audit/audit-undone.writer.js';",
      },
      { path: 'extensions/acme/claim.ts', text: 'await audit.recordUndone(tx, id, entry);' },
      {
        path: 'apps/api/src/audit/audit-entries.controller.ts',
        text: "import type { AuditUndoneEntryInput } from './audit-undone.writer.js';",
      },
      {
        path: 'apps/api/src/audit/audit-undo.service.ts',
        text: "import { AuditUndoneWriter } from './audit-undone.writer.js';",
      },
      { path: 'apps/api/src/audit/audit-undo.spec.ts', text: 'AuditUndoneWriter' },
    ];

    expect(undoneWriterBreaches(planted)).toEqual([
      'apps/api/src/inventory/shortcut.ts',
      'extensions/acme/claim.ts',
      'apps/api/src/audit/audit-entries.controller.ts',
    ]);
  });
});
