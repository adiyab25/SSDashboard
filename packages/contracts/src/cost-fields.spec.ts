import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COST_FIELD_KEYS } from './access.js';
import * as contracts from './index.js';
import { MoneyString, UnitCostString } from './money.js';
import { SkuMovementsResponse, SkuStockResponse, StockListResponse } from './stock.js';
import { StockReceiptDetail, StockReceiptListResponse } from './stock-receipts.js';

// Spec 0008, AC-6: a cost serializer removes the fields named in `COST_FIELD_KEYS` for a caller
// without `cost.view`. A cost field whose name is missing from that list would leave the api
// unseen, so these tests read the fields from the Zod shapes themselves, never from a hand list.

/** One money or unit cost field found in a shape: where it is, its key, and whether it is optional. */
interface MoneyField {
  path: string;
  key: string;
  optional: boolean;
}

/**
 * Every field typed `MoneyString` or `UnitCostString` at any depth of a schema, through objects,
 * arrays, optional, nullable, default, readonly, pipes, unions and records.
 */
function moneyFieldsOf(schema: unknown, path: string): MoneyField[] {
  const found: MoneyField[] = [];
  const visit = (node: unknown, at: string, key: string, optional: boolean): void => {
    if (node === MoneyString || node === UnitCostString) {
      found.push({ path: at, key, optional });
    } else if (node instanceof z.ZodOptional) {
      visit(node.unwrap(), at, key, true);
    } else if (
      node instanceof z.ZodNullable ||
      node instanceof z.ZodDefault ||
      node instanceof z.ZodReadonly
    ) {
      visit(node.unwrap(), at, key, optional);
    } else if (node instanceof z.ZodObject) {
      for (const [name, child] of Object.entries(node.shape)) {
        visit(child, `${at}.${name}`, name, false);
      }
    } else if (node instanceof z.ZodArray) {
      visit(node.element, `${at}[]`, key, false);
    } else if (node instanceof z.ZodPipe) {
      visit(node.in, at, key, optional);
      visit(node.out, at, key, optional);
    } else if (node instanceof z.ZodUnion) {
      for (const option of node.options) visit(option, at, key, optional);
    } else if (node instanceof z.ZodRecord) {
      visit(node.valueType, `${at}{}`, key, false);
    }
  };
  visit(schema, path, '', false);
  return found;
}

/** The stock and receipt answers of spec 0006 that carry cost (AC-11). */
const COST_ANSWERS = {
  StockListResponse,
  SkuStockResponse,
  SkuMovementsResponse,
  StockReceiptDetail,
  StockReceiptListResponse,
};

describe('cost fields in the contracts (spec 0008, AC-6)', () => {
  it('names every money or unit cost field of the stock and receipt answers in COST_FIELD_KEYS, each optional', () => {
    const fields = Object.entries(COST_ANSWERS).flatMap(([name, schema]) =>
      moneyFieldsOf(schema, name),
    );
    const unlisted = fields.filter(
      (field) => !(COST_FIELD_KEYS as readonly string[]).includes(field.key),
    );
    const required = fields.filter((field) => !field.optional);

    expect(fields.length).toBeGreaterThan(0);
    expect(unlisted, 'a cost field missing from COST_FIELD_KEYS').toEqual([]);
    expect(required, 'a cost field the serializer cannot leave out').toEqual([]);
    // No stale name: every listed key is a field of one of these answers.
    expect([...new Set(fields.map((field) => field.key))].sort()).toEqual(
      [...COST_FIELD_KEYS].sort(),
    );
  });

  it('names every optional money or unit cost field of any contract in COST_FIELD_KEYS', () => {
    // An optional money field is one an answer can leave out, the shape of a cost field. A sale
    // amount is never optional this way and never uses a cost field's name.
    const unlisted = Object.entries(contracts)
      .flatMap(([name, schema]) => moneyFieldsOf(schema, name))
      .filter(
        (field) => field.optional && !(COST_FIELD_KEYS as readonly string[]).includes(field.key),
      );

    expect(unlisted).toEqual([]);
  });

  it('finds the cost fields the walk is meant to see', () => {
    expect(moneyFieldsOf(StockReceiptDetail, 'StockReceiptDetail')).toEqual([
      { path: 'StockReceiptDetail.lines[].unitCost', key: 'unitCost', optional: true },
      { path: 'StockReceiptDetail.lines[].lineTotal', key: 'lineTotal', optional: true },
      { path: 'StockReceiptDetail.referenceValue', key: 'referenceValue', optional: true },
    ]);
  });
});
