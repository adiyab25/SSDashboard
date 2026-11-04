#!/usr/bin/env node
// Fails when source styles a physical side (left or right) instead of a logical one
// (start or end), so right to left layouts mirror without fixes. Spec 0003, AC-5.
//
// Usage: node check-logical-css.mjs <dir> [<dir>...]
// Allowed: `ltr:` and `rtl:` scoped utilities, `space-x-*` and `divide-x-*` (direction
// aware in Tailwind v4), and any line marked `logical-css-ignore: <reason>` (on the line
// itself or the line above).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'coverage',
  'test-results',
  'fixtures',
]);
const EXTENSIONS = new Set(['.ts', '.tsx', '.css']);
const IGNORE = /logical-css-ignore:\s*\S/;

/** Tailwind utilities that name a physical side, after variants and `!`/`-` are stripped. */
const PHYSICAL_UTILITIES = [
  /^(scroll-)?[mp][lr]-/,
  /^(left|right)-/,
  /^text-(left|right)$/,
  /^border-[lr](-|$)/,
  /^rounded-([lr]|tl|tr|bl|br)(-|$)/,
  /^float-(left|right)$/,
  /^clear-(left|right)$/,
  /^(slide-in-from|slide-out-to)-(left|right)(-|$)/,
  /^origin-(.*-)?(left|right)$/,
];

/** Variants that select on a physical side. */
const PHYSICAL_VARIANT = /data-\[side=(left|right)\]/;

/** Plain CSS properties and values that name a physical side. */
const PHYSICAL_CSS = [
  /\b(margin|padding|border)-(left|right)\b/,
  /(^|[\s;{])(left|right)\s*:/,
  /\btext-align\s*:\s*(left|right)\b/,
  /\bfloat\s*:\s*(left|right)\b/,
];

/** Inline React style properties that name a physical side. */
const PHYSICAL_STYLE_PROPS = /\b(margin|padding|border)(Left|Right)\b/;

/** Splits a class token into its variant prefix and the utility itself. */
function splitToken(token) {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
    else if (char === ':' && depth === 0) cut = i;
  }
  return { variants: token.slice(0, cut + 1), utility: token.slice(cut + 1) };
}

/** The physical side utilities in one line of source, or an empty list. */
export function findPhysicalUtilities(line) {
  const found = [];
  for (const token of line.split(/[\s'"`{}(),;]+/)) {
    if (!token) continue;
    const { variants, utility } = splitToken(token);
    if (/(^|:)(ltr|rtl):/.test(`:${variants}`)) continue;
    const bare = utility.replace(/^!/, '').replace(/!$/, '').replace(/^-/, '');
    if (PHYSICAL_VARIANT.test(variants) || PHYSICAL_UTILITIES.some((rule) => rule.test(bare))) {
      found.push(token);
    }
  }
  return found;
}

/** Every violation in a file's text, as `{ line, text }`. */
export function checkSource(text, extension) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  lines.forEach((line, index) => {
    if (IGNORE.test(line) || (index > 0 && IGNORE.test(lines[index - 1] ?? ''))) return;
    const hits =
      extension === '.css'
        ? PHYSICAL_CSS.some((rule) => rule.test(line))
          ? [line.trim()]
          : findPhysicalUtilities(line.replace(/^\s*@apply\s+/, ''))
        : [
            ...findPhysicalUtilities(line),
            ...(PHYSICAL_STYLE_PROPS.test(line) ? [line.trim()] : []),
          ];
    for (const hit of hits) problems.push({ line: index + 1, text: hit });
  });
  return problems;
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(path);
    return EXTENSIONS.has(extname(name)) ? [path] : [];
  });
}

function main(dirs) {
  if (dirs.length === 0) {
    console.error('Usage: check-logical-css.mjs <dir> [<dir>...]');
    return 2;
  }
  let count = 0;
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      for (const problem of checkSource(readFileSync(file, 'utf8'), extname(file))) {
        count++;
        console.error(`${relative(process.cwd(), file)}:${problem.line}  ${problem.text}`);
      }
    }
  }
  if (count > 0) {
    console.error(
      `\n${count} physical side ${count === 1 ? 'style' : 'styles'} found. Use logical sides ` +
        '(ms-/me-, ps-/pe-, start-/end-, border-s/e, rounded-s/e, text-start/end), scope it ' +
        'with ltr:/rtl:, or mark the line `logical-css-ignore: <reason>`.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
