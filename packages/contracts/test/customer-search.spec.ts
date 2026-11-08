import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_FLAG_SEVERITY,
  CustomerRiskFlag,
  CustomerSearchRequest,
  CustomerSearchResponse,
} from '../src/index.js';

// Spec 0014 AC-5: a search names exactly one of phone, nameContains, or flagged.
describe('CustomerSearchRequest', () => {
  it('accepts each of the three alone and defaults the page size to 25', () => {
    expect(CustomerSearchRequest.parse({ phone: '٠١٠٠١٢٣٤٥٦٧' }).limit).toBe(25);
    expect(CustomerSearchRequest.parse({ nameContains: 'منى' + ' علي' }).limit).toBe(25);
    expect(CustomerSearchRequest.parse({ flagged: true, limit: 100 }).limit).toBe(100);
  });

  it('refuses none, or more than one', () => {
    expect(CustomerSearchRequest.safeParse({}).success).toBe(false);
    expect(CustomerSearchRequest.safeParse({ limit: 10 }).success).toBe(false);
    expect(CustomerSearchRequest.safeParse({ phone: '0100', nameContains: 'abc' }).success).toBe(
      false,
    );
    expect(CustomerSearchRequest.safeParse({ phone: '0100', flagged: true }).success).toBe(false);
  });

  it('keeps a name between 3 and 100 characters after trimming, and refuses flagged false', () => {
    expect(CustomerSearchRequest.safeParse({ nameContains: '  ab ' }).success).toBe(false);
    expect(CustomerSearchRequest.safeParse({ nameContains: 'a'.repeat(101) }).success).toBe(false);
    expect(CustomerSearchRequest.parse({ nameContains: ' abc ' }).nameContains).toBe('abc');
    expect(CustomerSearchRequest.safeParse({ flagged: false }).success).toBe(false);
  });

  it('needs a letter or a digit in a name fragment (so a bare wildcard or punctuation is refused)', () => {
    for (const text of ['%%%', '___', '...', '- - -', '   ']) {
      expect(CustomerSearchRequest.safeParse({ nameContains: text }).success, text).toBe(false);
    }
    expect(CustomerSearchRequest.safeParse({ nameContains: 'منى' }).success).toBe(true);
    expect(CustomerSearchRequest.safeParse({ nameContains: '٠١٢' }).success).toBe(true);
    expect(CustomerSearchRequest.safeParse({ nameContains: 'a%_' }).success).toBe(true);
  });

  it('keeps the page size between 1 and 100 and refuses a key it does not know', () => {
    expect(CustomerSearchRequest.safeParse({ flagged: true, limit: 0 }).success).toBe(false);
    expect(CustomerSearchRequest.safeParse({ flagged: true, limit: 101 }).success).toBe(false);
    expect(CustomerSearchRequest.safeParse({ flagged: true, extra: 1 }).success).toBe(false);
  });
});

describe('customer enums', () => {
  it('lists every flag kind once in the severity order', () => {
    expect([...CUSTOMER_FLAG_SEVERITY].sort()).toEqual([...CustomerRiskFlag.options].sort());
  });

  it('parses an empty search answer', () => {
    expect(CustomerSearchResponse.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
