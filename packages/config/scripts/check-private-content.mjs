#!/usr/bin/env node
// Fails when private content is committed to this public repository.
// Two rules over `git ls-files`:
//   1. no tracked path starts with a private folder (internal reviews, positioning, research, hand-overs,
//      PR drafts, and the vendored agent skills and agents);
//   2. no tracked text file or path contains a blocked word, matched as a whole word: camelCase and
//      PascalCase boundaries are split first (fooBarWord -> foo, bar, word), then the lowercased text is
//      split on runs of Unicode letters and digits, so a longer word that merely contains a blocked
//      one never matches.
// The blocked words are stored only as SHA-256 digests of the lowercase word, so this file does not
// publish what it blocks. Never add a plain word here, to a comment, or to a test.
//
// Blocked words are Latin script today. No Arabic script word is blocked yet: the tokenizer already
// reads Unicode letters, so the owner can add the digest of a lowercase Arabic word to BLOCKED_DIGESTS.
//
// Out of scope: untracked and ignored files, real binary files (a NUL byte, unless the file starts with
// a UTF-16 byte order mark, which is decoded and scanned), and git history. Not caught: a blocked word
// joined to other letters without a case change (for example all lowercase compounds), or split by
// punctuation or spaces; digests can only match whole tokens.
//
// Usage: node check-private-content.mjs [<repo root>]   (default: the current directory)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** SHA-256 hex digests of the lowercase blocked words. */
export const BLOCKED_DIGESTS = new Set([
  '5ee84a2ddad2d907f6e87be434690d78f4b819fe437c08ca505c2a5163a07599',
  'd5cf21ad541bd7f7cb147c1be82e7bebe5a6f0a17762f37f41b39e71f4f25b73',
  '532343b2c339de8203a32966d4fbfe830c359ff40cfa1cbc570a7c2ef9e7d978',
  'a541040b36e100c6da45f176fd5ab865cb08a4faab4f136f867c43a7722cc6c5',
  '2ffb6e3b73cce5c2327d349550a72e7ac6877e7aaff8e7c33e7fb386f884adef',
  '95ef5a31d084e89425c9e30a864d6cba7fb5a4d1c0e031029cd58c1a433adb5d',
  'e9862dbb408a8b13e4f1b919ed0f95f39f2f29e0983641c27d7e4397471e71a4',
]);

/** Folders whose content is private; no tracked path may start with one. */
export const PRIVATE_FOLDERS = [
  'docs/reviews/',
  'docs/positioning/',
  'docs/research/',
  'docs/handover/',
  'docs/pr/',
  '.claude/skills/',
  '.claude/agents/',
];

const digest = (word) => createHash('sha256').update(word).digest('hex');

/**
 * The lines of a text that hold a blocked word.
 *
 * @param {string} text The content (LF or CRLF); matching is case insensitive and on whole tokens (camelCase split, Unicode letters and digits).
 * @returns {{ line: number }[]} One entry per line with a blocked word; the word itself is never returned.
 */
export function blockedWordHits(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((content, index) => {
    const split = content
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
    const words = split.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.some((word) => BLOCKED_DIGESTS.has(digest(word)))) hits.push({ line: index + 1 });
  });
  return hits;
}

/**
 * The private folder a tracked path sits in, if any.
 *
 * @param {string} path A repo relative path with forward slashes.
 * @returns {string | undefined} The folder, or undefined.
 */
export function privateFolderOf(path) {
  const lower = path.toLowerCase();
  return PRIVATE_FOLDERS.find((folder) => lower.startsWith(folder));
}

/**
 * The text of a tracked file, or undefined for a real binary file.
 *
 * @param {Buffer} buffer The file content.
 * @returns {string | undefined} UTF-8 text, a decoded UTF-16 text (byte order mark), or undefined when binary.
 */
export function textOf(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  if (buffer.includes(0)) return undefined;
  return buffer.toString('utf8');
}

/**
 * Every private content problem among the tracked files of a repo.
 *
 * @param {string} root The repo root (must be a git work tree).
 * @returns {{ file: string, line?: number, reason: string }[]} One entry per problem; a blocked word is never named.
 */
export function privateContentProblems(root) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const problems = [];
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const folder = privateFolderOf(file);
    if (folder) problems.push({ file, reason: `tracked inside the private folder ${folder}` });
    if (blockedWordHits(file).length > 0) {
      problems.push({ file, reason: 'blocked word in the path' });
    }
    let buffer;
    try {
      buffer = readFileSync(join(root, file));
    } catch (error) {
      if (error?.code === 'ENOENT') continue; // deleted in the work tree but still indexed
      throw error;
    }
    const text = textOf(buffer);
    if (text === undefined) continue;
    for (const hit of blockedWordHits(text)) {
      problems.push({ file, line: hit.line, reason: 'blocked word' });
    }
  }
  return problems;
}

function main(args) {
  const root = args[0] ?? process.cwd();
  const problems = privateContentProblems(root);
  for (const problem of problems) {
    console.error(`${problem.file}${problem.line ? `:${problem.line}` : ''}: ${problem.reason}`);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} private content problem${problems.length === 1 ? '' : 's'}. ` +
        'This repository is public: remove the content, or the private folder from the index.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
