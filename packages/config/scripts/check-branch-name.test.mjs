import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isValidBranchName } from './check-branch-name.mjs';

const SCRIPT = fileURLToPath(new URL('./check-branch-name.mjs', import.meta.url));

describe('isValidBranchName', () => {
  for (const name of ['feat/scaffold-shape-a', 'fix/login-lockout', 'docs/adr-0002', 'feat/x']) {
    it(`accepts ${name}`, () => assert.equal(isValidBranchName(name), true));
  }
  for (const name of [
    'test-branch',
    'main',
    'feature/x',
    'feat/',
    'feat/Has_Caps',
    'chore/x',
    '',
  ]) {
    it(`rejects "${name}"`, () => assert.equal(isValidBranchName(name), false));
  }
});

describe('the command', () => {
  it('exits 1 for test-branch and 0 for feat/<slug>', () => {
    const bad = spawnSync(process.execPath, [SCRIPT, 'test-branch'], { encoding: 'utf8' });
    const good = spawnSync(process.execPath, [SCRIPT, 'feat/some-slug'], { encoding: 'utf8' });

    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /test-branch/);
    assert.equal(good.status, 0);
  });
});
