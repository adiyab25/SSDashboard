#!/usr/bin/env node
// Fails when a port in the CI only block (4900-4949) appears in dev facing config.
// The block is reserved for CI (`.github/workflows/ci.yml`, docs/ops/self-hosted-ci-runner.md): a
// self-hosted runner shares the machine with the dev servers and databases, so a dev default on one
// of these ports would collide with a CI run. The workflow files are the one allowed place.
//
// Checked: `.env.example` files, `.claude/launch.json`, every `package.json` (root, apps, packages,
// extensions), `deploy/compose*.yaml`, and `apps/web/playwright.config.ts`.
//
// Out of scope: `.claude/launch.json` is untracked, so it is only checked on a machine that has it,
// never in CI. Ports built at run time and any file not listed above are not seen.
//
// Usage: node check-reserved-ci-ports.mjs [<repo root>]   (default: the current directory)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RESERVED_FIRST_PORT = 4900;
export const RESERVED_LAST_PORT = 4949;

// A port in 4900-4949 that is not part of a longer number.
const PORT = '49[0-4]\\d';
// Port like contexts only, so `4920 items` or an id such as `ab4920` is not flagged.
const PORT_CONTEXTS = [
  // host:4920, localhost:4920, a bare `:4920`
  new RegExp(`:(${PORT})(?!\\d)`, 'g'),
  // a Compose mapping such as `4932:5432` (the host side leads)
  new RegExp(`(?<![\\w.:])(${PORT}):\\d{2,5}(?!\\d)`, 'g'),
  // --port 4920, --port=4920, -p 4920
  new RegExp(`(?:--port|(?<![\\w-])-p)[ =]+(${PORT})(?!\\d)`, 'g'),
  // PORT=4920, E2E_API_PORT: 4920, "port": 4920
  new RegExp(`port["']?\\s*[:=]\\s*["']?(${PORT})(?!\\d)`, 'gi'),
];
// Compose files only: the long form `published: 4932` and a bare list item `- 4932` or `- "4932"`.
const COMPOSE_CONTEXTS = [
  new RegExp(`published["']?\\s*:\\s*["']?(${PORT})(?!\\d)`, 'g'),
  new RegExp(`^\\s*-\\s+["']?(${PORT})["']?\\s*(?:#.*)?$`, 'g'),
];

/**
 * Every reserved CI port the text uses in a port like context.
 *
 * @param {string} text The file content (LF or CRLF).
 * @param {{ compose?: boolean }} [options] Set `compose` to also match the Compose long form and bare list items.
 * @returns {{ line: number, port: number }[]} One entry per hit, with its 1 based line number.
 */
export function reservedPortHits(text, options = {}) {
  const contexts = options.compose ? [...PORT_CONTEXTS, ...COMPOSE_CONTEXTS] : PORT_CONTEXTS;
  const hits = [];
  text.split(/\r?\n/).forEach((content, index) => {
    const seen = new Set();
    for (const context of contexts) {
      for (const match of content.matchAll(context)) {
        const port = Number(match[1]);
        if (!seen.has(port)) {
          seen.add(port);
          hits.push({ line: index + 1, port });
        }
      }
    }
  });
  return hits;
}

/** The workspace folders (`apps/web`, `packages/db`, ...) one level under the usual parents. */
function workspaceDirs(root) {
  const dirs = [root];
  for (const parent of ['apps', 'packages', 'extensions']) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const name of readdirSync(parentDir)) {
      const dir = join(parentDir, name);
      if (name !== 'node_modules' && statSync(dir).isDirectory()) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * The dev facing files that must not use a reserved port.
 *
 * @param {string} root The repo root.
 * @returns {string[]} Absolute paths of the files that exist.
 */
export function filesToCheck(root) {
  const files = [];
  const add = (path) => {
    if (existsSync(path) && statSync(path).isFile()) files.push(path);
  };
  for (const dir of workspaceDirs(root)) {
    add(join(dir, 'package.json'));
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.env.example')) add(join(dir, name));
    }
  }
  add(join(root, '.claude', 'launch.json'));
  const deployDir = join(root, 'deploy');
  if (existsSync(deployDir)) {
    for (const name of readdirSync(deployDir)) {
      if (/^compose.*\.ya?ml$/.test(name)) add(join(deployDir, name));
    }
  }
  add(join(root, 'apps', 'web', 'playwright.config.ts'));
  return files;
}

/**
 * Every reserved port use in the dev facing files under a repo root.
 *
 * @param {string} root The repo root.
 * @returns {{ file: string, line: number, port: number }[]} One entry per use, file relative to the root.
 */
export function reservedPortUses(root) {
  const uses = [];
  for (const file of filesToCheck(root)) {
    const compose = /^compose.*\.ya?ml$/.test(basename(file));
    for (const hit of reservedPortHits(readFileSync(file, 'utf8'), { compose })) {
      uses.push({ file: relative(root, file).replaceAll('\\', '/'), ...hit });
    }
  }
  return uses;
}

function main(args) {
  const root = args[0] ?? process.cwd();
  const uses = reservedPortUses(root);
  for (const use of uses) console.error(`${use.file}:${use.line}: port ${use.port}`);
  if (uses.length > 0) {
    console.error(
      `\n${uses.length} use${uses.length === 1 ? '' : 's'} of a port in ` +
        `${RESERVED_FIRST_PORT}-${RESERVED_LAST_PORT}, which is reserved for CI only. ` +
        'Use another port in dev facing config; only .github/workflows/** may use this block.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
