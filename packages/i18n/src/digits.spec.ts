import { describe, expect, it } from 'vitest';
import { InvalidDigitInputError, normalizeDigits, parseMoney, parseQuantity } from './digits.js';

describe('normalizeDigits', () => {
  // AC-18: both digit sets and the Arabic separators are mapped.
  it.each([
    ['٠١٢٣٤٥٦٧٨٩', '0123456789'],
    ['۰۱۲۳۴۵۶۷۸۹', '0123456789'],
    ['٣٫٥', '3.5'],
    ['1٬234٫50', '1,234.50'],
    ['١٢،٣٤٥', '12,345'],
    ['12a', '12a'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeDigits(input)).toBe(expected);
  });

  it('removes the invisible marks and the no break space', () => {
    expect(normalizeDigits('‎1‏2؜3 4')).toBe('1234');
  });
});

describe('parseQuantity', () => {
  it.each([
    ['٣', 3],
    ['۳', 3],
    ['12', 12],
    [' ١٢ ', 12],
  ])('parses %s', (input, expected) => {
    expect(parseQuantity(input)).toBe(expected);
  });

  it.each(['', '1.5', '1,5', '-3', '12a', '99999999999999999999'])('rejects "%s"', (input) => {
    expect(() => parseQuantity(input)).toThrow(InvalidDigitInputError);
  });
});

describe('parseMoney', () => {
  it.each([
    ['٣٫٥', 2, '3.5'],
    ['1٬234٫50', 2, '1234.50'],
    ['١٢٣٤.٥٠', 2, '1234.50'],
    ['1,234.50', 2, '1234.50'],
    ['۳', 2, '3'],
    ['12.5000', 4, '12.5000'],
    ['-5.25', 2, '-5.25'],
  ])('parses %s with %i digits', (input, digits, expected) => {
    expect(parseMoney(input, digits)).toBe(expected);
  });

  it.each([
    ['1,5', 2],
    ['1.234', 2],
    ['12a', 2],
    ['', 2],
    ['.5', 2],
    ['1,23,456', 2],
    ['12.50001', 4],
  ])('rejects "%s" with %i digits, with a named error', (input, digits) => {
    try {
      parseMoney(input, digits);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDigitInputError);
      expect((error as InvalidDigitInputError).code).toBe('InvalidDigitInput');
    }
  });
});
