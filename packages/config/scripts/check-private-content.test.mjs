import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BLOCKED_DIGESTS,
  blockedWordHits,
  privateContentProblems,
  privateFolderOf,
} from './check-private-content.mjs';

const SCRIPT = fileURLToPath(new URL('./check-private-content.mjs', import.meta.url));
const roots = [];

// Words built from char codes so no blocked word is written in this file. Each one has its digest in
// BLOCKED_DIGESTS (asserted below), so the test breaks if the list and the codes drift apart.
const fromCodes = (codes) => String.fromCharCode(...codes);
const BLOCKED_SAMPLE = fromCodes([114, 105, 122, 122]);
const BLOCKED_LONGER = fromCodes([103, 101, 110, 122]);

/** A throwaway git repo holding the given files (path to content), all added to the index. */
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'private-content-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '-A', '-f'], { cwd: root });
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the blocked list', () => {
  it('holds the digest of the constructed sample words', () => {
    for (const word of [BLOCKED_SAMPLE, BLOCKED_LONGER]) {
      assert.ok(BLOCKED_DIGESTS.has(createHash('sha256').update(word).digest('hex')));
    }
  });
});

describe('blockedWordHits', () => {
  it('flags a blocked word in any case and reports the line', () => {
    assert.deepEqual(blockedWordHits(`a\nb ${BLOCKED_SAMPLE.toUpperCase()}!\n`), [{ line: 2 }]);
    assert.deepEqual(blockedWordHits(`x_${BLOCKED_LONGER}-y`), [{ line: 1 }]);
  });

  it('passes a longer word that merely contains a blocked one, and a handle', () => {
    assert.deepEqual(blockedWordHits('import { pgTable } from "drizzle-orm"'), []);
    assert.deepEqual(blockedWordHits('https://github.com/adiyab25/SSDashboard'), []);
  });

  it('reads CRLF text', () => {
    assert.deepEqual(blockedWordHits(`a\r\n${BLOCKED_SAMPLE}\r\n`), [{ line: 2 }]);
  });
});

describe('privateFolderOf', () => {
  it('matches the private folders only at the start of a path', () => {
    assert.equal(privateFolderOf('docs/reviews/x.md'), 'docs/reviews/');
    assert.equal(privateFolderOf('.claude/skills/a/SKILL.md'), '.claude/skills/');
    assert.equal(privateFolderOf('docs/specs/reviews/x.md'), undefined);
    assert.equal(privateFolderOf('docs/reviews.md'), undefined);
  });
});

describe('privateContentProblems', () => {
  it('passes a clean repo', () => {
    const root = repo({ 'src/a.ts': 'export const orm = "drizzle";\n', 'README.md': 'hello\n' });
    assert.deepEqual(privateContentProblems(root), []);
  });

  it('flags a blocked word with file and line, never naming the word', () => {
    const root = repo({ 'src/a.ts': `ok\n// ${BLOCKED_SAMPLE}\n` });
    assert.deepEqual(privateContentProblems(root), [
      { file: 'src/a.ts', line: 2, reason: 'blocked word' },
    ]);
  });

  it('flags a tracked file in a private folder', () => {
    const root = repo({ 'docs/handover/next.md': 'clean text\n' });
    assert.deepEqual(
      privateContentProblems(root).map((problem) => problem.file),
      ['docs/handover/next.md'],
    );
  });

  it('flags a blocked word in a path and skips binary files', () => {
    const root = repo({
      [`src/${BLOCKED_SAMPLE}.txt`]: 'clean\n',
      'img.bin': Buffer.from([0, 1, 2]),
    });
    assert.deepEqual(
      privateContentProblems(root).map((problem) => problem.reason),
      ['blocked word in the path'],
    );
  });
});

describe('the command', () => {
  it('fails on a planted blocked word and names the file and line', () => {
    const root = repo({ 'a.md': `x\n${BLOCKED_LONGER}\n` });
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /a\.md:2: blocked word/);
    assert.ok(!result.stderr.includes(BLOCKED_LONGER));
  });

  it('passes a clean repo', () => {
    const root = repo({ 'a.md': 'drizzle and adiyab25\n' });
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
