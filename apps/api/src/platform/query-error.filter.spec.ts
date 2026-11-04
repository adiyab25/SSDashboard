import type { ArgumentsHost } from '@nestjs/common';
import { ConflictException, HttpException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailedQueryError } from '../database/pg-error.js';
import { QueryErrorFilter } from './query-error.filter.js';

const EMAIL = 'sam@example.com';
const HASH = 'a1b2c3d4e5f6a7b8:0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** Built the way drizzle-orm's `DrizzleQueryError` is: params in the message, pg error as cause. */
function drizzleQueryError(cause?: unknown): Error {
  const query = 'insert into "users" ("email", "password") values ($1, $2)';
  const params = [EMAIL, HASH];
  const error = new Error(`Failed query: ${query}\nparams: ${params.join(',')}`, { cause });
  return Object.assign(error, { query, params });
}

const pgError = (code: string) =>
  Object.assign(new Error(`duplicate key value, Key (email)=(${EMAIL}) already exists`), {
    code,
    detail: `Key (email)=(${EMAIL}) already exists.`,
  });

function run(exception: unknown) {
  const reply = vi.fn();
  const adapter = { isHeadersSent: () => false, reply, end: vi.fn() };
  const host = { getArgByIndex: () => ({}) } as unknown as ArgumentsHost;
  const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  logged.mockClear();
  new QueryErrorFilter(adapter as never).catch(exception, host);
  return { reply, logged };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QueryErrorFilter', () => {
  it('logs a failed query as "Failed query" with the pg code, and no params, SQL or pg message', () => {
    const { reply, logged } = run(drizzleQueryError(pgError('23505')));

    expect(logged).toHaveBeenCalledTimes(1);
    const [entry] = logged.mock.calls[0] ?? [];
    expect(entry).toBeInstanceOf(FailedQueryError);
    const text = `${(entry as Error).message}\n${(entry as Error).stack ?? ''}`;
    expect((entry as Error).message).toBe('Failed query (pg 23505)');
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(HASH);
    expect(text).not.toContain('insert into');
    expect((entry as Error).cause).toBeUndefined();
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ statusCode: 500 }),
      500,
    );
  });

  it('logs "Failed query" alone when there is no usable pg code', () => {
    const { logged } = run(drizzleQueryError({ code: `x ${EMAIL}` }));

    expect((logged.mock.calls[0]?.[0] as Error).message).toBe('Failed query');
  });

  it('leaves every other error to Nest as before', () => {
    const plain = new Error('something else');
    expect(run(plain).logged).toHaveBeenCalledWith(plain);

    const { reply, logged } = run(new ConflictException({ code: 'LAST_ADMIN', message: 'x' }));
    expect(logged).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      { code: 'LAST_ADMIN', message: 'x' },
      409,
    );
  });

  it('passes an HttpException through untouched, even one shaped like a failed query', () => {
    const http = Object.assign(new HttpException({ code: 'X', message: 'chosen' }, 400), {
      query: 'select 1',
      params: [EMAIL],
    });
    const { reply, logged } = run(http);

    expect(logged).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.anything(), { code: 'X', message: 'chosen' }, 400);
  });
});
