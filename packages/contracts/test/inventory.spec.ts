import { describe, expect, it } from 'vitest';
import {
  GetLevelsInput,
  PostingInput,
  PostingLine,
  ReleaseInput,
  ReserveInput,
  ReverseInput,
} from '../src/index.js';

const ID = '01a1a04f-4735-7039-83da-13951ed11650';
const line = { variantId: ID, locationId: ID, quantity: 5, unitCost: '3.3333' };
const posting = {
  idempotencyKey: 'k1',
  sourceType: 'purchase_receipt',
  sourceId: ID,
  lines: [line],
};

describe('PostingLine', () => {
  it('accepts a signed whole quantity with a 4 decimal unit cost (covers: AC-3)', () => {
    expect(PostingLine.parse(line)).toEqual(line);
    expect(PostingLine.parse({ ...line, quantity: -2, unitCost: undefined }).quantity).toBe(-2);
  });

  it.each([
    ['a zero quantity', { quantity: 0 }],
    ['a fractional quantity', { quantity: 1.5 }],
    ['a quantity past the int4 range', { quantity: 2_147_483_648 }],
    ['a unit cost with 5 decimals', { unitCost: '1.00001' }],
    ['a negative unit cost', { unitCost: '-1.0000' }],
    ['a unit cost written as a number', { unitCost: 1.5 }],
    ['a SKU id that is not a uuid', { variantId: 'SKU-1' }],
    ['an empty serial', { serials: ['  '] }],
  ])('rejects %s (covers: AC-3)', (_case, override) => {
    expect(PostingLine.safeParse({ ...line, ...override }).success).toBe(false);
  });

  it('trims serials and reason codes', () => {
    const parsed = PostingLine.parse({ ...line, serials: [' SN-1 '], reasonCode: ' found ' });

    expect(parsed.serials).toEqual(['SN-1']);
    expect(parsed.reasonCode).toBe('found');
  });
});

describe('PostingInput', () => {
  it('accepts a posting and turns an ISO date into a Date (covers: AC-6)', () => {
    const parsed = PostingInput.parse({ ...posting, effectiveAt: '2026-11-01T10:00:00Z' });

    expect(parsed.effectiveAt).toEqual(new Date('2026-11-01T10:00:00Z'));
  });

  it('leaves the date out when none is given, so it defaults to now', () => {
    expect(PostingInput.parse(posting).effectiveAt).toBeUndefined();
  });

  it.each([
    ['no lines', { lines: [] }],
    ['an unknown source type', { sourceType: 'gift' }],
    ['an empty idempotency key', { idempotencyKey: '' }],
    ['more than 1000 lines', { lines: Array.from({ length: 1001 }, () => line) }],
  ])('rejects %s', (_case, override) => {
    expect(PostingInput.safeParse({ ...posting, ...override }).success).toBe(false);
  });
});

describe('ReverseInput', () => {
  it('needs a reason code (covers: AC-2)', () => {
    expect(ReverseInput.safeParse({ groupId: ID, idempotencyKey: 'r1' }).success).toBe(false);
    expect(
      ReverseInput.safeParse({ groupId: ID, idempotencyKey: 'r1', reasonCode: 'mistake' }).success,
    ).toBe(true);
  });
});

describe('GetLevelsInput', () => {
  it('pages 50 at a time by default', () => {
    expect(GetLevelsInput.parse({}).limit).toBe(50);
  });

  it('caps a page at 200', () => {
    expect(GetLevelsInput.safeParse({ limit: 200 }).success).toBe(true);
    expect(GetLevelsInput.safeParse({ limit: 201 }).success).toBe(false);
    expect(GetLevelsInput.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('ReserveInput and ReleaseInput (covers: AC-9)', () => {
  const reserve = {
    variantId: ID,
    locationId: ID,
    quantity: 2,
    sourceType: 'sales_order',
    sourceId: ID,
    sourceLineId: ID,
  };

  it('accepts a positive reservation and rejects zero or negative', () => {
    expect(ReserveInput.safeParse(reserve).success).toBe(true);
    expect(ReserveInput.safeParse({ ...reserve, quantity: 0 }).success).toBe(false);
    expect(ReserveInput.safeParse({ ...reserve, quantity: -1 }).success).toBe(false);
  });

  it('needs the document line a reservation belongs to', () => {
    const { sourceLineId: _line, ...withoutLine } = reserve;

    expect(ReserveInput.safeParse(withoutLine).success).toBe(false);
  });

  it('releases everything open when no quantity is given', () => {
    expect(ReleaseInput.parse({ reservationId: ID }).quantity).toBeUndefined();
    expect(ReleaseInput.safeParse({ reservationId: ID, quantity: 0 }).success).toBe(false);
  });
});
