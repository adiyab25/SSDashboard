#!/usr/bin/env node
// Fails on a global layer folder (`services`, `controllers`) anywhere under apps/*/src or
// packages/*/src: code is foldered by feature. Spec 0007, Conventions (Organisation and naming).
//
// Usage: node check-folder-names.mjs [<repo root>]   (default: the current directory)
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BANNED_FOLDERS = new Set(['services', 'controllers']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);

/** Every banned folder below a directory. */
export function findBannedFolders(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIP_DIRS.has(name) || !statSync(path).isDirectory()) return [];
    return BANNED_FOLDERS.has(name) ? [path] : findBannedFolders(path);
  });
}

function sourceRoots(root) {
  return ['apps', 'packages'].flatMap((group) => {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) return [];
    return readdirSync(groupDir).map((name) => join(groupDir, name, 'src'));
  });
}

function main(args) {
  const root = args[0] ?? process.cwd();
  const found = sourceRoots(root).flatMap(findBannedFolders);
  for (const path of found) console.error(relative(process.cwd(), path));
  if (found.length > 0) {
    console.error(
      `\n${found.length} global layer ${found.length === 1 ? 'folder' : 'folders'} found. ` +
        'Folder by feature: colocate the service or controller with its module.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
