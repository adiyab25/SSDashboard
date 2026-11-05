#!/usr/bin/env node
// Fails on a file or folder named with a vague or abbreviated word (`mgr`, `cfg`, `util`,
// `misc`, `temp`, and the like) anywhere in apps/*, packages/*, and extensions/* (except this package's test fixtures): names use
// the business's words. Spec 0007, Conventions (Organisation and naming).
//
// A name is split into words at dashes, dots, underscores, and camel case humps, so
// `MiscHelper.ts` is `misc` + `helper`. Only whole words match: `template` is fine.
//
// Exempt, by exact path: packages/ui/src/lib/utils.ts, because shadcn's `components.json` alias
// and CLI output import `cn` from `@/lib/utils`
// (docs/adr/0001-shadcn-component-files-keep-their-vendor-shape.md).
//
// Usage: node check-banned-names.mjs [<repo root>]   (default: the current directory)
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BANNED_WORDS = new Set([
  'mgr',
  'cfg',
  'util',
  'utils',
  'misc',
  'temp',
  'tmp',
  'stuff',
  'helper',
  'helpers',
]);

// ADR 0001: the one shadcn path that keeps its vendor name. Exact path, relative to the root.
// The planted fixtures of this package's own tests are not source names either. Only this folder.
export const FIXTURES_DIR = 'packages/config/scripts/fixtures/';

export const EXEMPT_PATHS = new Set(['packages/ui/src/lib/utils.ts']);

// Generated output and installed packages are not source names.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'test-results']);

/** The lower case words in a file or folder name. */
export function nameWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** The banned words a name contains, if any. */
export function bannedWordsIn(name) {
  return nameWords(name).filter((word) => BANNED_WORDS.has(word));
}

/** Every file and folder below a directory with a banned word in its name. */
export function findBannedNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    const own = bannedWordsIn(name).length > 0 ? [path] : [];
    return statSync(path).isDirectory() ? [...own, ...findBannedNames(path)] : own;
  });
}

function workspaceRoots(root) {
  return ['apps', 'packages', 'extensions'].flatMap((group) => {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) return [];
    return readdirSync(groupDir)
      .map((name) => join(groupDir, name))
      .filter((path) => statSync(path).isDirectory());
  });
}

/** Banned names across every workspace of a repo. */
export function checkBannedNames(root) {
  return workspaceRoots(root)
    .flatMap(findBannedNames)
    .filter((path) => {
      const rel = relative(root, path).split(sep).join('/');
      return !EXEMPT_PATHS.has(rel) && !rel.startsWith(FIXTURES_DIR);
    });
}

function main(args) {
  const root = args[0] ?? process.cwd();
  const found = checkBannedNames(root);
  for (const path of found) console.error(relative(process.cwd(), path));
  if (found.length > 0) {
    console.error(
      `\n${found.length} file or folder ${found.length === 1 ? 'name uses' : 'names use'} a banned word ` +
        `(${[...BANNED_WORDS].join(', ')}). Rename it in the business's words.`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
