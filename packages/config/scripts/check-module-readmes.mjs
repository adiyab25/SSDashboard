#!/usr/bin/env node
// Fails when an api module, web feature folder, or package has no README.md with the five
// required headings. Spec 0007, Conventions (Code documentation).
//
// Usage: node check-module-readmes.mjs [<repo root>]   (default: the current directory)
// Targets: each direct child folder of apps/api/src, each direct child folder of
// apps/web/src except `app`, and each folder in packages/.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_HEADINGS = [
  'Owns',
  'Never touches',
  'How to test',
  'Governing spec',
  'Decisions',
];

const IGNORED_FOLDERS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);

/** The required headings a README's text does not contain as an exact H2 line. */
export function missingHeadings(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  return REQUIRED_HEADINGS.filter((heading) => !lines.includes(`## ${heading}`));
}

function childFolders(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !IGNORED_FOLDERS.has(name) && !name.startsWith('.'))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory());
}

/** Every folder that must carry a README.md. */
export function readmeTargets(root) {
  const webSrc = join(root, 'apps', 'web', 'src');
  return [
    ...childFolders(join(root, 'apps', 'api', 'src')),
    ...childFolders(webSrc).filter((path) => path !== join(webSrc, 'app')),
    ...childFolders(join(root, 'packages')),
  ];
}

/** Every problem under a repo root, as `{ file, message }`. */
export function checkReadmes(root) {
  const problems = [];
  for (const folder of readmeTargets(root)) {
    const file = join(folder, 'README.md');
    if (!existsSync(file)) {
      problems.push({ file, message: 'README.md is missing' });
      continue;
    }
    for (const heading of missingHeadings(readFileSync(file, 'utf8'))) {
      problems.push({ file, message: `missing heading "## ${heading}"` });
    }
  }
  return problems;
}

function main(args) {
  const root = args[0] ?? process.cwd();
  const problems = checkReadmes(root);
  for (const problem of problems) {
    console.error(`${relative(process.cwd(), problem.file)}  ${problem.message}`);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} README ${problems.length === 1 ? 'problem' : 'problems'}. ` +
        'Copy docs/templates/module-readme.md.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
