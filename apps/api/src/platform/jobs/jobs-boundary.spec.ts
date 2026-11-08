import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spec 0009, AC-10 (security review m3, finding 4): every job goes through the declared queues and
// carries its capability. Only `JobBoss` builds a pg-boss client, only `JobSender` and the
// supervisor send on it, and only they (and the module that wires them) take the client at all.
const API_SRC = fileURLToPath(new URL('../..', import.meta.url));

/** Every non test TypeScript file under `src/`, as a path relative to it with forward slashes. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

const FILES = sourceFiles(API_SRC).map((path) => ({
  file: relative(API_SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

/** The files whose text matches `pattern`. */
const matching = (pattern: RegExp): string[] =>
  FILES.filter(({ text }) => pattern.test(text))
    .map(({ file }) => file)
    .sort();

describe('the job client boundary (AC-10)', () => {
  it('builds a pg-boss client only in JobBoss', () => {
    expect(matching(/new PgBoss\(/)).toEqual(['platform/jobs/job-boss.ts']);
  });

  it('sends on the client only in JobSender and the supervisor', () => {
    expect(matching(/\bboss\.send\(/)).toEqual([
      'platform/jobs/job-sender.ts',
      'platform/jobs/module-job-supervisor.ts',
    ]);
  });

  it('imports values from pg-boss only inside platform/jobs/ (type imports are fine)', () => {
    // Every import, export, require, or dynamic import of the package, whatever its spacing or
    // alias; an `import type` (or one whose every name is `type`) brings in no code (R4).
    const statement =
      /(?:import|export)\s+([^;]*?)\s*from\s*['"]pg-boss['"]|(?:import|require)\s*\(\s*['"]pg-boss['"]\s*\)/g;
    const valueImport = (clause: string | undefined): boolean => {
      if (clause === undefined) return true; // require() or import()
      const text = clause.trim();
      if (text.startsWith('type ')) return false;
      const named = /^\{([\s\S]*)\}$/.exec(text);
      if (!named) return true; // a default or namespace import
      return (named[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .some((name) => !name.startsWith('type '));
    };
    const offenders = FILES.filter(({ file, text }) => {
      if (file.startsWith('platform/jobs/')) return false;
      return [...text.matchAll(statement)].some((match) => valueImport(match[1]));
    }).map(({ file }) => file);
    expect(offenders).toEqual([]);
    // The rule finds what it must: a value import is caught, a type import is not.
    const caught = (source: string) =>
      [...source.matchAll(statement)].some((match) => valueImport(match[1]));
    expect(caught("import { PgBoss as Queue } from 'pg-boss';")).toBe(true);
    expect(caught("import * as boss from 'pg-boss';")).toBe(true);
    expect(caught("const m = await import ( 'pg-boss' );")).toBe(true);
    expect(caught("import { fromDrizzle, type Job } from 'pg-boss';")).toBe(true);
    expect(caught("import type { Job } from 'pg-boss';")).toBe(false);
    expect(caught("import { type Job, type SendOptions } from 'pg-boss';")).toBe(false);
  });

  it('hands the client out only to JobSender, the supervisor, and the jobs module', () => {
    expect(matching(/\bJobBoss\b/)).toEqual([
      'platform/jobs/job-boss.ts',
      'platform/jobs/job-sender.ts',
      'platform/jobs/jobs.module.ts',
      'platform/jobs/module-job-supervisor.ts',
    ]);
  });
});
