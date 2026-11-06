import { describe, expect, it } from 'vitest';
import { EgyptianPhone } from '../src/index.js';

// Added by QA (verify-data-model-m3): the customers child's scenario "parse(parse(x).e164) equals
// parse(x) for every row" had no test.
describe('EgyptianPhone.parse round trip (AC-27)', () => {
  it.each([
    '01001234567',
    '٠١٠٠١٢٣٤٥٦٧',
    '۰۱۰۰۱۲۳۴۵۶۷',
    '+20 100 123 4567',
    '00201001234567',
    '+2001001234567',
    '201001234567',
    '1001234567',
    '0010 0123 4567‏',
    '0011 1234 5678',
    '0223456789',
    '034567890',
    '+971501234567',
    '00971501234567',
  ])('parses the normalized form of %s to the same value', (raw) => {
    const first = EgyptianPhone.parse(raw);
    expect(EgyptianPhone.parse(first.e164)).toEqual(first);
  });
});
