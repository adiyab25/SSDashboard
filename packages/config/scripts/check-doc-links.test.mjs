import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractLinks, localPath } from './check-doc-links.mjs';

const SCRIPT = fileURLToPath(new URL('./check-doc-links.mjs', import.meta.url));
const GOOD = fileURLToPath(new URL('./fixtures/doc-links/good', import.meta.url));
const BAD = fileURLToPath(new URL('./fixtures/doc-links/bad', import.meta.url));

describe('extractLinks', () => {
  it('reads inline and reference links with their line numbers', () => {
    const text = 'a\n[x](one.md "title") and [y](<two.md>)\n[ref]: three.md\n';

    assert.deepEqual(extractLinks(text), [
      { line: 2, target: 'one.md' },
      { line: 2, target: 'two.md' },
      { line: 3, target: 'three.md' },
    ]);
  });

  it('skips code spans and fenced blocks', () => {
    assert.deepEqual(extractLinks('`[a](b.md)`\n```\n[c](d.md)\n```\n'), []);
  });
});

describe('localPath', () => {
  it('ignores web links, mail links, and pure anchors', () => {
    for (const target of ['https://a.b/c', 'http://a.b', 'mailto:a@b.c', '#top']) {
      assert.equal(localPath(target), null, target);
    }
  });

  it('strips the fragment and decodes escapes', () => {
    assert.equal(localPath('my%20file.md#part'), 'my file.md');
  });
});

describe('the command', () => {
  it('fails on a planted broken link and names file and line', () => {
    const result = spawnSync(process.execPath, [SCRIPT, BAD], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /index\.md:4 {2}missing\.md/);
  });

  it('passes good links, anchors, web links, fragments, escapes, and code', () => {
    const result = spawnSync(process.execPath, [SCRIPT, GOOD], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
