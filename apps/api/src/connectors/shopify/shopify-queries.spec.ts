import { describe, expect, it } from 'vitest';
import {
  ORDER_READ,
  ORDER_READ_AGREEMENTS_PAGE,
  ORDER_READ_ESTIMATED_COST,
  ORDER_READ_SALES_PAGE,
  ordersBulkQuery,
} from './shopify-queries.js';

/** The body of the first selection that opens with `opener`, up to its matching brace. */
function selectionAfter(query: string, opener: string): string {
  const start = query.indexOf(opener);
  if (start < 0) throw new Error(`no ${opener}`);
  let depth = 0;
  for (let i = start + opener.length - 1; i < query.length; i += 1) {
    if (query[i] === '{') depth += 1;
    if (query[i] === '}') depth -= 1;
    if (depth === 0) return query.slice(start + opener.length, i);
  }
  throw new Error('unbalanced');
}

/** A selection without one field's whole subtree (its name, arguments, and braces). */
function withoutField(selection: string, field: string): string {
  const at = selection.search(new RegExp(`\\b${field}\\b`));
  if (at < 0) return selection;
  const open = selection.indexOf('{', at);
  const body = selectionAfter(selection.slice(open), '{');
  return selection.slice(0, at) + selection.slice(open + body.length + 2);
}

/** The field names of a selection, in order, without arguments and connection wrappers. */
function fieldNames(selection: string): string[] {
  const wrappers = new Set(['edges', 'node', 'nodes', 'pageInfo', 'hasNextPage']);
  return selection
    .replace(/\([^)]*\)/g, '')
    .split(/[\s{}]+/)
    .filter((token) => token !== '' && !wrappers.has(token));
}

// Spec 0015 AC-25 and task 10: the order read back stays inside the 900 point budget of the rate
// policy with the sales history it now reads. The estimate follows the rule in `ORDER_READ`'s
// TSDoc; task 1's recordings replace it with Shopify's `requestedQueryCost`.
describe('ORDER_READ', () => {
  it('requests at most 900 points by its estimate', () => {
    expect(ORDER_READ_ESTIMATED_COST).toBe(869);
    expect(ORDER_READ_ESTIMATED_COST).toBeLessThanOrEqual(900);
  });

  it('reads the sales history newest first, with each refund id and each product sale line item', () => {
    expect(ORDER_READ).toContain(`agreements(first: ${ORDER_READ_AGREEMENTS_PAGE}, reverse: true)`);
    expect(ORDER_READ).toContain(`sales(first: ${ORDER_READ_SALES_PAGE})`);
    expect(ORDER_READ).toMatch(/\.\.\. on RefundAgreement \{\s+refund \{\s+id\s+\}/);
    expect(ORDER_READ).toMatch(/\.\.\. on ProductSale \{\s+lineItem \{\s+id\s+\}/);
  });
});

// Code review nit (sync jobs, F1): the bulk copy of the order fields must not drift from the read
// back's, apart from the sales history (`agreements`, a third nesting level bulk cannot take).
describe('ORDER_BULK_FIELDS', () => {
  it('selects exactly the read back fields minus the sales history, connections as edges', () => {
    const read = withoutField(selectionAfter(ORDER_READ, 'order(id: $id) {'), 'agreements');
    const bulk = selectionAfter(ordersBulkQuery('2026-09-06T08:00:00Z'), 'node {');
    expect(fieldNames(bulk)).toEqual(fieldNames(read));
    expect(fieldNames(read)).toContain('transactions');
    expect(fieldNames(read)).not.toContain('agreements');
    expect(fieldNames(selectionAfter(ORDER_READ, 'order(id: $id) {'))).toContain('agreements');
  });
});
