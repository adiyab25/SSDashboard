import type { Database } from '@ssdashboard/db';

/** A Drizzle transaction, as handed to `db.transaction(...)` callbacks. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything that can run a query: the database or an open transaction. */
export type Executor = Database | Transaction;

/**
 * A PostgreSQL array literal (`{"a","b",NULL}`) for one bound parameter. Drizzle expands a
 * JS array into a list of parameters, so arrays travel as one literal cast in SQL
 * (`${pgArray(ids)}::uuid[]`).
 */
export function pgArray(values: readonly (string | number | boolean | bigint | null)[]): string {
  const items = values.map((value) => {
    if (value === null) return 'NULL';
    const text = String(value);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}

/** The SQLSTATE of a PostgreSQL error, also when Drizzle wrapped it. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** The constraint a PostgreSQL error names, also when Drizzle wrapped it. */
export function pgConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (
      typeof current === 'object' &&
      'constraint' in current &&
      typeof current.constraint === 'string'
    ) {
      return current.constraint;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Deadlock or serialization failure: the whole transaction may be retried. */
export function isRetryable(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === '40P01' || code === '40001';
}
