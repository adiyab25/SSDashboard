#!/usr/bin/env node
// Rejects commit subjects that break the spec 0007 Git convention: banned whole subjects,
// conventional commit prefixes, fixup!/squash! markers, and subjects over 72 characters.
// Merge commits made by GitHub or `git merge` are allowed.
//
// One script for both places: the `.husky/commit-msg` hook and the CI `conventions` job.
// Usage: node check-commit-subject.mjs <message file>        (the hook; first non comment line)
//        node check-commit-subject.mjs --range <base>..<head>  (CI; every commit in the range)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_SUBJECT_LENGTH = 72;
export const BANNED_SUBJECTS = [
  'wip',
  'misc',
  'fix',
  'fixes',
  'update',
  'updates',
  'changes',
  'temp',
  'tmp',
  'test',
];
const CONVENTIONAL_PREFIX =
  /^(feat|fix|chore|docs|refactor|test|style|perf|build|ci|revert)(\([^)]*\))?!?:/i;
const MERGE_SUBJECT = /^Merge (pull request|branch|remote-tracking branch|tag) /;
const FIXUP_PREFIX = /^(fixup|squash|amend)!/;

/** The first line of a commit message file that is not a `#` comment, or an empty string. */
export function firstSubjectLine(message) {
  const line = message.split(/\r?\n/).find((l) => l.trim() !== '' && !l.startsWith('#'));
  return line === undefined ? '' : line.trim();
}

/** The reason a subject is rejected, or `null` when it is fine. */
export function subjectProblem(subject) {
  if (subject === '') return 'the subject is empty';
  if (MERGE_SUBJECT.test(subject)) return null;
  if (FIXUP_PREFIX.test(subject)) return 'fixup!/squash! commits must be squashed before pushing';
  const bare = subject.replace(/[\s.!?,;:]+$/, '').toLowerCase();
  if (BANNED_SUBJECTS.includes(bare)) return `"${bare}" says nothing; describe the change`;
  if (CONVENTIONAL_PREFIX.test(subject)) {
    return 'no conventional commit prefixes (feat:, fix(scope):); start with an imperative verb';
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return `the subject is ${subject.length} characters; the limit is ${MAX_SUBJECT_LENGTH}`;
  }
  return null;
}

function checkRange(range) {
  const git = spawnSync('git', ['log', '--format=%H%x00%s', range], { encoding: 'utf8' });
  if (git.status !== 0) {
    console.error(git.stderr || `git log ${range} failed`);
    return 2;
  }
  let failures = 0;
  for (const row of git.stdout.split('\n').filter(Boolean)) {
    const [sha = '', subject = ''] = row.split('\0');
    const problem = subjectProblem(subject);
    if (problem !== null) {
      failures += 1;
      console.error(`${sha.slice(0, 7)} "${subject}": ${problem}`);
    }
  }
  if (failures > 0) console.error(`\n${failures} commit subject(s) break the convention.`);
  return failures > 0 ? 1 : 0;
}

function checkFile(file) {
  const subject = firstSubjectLine(readFileSync(file, 'utf8'));
  const problem = subjectProblem(subject);
  if (problem === null) return 0;
  console.error(`Commit rejected: "${subject}": ${problem}.`);
  return 1;
}

function main(args) {
  if (args[0] === '--range' && args[1]) return checkRange(args[1]);
  if (args[0] && !args[0].startsWith('--')) return checkFile(args[0]);
  console.error('Usage: check-commit-subject.mjs <message file> | --range <base>..<head>');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
