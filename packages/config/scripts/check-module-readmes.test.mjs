import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkReadmes, missingHeadings } from './check-module-readmes.mjs';

const SCRIPT = fileURLToPath(new URL('./check-module-readmes.mjs', import.meta.url));
const GOOD = fileURLToPath(new URL('./fixtures/readmes/good', import.meta.url));
const BAD = fileURLToPath(new URL('./fixtures/readmes/bad', import.meta.url));

describe('missingHeadings', () => {
  it('names each absent heading', () => {
    assert.deepEqual(missingHeadings('## Owns\n## Decisions\n'), [
      'Never touches',
      'How to test',
      'Governing spec',
    ]);
  });

  it('needs the exact H2 line', () => {
    assert.equal(missingHeadings('### Owns\n').includes('Owns'), true);
  });
});

describe('checkReadmes', () => {
  it('passes api modules, web features (not app), and packages with all five headings', () => {
    assert.deepEqual(checkReadmes(GOOD), []);
  });

  it('names the file and the missing heading', () => {
    const problems = checkReadmes(BAD);

    assert.equal(problems.length, 1);
    assert.match(problems[0].file, /orders[\\/]README\.md$/);
    assert.equal(problems[0].message, 'missing heading "## Never touches"');
  });
});

describe('the command', () => {
  it('fails on the planted README and prints the file', () => {
    const result = spawnSync(process.execPath, [SCRIPT, BAD], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /README\.md {2}missing heading "## Never touches"/);
  });

  it('passes a good tree', () => {
    const result = spawnSync(process.execPath, [SCRIPT, GOOD], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
