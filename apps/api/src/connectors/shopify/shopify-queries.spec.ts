import { describe, expect, it } from 'vitest';
import {
  ORDER_READ,
  ORDER_READ_AGREEMENTS_PAGE,
  ORDER_READ_ESTIMATED_COST,
  ORDER_READ_SALES_PAGE,
} from './shopify-queries.js';

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
