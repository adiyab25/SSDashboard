import { describe, expect, it } from 'vitest';
import { CreateProductRequest, UpdateSkuRequest } from './catalog.js';
import { moneyInput, quantityInput, westernDigits } from './digit-input.js';
import { CreateStockReceiptRequest } from './stock-receipts.js';
import { UnitCostString } from './money.js';

describe('westernDigits', () => {
  it('normalizes digits and nothing else', () => {
    expect(westernDigits.parse('+٢٠ ۱۰')).toBe('+20 10');
  });
});

describe('quantityInput', () => {
  const quantity = quantityInput({ min: 1, max: 1000 });
  it('accepts a number or text in any digit set', () => {
    expect(quantity.parse(3)).toBe(3);
    expect(quantity.parse('٣')).toBe(3);
    expect(quantity.parse('۳')).toBe(3);
  });
  it('keeps the range and refuses fractions and letters on the field', () => {
    for (const bad of [0, 1001, 1.5, '0', '1,5', '12a', '']) {
      expect(quantity.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe('moneyInput', () => {
  it('gives the normalized decimal string for the existing rules to check', () => {
    expect(moneyInput(4).pipe(UnitCostString).parse('١٢٫٥٠')).toBe('12.50');
    expect(moneyInput(2).parse('1٬234٫50')).toBe('1234.50');
  });
  it('refuses a guessed comma and too many decimals', () => {
    expect(moneyInput(2).safeParse('1,5').success).toBe(false);
    expect(moneyInput(2).safeParse('1.234').success).toBe(false);
  });
});

describe('request schemas', () => {
  it('normalize the receipt line and the SKU prices', () => {
    const receipt = CreateStockReceiptRequest.parse({
      locationId: crypto.randomUUID(),
      lines: [{ skuId: crypto.randomUUID(), quantity: '٣', unitCost: '١٢٫٥٠' }],
    });
    expect(receipt.lines[0]).toMatchObject({ quantity: 3, unitCost: '12.50' });
    const product = CreateProductRequest.parse({
      name: { en: 'x' },
      variants: [{ sku: 'a', price: '١٢٣٤٫٥٠' }],
    });
    expect(product.variants[0]?.price).toBe('1234.50');
    expect(UpdateSkuRequest.parse({ updatedAt: 'x', price: null }).price).toBeNull();
    expect(UpdateSkuRequest.safeParse({ updatedAt: 'x', price: '-١' }).success).toBe(false);
  });
});
