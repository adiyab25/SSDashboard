#!/usr/bin/env node
// Fails when a React component file does not export the component its file name says:
// `exchange-request-form.tsx` must export `ExchangeRequestForm` (named or default).
// Spec 0007, Conventions (Organisation and naming).
//
// Exact rule. A file is checked when it is a `.tsx` file in apps/web/src or packages/ui/src
// and is not exempt. It is a component file when it exports at least one value (function,
// class, constant, or `export { ... }` entry, not a type or interface) whose name is
// PascalCase (starts with a capital, has a lower case letter, no underscore). A component
// file passes when one of those exports is named after the file: kebab case to PascalCase
// (`use-case-card` is `UseCaseCard`). A file may export more PascalCase values beside it
// (a compound component such as `card.tsx` with `Card` and `CardHeader`), but the one named
// after the file must be there. An anonymous default export fails.
//
// Exempt: Next special files (page, layout, template, loading, error, global-error,
// global-not-found, not-found, default, route, forbidden, unauthorized, icon, apple-icon, opengraph-image,
// twitter-image, sitemap, robots, manifest), spec, test, and test utility files, `e2e`, and
// `.d.ts`. Files with no PascalCase value export (hooks, helpers) are not component files.
//
// Also exempt: packages/ui/src/components/**, the shadcn compound components, which keep their
// vendor shape (docs/adr/0001-shadcn-component-files-keep-their-vendor-shape.md).
//
// Usage: node check-component-export-names.mjs [<repo root>]   (default: the current directory)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const SOURCE_ROOTS = ['apps/web/src', 'packages/ui/src'];

export const NEXT_SPECIAL_FILES = new Set([
  'page',
  'layout',
  'template',
  'loading',
  'error',
  'global-error',
  'global-not-found',
  'not-found',
  'default',
  'route',
  'forbidden',
  'unauthorized',
  'icon',
  'apple-icon',
  'opengraph-image',
  'twitter-image',
  'sitemap',
  'robots',
  'manifest',
]);

// ADR 0001: shadcn compound components keep their vendor shape. Path prefix, relative to the root.
export const SHADCN_COMPONENTS_DIR = 'packages/ui/src/components/';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'e2e']);

/** `exchange-request-form` becomes `ExchangeRequestForm`. */
export function pascalCase(kebab) {
  return kebab
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

function isPascalCase(name) {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
}

/** The file name without its `.tsx` extension, or null when the file is exempt. */
export function checkedStem(fileName) {
  if (!fileName.endsWith('.tsx') || fileName.endsWith('.d.ts')) return null;
  const stem = fileName.slice(0, -'.tsx'.length);
  if (/\.(spec|test)$/.test(stem) || /\.test-support$/.test(stem)) return null;
  if (NEXT_SPECIAL_FILES.has(stem)) return null;
  return stem;
}

/**
 * The value exports of a source text: `{ names, anonymousDefault }`. Types and interfaces
 * are not values, so they are left out.
 */
export function valueExports(source) {
  const file = ts.createSourceFile(
    'file.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = [];
  let anonymousDefault = false;
  const hasModifier = (node, kind) => ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;

  for (const node of file.statements) {
    if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) names.push(node.expression.text);
      else anonymousDefault = true;
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly || !node.exportClause || !ts.isNamedExports(node.exportClause)) continue;
      for (const element of node.exportClause.elements) {
        if (!element.isTypeOnly) names.push(element.name.text);
      }
    } else if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        if (node.name) names.push(node.name.text);
        else if (isDefault) anonymousDefault = true;
      } else if (ts.isEnumDeclaration(node)) {
        names.push(node.name.text);
      }
    }
  }
  return { names, anonymousDefault };
}

/** The problem with a component file, or null when it is fine or not a component file. */
export function exportNameProblem(fileName, source) {
  const stem = checkedStem(fileName);
  if (stem === null) return null;
  const { names, anonymousDefault } = valueExports(source);
  const components = names.filter(isPascalCase);
  if (components.length === 0 && !anonymousDefault) return null;
  const expected = pascalCase(stem);
  if (components.includes(expected)) return null;
  if (anonymousDefault) return `anonymous default export; expected a component named ${expected}`;
  return `expected an export named ${expected}, found ${components.join(', ')}`;
}

function tsxFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? tsxFiles(path) : [path];
  });
}

/** Every `{ path, problem }` across the component source folders of a repo. */
export function checkExportNames(root) {
  return SOURCE_ROOTS.flatMap((source) =>
    tsxFiles(join(root, source)).flatMap((path) => {
      const rel = relative(root, path).split(sep).join('/');
      if (rel.startsWith(SHADCN_COMPONENTS_DIR)) return [];
      const problem = exportNameProblem(basename(path), readFileSync(path, 'utf8'));
      return problem === null ? [] : [{ path, problem }];
    }),
  );
}

function main(args) {
  const root = args[0] ?? process.cwd();
  const found = checkExportNames(root);
  for (const { path, problem } of found)
    console.error(`${relative(process.cwd(), path)}: ${problem}`);
  if (found.length > 0) {
    console.error(
      `\n${found.length} component ${found.length === 1 ? 'file' : 'files'} not named after ${found.length === 1 ? 'its' : 'their'} component. ` +
        'Rename the file or the component so they match.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
