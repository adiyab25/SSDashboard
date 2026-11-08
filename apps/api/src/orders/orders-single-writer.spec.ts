import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ORDERS_DIR = fileURLToPath(new URL('.', import.meta.url));
const WRITER = 'writer/order-writer.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** SQL that writes one of the order tables (the `INSERT` or `UPDATE` words naming it). */
const WRITES_ORDER_TABLES =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?"?(orders|order_lines|order_events)"?\b|\$\{sql\.raw\(table\)\}|insertSql\(\s*'order/i;

// Spec 0013, Key invariants: only writer/order-writer.ts writes orders, order_lines, and order_events.
describe('the orders module has one writer', () => {
  const files = sourceFiles(ORDERS_DIR).map((path) => ({
    name: relative(ORDERS_DIR, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));

  it('finds the module source', () => {
    expect(files.map((file) => file.name)).toContain(WRITER);
  });

  it('issues INSERT or UPDATE on the order tables from the writer only', () => {
    const writers = files.filter((file) => WRITES_ORDER_TABLES.test(file.text)).map((f) => f.name);

    expect(writers).toEqual([WRITER]);
  });

  it('would catch a planted write from another file', () => {
    expect(WRITES_ORDER_TABLES.test('await tx.execute(sql`UPDATE orders SET outcome = 1`)')).toBe(
      true,
    );
    expect(WRITES_ORDER_TABLES.test('INSERT INTO order_events (x) VALUES (1)')).toBe(true);
    expect(WRITES_ORDER_TABLES.test('DELETE FROM orders WHERE id = 1')).toBe(true);
    expect(WRITES_ORDER_TABLES.test('DELETE FROM order_lines')).toBe(true);
    expect(WRITES_ORDER_TABLES.test('SELECT id FROM orders FOR UPDATE')).toBe(false);
  });
});
