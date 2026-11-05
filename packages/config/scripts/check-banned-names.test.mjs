import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bannedWordsIn, checkBannedNames, nameWords } from './check-banned-names.mjs';

const SCRIPT = fileURLToPath(new URL('./check-banned-names.mjs', import.meta.url));
const GOOD = fileURLToPath(new URL('./fixtures/banned-names/good', import.meta.url));
const BAD = fileURLToPath(new URL('./fixtures/banned-names/bad', import.meta.url));

describe('nameWords', () => {
  it('splits dashes, dots, underscores, and camel case', () => {
    assert.deepEqual(nameWords('MiscHelper.ts'), ['misc', 'helper', 'ts']);
    assert.deepEqual(nameWords('order-number_utils.spec.ts'), [
      'order',
      'number',
      'utils',
      'spec',
      'ts',
    ]);
  });
});

describe('bannedWordsIn', () => {
  it('matches whole words only', () => {
    assert.deepEqual(bannedWordsIn('MiscHelper.ts'), ['misc', 'helper']);
    assert.deepEqual(bannedWordsIn('order-template.ts'), []);
    assert.deepEqual(bannedWordsIn('cfg.ts'), ['cfg']);
  });
});

describe('checkBannedNames', () => {
  it('finds a banned file and a banned folder', () => {
    const found = checkBannedNames(BAD).map((path) => basename(path));

    assert.deepEqual(found.sort(), ['MiscHelper.ts', 'utils', 'utils.ts']);
  });

  it('exempts packages/ui/src/lib/utils.ts by exact path only', () => {
    assert.deepEqual(checkBannedNames(GOOD), []);
    const found = checkBannedNames(BAD).map((path) => path.replaceAll('\\', '/'));

    assert.ok(found.some((path) => path.endsWith('packages/ui/src/exchanges/utils.ts')));
    assert.ok(!found.some((path) => path.endsWith('packages/ui/src/lib/utils.ts')));
  });

  it('passes business names', () => {
    assert.deepEqual(checkBannedNames(GOOD), []);
  });
});

describe('the command', () => {
  it('fails on MiscHelper.ts', () => {
    const result = spawnSync(process.execPath, [SCRIPT, BAD], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /MiscHelper\.ts/);
  });

  it('passes a good tree', () => {
    const result = spawnSync(process.execPath, [SCRIPT, GOOD], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
