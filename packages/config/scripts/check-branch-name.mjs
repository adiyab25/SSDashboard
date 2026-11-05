#!/usr/bin/env node
// Fails unless a branch is named `<prefix>/<feature-slug>` with prefix feat, fix, or docs.
// Spec 0007, Conventions (Git). CI passes the pull request head branch.
//
// Usage: node check-branch-name.mjs <branch name>
import { pathToFileURL } from 'node:url';

export const BRANCH_PREFIXES = ['feat', 'fix', 'docs'];
const BRANCH_NAME = new RegExp(`^(${BRANCH_PREFIXES.join('|')})/[a-z0-9]+(-[a-z0-9]+)*$`);

/** Whether a branch name is `feat/`, `fix/`, or `docs/` plus a lowercase kebab case slug. */
export function isValidBranchName(name) {
  return BRANCH_NAME.test(name);
}

function main(args) {
  const name = args[0] ?? '';
  if (isValidBranchName(name)) return 0;
  console.error(
    `Branch "${name}" is not allowed. Name it <prefix>/<feature-slug> with prefix ` +
      `${BRANCH_PREFIXES.map((p) => `${p}/`).join(', ')} (lowercase, hyphens), e.g. feat/exchange-request.`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
