#!/usr/bin/env node
// Fails when a relative markdown link in docs/**, a README.md, or an AGENTS.md points at a
// file that does not exist. Spec 0007, Conventions (Documentation kept true).
//
// Usage: node check-doc-links.mjs [<repo root>]   (default: the current directory)
// Ignored: links with a scheme (http, https, mailto), pure #anchors, code spans, fenced blocks.
// A `#fragment` is stripped and %20 style escapes are decoded before the file is looked up;
// the fragment itself is not verified. A link starting with `/` resolves from the repo root.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.claude',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  'fixtures',
]);
const NAMED_FILES = new Set(['README.md', 'AGENTS.md']);
const INLINE_LINK = /\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_LINK = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;

/** Blanks fenced code blocks and inline code spans, keeping line numbers. */
export function stripCode(text) {
  let fence = null;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (marker?.[1] && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
          fence = null;
        }
        return '';
      }
      if (marker?.[1]) {
        fence = marker[1];
        return '';
      }
      return line.replace(/(`+)[^`]*?\1/g, '');
    })
    .join('\n');
}

/** The raw link targets in markdown text, as `{ line, target }`. */
export function extractLinks(text) {
  const links = [];
  stripCode(text)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(INLINE_LINK)) {
        if (match[1]) links.push({ line: index + 1, target: match[1] });
      }
      const reference = REFERENCE_LINK.exec(line);
      if (reference?.[1]) links.push({ line: index + 1, target: reference[1] });
    });
  return links.map(({ line, target }) => ({ line, target: target.replace(/^<|>$/g, '') }));
}

/** The file path a link points at, or null when the link is not a local file link. */
export function localPath(target) {
  if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const path = target.split('#')[0]?.split('?')[0] ?? '';
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Broken links in one markdown file, as `{ line, target }`. */
export function brokenLinks(file, text, root) {
  return extractLinks(text).filter(({ target }) => {
    const path = localPath(target);
    if (path === null) return false;
    const resolved = path.startsWith('/') ? join(root, path) : resolve(dirname(file), path);
    return !existsSync(resolved);
  });
}

function walk(dir, keep) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(path, keep);
    return keep(name) ? [path] : [];
  });
}

/** Every markdown file the check reads under a repo root. */
export function filesToCheck(root) {
  const docsRoot = join(root, 'docs');
  const docs = existsSync(docsRoot) ? walk(docsRoot, (name) => name.endsWith('.md')) : [];
  const named = walk(root, (name) => NAMED_FILES.has(name));
  return [...new Set([...docs, ...named])];
}

function main(args) {
  const root = resolve(args[0] ?? process.cwd());
  let count = 0;
  for (const file of filesToCheck(root)) {
    for (const problem of brokenLinks(file, readFileSync(file, 'utf8'), root)) {
      count++;
      console.error(`${relative(process.cwd(), file)}:${problem.line}  ${problem.target}`);
    }
  }
  if (count > 0) {
    console.error(`\n${count} broken relative ${count === 1 ? 'link' : 'links'}.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
