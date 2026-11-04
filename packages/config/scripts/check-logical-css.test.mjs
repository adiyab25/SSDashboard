import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSource, findPhysicalUtilities } from './check-logical-css.mjs';

const SCRIPT = fileURLToPath(new URL('./check-logical-css.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('findPhysicalUtilities', () => {
  it('catches physical side utilities, with variants and important or negative marks', () => {
    for (const token of [
      'ml-2',
      'mr-auto',
      'pl-4',
      'pr-0',
      'left-0',
      '-right-4',
      'text-left',
      'text-right',
      'border-l',
      'border-r-2',
      'rounded-l-md',
      'rounded-tr-lg',
      'float-left',
      'slide-in-from-left-10',
      'slide-out-to-right',
      'origin-top-left',
      'md:pl-4',
      'hover:!ml-1',
      'data-[side=left]:border-e',
      'scroll-ml-2',
    ]) {
      assert.deepEqual(findPhysicalUtilities(`"${token}"`), [token], token);
    }
  });

  it('allows logical sides, direction scoped overrides, and direction aware spacing', () => {
    for (const token of [
      'ms-2',
      'me-auto',
      'ps-4',
      'pe-0',
      'start-0',
      '-end-4',
      'text-start',
      'border-s',
      'border-e-2',
      'rounded-s-md',
      'rounded-ee-lg',
      'rtl:-scale-x-100',
      'rtl:left-0',
      'ltr:-translate-x-1/2',
      'space-x-2',
      'divide-x',
      'inset-x-0',
      'translate-x-px',
      'mx-auto',
      'px-2',
      'leftover',
    ]) {
      assert.deepEqual(findPhysicalUtilities(`"${token}"`), [], token);
    }
  });
});

describe('checkSource', () => {
  it('reports the line of each physical style in CSS', () => {
    const css = '.a {\n  margin-left: 1rem;\n  inset-inline-start: 0;\n  left: 0;\n}';

    assert.deepEqual(
      checkSource(css, '.css').map((problem) => problem.line),
      [2, 4],
    );
  });

  it('checks utilities inside @apply', () => {
    assert.equal(checkSource('.a { @apply pl-2; }', '.css').length, 1);
  });

  it('flags physical inline style properties in components', () => {
    assert.equal(checkSource('<div style={{ marginLeft: 4 }} />', '.tsx').length, 1);
  });

  it('skips a line marked logical-css-ignore, on the line or the line above', () => {
    const tsx = [
      "'left-0', // logical-css-ignore: Radix side is physical",
      '// logical-css-ignore: positioned by the popper',
      "'right-0'",
      "'ml-2'",
    ].join('\n');

    assert.deepEqual(
      checkSource(tsx, '.tsx').map((problem) => problem.line),
      [4],
    );
  });

  it('needs a reason after logical-css-ignore', () => {
    assert.equal(checkSource("'ml-2' // logical-css-ignore:", '.tsx').length, 1);
  });
});

describe('the command', () => {
  it('fails on a planted ml-2 and names the file and line', () => {
    const result = spawnSync(process.execPath, [SCRIPT, FIXTURES], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /planted\.tsx:3 {2}ml-2/);
  });

  it('passes a clean folder', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, fileURLToPath(new URL('.', import.meta.url))],
      {
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
  });
});
