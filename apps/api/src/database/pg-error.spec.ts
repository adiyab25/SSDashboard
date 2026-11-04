import { describe, expect, it } from 'vitest';
import {
  describeError,
  FailedQueryError,
  isQueryError,
  loggableError,
  pgErrorCode,
} from './pg-error.js';

const EMAIL = 'sam@example.com';
const HASH = 'a1b2c3d4e5f6a7b8:0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const QUERY = 'select "id" from "users" where "users"."email" = $1 and "password" = $2';

/** Built the way drizzle-orm's `DrizzleQueryError` is: params in the message, pg error as cause. */
function drizzleQueryError(cause?: unknown): Error {
  const params = [EMAIL, HASH];
  const error = new Error(`Failed query: ${QUERY}\nparams: ${params.join(',')}`, { cause });
  return Object.assign(error, { query: QUERY, params });
}

const pgError = (code: string) =>
  Object.assign(new Error(`duplicate key value, Key (email)=(${EMAIL}) already exists`), {
    code,
    detail: `Key (email)=(${EMAIL}) already exists.`,
  });

const leaks = (text: string) =>
  [EMAIL, HASH, 'select', 'duplicate key'].filter((secret) => text.includes(secret));

describe('isQueryError and pgErrorCode', () => {
  it('tells a failed query by its shape and reads the code from the cause only', () => {
    expect(isQueryError(drizzleQueryError())).toBe(true);
    expect(isQueryError(new Error('Failed query: select 1'))).toBe(false);
    expect(isQueryError({ query: 'select 1', params: [] })).toBe(false);
    expect(pgErrorCode(drizzleQueryError(pgError('P0001')))).toBe('P0001');
    expect(pgErrorCode(Object.assign(new Error('x'), { code: '23505' }))).toBeUndefined();
    expect(pgErrorCode(drizzleQueryError({ code: `x ${EMAIL}` }))).toBeUndefined();
    expect(pgErrorCode(undefined)).toBeUndefined();
  });
});

describe('loggableError', () => {
  it('swaps a failed query for a FailedQueryError with the pg code and no cause', () => {
    const safe = loggableError(drizzleQueryError(pgError('23505')));

    expect(safe).toBeInstanceOf(FailedQueryError);
    expect((safe as Error).message).toBe('Failed query (pg 23505)');
    expect((safe as Error).cause).toBeUndefined();
    expect(leaks(`${(safe as Error).message}\n${(safe as Error).stack ?? ''}`)).toEqual([]);
  });

  it('returns any other value as it is', () => {
    const plain = new Error('boom');
    expect(loggableError(plain)).toBe(plain);
    expect(loggableError('text')).toBe('text');
    expect(loggableError(undefined)).toBeUndefined();
  });
});

describe('describeError', () => {
  it('prints a failed query as its pg code only, with or without the stack', () => {
    const error = drizzleQueryError(pgError('42703'));

    expect(describeError(error)).toBe('FailedQueryError: Failed query (pg 42703)');
    expect(describeError(error, true)).toBe('FailedQueryError: Failed query (pg 42703)');
    expect(describeError(drizzleQueryError())).toBe('FailedQueryError: Failed query');
  });

  it("prints Drizzle's message text as 'Failed query' when it arrives as a string", () => {
    expect(describeError(drizzleQueryError().message)).toBe('Failed query');
  });

  it('keeps the usual text of any other error, and its stack when asked', () => {
    const plain = new TypeError('listener broke');

    expect(describeError(plain)).toBe('TypeError: listener broke');
    expect(describeError(plain, true)).toBe(plain.stack);
    expect(describeError('plain words')).toBe('plain words');
    expect(describeError(42)).toBe('42');
  });
});
