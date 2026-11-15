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
  textOf,
} from './check-private-content.mjs';

const SCRIPT = fileURLToPath(new URL('./check-private-content.mjs', import.meta.url));
const roots = [];

// Words built from char codes so no blocked word is written in this file. Each one has its digest in
// BLOCKED_DIGESTS (asserted below), so the test breaks if the list and the codes drift apart.
const fromCodes = (codes) => String.fromCharCode(...codes);
const ALL_BLOCKED = [
  [115, 101, 101, 109, 108, 121],
  [115, 101, 101, 109, 108, 121, 111, 112, 115],
  [115, 101, 101, 109, 108, 121, 101, 103],
  [103, 101, 110, 122],
  [115, 97, 115, 104],
  [114, 105, 122, 122],
  [100, 105, 121, 97, 98],
].map(fromCodes);
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
  it('holds exactly the digests of the seven constructed words, and blocks each', () => {
    const digests = ALL_BLOCKED.map((word) => createHash('sha256').update(word).digest('hex'));
    assert.deepEqual([...digests].sort(), [...BLOCKED_DIGESTS].sort());
    for (const word of ALL_BLOCKED) assert.deepEqual(blockedWordHits(`a ${word}`), [{ line: 1 }]);
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

  it('splits camelCase and PascalCase, and reads Unicode letters', () => {
    const [first] = ALL_BLOCKED;
    const pascal = first[0].toUpperCase() + first.slice(1);
    assert.deepEqual(blockedWordHits(`fooBar${pascal}Baz`), [{ line: 1 }]);
    assert.deepEqual(blockedWordHits(`${first}Ops ${pascal}ID`), [{ line: 1 }]);
    assert.deepEqual(blockedWordHits('\u0645\u0631\u062d\u0628\u0627 drizzleOrm'), []);
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
    assert.equal(privateFolderOf('Docs/Reviews/x.md'), 'docs/reviews/');
  });
});

describe('textOf', () => {
  it('decodes UTF-16 with a byte order mark and skips real binaries', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a b', 'utf16le')]);
    const be = Buffer.from(le.subarray(2)).swap16();
    assert.equal(textOf(le), 'a b');
    assert.equal(textOf(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'a b');
    assert.equal(textOf(Buffer.from([0, 1, 2])), undefined);
    assert.equal(textOf(Buffer.from('plain')), 'plain');
  });
});

describe('privateContentProblems', () => {
  it('scans UTF-16 files', () => {
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`ok\n${BLOCKED_SAMPLE}\n`, 'utf16le'),
    ]);
    const root = repo({ 'notes.txt': body });
    assert.deepEqual(privateContentProblems(root), [
      { file: 'notes.txt', line: 2, reason: 'blocked word' },
    ]);
  });

  it('skips a file that is tracked but deleted from the work tree', () => {
    const root = repo({ 'gone.txt': 'x\n', 'a.md': 'ok\n' });
    rmSync(join(root, 'gone.txt'));
    assert.deepEqual(privateContentProblems(root), []);
  });

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

  it('fails on CRLF text', () => {
    const root = repo({ 'a.md': `x\r\n${BLOCKED_SAMPLE}\r\n` });
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /a\.md:2: blocked word/);
  });

  it('passes a clean repo', () => {
    const root = repo({ 'a.md': 'drizzle and adiyab25\n' });
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
