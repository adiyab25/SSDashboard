import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { badRouteGroups } from './check-route-groups.mjs';

const SCRIPT = fileURLToPath(new URL('./check-route-groups.mjs', import.meta.url));
const GOOD = fileURLToPath(new URL('./fixtures/route-groups/good', import.meta.url));
const BAD = fileURLToPath(new URL('./fixtures/route-groups/bad', import.meta.url));

describe('badRouteGroups', () => {
  it('allows the audience groups', () => {
    assert.deepEqual(badRouteGroups(`${GOOD}/apps/web/src/app`), []);
  });

  it('flags any other group', () => {
    assert.deepEqual(badRouteGroups(`${BAD}/apps/web/src/app`), ['(admin)']);
  });
});

describe('the command', () => {
  it('fails on a planted (admin) group', () => {
    const result = spawnSync(process.execPath, [SCRIPT, BAD], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\(admin\)/);
  });

  it('passes the allowed groups', () => {
    const result = spawnSync(process.execPath, [SCRIPT, GOOD], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
