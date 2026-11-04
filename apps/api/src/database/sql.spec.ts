import { describe, expect, it } from 'vitest';
import { isRetryable, isStillReferenced, pgArray, pgConstraint, pgErrorCode } from './sql.js';

describe('pgArray', () => {
  it('builds a quoted PostgreSQL array literal', () => {
    expect(pgArray(['a', 'b'])).toBe('{"a","b"}');
  });

  it('writes null as the bare NULL keyword, not the text "NULL"', () => {
    expect(pgArray(['x', null])).toBe('{"x",NULL}');
    expect(pgArray(['NULL'])).toBe('{"NULL"}');
  });

  it('escapes quotes and backslashes inside values', () => {
    expect(pgArray(['say "hi"', 'C:\\bin'])).toBe('{"say \\"hi\\"","C:\\\\bin"}');
  });

  it('keeps commas and braces inside one element', () => {
    expect(pgArray(['a,b', '{c}'])).toBe('{"a,b","{c}"}');
  });

  it('writes numbers, booleans, and bigints as text', () => {
    expect(pgArray([1, -2, true, 9_007_199_254_740_993n])).toBe(
      '{"1","-2","true","9007199254740993"}',
    );
  });

  it('gives an empty literal for no values', () => {
    expect(pgArray([])).toBe('{}');
  });
});

describe('pgErrorCode and pgConstraint', () => {
  const pgError = Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint: 'reservations_active_source_line_unique',
  });

  it('read a PostgreSQL error directly', () => {
    expect(pgErrorCode(pgError)).toBe('23505');
    expect(pgConstraint(pgError)).toBe('reservations_active_source_line_unique');
  });

  it('read through the cause Drizzle wraps it in', () => {
    const wrapped = new Error('Failed query', { cause: pgError });

    expect(pgErrorCode(wrapped)).toBe('23505');
    expect(pgConstraint(wrapped)).toBe('reservations_active_source_line_unique');
  });

  it('return undefined for errors that are not from PostgreSQL', () => {
    expect(pgErrorCode(new Error('boom'))).toBeUndefined();
    expect(pgConstraint(new Error('boom'))).toBeUndefined();
    expect(pgErrorCode(undefined)).toBeUndefined();
    expect(pgErrorCode('text')).toBeUndefined();
  });
});

describe('isRetryable', () => {
  it.each([
    ['a deadlock', '40P01', true],
    ['a serialization failure', '40001', true],
    ['a unique violation', '23505', false],
    ['a check violation', '23514', false],
  ])('is %s → %s', (_case, code, expected) => {
    const error = new Error('Failed query', { cause: Object.assign(new Error('x'), { code }) });

    expect(isRetryable(error)).toBe(expected);
  });

  it('is false for an error without a code', () => {
    expect(isRetryable(new Error('network down'))).toBe(false);
  });
});

describe('isStillReferenced', () => {
  it('is true for a foreign key refusal, RESTRICT or NO ACTION, also when wrapped', () => {
    expect(isStillReferenced({ code: '23001' })).toBe(true);
    expect(isStillReferenced({ message: 'wrapped', cause: { code: '23503' } })).toBe(true);
    expect(isStillReferenced({ code: '23505' })).toBe(false);
    expect(isStillReferenced(new Error('plain'))).toBe(false);
  });
});
