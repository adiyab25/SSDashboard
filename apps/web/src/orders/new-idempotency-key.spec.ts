import { afterEach, describe, expect, it, vi } from 'vitest';
import { newIdempotencyKey } from './new-idempotency-key';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('newIdempotencyKey', () => {
  it('returns a version 4 UUID', () => {
    expect(newIdempotencyKey()).toMatch(V4);
  });

  it('builds a version 4 UUID from getRandomValues where randomUUID is missing (plain HTTP)', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(crypto) });
    const keys = Array.from({ length: 50 }, () => newIdempotencyKey());
    for (const key of keys) expect(key).toMatch(V4);
    expect(new Set(keys).size).toBe(50);
  });

  it('sets the version and variant bits even on all-ones and all-zero input', () => {
    for (const fill of [0x00, 0xff]) {
      vi.stubGlobal('crypto', {
        getRandomValues: (bytes: Uint8Array) => bytes.fill(fill),
      });
      expect(newIdempotencyKey()).toMatch(V4);
    }
  });
});
