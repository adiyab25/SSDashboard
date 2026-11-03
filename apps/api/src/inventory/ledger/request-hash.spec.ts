import { describe, expect, it } from 'vitest';
import { requestHash, type HashedRequest } from './request-hash.js';

const A = '01a1a04f-0000-7000-8000-00000000000a';
const B = '01a1a04f-0000-7000-8000-00000000000b';
const L = '01a1a04f-0000-7000-8000-0000000000aa';

function request(overrides: Partial<HashedRequest> = {}): HashedRequest {
  return {
    operation: 'post',
    sourceType: 'purchase_receipt',
    sourceId: '01a1a04f-0000-7000-8000-000000000001',
    reversesGroupId: null,
    lines: [
      { variantId: A, locationId: L, quantity: 5, unitCost: '2.5000' },
      { variantId: B, locationId: L, quantity: -1 },
    ],
    ...overrides,
  };
}

// Spec 0002, Value sourcing `request_hash`: what a replay must match (AC-5).
describe('requestHash', () => {
  it('is a stable SHA-256 hex digest for the same request', () => {
    expect(requestHash(request())).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash(request())).toBe(requestHash(request()));
  });

  it('ignores the order the lines come in (covers: AC-5)', () => {
    const lines = request().lines;

    expect(requestHash(request({ lines: [...lines].reverse() }))).toBe(requestHash(request()));
  });

  it('ignores the order of keys inside a line', () => {
    const reordered = request({
      lines: [
        { unitCost: '2.5000', quantity: 5, locationId: L, variantId: A },
        { quantity: -1, locationId: L, variantId: B },
      ],
    });

    expect(requestHash(reordered)).toBe(requestHash(request()));
  });

  it('treats a missing date as the same request, so a retry without one still matches (covers: AC-5)', () => {
    expect(requestHash(request({ effectiveAt: undefined }))).toBe(requestHash(request()));
  });

  it('treats the same cost written two ways as one request (covers: AC-5)', () => {
    const plain = request({
      lines: [{ variantId: A, locationId: L, quantity: 5, unitCost: '10' }],
    });
    const padded = request({
      lines: [{ variantId: A, locationId: L, quantity: 5, unitCost: '10.0000' }],
    });

    expect(requestHash(plain)).toBe(requestHash(padded));
  });

  it('includes an explicit date', () => {
    const dated = request({ effectiveAt: new Date('2026-11-01T10:00:00Z') });

    expect(requestHash(dated)).not.toBe(requestHash(request()));
    expect(requestHash(dated)).toBe(
      requestHash(request({ effectiveAt: new Date('2026-11-01T10:00:00.000Z') })),
    );
  });

  it.each<[string, Partial<HashedRequest>]>([
    [
      'a changed quantity',
      {
        lines: [
          { variantId: A, locationId: L, quantity: 6, unitCost: '2.5000' },
          { variantId: B, locationId: L, quantity: -1 },
        ],
      },
    ],
    [
      'a changed unit cost',
      {
        lines: [
          { variantId: A, locationId: L, quantity: 5, unitCost: '2.5001' },
          { variantId: B, locationId: L, quantity: -1 },
        ],
      },
    ],
    ['a different operation', { operation: 'reverse' }],
    ['a different source type', { sourceType: 'adjustment' }],
    ['a different source id', { sourceId: '01a1a04f-0000-7000-8000-000000000002' }],
    ['a reversal target', { reversesGroupId: '01a1a04f-0000-7000-8000-000000000003' }],
    [
      'a dropped line',
      { lines: [{ variantId: A, locationId: L, quantity: 5, unitCost: '2.5000' }] },
    ],
  ])('changes with %s, so the same key is a conflict (covers: AC-5)', (_case, overrides) => {
    expect(requestHash(request(overrides))).not.toBe(requestHash(request()));
  });

  it('hashes two lines on one balance the same in either order', () => {
    const one = request({
      lines: [
        { variantId: A, locationId: L, quantity: 5, unitCost: '1.0000' },
        { variantId: A, locationId: L, quantity: -3 },
      ],
    });
    const swapped = request({
      lines: [
        { variantId: A, locationId: L, quantity: -3 },
        { variantId: A, locationId: L, quantity: 5, unitCost: '1.0000' },
      ],
    });

    expect(requestHash(one)).toBe(requestHash(swapped));
  });
});
