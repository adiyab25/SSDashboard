import { describe, expect, it } from 'vitest';
import { receiptLineId, uuidV5 } from './line-id.js';

describe('receipt line ids', () => {
  it('match the RFC 9562 version 5 test vector', () => {
    // RFC 9562, appendix A.4: "www.example.com" in the DNS namespace.
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('are the same for the same receipt and position, and differ otherwise', () => {
    const receipt = '0192d9c4-1111-7000-8000-000000000001';
    expect(receiptLineId(receipt, 1)).toBe(receiptLineId(receipt, 1));
    expect(receiptLineId(receipt, 1)).not.toBe(receiptLineId(receipt, 2));
    expect(receiptLineId(receipt, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab]/);
  });
});
