import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { missingKinds } from './check-tsdoc-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('./check-tsdoc-fixture.mjs', import.meta.url));
const KINDS = [
  'function',
  'class',
  'method',
  'interface',
  'type alias',
  'enum',
  'exported const',
  'React component',
  'hook',
];

describe('missingKinds', () => {
  it('finds nothing missing with the rule on', async () => {
    assert.deepEqual(await missingKinds(), []);
  });

  it('reports every kind when the rule is off', async () => {
    assert.deepEqual(await missingKinds({ requireJsdoc: false }), KINDS);
  });
});

describe('the command', () => {
  it('passes with the rule on', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });

  it('fails with the rule off', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--without-require-jsdoc'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /hook/);
  });
});
