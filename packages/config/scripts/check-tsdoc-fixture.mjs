#!/usr/bin/env node
// Proves `jsdoc/require-jsdoc` still catches every kind of export. Older issues report that
// `publicOnly` misses some declarations, so this lints a fixture holding one undocumented
// export of each kind with the real shared config and fails unless every kind is reported.
// Spec 0007, Conventions (TSDoc).
//
// Usage: node check-tsdoc-fixture.mjs [--without-require-jsdoc]
//   --without-require-jsdoc  switches the rule off first, to show the check fails (verify.md)
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { base } from '../eslint/base.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/tsdoc', import.meta.url));
const FIXTURE = `${FIXTURE_DIR}/undocumented-exports.tsx`;

/** The export kinds the fixture marks with `// kind: <name>`, with the line of the declaration below. */
export function fixtureKinds(source) {
  return source.split('\n').flatMap((text, index) => {
    const match = /\/\/ kind: (.+)$/.exec(text);
    return match?.[1] ? [{ kind: match[1], line: index + 2 }] : [];
  });
}

/**
 * Lints the fixture and returns the kinds no `jsdoc/require-jsdoc` message covers.
 * Pass `{ requireJsdoc: false }` to switch the rule off and see every kind come back.
 */
export async function missingKinds({ requireJsdoc = true } = {}) {
  const eslint = new ESLint({
    cwd: FIXTURE_DIR,
    overrideConfigFile: true,
    overrideConfig: [
      ...base(FIXTURE_DIR),
      ...(requireJsdoc ? [] : [{ rules: { 'jsdoc/require-jsdoc': 'off' } }]),
    ],
  });
  const [result] = await eslint.lintFiles([FIXTURE]);
  const reported = new Set(
    (result?.messages ?? []).filter((m) => m.ruleId === 'jsdoc/require-jsdoc').map((m) => m.line),
  );
  return fixtureKinds(readFileSync(FIXTURE, 'utf8'))
    .filter(({ line }) => !reported.has(line))
    .map(({ kind }) => kind);
}

async function main(args) {
  const requireJsdoc = !args.includes('--without-require-jsdoc');
  const missing = await missingKinds({ requireJsdoc });
  for (const kind of missing) console.error(`not reported by jsdoc/require-jsdoc: ${kind}`);
  if (missing.length > 0) {
    console.error(`\n${missing.length} export kind(s) slip past the TSDoc rule.`);
    return 1;
  }
  console.log('jsdoc/require-jsdoc reports every export kind in the fixture.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
