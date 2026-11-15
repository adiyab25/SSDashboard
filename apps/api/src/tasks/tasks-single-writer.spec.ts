import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TASKS_DIR = fileURLToPath(new URL('.', import.meta.url));
const WRITER = 'tasks.service.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** SQL that writes one of the task tables (the `INSERT` or `UPDATE` words naming it). */
const WRITES_TASK_TABLES =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?"?(tasks|task_notes)"?\b/i;

// Spec 0016, Key invariants: only TasksService writes tasks and task_notes.
describe('the tasks module has one writer', () => {
  const files = sourceFiles(TASKS_DIR).map((path) => ({
    name: relative(TASKS_DIR, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));

  it('finds the module source', () => {
    expect(files.map((file) => file.name)).toContain(WRITER);
  });

  it('issues INSERT or UPDATE on the task tables from the service only', () => {
    const writers = files.filter((file) => WRITES_TASK_TABLES.test(file.text)).map((f) => f.name);

    expect(writers).toEqual([WRITER]);
  });

  it('never deletes a task or a note', () => {
    expect(files.filter((file) => /DELETE\s+FROM\s+"?task/i.test(file.text))).toEqual([]);
  });

  it('would catch a planted write from another file', () => {
    expect(WRITES_TASK_TABLES.test('await tx.execute(sql`UPDATE tasks SET status = 1`)')).toBe(
      true,
    );
    expect(WRITES_TASK_TABLES.test('INSERT INTO task_notes (note) VALUES (1)')).toBe(true);
    expect(WRITES_TASK_TABLES.test('DELETE FROM tasks WHERE id = 1')).toBe(true);
    expect(WRITES_TASK_TABLES.test('SELECT id FROM tasks FOR UPDATE')).toBe(false);
  });
});
