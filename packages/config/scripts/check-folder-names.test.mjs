import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findBannedFolders } from './check-folder-names.mjs';

const SCRIPT = fileURLToPath(new URL('./check-folder-names.mjs', import.meta.url));
const GOOD = fileURLToPath(new URL('./fixtures/folder-names/good', import.meta.url));
const BAD = fileURLToPath(new URL('./fixtures/folder-names/bad', import.meta.url));

describe('findBannedFolders', () => {
  it('finds a services folder at any depth', () => {
    const found = findBannedFolders(`${BAD}/apps/api/src`);

    assert.equal(found.length, 1);
    assert.match(found[0], /orders[\\/]services$/);
  });

  it('passes feature folders', () => {
    assert.deepEqual(findBannedFolders(`${GOOD}/apps/api/src`), []);
  });
});

describe('the command', () => {
  it('fails on a planted services folder', () => {
    const result = spawnSync(process.execPath, [SCRIPT, BAD], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /services/);
  });

  it('passes a good tree', () => {
    const result = spawnSync(process.execPath, [SCRIPT, GOOD], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
