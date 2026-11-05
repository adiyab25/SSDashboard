import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { firstSubjectLine, subjectProblem } from './check-commit-subject.mjs';

const SCRIPT = fileURLToPath(new URL('./check-commit-subject.mjs', import.meta.url));

describe('subjectProblem', () => {
  for (const good of [
    'Split the web app by audience and deny api routes by default',
    'Enforce TSDoc and naming rules and redact personal data from logs',
    'Merge pull request #12 from adiyab25/feat/rebuild',
    'Merge branch main into feat/x',
    'a'.repeat(72),
  ]) {
    it(`accepts "${good.slice(0, 40)}"`, () => assert.equal(subjectProblem(good), null));
  }

  for (const bad of [
    'wip',
    'WIP.',
    'misc',
    'Fixes!',
    'update',
    'temp',
    'feat: add x',
    'fix(api): y',
    'chore!: drop node 24',
    'fixup! Add the hook',
    'a'.repeat(73),
    '',
  ]) {
    it(`rejects "${bad.slice(0, 40)}"`, () => assert.notEqual(subjectProblem(bad), null));
  }

  it('allows a longer subject that merely starts with a banned word', () => {
    assert.equal(subjectProblem('Update the stock count screen labels'), null);
  });
});

describe('firstSubjectLine', () => {
  it('skips comment lines and blank lines', () => {
    assert.equal(firstSubjectLine('# note\n\nAdd the hook\n\nbody'), 'Add the hook');
  });
});

describe('the command', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('checks a message file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commit-subject-'));
    try {
      const file = join(dir, 'MSG');
      writeFileSync(file, 'wip\n');
      assert.equal(run(file).status, 1);
      writeFileSync(file, '# comment\nAdd the commit message hook\n');
      assert.equal(run(file).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a planted bad subject in a git range', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commit-range-'));
    const git = (...a) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        cwd: dir,
        encoding: 'utf8',
      });
    try {
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'Start the repo');
      git('tag', 'base');
      git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'Add a good thing');
      git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'wip');
      const result = spawnSync(process.execPath, [SCRIPT, '--range', 'base..HEAD'], {
        cwd: dir,
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /"wip"/);
      assert.doesNotMatch(result.stderr, /Add a good thing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
